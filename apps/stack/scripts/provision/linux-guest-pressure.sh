#!/usr/bin/env bash
set -euo pipefail

SWAP_GIB="${HAPPIER_SWAP_GIB:-0}"
ZSWAP="${HAPPIER_ZSWAP:-0}"
RESERVE_GIB="${HAPPIER_SWAP_FREE_RESERVE_GIB:-32}"
SWAP_FILE="/var/lib/happier/swapfile"
ZSWAP_UNIT="happier-zswap.service"

case "${SWAP_GIB}" in 0|64|128) ;; *) echo "unsupported swap size: ${SWAP_GIB}" >&2; exit 2 ;; esac
case "${ZSWAP}" in 0|1) ;; *) echo "unsupported zswap value: ${ZSWAP}" >&2; exit 2 ;; esac
case "${RESERVE_GIB}" in 32) ;; *) echo "unsupported free-space reserve: ${RESERVE_GIB}" >&2; exit 2 ;; esac

as_root() {
  if [[ "$(id -u)" == "0" ]]; then "$@"; else sudo "$@"; fi
}

swap_is_active() {
  swapon --show=NAME --noheadings 2>/dev/null | sed 's/^[[:space:]]*//;s/[[:space:]]*$//' | grep -Fxq "${SWAP_FILE}"
}

rewrite_fstab() {
  local include="$1"
  local temporary
  temporary="$(mktemp)"
  awk -v path="${SWAP_FILE}" '$1 != path { print }' /etc/fstab > "${temporary}"
  if [[ "${include}" == "1" ]]; then
    printf '%s none swap sw 0 0\n' "${SWAP_FILE}" >> "${temporary}"
  fi
  as_root install -o root -g root -m 0644 "${temporary}" /etc/fstab
  rm -f "${temporary}"
}

configure_zswap() {
  local unit_path="/etc/systemd/system/${ZSWAP_UNIT}"
  if [[ "${ZSWAP}" == "1" ]]; then
    if [[ ! -e /sys/module/zswap/parameters/enabled ]]; then
      echo "zswap is unavailable in this guest kernel" >&2
      exit 3
    fi
    local temporary
    temporary="$(mktemp)"
    cat > "${temporary}" <<'EOF'
[Unit]
Description=Enable zswap for Happier pressure survival
DefaultDependencies=no
Before=swap.target
ConditionPathExists=/sys/module/zswap/parameters/enabled

[Service]
Type=oneshot
ExecStart=/bin/sh -c 'printf Y > /sys/module/zswap/parameters/enabled'
RemainAfterExit=yes

[Install]
WantedBy=sysinit.target
EOF
    as_root install -o root -g root -m 0644 "${temporary}" "${unit_path}"
    rm -f "${temporary}"
    printf Y | as_root tee /sys/module/zswap/parameters/enabled >/dev/null
    as_root systemctl daemon-reload
    as_root systemctl enable "${ZSWAP_UNIT}" >/dev/null
  else
    if [[ -e /sys/module/zswap/parameters/enabled ]]; then
      printf N | as_root tee /sys/module/zswap/parameters/enabled >/dev/null
    fi
    as_root systemctl disable "${ZSWAP_UNIT}" >/dev/null 2>&1 || true
    as_root rm -f "${unit_path}"
    as_root systemctl daemon-reload
  fi
}

desired_bytes="$((SWAP_GIB * 1024 * 1024 * 1024))"
reserve_bytes="$((RESERVE_GIB * 1024 * 1024 * 1024))"
current_bytes="$(stat -c %s "${SWAP_FILE}" 2>/dev/null || printf 0)"
if (( desired_bytes > current_bytes )); then
  available_bytes="$(df --output=avail -B1 / | tail -n 1 | tr -d '[:space:]')"
  additional_bytes="$((desired_bytes - current_bytes))"
  if (( available_bytes < additional_bytes + reserve_bytes )); then
    echo "insufficient guest disk headroom for ${SWAP_GIB} GiB swap plus ${RESERVE_GIB} GiB reserve" >&2
    exit 4
  fi
fi

configure_zswap

if [[ "${SWAP_GIB}" == "0" ]]; then
  if swap_is_active; then as_root swapoff "${SWAP_FILE}"; fi
  rewrite_fstab 0
  as_root rm -f "${SWAP_FILE}"
else
  if [[ "${current_bytes}" != "${desired_bytes}" ]]; then
    if swap_is_active; then as_root swapoff "${SWAP_FILE}"; fi
    as_root install -d -o root -g root -m 0755 "$(dirname "${SWAP_FILE}")"
    as_root dd if=/dev/zero of="${SWAP_FILE}" bs=1M count="$((SWAP_GIB * 1024))" status=none
    as_root chmod 0600 "${SWAP_FILE}"
    as_root mkswap "${SWAP_FILE}" >/dev/null
  fi
  rewrite_fstab 1
  if ! swap_is_active; then as_root swapon "${SWAP_FILE}"; fi
fi

active=false
if swap_is_active; then active=true; fi
zswap_enabled=false
if [[ -e /sys/module/zswap/parameters/enabled ]] && [[ "$(cat /sys/module/zswap/parameters/enabled)" == "Y" ]]; then
  zswap_enabled=true
fi
printf '{"swapGiB":%s,"zswap":%s,"active":%s}\n' "${SWAP_GIB}" "${zswap_enabled}" "${active}"
