#!/bin/bash

set -euo pipefail

archive_path="${1:?usage: namespaceGhosttyWuffs.sh <libghostty.a>}"

if [[ ! -f "$archive_path" ]]; then
  echo "error: Ghostty archive not found: $archive_path" >&2
  exit 1
fi

if ! command -v lipo >/dev/null || ! command -v nmedit >/dev/null; then
  echo "error: Ghostty Wuffs isolation requires the Apple command-line tools" >&2
  exit 1
fi

work_root="$(mktemp -d "${TMPDIR:-/tmp}/happier-ghostty-wuffs.XXXXXX")"
trap 'rm -rf "$work_root"' EXIT

platform_name="${PLATFORM_NAME:-iphonesimulator}"
effective_platform_name="${EFFECTIVE_PLATFORM_NAME:-}"
case "$platform_name:$effective_platform_name" in
  iphoneos:*)
    linker_platform="ios"
    deployment_target="${IPHONEOS_DEPLOYMENT_TARGET:-15.1}"
    ;;
  iphonesimulator:*)
    linker_platform="ios-simulator"
    deployment_target="${IPHONEOS_DEPLOYMENT_TARGET:-15.1}"
    ;;
  macosx:-maccatalyst)
    linker_platform="mac-catalyst"
    deployment_target="${IPHONEOS_DEPLOYMENT_TARGET:-15.1}"
    ;;
  macosx:*)
    linker_platform="macos"
    deployment_target="${MACOSX_DEPLOYMENT_TARGET:-13.0}"
    ;;
  *)
    echo "error: unsupported Ghostty archive platform: $platform_name$effective_platform_name" >&2
    exit 1
    ;;
esac

sdk_version="${SDK_VERSION:-26.0}"
read -r -a architectures <<< "$(lipo -archs "$archive_path")"
if [[ ${#architectures[@]} -eq 0 ]]; then
  echo "error: Ghostty archive has no architectures: $archive_path" >&2
  exit 1
fi

outputs=()
for architecture in "${architectures[@]}"; do
  arch_root="$work_root/$architecture"
  mkdir -p "$arch_root"
  thin_archive="$arch_root/libghostty.a"
  if [[ ${#architectures[@]} -eq 1 ]]; then
    cp "$archive_path" "$thin_archive"
  else
    lipo "$archive_path" -thin "$architecture" -output "$thin_archive"
  fi

  if ! nm -g "$thin_archive" 2>/dev/null | grep -E ' [TDSB] _((sizeof__)?wuffs_|WUFFS_)' >/dev/null; then
    if ! ar -t "$thin_archive" | grep -x 'libghostty_zcu_wuffs_private.o' >/dev/null; then
      echo "error: Ghostty archive has neither public Wuffs symbols nor the isolation marker" >&2
      exit 1
    fi
    outputs+=("$thin_archive")
    continue
  fi

  (
    cd "$arch_root"
    ar -x libghostty.a libghostty_zcu.o wuffs-v0.4.o
    if [[ ! -f libghostty_zcu.o || ! -f wuffs-v0.4.o ]]; then
      echo "error: pinned Ghostty archive layout changed; refusing an unsafe link" >&2
      exit 1
    fi
    chmod u+rw libghostty_zcu.o wuffs-v0.4.o
    nm -g wuffs-v0.4.o \
      | grep -E ' [TDSB] _((sizeof__)?wuffs_|WUFFS_)' \
      | sed -E 's/^.* [TDSB] //' \
      | sort -u > wuffs-symbols.txt
    if [[ ! -s wuffs-symbols.txt ]]; then
      echo "error: pinned Ghostty Wuffs object exported no isolatable symbols" >&2
      exit 1
    fi

    ld -r \
      -arch "$architecture" \
      -platform_version "$linker_platform" "$deployment_target" "$sdk_version" \
      libghostty_zcu.o wuffs-v0.4.o \
      -o libghostty_zcu_wuffs_private.o
    nmedit -R wuffs-symbols.txt libghostty_zcu_wuffs_private.o
    ar -d libghostty.a libghostty_zcu.o wuffs-v0.4.o
    ar -r libghostty.a libghostty_zcu_wuffs_private.o
    ranlib libghostty.a
  )

  if nm -g "$thin_archive" 2>/dev/null | grep -E ' [TDSB] _((sizeof__)?wuffs_|WUFFS_)' >/dev/null; then
    echo "error: Ghostty Wuffs symbols remain public after isolation" >&2
    exit 1
  fi
  if ! nm -g "$thin_archive" 2>/dev/null | grep -E ' [TDSB] _ghostty_surface_new$' >/dev/null; then
    echo "error: Ghostty public surface ABI disappeared during Wuffs isolation" >&2
    exit 1
  fi
  outputs+=("$thin_archive")
done

isolated_archive="$work_root/libghostty-isolated.a"
if [[ ${#outputs[@]} -eq 1 ]]; then
  cp "${outputs[0]}" "$isolated_archive"
else
  lipo -create "${outputs[@]}" -output "$isolated_archive"
fi
chmod --reference="$archive_path" "$isolated_archive" 2>/dev/null || true
mv "$isolated_archive" "$archive_path"

echo "Ghostty Wuffs symbols isolated for: ${architectures[*]}"
