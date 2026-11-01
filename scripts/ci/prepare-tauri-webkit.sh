#!/usr/bin/env bash
set -euo pipefail

stage_dir=
build_dir=
cache_hit=
while [ "$#" -gt 0 ]; do
  case "$1" in
    --stage-dir) stage_dir="$2"; shift 2 ;;
    --build-dir) build_dir="$2"; shift 2 ;;
    --cache-hit) cache_hit="$2"; shift 2 ;;
    *) echo "Unknown WebKit SDK option: $1" >&2; exit 64 ;;
  esac
done
if [ -z "$stage_dir" ] || [ -z "$build_dir" ] || { [ "$cache_hit" != true ] && [ "$cache_hit" != false ]; }; then
  echo 'Usage: prepare-tauri-webkit.sh --stage-dir PATH --build-dir PATH --cache-hit true|false' >&2
  exit 64
fi
repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
validator="$repo_root/scripts/pipeline/tauri/linux-webkit-runtime.mjs"
if [ "$cache_hit" = true ]; then
  # A corrupt exact-key cache is a failed build, never a silent source rebuild.
  node "$validator" --root "$stage_dir"
  exit 0
fi
if [ -e "$build_dir" ] || [ -e "$stage_dir" ]; then
  echo 'A WebKit cache miss requires fresh build and stage directories' >&2
  exit 1
fi
mapfile -t recipe < <(node "$validator" --recipe)
test "${#recipe[@]}" -eq 3
mkdir -p -- "$build_dir" "$stage_dir"
archive="$build_dir/source.tar.xz"
curl --proto '=https' --proto-redir '=https' -L --fail --show-error \
  "${recipe[1]}" -o "$archive"
printf '%s  %s\n' "${recipe[2]}" "$archive" | sha256sum --check --strict
mkdir "$build_dir/source"
tar -xJf "$archive" --strip-components=1 -C "$build_dir/source"
cmake -S "$build_dir/source" -B "$build_dir/build" -GNinja \
  -DPORT=GTK -DUSE_GTK4=OFF \
  -DCMAKE_C_COMPILER=clang-18 -DCMAKE_CXX_COMPILER=clang++-18 \
  -DCMAKE_CXX_FLAGS='--gcc-install-dir=/usr/lib/gcc/x86_64-linux-gnu/12 -stdlib=libstdc++' \
  -DCMAKE_BUILD_TYPE=Release -DCMAKE_INSTALL_PREFIX=/usr \
  -DCMAKE_INSTALL_LIBDIR=lib/x86_64-linux-gnu \
  -DCMAKE_INSTALL_LIBEXECDIR=lib/x86_64-linux-gnu \
  -DUSE_LIBBACKTRACE=OFF -DUSE_AVIF=OFF -DUSE_JPEGXL=OFF \
  -DENABLE_SPEECH_SYNTHESIS=OFF -DENABLE_DOCUMENTATION=OFF \
  -DENABLE_BUBBLEWRAP_SANDBOX=ON -DUSE_SYSPROF_CAPTURE=ON \
  -DENABLE_MINIBROWSER=ON
cmake --build "$build_dir/build" --parallel "${CMAKE_BUILD_PARALLEL_LEVEL:-$(nproc)}"
DESTDIR="$stage_dir" cmake --install "$build_dir/build"
node "$validator" --root "$stage_dir"
# Only this invocation's fresh workspace is removed; retain the validated cache tree.
rm -rf -- "$build_dir"
