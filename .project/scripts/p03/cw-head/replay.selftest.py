"""Exercise the real shell writer, private Git index, gate, flock and CAS."""
import os
from pathlib import Path
import subprocess
import shutil
import tempfile

WRAPPER = Path(__file__).resolve().with_name("commit-partial.sh")


def run_case(kind):
    with tempfile.TemporaryDirectory(prefix="p03-writer-fixture-") as temp:
        repo = Path(temp)
        env = {**os.environ, "P03_GATE_CACHE": str(repo / "cache"), "P03_COMMIT_KICK": "true"}

        fixture_bin = repo / "bin"
        fixture_bin.mkdir()
        index_path_log = repo / "indexes"
        git_shim = fixture_bin / "git"
        git_shim.write_text(
            '#!/bin/sh\n'
            '[ -z "${GIT_INDEX_FILE:-}" ] || printf "%s\\n" "$GIT_INDEX_FILE" >> "$FIXTURE_INDEX_LOG"\n'
            'exec "$FIXTURE_GIT" "$@"\n'
        )
        git_shim.chmod(0o700)
        env.update(PATH=f"{fixture_bin}:{env['PATH']}", FIXTURE_GIT=shutil.which("git"),
                   FIXTURE_INDEX_LOG=str(index_path_log))

        def git(*args, **kwargs):
            return subprocess.run(["git", *args], cwd=repo, env=env, text=True,
                                  capture_output=True, check=True, **kwargs).stdout

        git("init", "-qb", "main")
        git("config", "user.name", "Fixture")
        git("config", "user.email", "fixture@example.invalid")
        tracked = repo / "packet.txt"
        tracked.write_text("base\nkeep\nmore\nlast\n")
        git("add", "--", "packet.txt")
        git("commit", "-qm", "fixture base")
        base = git("rev-parse", "HEAD").strip()
        tracked.write_text("landed\nkeep\nmore\nlast\n")
        patch = repo / "own.patch"
        patch.write_text(git("diff", "--binary", "--full-index", "HEAD", "--", "packet.txt"))
        msg = repo / "message"
        msg.write_text("fix: fixture packet\n")
        if kind == "foreign":
            tracked.write_text("base\nkeep\nmore\nforeign\n")
        if kind == "materialized":
            tracked.write_text("landed\nkeep\nmore\nforeign\n")
        if kind == "dry":
            env["DRY"] = "1"
        result = subprocess.run(["bash", str(WRAPPER), str(msg), "-", str(patch)],
                                cwd=repo, env=env, capture_output=True, text=True)
        details = result.stdout + result.stderr
        assert result.returncode == 0, details
        assert details.count("commit gate: lock held ") == 1, details
        index_paths = [Path(line) for line in index_path_log.read_text().splitlines()]
        assert index_paths and all(path.is_relative_to(repo / "cache") for path in index_paths), index_paths
        assert not list((repo / "cache").glob("packet.*")), details
        if kind == "dry":
            assert "DRY candidate " in details and git("rev-parse", "HEAD").strip() == base, details
        else:
            assert git("rev-parse", "HEAD^").strip() == base, details
            assert git("show", "HEAD:packet.txt") == "landed\nkeep\nmore\nlast\n", details
            assert ("HSTACK_COMMITTED_CHECKOUT_DRIFT packet.txt" in details) == (kind == "foreign"), details
        print(f"PASS {kind}")


for case in ("foreign", "materialized", "dry"):
    run_case(case)
