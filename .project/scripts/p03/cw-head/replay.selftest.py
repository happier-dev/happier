"""Exercise the real shell writer, private Git index, gate, flock and CAS."""
import os
from pathlib import Path
import subprocess
import shutil
import tempfile

WRAPPER = Path(__file__).resolve().with_name("commit-partial.sh")


def capture_index_paths(repo, env):
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

    return index_path_log


def assert_packet_cleanup(repo, index_path_log, details):
    index_paths = [Path(line) for line in index_path_log.read_text().splitlines()]
    assert index_paths and all(path.is_relative_to(repo / "cache") for path in index_paths), index_paths
    assert not list((repo / "cache").glob("packet.*")), details


def run_case(kind):
    with tempfile.TemporaryDirectory(prefix="p03-writer-fixture-") as temp:
        repo = Path(temp)
        env = {**os.environ, "P03_GATE_CACHE": str(repo / "cache"), "P03_COMMIT_KICK": "true"}

        index_path_log = capture_index_paths(repo, env)

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
        assert_packet_cleanup(repo, index_path_log, details)
        if kind == "dry":
            assert "DRY candidate " in details and git("rev-parse", "HEAD").strip() == base, details
        else:
            assert git("rev-parse", "HEAD^").strip() == base, details
            assert git("show", "HEAD:packet.txt") == "landed\nkeep\nmore\nlast\n", details
            assert ("HSTACK_COMMITTED_CHECKOUT_DRIFT packet.txt" in details) == (kind == "foreign"), details
        print(f"PASS {kind}")


for case in ("foreign", "materialized", "dry"):
    run_case(case)

def test_old_action_packet():
    with tempfile.TemporaryDirectory(prefix="p03-action-writer-") as temp:
        repo = Path(temp)
        git = lambda *args: subprocess.check_output(["git", *args], cwd=repo, text=True)
        git("init", "-qb", "main")
        git("config", "user.name", "Fixture")
        git("config", "user.email", "fixture@example.invalid")
        asset = "apps/cli/assets/bundled-plugin-manifests/declarations/test.summary.json"
        generator = repo / "apps/cli/scripts/build-owned/generateBundledPluginEntries.ts"
        generator.parent.mkdir(parents=True)
        (repo / asset).parent.mkdir(parents=True)
        generator.write_text(rf"""
import {{ mkdirSync, readFileSync, writeFileSync }} from 'node:fs';
import {{ dirname, join }} from 'node:path';
const out = join(process.argv.at(-1), {asset!r});
mkdirSync(dirname(out), {{ recursive: true }});
writeFileSync(out, JSON.stringify(['first', 'second'].map(file => readFileSync(file, 'utf8'))) + '\n');
""")

        def write(path, text):
            (repo / path).write_text(text)

        write("first", "old")
        write("second", "old")
        write(asset, '["old","old"]\n')
        git("add", "--", "first", "second", asset, str(generator))
        git("commit", "-qm", "fixture base")
        base = git("rev-parse", "HEAD").strip()
        write("second", "new")
        write(asset, '["old","new"]\n')
        patch = repo / "old.patch"
        patch.write_text(git("diff", "--binary", "--full-index", base, "--", "second", asset))
        write("second", "old")
        write("first", "new")
        write(asset, '["new","old"]\n')
        git("add", "--", "first", asset)
        git("commit", "-qm", "first Action packet")
        winner = git("rev-parse", "HEAD").strip()
        msg = repo / "message"
        msg.write_text("fix: second Action packet\n")
        env = {**os.environ, "P03_CP_PACKET_BASE": base, "P03_GATE_CACHE": str(repo / "cache"),
               "P03_COMMIT_KICK": "true"}
        index_path_log = capture_index_paths(repo, env)
        result = subprocess.run(["bash", str(WRAPPER), str(msg), "-", str(patch)],
                                cwd=repo, env=env, capture_output=True, text=True)
        details = result.stdout + result.stderr
        assert result.returncode == 0, details
        assert_packet_cleanup(repo, index_path_log, details)
        assert git("rev-parse", "HEAD^").strip() == winner, details
        assert git("show", f"HEAD:{asset}") == '["new","new"]\n', details
        assert git("show", "HEAD:second") == "new", details
        assert "HSTACK_COMMITTED_CHECKOUT_DRIFT " + asset in details, details
        print("PASS old Action packet")


test_old_action_packet()


def test_projection_producers_land_current_outputs():
    with tempfile.TemporaryDirectory(prefix="p03-projection-writer-") as temp:
        repo = Path(temp)
        git = lambda *args: subprocess.check_output(["git", *args], cwd=repo, text=True)
        git("init", "-qb", "main")
        git("config", "user.name", "Fixture")
        git("config", "user.email", "fixture@example.invalid")
        titles = "packages/protocol/src/actions/schemaInputHints.ts"
        manifest = "packages/plugins/test/src/manifest.ts"
        approvals = "packages/protocol/src/approvals/approvalRequestV2.ts"
        dto = "packages/plugin-sdk/src/actions/dtos/approvalsActionDtos.generated.ts"
        declaration = "apps/cli/assets/bundled-plugin-manifests/declarations/test.summary.json"
        bundled = "apps/cli/assets/bundled-plugin-manifests/test.json"

        def write(path, text):
            target = repo / path
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(text)

        write("apps/cli/scripts/build-owned/generateBundledPluginEntries.ts", rf'''
import {{ mkdirSync, readFileSync, writeFileSync }} from 'node:fs';
import {{ dirname, join }} from 'node:path';
for (const [producer, projection] of [[{titles!r}, {declaration!r}], [{manifest!r}, {bundled!r}]]) {{
  const out = join(process.argv.at(-1), projection);
  mkdirSync(dirname(out), {{ recursive: true }});
  writeFileSync(out, readFileSync(producer, 'utf8').match(/= (\d+);/)[1] + '\n');
}}
''')
        write("packages/plugin-sdk/scripts/generateActionTypeMap.mjs", rf'''
import {{ readFileSync }} from 'node:fs';
import {{ resolve }} from 'node:path';
export const prepareActionTypeMap = () => ({{ outputs: new Map([[resolve({dto!r}), readFileSync({approvals!r})]]) }});
''')
        (repo / "node_modules").symlink_to(WRAPPER.parents[4] / "node_modules", target_is_directory=True)
        (repo / ".git/info/exclude").write_text("node_modules\n")
        write("packages/cli-common/sourceRuntimeEntries.mjs", "export const resolveWorkspaceSource = () => {};\n")
        write("packages/protocol/src/plugins/manifest/ingest.ts", "export const ingestPluginManifestV2 = () => ({ ok: true });\n")
        write("packages/plugin-sdk/src/manifest.ts", "export const parsePluginManifest = () => ({ ok: true });\n")
        for path in (titles, manifest, approvals, dto, declaration, bundled):
            write(path, "export const value = 0;\n" if path.endswith(".ts") else '0\n')
        git("add", ".")
        git("commit", "-qm", "fixture base")
        for producer in (titles, manifest, approvals):
            write(producer, "export const value = 1;\n")
        patch = repo / "own.patch"
        patch.write_text(git("diff", "--binary", "--full-index", "HEAD", "--", titles, manifest, approvals))
        msg = repo / "message"
        msg.write_text("fix: update projection producers\n")
        env = {**os.environ, "P03_GATE_CACHE": str(repo / "cache"), "P03_COMMIT_KICK": "true"}
        result = subprocess.run(["bash", str(WRAPPER), str(msg), "-", str(patch)],
                                cwd=repo, env=env, capture_output=True, text=True)
        assert result.returncode == 0, result.stdout + result.stderr
        for path in (dto, declaration, bundled):
            assert git("show", f"HEAD:{path}") == ("export const value = 1;\n" if path == dto else "1\n"), path
        print("PASS projection producers")


test_projection_producers_land_current_outputs()


def test_stale_packet_preserves_post_base_workspace_writes():
    with tempfile.TemporaryDirectory(prefix="p03-stale-writer-") as temp:
        repo = Path(temp)
        git = lambda *args: subprocess.check_output(["git", *args], cwd=repo, text=True)
        git("init", "-qb", "main")
        git("config", "user.name", "Fixture")
        git("config", "user.email", "fixture@example.invalid")
        path = "requester.txt"
        field = "  workspaceWrites: z.optional(z.enum(['allow', 'deny'])),"
        context = "attribution\npermissions\nconstraints\n" + field + "\nsession\ncreation\ndefaults\n"
        (repo / path).write_text("base marker\n" + context + "original requester\n")
        git("add", path)
        git("commit", "-qm", "packet base")
        base = git("rev-parse", "HEAD").strip()
        (repo / path).write_text("base marker\n" + context.replace(field + "\n", "") + "original requester\n")
        patch = repo / "stale.patch"
        patch.write_text(git("diff", "--binary", "--full-index", base, "--", path))
        (repo / path).write_text("new marker\n" + context + "new requester\nbase marker\n" + context + "original requester\n")
        git("add", path)
        git("commit", "-qm", "retain workspace write restrictions in the new requester")
        winner = git("rev-parse", "HEAD").strip()
        msg = repo / "message"
        env = {**os.environ, "P03_CP_PACKET_BASE": base, "P03_GATE_CACHE": str(repo / "cache"),
               "P03_COMMIT_KICK": "true"}
        def commit(message):
            msg.write_text(message)
            return subprocess.run(["bash", str(WRAPPER), str(msg), "-", str(patch)],
                                  cwd=repo, env=env, capture_output=True, text=True)
        result = commit("fix: change requester\n")
        details = result.stdout + result.stderr
        assert result.returncode == 1 and "post-base" in details and field.strip() in details, details
        assert git("rev-parse", "HEAD").strip() == winner, details
        result = commit(f"fix: change requester\n\n{field.strip()}\n")
        assert result.returncode == 0, result.stdout + result.stderr
        assert git("show", f"HEAD:{path}") == "new marker\n" + context.replace(field + "\n", "") + "new requester\nbase marker\n" + context + "original requester\n"
        print("PASS post-base workspaceWrites removal requires an explicit message")


test_stale_packet_preserves_post_base_workspace_writes()
