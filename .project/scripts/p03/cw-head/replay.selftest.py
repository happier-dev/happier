"""Exercise the real shell writer, private Git index, gate, flock and CAS."""
import os
from pathlib import Path
import subprocess
import tempfile

WRAPPER = Path(__file__).resolve().with_name("commit-partial.sh")


def run_case(kind):
    with tempfile.TemporaryDirectory(prefix="p03-writer-fixture-") as temp:
        repo = Path(temp)
        env = {**os.environ, "P03_GATE_CACHE": str(repo / "cache"), "P03_COMMIT_KICK": "true"}

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
        if kind == "dry":
            assert "DRY candidate " in details and git("rev-parse", "HEAD").strip() == base, details
        else:
            assert git("rev-parse", "HEAD^").strip() == base, details
            assert git("show", "HEAD:packet.txt") == "landed\nkeep\nmore\nlast\n", details
            assert ("HSTACK_COMMITTED_CHECKOUT_DRIFT packet.txt" in details) == (kind == "foreign"), details
        print(f"PASS {kind}")


for case in ("foreign", "materialized", "dry"):
    run_case(case)
