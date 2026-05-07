#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CRATE_DIR="${ROOT_DIR}/rust/happier-ssh-native"
OUT_DIR="${ROOT_DIR}/android/build/generated/rustJniLibs"
NDK_HOME="${ANDROID_NDK_HOME:-${ANDROID_NDK_ROOT:-${ANDROID_HOME:-${ANDROID_SDK_ROOT:-}}/ndk/27.1.12297006}}"
case "$(uname -s)" in
  Darwin) HOST_TAG="darwin-x86_64" ;;
  Linux) HOST_TAG="linux-x86_64" ;;
  *) echo "Unsupported Android NDK build host: $(uname -s)" >&2; exit 1 ;;
esac
TOOLCHAIN="${NDK_HOME}/toolchains/llvm/prebuilt/${HOST_TAG}/bin"
API_LEVEL="${HAPPIER_ANDROID_NATIVE_API_LEVEL:-35}"

build_target() {
  local target="$1"
  local abi="$2"
  local clang_prefix="$3"
  local cargo_target
  cargo_target="$(printf '%s' "${target}" | tr '[:lower:]-' '[:upper:]_')"
  export "CC_${target//-/_}=${TOOLCHAIN}/${clang_prefix}${API_LEVEL}-clang"
  export "AR_${target//-/_}=${TOOLCHAIN}/llvm-ar"
  export "CARGO_TARGET_${cargo_target}_LINKER=${TOOLCHAIN}/${clang_prefix}${API_LEVEL}-clang"
  cargo build --manifest-path "${CRATE_DIR}/Cargo.toml" --release --target "${target}"
  mkdir -p "${OUT_DIR}/${abi}"
  cp "${CRATE_DIR}/target/${target}/release/libhappier_ssh_native.so" "${OUT_DIR}/${abi}/libhappier_ssh_native.so"
}

build_target "aarch64-linux-android" "arm64-v8a" "aarch64-linux-android"
build_target "x86_64-linux-android" "x86_64" "x86_64-linux-android"
