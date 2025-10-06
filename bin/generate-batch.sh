#!/usr/bin/env bash

set -euo pipefail

# Usage examples:
#   bin/generate-batch.sh --amount 5 --mongo-user user --mongo-pass pass --mongo-authSource admin \
#     --categories "Infancia,Familia,Escuela" --languages "es,en"
#
# Flags:
#   --categories: lista separada por comas
#   --languages: lista separada por comas (ej: es,en)
#   --amount: número por categoría/idioma (default 5)
#   --subcategories: lista separada por comas aplicada a todas
#   --dry-run: no guarda, solo imprime
#   --sleep-s: segundos (puede ser decimal) entre llamadas (ej: 0.5)
#   --log-dir: directorio donde guardar logs por categoría/idioma
#   --mongodb-uri / --mongo-user --mongo-pass --mongo-authSource --mongo-host --mongo-port --mongo-db
#   --atlas-uri / --atlas-cluster / --mongo-params

AMOUNT=5
CATEGORIES=""
LANGUAGES="es,en"
SUBCATS=""
SLEEP_S="0"
LOG_DIR=""
EXTRA_ARGS=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --amount)
      AMOUNT="$2"; shift 2;;
    --categories)
      CATEGORIES="$2"; shift 2;;
    --languages)
      LANGUAGES="$2"; shift 2;;
    --subcategories)
      SUBCATS="$2"; shift 2;;
    --dry-run)
      EXTRA_ARGS+=("--dry-run"); shift;;
    --sleep-s)
      SLEEP_S="$2"; shift 2;;
    --log-dir)
      LOG_DIR="$2"; shift 2;;
    --mongodb-uri|--mongo-user|--mongo-pass|--mongo-authSource|--mongo-host|--mongo-port|--mongo-db|--atlas-uri|--atlas-cluster|--mongo-params)
      EXTRA_ARGS+=("$1" "$2"); shift 2;;
    *)
      echo "Argumento desconocido: $1"; exit 1;;
  esac
done

if [[ -z "$CATEGORIES" ]]; then
  echo "❌ Debes especificar --categories 'A,B,C'"; exit 1
fi

if [[ -n "$LOG_DIR" ]]; then
  mkdir -p "$LOG_DIR"
fi

IFS=',' read -r -a CAT_ARR <<< "$CATEGORIES"
IFS=',' read -r -a LANG_ARR <<< "$LANGUAGES"

for CAT in ${CAT_ARR[@]}; do
  for L in ${LANG_ARR[@]}; do
    echo "➡️  Generando categoría='$CAT' idioma='$L' amount=$AMOUNT"

    # Construir comando
    CMD=(node bin/generate-prompts.js --category "$CAT" --language "$L" --amount "$AMOUNT")
    if [[ -n "$SUBCATS" ]]; then
      CMD+=(--subcategories "$SUBCATS")
    fi
    if [[ ${#EXTRA_ARGS[@]} -gt 0 ]]; then
      CMD+=(${EXTRA_ARGS[@]})
    fi

    # Ejecutar sin abortar todo el batch si falla
    set +e
    OUTPUT="$(${CMD[@]} 2>&1)"
    STATUS=$?
    set -e

    # Echo a consola
    echo "$OUTPUT"

    # Logging opcional
    if [[ -n "$LOG_DIR" ]]; then
      # Sanitizar nombre del archivo
      SAFE_CAT="${CAT//\//-}"
      SAFE_CAT="${SAFE_CAT// /_}"
      TS=$(date +%Y%m%d_%H%M%S)
      LOG_FILE="$LOG_DIR/${TS}_${L}_${SAFE_CAT}.log"
      {
        echo "# ${TS} categoria='${CAT}' idioma='${L}' amount='${AMOUNT}' subcategories='${SUBCATS}' status='${STATUS}'"
        echo "$OUTPUT"
        echo "\n---\n"
      } >> "$LOG_FILE"
      echo "📝 Log: $LOG_FILE"
    fi

    # Pausa si se pidió
    if [[ "$SLEEP_S" != "0" ]]; then
      echo "⏱  Durmiendo ${SLEEP_S}s para evitar rate limits..."
      sleep "$SLEEP_S"
    fi

    # Continuar aunque una ejecución falle
  done
done

echo "✅ Proceso por lotes finalizado"


