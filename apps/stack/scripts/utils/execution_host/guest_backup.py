#!/usr/bin/env python3
"""Create a consistent, portable backup for one Stack-owned SQLite deployment.

This helper is streamed to the guest by the Mac `dev-vm` controller. It must not
depend on a checked-out repository or a guest-side hstack installation.
"""

from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import sqlite3
import stat
import sys
import tarfile
import tempfile


ARCHIVE_FORMAT = 2
STACK_NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$")
ARCHIVE_ROOT = "stack/server-light"
DATABASE_ARCHIVE_PATH = f"{ARCHIVE_ROOT}/happier-server-light.sqlite"
SECRET_ARCHIVE_PATH = f"{ARCHIVE_ROOT}/handy-master-secret.txt"


def read_env(path: Path) -> dict[str, str]:
    values: dict[str, str] = {}
    if not path.is_file():
        return values
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("export "):
            line = line[7:].lstrip()
        key, separator, value = line.partition("=")
        if not separator or not re.match(r"^[A-Za-z_][A-Za-z0-9_]*$", key):
            continue
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in ("'", '"'):
            value = value[1:-1]
        values[key] = value
    return values


def path_from_env(values: dict[str, str], names: tuple[str, ...], fallback: Path) -> Path:
    for name in names:
        raw = values.get(name, "").strip()
        if raw:
            path = Path(raw).expanduser()
            return path if path.is_absolute() else fallback / path
    return fallback


def file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        while True:
            chunk = source.read(1024 * 1024)
            if not chunk:
                return digest.hexdigest()
            digest.update(chunk)


def archive_entry(path: Path, archive_name: str) -> dict[str, object]:
    metadata = path.lstat()
    mode = stat.S_IMODE(metadata.st_mode)
    if stat.S_ISREG(metadata.st_mode):
        return {
            "path": archive_name,
            "kind": "file",
            "bytes": metadata.st_size,
            "sha256": file_sha256(path),
            "mode": mode,
        }
    if stat.S_ISDIR(metadata.st_mode):
        return {"path": archive_name, "kind": "directory", "mode": mode}
    raise RuntimeError(f"backup source is not a regular file or directory: {archive_name}")


def archive_tree_entries(path: Path, archive_name: str) -> list[dict[str, object]]:
    if not path.exists() and not path.is_symlink():
        return []
    entry = archive_entry(path, archive_name)
    if entry["kind"] != "directory":
        return [entry]
    entries = [entry]
    for child in sorted(path.iterdir(), key=lambda value: value.name):
        entries.extend(archive_tree_entries(child, f"{archive_name}/{child.name}"))
    return entries


def add_archive_entry(bundle: tarfile.TarFile, path: Path, entry: dict[str, object]) -> None:
    info = bundle.gettarinfo(str(path), arcname=str(entry["path"]))
    if entry["kind"] == "directory":
        bundle.addfile(info)
        return
    with path.open("rb") as source:
        bundle.addfile(info, source)


def archive_entry_bytes(entry: dict[str, object]) -> int:
    return int(entry.get("bytes", 0)) if entry.get("kind") == "file" else 0


def archive_entry_tar_bytes(entry: dict[str, object]) -> int:
    size = archive_entry_bytes(entry)
    return ((size + 511) // 512) * 512


def archive_max_bytes(tar_bytes: int) -> int:
    # zlib's stored-block worst case plus gzip framing. The archive can contain
    # already-compressed uploads, so capacity cannot rely on compression.
    return tar_bytes + (tar_bytes >> 12) + (tar_bytes >> 14) + (tar_bytes >> 25) + 64


def build_backup_plan(stack_name: str) -> tuple[dict[str, object], Path, Path, Path, list[dict[str, object]]]:
    home = Path.home()
    storage_root = Path(os.environ.get("HAPPIER_STACK_STORAGE_DIR", home / ".happier" / "stacks")).expanduser()
    stack_dir = storage_root / stack_name
    env_path = stack_dir / "env"
    if not stack_dir.is_dir() or not env_path.is_file():
        raise RuntimeError("the requested Stack storage is missing")

    values = read_env(env_path)
    provider = values.get("HAPPIER_DB_PROVIDER", values.get("HAPPY_DB_PROVIDER", "sqlite")).strip().lower() or "sqlite"
    if provider != "sqlite":
        raise RuntimeError("dev-vm backup currently supports Stack SQLite storage only")
    data_dir = path_from_env(
        values,
        ("HAPPIER_SERVER_LIGHT_DATA_DIR", "HAPPY_SERVER_LIGHT_DATA_DIR"),
        stack_dir / "server-light",
    )
    files_dir = path_from_env(
        values,
        ("HAPPIER_SERVER_LIGHT_FILES_DIR", "HAPPY_SERVER_LIGHT_FILES_DIR"),
        data_dir / "files",
    )
    database_path = data_dir / "happier-server-light.sqlite"
    secret_path = data_dir / "handy-master-secret.txt"
    if not database_path.is_file() or database_path.is_symlink():
        raise RuntimeError("the Stack SQLite database is missing")
    if not secret_path.is_file() or secret_path.is_symlink():
        raise RuntimeError("the Stack handy master secret is missing")

    source_entries = [
        archive_entry(secret_path, "stack/server-light/handy-master-secret.txt"),
        *archive_tree_entries(files_dir, "stack/server-light/files"),
    ]
    source_bytes = sum(archive_entry_bytes(entry) for entry in source_entries)
    tar_data_bytes = sum(archive_entry_tar_bytes(entry) for entry in source_entries)
    database_bytes = database_path.stat().st_size
    snapshot_tar_bytes = ((database_bytes + 511) // 512) * 512
    entry_count = len(source_entries) + 2  # SQLite snapshot plus manifest.
    # Account for the checksum manifest itself as well as a conservative amount
    # of ustar/PAX metadata for each entry and long name.
    manifest_bytes = 1024 + sum(len(str(entry["path"])) + 512 for entry in source_entries) + 1024
    manifest_tar_bytes = ((manifest_bytes + 511) // 512) * 512
    tar_bytes = tar_data_bytes + snapshot_tar_bytes + manifest_tar_bytes + entry_count * 16 * 512 + 1024
    max_archive_bytes = archive_max_bytes(tar_bytes)
    required_free_bytes = database_bytes + max_archive_bytes
    temp_dir = Path(tempfile.gettempdir())
    available_free_bytes = shutil.disk_usage(temp_dir).free
    plan: dict[str, object] = {
        "stackName": stack_name,
        "database": {"provider": "sqlite", "integrity": "pending", "foreignKeys": "pending"},
        "databaseBytes": database_bytes,
        "treeBytes": source_bytes,
        "archiveMaxBytes": max_archive_bytes,
        "requiredFreeBytes": required_free_bytes,
    }
    if available_free_bytes < required_free_bytes:
        raise RuntimeError(
            "insufficient free space for SQLite snapshot and archive: "
            f"need {required_free_bytes} bytes, found {available_free_bytes} bytes"
        )
    return plan, database_path, secret_path, files_dir, source_entries


def require_safe_archive_path(value: object) -> str:
    path = str(value or "")
    if not path or path.startswith("/") or "\\" in path:
        raise RuntimeError("backup manifest has an unsafe archive path")
    parts = path.split("/")
    if any(not part or part in (".", "..") for part in parts):
        raise RuntimeError("backup manifest has an unsafe archive path")
    return path


def require_sha256(value: object, label: str) -> str:
    digest = str(value or "")
    if not re.fullmatch(r"[0-9a-f]{64}", digest):
        raise RuntimeError(f"backup manifest has an invalid {label} checksum")
    return digest


def require_mode(value: object, label: str) -> int:
    if not isinstance(value, int) or isinstance(value, bool) or value < 0 or value > 0o777:
        raise RuntimeError(f"backup manifest has an invalid {label} mode")
    return value


def require_size(value: object, label: str) -> int:
    if not isinstance(value, int) or isinstance(value, bool) or value < 0:
        raise RuntimeError(f"backup manifest has an invalid {label} size")
    return value


def validated_manifest_entry(value: object) -> dict[str, object]:
    if not isinstance(value, dict):
        raise RuntimeError("backup manifest has an invalid entry")
    path = require_safe_archive_path(value.get("path"))
    if not path.startswith(f"{ARCHIVE_ROOT}/"):
        raise RuntimeError("backup manifest contains a non-server-state entry")
    kind = value.get("kind")
    if kind not in ("file", "directory"):
        raise RuntimeError("backup manifest has an invalid entry kind")
    entry: dict[str, object] = {"path": path, "kind": kind, "mode": require_mode(value.get("mode"), "entry")}
    if kind == "file":
        entry["bytes"] = require_size(value.get("bytes"), "entry")
        entry["sha256"] = require_sha256(value.get("sha256"), "entry")
    return entry


def read_validated_manifest(bundle: tarfile.TarFile) -> tuple[dict[str, object], list[dict[str, object]]]:
    try:
        manifest_member = bundle.getmember("manifest.json")
    except KeyError as error:
        raise RuntimeError("backup archive is missing its manifest") from error
    if not manifest_member.isreg():
        raise RuntimeError("backup archive manifest is not a regular file")
    source = bundle.extractfile(manifest_member)
    if source is None:
        raise RuntimeError("backup archive manifest could not be read")
    try:
        manifest = json.loads(source.read().decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise RuntimeError("backup archive manifest is invalid") from error
    if not isinstance(manifest, dict) or manifest.get("format") != ARCHIVE_FORMAT:
        raise RuntimeError("backup archive format is unsupported")
    stack_name = manifest.get("stackName")
    if not isinstance(stack_name, str) or not STACK_NAME_RE.fullmatch(stack_name):
        raise RuntimeError("backup manifest has an invalid Stack name")
    raw_entries = manifest.get("entries")
    if not isinstance(raw_entries, list) or not raw_entries:
        raise RuntimeError("backup manifest has no server-state entries")
    entries = [validated_manifest_entry(value) for value in raw_entries]
    entries_by_path = {str(entry["path"]): entry for entry in entries}
    if len(entries_by_path) != len(entries):
        raise RuntimeError("backup manifest has duplicate entries")
    for entry in entries:
        path = str(entry["path"])
        parent = path.rsplit("/", 1)[0]
        if parent != ARCHIVE_ROOT and entries_by_path.get(parent, {}).get("kind") != "directory":
            raise RuntimeError("backup manifest is missing a parent directory entry")

    database = manifest.get("database")
    if not isinstance(database, dict) or database.get("provider") != "sqlite" or database.get("integrity") != "ok" or database.get("foreignKeys") != "ok":
        raise RuntimeError("backup manifest does not contain an integrity-checked SQLite snapshot")
    database_entry = entries_by_path.get(DATABASE_ARCHIVE_PATH)
    if database_entry is None or database_entry.get("kind") != "file":
        raise RuntimeError("backup manifest is missing the SQLite snapshot")
    for key in ("path", "bytes", "sha256", "mode"):
        if database.get(key) != database_entry.get(key):
            raise RuntimeError("backup manifest SQLite metadata does not match its snapshot")

    secret = manifest.get("secret")
    if not isinstance(secret, dict):
        raise RuntimeError("backup manifest is missing the handy master secret")
    secret_entry = entries_by_path.get(SECRET_ARCHIVE_PATH)
    if secret_entry is None or secret_entry.get("kind") != "file":
        raise RuntimeError("backup manifest is missing the handy master secret")
    for key in ("path", "bytes", "sha256", "mode"):
        if secret.get(key) != secret_entry.get(key):
            raise RuntimeError("backup manifest secret metadata does not match its file")
    return manifest, entries


def validate_archive_entries(bundle: tarfile.TarFile, entries: list[dict[str, object]]) -> None:
    archive_members: dict[str, tarfile.TarInfo] = {}
    for member in bundle.getmembers():
        name = member.name.rstrip("/")
        if not name or name in archive_members:
            raise RuntimeError("backup archive has duplicate or invalid entries")
        archive_members[name] = member
    expected_paths = {"manifest.json", *(str(entry["path"]) for entry in entries)}
    if set(archive_members) != expected_paths:
        raise RuntimeError("backup archive contains entries outside its manifest")
    for entry in entries:
        path = str(entry["path"])
        member = archive_members[path]
        if entry["kind"] == "directory":
            if not member.isdir():
                raise RuntimeError("backup archive entry kind does not match its manifest")
        elif not member.isreg():
            raise RuntimeError("backup archive entry kind does not match its manifest")
        if stat.S_IMODE(member.mode) != entry["mode"]:
            raise RuntimeError("backup archive entry mode does not match its manifest")
        if entry["kind"] != "file":
            continue
        source = bundle.extractfile(member)
        if source is None:
            raise RuntimeError("backup archive entry could not be read")
        digest = hashlib.sha256()
        size = 0
        while True:
            chunk = source.read(1024 * 1024)
            if not chunk:
                break
            size += len(chunk)
            digest.update(chunk)
        if size != entry["bytes"] or digest.hexdigest() != entry["sha256"]:
            raise RuntimeError("backup archive entry does not match its manifest checksum")


def sqlite_health(path: Path) -> None:
    connection = sqlite3.connect(f"file:{path}?mode=ro", uri=True, timeout=30)
    try:
        integrity = connection.execute("PRAGMA integrity_check").fetchone()[0]
        foreign_key_violations = connection.execute("PRAGMA foreign_key_check").fetchall()
    finally:
        connection.close()
    if integrity != "ok":
        raise RuntimeError("SQLite snapshot integrity check failed")
    if foreign_key_violations:
        raise RuntimeError("SQLite snapshot foreign-key check failed")


def inspect_archive(archive_path: Path) -> tuple[dict[str, object], list[dict[str, object]], dict[str, object]]:
    if not archive_path.is_absolute() or not archive_path.is_file() or archive_path.is_symlink():
        raise RuntimeError("backup archive must be an existing regular absolute path")
    archive_sha256 = file_sha256(archive_path)
    with tarfile.open(archive_path, "r:gz") as bundle:
        manifest, entries = read_validated_manifest(bundle)
        validate_archive_entries(bundle, entries)
        with tempfile.TemporaryDirectory(prefix="happier-dev-vm-verify-") as verified_raw:
            database_path = Path(verified_raw) / "happier-server-light.sqlite"
            database_member = bundle.getmember(DATABASE_ARCHIVE_PATH)
            source = bundle.extractfile(database_member)
            if source is None:
                raise RuntimeError("backup archive SQLite snapshot could not be read")
            with database_path.open("xb") as destination:
                shutil.copyfileobj(source, destination)
            sqlite_health(database_path)
    database = manifest["database"]
    secret = manifest["secret"]
    return manifest, entries, {
        "format": ARCHIVE_FORMAT,
        "stackName": manifest["stackName"],
        "archiveBytes": archive_path.stat().st_size,
        "archiveSha256": archive_sha256,
        "database": {"provider": "sqlite", "integrity": "ok", "foreignKeys": "ok"},
        "secret": {"path": secret["path"], "mode": secret["mode"], "sha256": secret["sha256"]},
        "entryCount": len(entries),
    }


def destination_for_entry(destination: Path, archive_path: str) -> Path:
    if not archive_path.startswith(f"{ARCHIVE_ROOT}/"):
        raise RuntimeError("backup archive contains a non-server-state entry")
    relative_path = archive_path.removeprefix(f"{ARCHIVE_ROOT}/")
    return destination.joinpath(*relative_path.split("/"))


def validate_restored_tree(destination: Path, entries: list[dict[str, object]]) -> None:
    for entry in entries:
        path = destination_for_entry(destination, str(entry["path"]))
        metadata = path.lstat()
        if entry["kind"] == "directory":
            if not stat.S_ISDIR(metadata.st_mode):
                raise RuntimeError("restored server state has the wrong directory kind")
        else:
            if not stat.S_ISREG(metadata.st_mode):
                raise RuntimeError("restored server state has the wrong file kind")
            if metadata.st_size != entry["bytes"] or file_sha256(path) != entry["sha256"]:
                raise RuntimeError("restored server state does not match its manifest checksum")
        if stat.S_IMODE(metadata.st_mode) != entry["mode"]:
            raise RuntimeError("restored server state mode does not match its manifest")
    secret_path = destination / "handy-master-secret.txt"
    if not secret_path.is_file() or secret_path.is_symlink():
        raise RuntimeError("restored server state is missing the handy master secret")
    sqlite_health(destination / "happier-server-light.sqlite")


def restore_archive(archive_path: Path, destination: Path) -> dict[str, object]:
    if not destination.is_absolute():
        raise RuntimeError("restore destination must be an absolute path")
    if destination.exists() or destination.is_symlink():
        raise RuntimeError("restore destination must be absent")
    manifest, entries, report = inspect_archive(archive_path)
    created = False
    try:
        destination.mkdir(mode=0o700)
        created = True
        with tarfile.open(archive_path, "r:gz") as bundle:
            for entry in sorted((value for value in entries if value["kind"] == "directory"), key=lambda value: str(value["path"]).count("/")):
                output = destination_for_entry(destination, str(entry["path"]))
                output.parent.mkdir(parents=True, exist_ok=True)
                output.mkdir(mode=int(entry["mode"]))
                os.chmod(output, int(entry["mode"]))
            for entry in (value for value in entries if value["kind"] == "file"):
                output = destination_for_entry(destination, str(entry["path"]))
                output.parent.mkdir(parents=True, exist_ok=True)
                member = bundle.getmember(str(entry["path"]))
                source = bundle.extractfile(member)
                if source is None:
                    raise RuntimeError("backup archive entry could not be restored")
                with output.open("xb") as target:
                    shutil.copyfileobj(source, target)
                os.chmod(output, int(entry["mode"]))
        validate_restored_tree(destination, entries)
        report["destination"] = str(destination)
        return report
    except BaseException:
        if created:
            shutil.rmtree(destination, ignore_errors=True)
        raise


def create_backup(stack_name: str) -> None:
    plan, database_path, secret_path, files_dir, source_entries = build_backup_plan(stack_name)
    archive_fd, archive_raw_path = tempfile.mkstemp(prefix="happier-dev-vm-backup-", suffix=".tar.gz")
    os.close(archive_fd)
    archive_path = Path(archive_raw_path)
    try:
        with tempfile.TemporaryDirectory(prefix="happier-dev-vm-snapshot-") as staging_raw:
            staging = Path(staging_raw)
            snapshot_path = staging / "happier-server-light.sqlite"
            source = sqlite3.connect(f"file:{database_path}?mode=ro", uri=True, timeout=30)
            snapshot = sqlite3.connect(snapshot_path)
            try:
                source.backup(snapshot)
                integrity = snapshot.execute("PRAGMA integrity_check").fetchone()[0]
                foreign_key_violations = snapshot.execute("PRAGMA foreign_key_check").fetchall()
            finally:
                snapshot.close()
                source.close()
            if integrity != "ok":
                raise RuntimeError("SQLite snapshot integrity check failed")
            if foreign_key_violations:
                raise RuntimeError("SQLite snapshot foreign-key check failed")

            snapshot_entry = archive_entry(snapshot_path, DATABASE_ARCHIVE_PATH)
            entries = [snapshot_entry, *source_entries]
            secret_entry = next(entry for entry in source_entries if entry["path"] == SECRET_ARCHIVE_PATH)
            manifest: dict[str, object] = {
                "format": ARCHIVE_FORMAT,
                "stackName": stack_name,
                "database": {
                    "provider": "sqlite",
                    "integrity": "ok",
                    "foreignKeys": "ok",
                    **snapshot_entry,
                },
                "secret": {
                    "path": secret_entry["path"],
                    "bytes": secret_entry["bytes"],
                    "sha256": secret_entry["sha256"],
                    "mode": secret_entry["mode"],
                },
                "entries": entries,
                "included": [entry["path"] for entry in entries],
            }
            manifest_path = staging / "manifest.json"
            manifest_path.write_text(json.dumps(manifest, sort_keys=True) + "\n", encoding="utf-8")
            with tarfile.open(archive_path, "w:gz", compresslevel=1, dereference=False) as bundle:
                add_archive_entry(bundle, snapshot_path, snapshot_entry)
                add_archive_entry(bundle, secret_path, secret_entry)
                for entry in source_entries:
                    if entry is secret_entry:
                        continue
                    archive_name = str(entry["path"])
                    relative_name = archive_name.removeprefix(f"{ARCHIVE_ROOT}/files")
                    source_path = files_dir if not relative_name else files_dir / relative_name.lstrip("/")
                    add_archive_entry(bundle, source_path, entry)
                bundle.add(manifest_path, arcname="manifest.json", recursive=False)
        _, _, report = inspect_archive(archive_path)
        print(json.dumps({
            "archivePath": str(archive_path),
            "archiveBytes": report["archiveBytes"],
            "archiveSha256": report["archiveSha256"],
            "stackName": stack_name,
            "database": {"provider": "sqlite", "integrity": "ok", "foreignKeys": "ok"},
            "included": [entry["path"] for entry in entries],
        }, sort_keys=True))
    except BaseException:
        archive_path.unlink(missing_ok=True)
        raise


def main() -> None:
    if len(sys.argv) < 3:
        raise RuntimeError("a backup action is required")
    action = sys.argv[1]
    if action in ("preflight", "backup"):
        if len(sys.argv) != 3 or not STACK_NAME_RE.fullmatch(sys.argv[2]):
            raise RuntimeError("a backup action and safe Stack name are required")
        if action == "preflight":
            plan, *_ = build_backup_plan(sys.argv[2])
            print(json.dumps(plan, sort_keys=True))
            return
        create_backup(sys.argv[2])
        return
    if action == "inspect" and len(sys.argv) == 3:
        _, _, report = inspect_archive(Path(sys.argv[2]))
        print(json.dumps(report, sort_keys=True))
        return
    if action == "restore" and len(sys.argv) == 4:
        report = restore_archive(Path(sys.argv[2]), Path(sys.argv[3]))
        print(json.dumps(report, sort_keys=True))
        return
    raise RuntimeError("a valid backup action and arguments are required")


if __name__ == "__main__":
    main()
