#!/usr/bin/env bash
set -euo pipefail

deploy_environment=""
release_sha=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --environment) deploy_environment="${2:-}"; shift 2 ;;
    --release-sha) release_sha="${2:-}"; shift 2 ;;
    *) echo "Unknown argument: $1" >&2; exit 2 ;;
  esac
done

case "$deploy_environment" in
  preview|production) ;;
  *) echo "--environment must be preview or production" >&2; exit 2 ;;
esac
if [[ ! "$release_sha" =~ ^[0-9a-f]{40}$ ]]; then
  echo "--release-sha must be a lowercase full commit SHA" >&2
  exit 2
fi

if [ "$deploy_environment" = production ]; then
  exec npx --yes wrangler@4 deploy --message "promote $release_sha"
fi

failure_log="$(mktemp)"
trap 'rm -f "$failure_log"' EXIT
set +e
npx --yes wrangler@4 versions upload --preview-alias preview --message "promote $release_sha" 2>&1 | tee "$failure_log"
upload_status=${PIPESTATUS[0]}
set -e
if [ "$upload_status" -eq 0 ]; then
  exit 0
fi
if ! grep -Fq 'You cannot upload a new version of a Worker that does not yet exist.' "$failure_log"; then
  exit "$upload_status"
fi

echo "Cloudflare Worker does not exist; creating its route-free initial deployment before publishing the preview alias."
npx --yes wrangler@4 deploy --message "bootstrap $release_sha"
npx --yes wrangler@4 versions upload --preview-alias preview --message "promote $release_sha"
