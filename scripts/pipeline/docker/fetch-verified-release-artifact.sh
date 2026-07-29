#!/bin/sh
set -eu

fail() {
  echo "[docker-artifact] $*" >&2
  exit 1
}

base_url="https://github.com/happier-dev/happier/releases/download"
release_tag=""
product=""
version=""
artifact_os=""
artifact_arch=""
dest=""
pubkey=""

while [ "$#" -gt 0 ]; do
  case "$1" in
    --base-url)
      base_url="${2:-}"
      shift 2
      ;;
    --release-tag)
      release_tag="${2:-}"
      shift 2
      ;;
    --product)
      product="${2:-}"
      shift 2
      ;;
    --version)
      version="${2:-}"
      shift 2
      ;;
    --os)
      artifact_os="${2:-}"
      shift 2
      ;;
    --arch)
      artifact_arch="${2:-}"
      shift 2
      ;;
    --dest)
      dest="${2:-}"
      shift 2
      ;;
    --pubkey)
      pubkey="${2:-}"
      shift 2
      ;;
    *)
      fail "unknown argument: $1"
      ;;
  esac
done

[ -n "$base_url" ] || fail "--base-url is required"
[ -n "$release_tag" ] || fail "--release-tag is required"
[ -n "$product" ] || fail "--product is required"
[ -n "$version" ] || fail "--version is required"
[ -n "$artifact_os" ] || fail "--os is required"
[ -n "$artifact_arch" ] || fail "--arch is required"
[ -n "$dest" ] || fail "--dest is required"
[ -n "$pubkey" ] || fail "--pubkey is required"
[ -f "$pubkey" ] || fail "public key not found: $pubkey"

command -v curl >/dev/null 2>&1 || fail "curl is required"
command -v tar >/dev/null 2>&1 || fail "tar is required"
command -v minisign >/dev/null 2>&1 || fail "minisign is required"
if command -v sha256sum >/dev/null 2>&1; then
  checksum_tool="sha256sum"
elif command -v shasum >/dev/null 2>&1; then
  checksum_tool="shasum"
else
  fail "sha256sum or shasum is required"
fi

archive_name="${product}-v${version}-${artifact_os}-${artifact_arch}.tar.gz"
checksums_name="checksums-${product}-v${version}.txt"

work_dir="$(mktemp -d 2>/dev/null || mktemp -d -t happier-docker-artifact)"
cleanup() {
  rm -rf "$work_dir"
}
trap cleanup EXIT INT TERM

download_asset() {
  name="$1"
  url="${base_url%/}/${release_tag}/${name}"
  curl -fsSL --retry 3 --retry-delay 2 "$url" -o "${work_dir}/${name}"
}

download_asset "$archive_name"
download_asset "$checksums_name"
download_asset "${checksums_name}.minisig"

checksums_path="${work_dir}/${checksums_name}"
archive_path="${work_dir}/${archive_name}"

minisign -Vm "$checksums_path" -x "${checksums_path}.minisig" -p "$pubkey"

expected_sha="$(
  awk -v name="$archive_name" '
    $2 == name { print $1; found = 1; exit }
    END { if (!found) exit 42 }
  ' "$checksums_path"
)" || fail "checksum entry not found for ${archive_name}"

if [ "$checksum_tool" = "sha256sum" ]; then
  actual_sha="$(sha256sum "$archive_path" | awk '{ print $1 }')"
else
  actual_sha="$(shasum -a 256 "$archive_path" | awk '{ print $1 }')"
fi

[ "$actual_sha" = "$expected_sha" ] || fail "checksum mismatch for ${archive_name}: expected ${expected_sha}, got ${actual_sha}"

rm -rf "$dest"
mkdir -p "$dest"
tar_extra_args=""
tar_help="$(tar --help 2>&1 || true)"
if printf '%s\n' "$tar_help" | grep -q 'bsdtar'; then
  tar_extra_args="${tar_extra_args} --no-mac-metadata --no-xattrs"
elif printf '%s\n' "$tar_help" | grep -q -- '--no-mac-metadata'; then
  tar_extra_args="${tar_extra_args} --no-mac-metadata"
  if printf '%s\n' "$tar_help" | grep -q -- '--no-xattrs'; then
    tar_extra_args="${tar_extra_args} --no-xattrs"
  fi
fi
# shellcheck disable=SC2086 # tar_extra_args contains feature-detected flag words.
COPYFILE_DISABLE=1 tar -xzf "$archive_path" -C "$dest" --strip-components=1 --exclude='._*' --exclude='*/._*' $tar_extra_args
find "$dest" -type f -name '._*' -exec rm -f {} +
