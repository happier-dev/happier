#!/usr/bin/env python3
from __future__ import annotations

import json
import sys
from pathlib import Path


def decode_jwt_subject(token: str) -> str:
    raw = str(token or "").strip()
    if not raw:
        return ""
    parts = raw.split(".")
    if len(parts) < 2:
        return ""
    payload = parts[1]
    payload += "=" * (-len(payload) % 4)
    try:
        import base64

        text = base64.urlsafe_b64decode(payload.encode("ascii")).decode("utf-8")
        parsed = json.loads(text)
        if isinstance(parsed, dict):
            subject = parsed.get("sub")
            return subject.strip() if isinstance(subject, str) else ""
    except Exception:
        return ""
    return ""


def main() -> int:
    if len(sys.argv) < 5:
        raise SystemExit(
            "usage: rewriteGuestSettingsForVmMachineId.py <settings-path> <active-server-id> <vm-machine-id> <server-url> [access-key-path]"
        )

    settings_path = Path(sys.argv[1])
    active_server_id = sys.argv[2].strip()
    vm_machine_id = sys.argv[3].strip()
    server_url = sys.argv[4].strip()
    access_key_path = Path(sys.argv[5]) if len(sys.argv) > 5 and sys.argv[5].strip() else None

    if not active_server_id or not vm_machine_id:
        raise SystemExit(0)

    account_id = ""
    if access_key_path is not None and access_key_path.exists():
        try:
            raw = access_key_path.read_text(encoding="utf-8").strip()
            if raw:
                try:
                    parsed = json.loads(raw)
                    if isinstance(parsed, dict) and isinstance(parsed.get("token"), str) and parsed["token"].strip():
                        raw = parsed["token"].strip()
                except Exception:
                    pass
                account_id = decode_jwt_subject(raw)
        except Exception:
            account_id = ""

    payload = {
        "schemaVersion": 6,
        "onboardingCompleted": True,
        "activeServerId": active_server_id,
        "servers": {
            active_server_id: {
                "id": active_server_id,
                "name": active_server_id,
                "serverUrl": server_url,
                "webappUrl": server_url,
                "createdAt": 0,
                "updatedAt": 0,
                "lastUsedAt": 0,
            },
        },
        "machineIdByServerId": {
            active_server_id: vm_machine_id,
        },
        "machineIdByServerIdByAccountId": {
            active_server_id: {
                account_id: vm_machine_id,
            } if account_id else {},
        },
        "lastTokenSubByServerId": {
            active_server_id: account_id,
        } if account_id else {},
        "machineIdConfirmedByServerByServerId": {
            active_server_id: True,
        },
    }

    settings_path.parent.mkdir(parents=True, exist_ok=True)
    settings_path.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
