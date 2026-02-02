#!/bin/sh
set -eu

provider="$(printf "%s" "${HAPPIER_DB_PROVIDER:-${HAPPY_DB_PROVIDER:-postgres}}" | tr '[:upper:]' '[:lower:]' | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"
schema="prisma/schema.prisma"
case "$provider" in
  ""|"postgres"|"postgresql") schema="prisma/schema.prisma" ;;
  "mysql") schema="prisma/mysql/schema.prisma" ;;
  *)
    echo "[entrypoint] Unsupported HAPPY_DB_PROVIDER/HAPPIER_DB_PROVIDER: $provider"
    exit 1
    ;;
esac

if [ "${RUN_MIGRATIONS:-1}" != "0" ]; then
  attempts="${MIGRATIONS_MAX_ATTEMPTS:-30}"
  delay="${MIGRATIONS_RETRY_DELAY_SECONDS:-2}"

  i=1
  while [ "$i" -le "$attempts" ]; do
    echo "[entrypoint] Running prisma migrate deploy (${provider}, ${schema}) (attempt $i/$attempts)..."

    out="$(yarn --cwd apps/server prisma migrate deploy --schema "$schema" 2>&1)" && {
      printf "%s\n" "$out"
      break
    }

    status=$?
    printf "%s\n" "$out"

    if [ "$provider" = "postgres" ] || [ "$provider" = "postgresql" ]; then
      if echo "$out" | grep -q "Timed out trying to acquire a postgres advisory lock"; then
      echo "[entrypoint] Advisory lock timeout; retrying in ${delay}s..."
      sleep "$delay"
      i=$((i + 1))
      continue
      fi
    fi

    echo "[entrypoint] Migration failed."
    exit "$status"
  done

  if [ "$i" -gt "$attempts" ]; then
    echo "[entrypoint] Migrations failed after ${attempts} attempts."
    exit 1
  fi
fi

exec yarn --cwd apps/server start
