#!/bin/sh
set -eu

if [ "${RUN_MIGRATIONS:-1}" != "0" ]; then
  attempts="${MIGRATIONS_MAX_ATTEMPTS:-30}"
  delay="${MIGRATIONS_RETRY_DELAY_SECONDS:-2}"

  i=1
  while [ "$i" -le "$attempts" ]; do
    echo "[entrypoint] Running prisma migrate deploy (attempt $i/$attempts)..."

    out="$(yarn --cwd apps/server prisma migrate deploy 2>&1)" && {
      printf "%s\n" "$out"
      break
    }

    status=$?
    printf "%s\n" "$out"

    if echo "$out" | grep -q "Timed out trying to acquire a postgres advisory lock"; then
      echo "[entrypoint] Advisory lock timeout; retrying in ${delay}s..."
      sleep "$delay"
      i=$((i + 1))
      continue
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

