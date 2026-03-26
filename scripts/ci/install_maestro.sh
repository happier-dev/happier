#!/usr/bin/env bash
set -euo pipefail

# Installs a pinned Maestro CLI version in CI (and can be used locally).
#
# Design goals:
# - avoid `curl | bash` in CI
# - allow version pinning via MAESTRO_VERSION
# - install into a deterministic bin dir
#
# References:
# - Maestro releases follow the tag pattern `cli-<version>` and publish `maestro.zip`.

MAESTRO_VERSION="${MAESTRO_VERSION:-2.3.0}"
INSTALL_DIR="${INSTALL_DIR:-$HOME/.local/bin}"
MAESTRO_ZIP_URL_OVERRIDE="${MAESTRO_ZIP_URL_OVERRIDE:-}"
MAESTRO_ZIP_SHA256="${MAESTRO_ZIP_SHA256:-}"
MAESTRO_SKIP_SHA256="${MAESTRO_SKIP_SHA256:-}"

mkdir -p "${INSTALL_DIR}"

OS="$(uname -s | tr '[:upper:]' '[:lower:]')"
ARCH="$(uname -m)"

case "${OS}" in
  linux|darwin) ;;
  *)
    echo "Unsupported OS for Maestro install: ${OS}" >&2
    exit 1
    ;;
esac

case "${ARCH}" in
  x86_64|amd64|arm64|aarch64) ;;
  *)
    echo "Unsupported arch for Maestro install: ${ARCH}" >&2
    exit 1
    ;;
esac

TMP_DIR="$(mktemp -d)"
cleanup() { rm -rf "${TMP_DIR}"; }
trap cleanup EXIT

ZIP_URL="${MAESTRO_ZIP_URL_OVERRIDE:-https://github.com/mobile-dev-inc/maestro/releases/download/cli-${MAESTRO_VERSION}/maestro.zip}"
ZIP_PATH="${TMP_DIR}/maestro.zip"

echo "[ci] downloading Maestro ${MAESTRO_VERSION} from ${ZIP_URL}" >&2
curl -fsSL "${ZIP_URL}" -o "${ZIP_PATH}"

if [ -z "${MAESTRO_ZIP_SHA256}" ] && [ -z "${MAESTRO_SKIP_SHA256}" ] && [ -z "${MAESTRO_ZIP_URL_OVERRIDE}" ]; then
  case "${MAESTRO_VERSION}" in
    2.3.0)
      MAESTRO_ZIP_SHA256="aaf524c6bcd456013855b1337464f964d9a65e2fb88861affea9b4c014644e50"
      ;;
  esac
fi

if [ -n "${MAESTRO_ZIP_SHA256}" ] && [ -z "${MAESTRO_SKIP_SHA256}" ]; then
  echo "[ci] verifying sha256 for ${ZIP_PATH}" >&2
  if command -v sha256sum >/dev/null 2>&1; then
    ACTUAL_SHA="$(sha256sum "${ZIP_PATH}" | awk '{print $1}')"
  elif command -v shasum >/dev/null 2>&1; then
    ACTUAL_SHA="$(shasum -a 256 "${ZIP_PATH}" | awk '{print $1}')"
  else
    echo "Missing sha256 tool (sha256sum/shasum) for Maestro install verification" >&2
    exit 1
  fi

  if [ "${ACTUAL_SHA}" != "${MAESTRO_ZIP_SHA256}" ]; then
    echo "Maestro zip sha256 mismatch: expected ${MAESTRO_ZIP_SHA256}, got ${ACTUAL_SHA}" >&2
    exit 1
  fi
fi

unzip -q "${ZIP_PATH}" -d "${TMP_DIR}"

MAESTRO_EXTRACTED_BIN=""
if [ -f "${TMP_DIR}/bin/maestro" ]; then
  MAESTRO_EXTRACTED_BIN="${TMP_DIR}/bin/maestro"
elif [ -f "${TMP_DIR}/maestro/bin/maestro" ]; then
  MAESTRO_EXTRACTED_BIN="${TMP_DIR}/maestro/bin/maestro"
else
  MAESTRO_EXTRACTED_BIN="$(find "${TMP_DIR}" -maxdepth 4 -type f -name maestro -print -quit 2>/dev/null || true)"
fi

if [ -z "${MAESTRO_EXTRACTED_BIN}" ] || [ ! -f "${MAESTRO_EXTRACTED_BIN}" ]; then
  echo "Expected Maestro binary inside extracted zip (zip layout changed?)" >&2
  find "${TMP_DIR}" -maxdepth 4 -type f -print >&2 || true
  exit 1
fi

install -m 0755 "${MAESTRO_EXTRACTED_BIN}" "${INSTALL_DIR}/maestro"

echo "[ci] installed Maestro to ${INSTALL_DIR}/maestro" >&2
"${INSTALL_DIR}/maestro" --version
