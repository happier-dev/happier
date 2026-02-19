import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');

test('install.sh asset lookup works even when awk has a line-length limit', async () => {
  const root = await mkdtemp(join(tmpdir(), 'happier-installer-asset-lookup-'));
  const binDir = join(root, 'bin');
  const installDir = join(root, 'install');
  const outBinDir = join(root, 'out-bin');
  await mkdir(binDir, { recursive: true });
  await mkdir(installDir, { recursive: true });
  await mkdir(outBinDir, { recursive: true });

  const unameStubPath = join(binDir, 'uname');
  await writeFile(
    unameStubPath,
    `#!/usr/bin/env bash
set -euo pipefail
if [[ "$1" = "-s" ]]; then
  echo Linux
  exit 0
fi
if [[ "$1" = "-m" ]]; then
  echo x86_64
  exit 0
fi
echo Linux
`,
    'utf8',
  );
  await chmod(unameStubPath, 0o755);

  // Simulate an awk implementation with a max line-length limit by refusing to process inputs that
  // contain any "very long" lines. This catches jq-free parsing that collapses JSON into a single
  // huge line (e.g. via `tr -d '[:space:]'`).
  const awkWrapperPath = join(binDir, 'awk');
  await writeFile(
    awkWrapperPath,
    `#!/usr/bin/env bash
set -euo pipefail

real_awk="/usr/bin/awk"
if [[ ! -x "$real_awk" ]]; then
  real_awk="$(command -v gawk || true)"
fi
if [[ -z "$real_awk" ]]; then
  echo "missing real awk" >&2
  exit 127
fi

tmp="$(mktemp)"
trap 'rm -f "$tmp"' EXIT
cat > "$tmp"

limit=8000
max_len="$(wc -L < "$tmp" | tr -d '[:space:]')"
if [[ -n "$max_len" ]] && [[ "$max_len" -gt "$limit" ]]; then
  # Behave like a truncating awk: produce no output so callers fail to find matches.
  exit 0
fi

exec "$real_awk" "$@" "$tmp"
`,
    'utf8',
  );
  await chmod(awkWrapperPath, 0o755);

  const curlStubPath = join(binDir, 'curl');
  await writeFile(
    curlStubPath,
    `#!/usr/bin/env bash
set -euo pipefail

# Minimal curl stub used by installer tests.
# - For metadata calls (no -o), return a pretty-printed JSON blob with enough padding to exceed the
#   wrapper-awk's max line-length limit *only if the installer collapses whitespace*.
# - For archive downloads, write an empty file (checksum mismatch).
# - For checksums downloads, write an entry with the correct filename but a mismatching checksum.
out=""
url=""
for ((i=1; i<=$#; i++)); do
  if [[ "\${!i}" = "-o" ]]; then
    j=$((i+1))
    out="\${!j}"
    continue
  fi
  case "\${!i}" in
    http://*|https://*) url="\${!i}" ;;
  esac
done
if [[ -n "$out" ]]; then
  if [[ "$url" == *"checksums-happier-v0.1.0-preview.1.txt" ]]; then
    # Wrong checksum on purpose; should trigger "Checksum verification failed." later.
    printf '%s  %s\n' "0000000000000000000000000000000000000000000000000000000000000000" "happier-v0.1.0-preview.1-linux-x64.tar.gz" > "$out"
    exit 0
  fi
  : > "$out"
  exit 0
fi

cat <<'JSON_HEAD'
{
  "assets": [
    {
      "name": "happier-v0.1.0-preview.1-linux-x64.tar.gz",
      "browser_download_url": "https://example.test/happier-v0.1.0-preview.1-linux-x64.tar.gz"
    },
    {
      "name": "checksums-happier-v0.1.0-preview.1.txt",
      "browser_download_url": "https://example.test/checksums-happier-v0.1.0-preview.1.txt"
    },
    {
      "name": "checksums-happier-v0.1.0-preview.1.txt.minisig",
      "browser_download_url": "https://example.test/checksums-happier-v0.1.0-preview.1.txt.minisig"
    }
  ],
  "pad": [
JSON_HEAD

# Produce many small lines so the JSON becomes *large* but doesn't contain any single long line.
for i in $(seq 1 4000); do
  if [[ "$i" -eq 4000 ]]; then
    printf '    "p%s"\n' "$i"
  else
    printf '    "p%s",\n' "$i"
  fi
done
cat <<'JSON_TAIL'
  ]
}
JSON_TAIL
`,
    'utf8',
  );
  await chmod(curlStubPath, 0o755);

  const installerPath = join(repoRoot, 'scripts', 'release', 'installers', 'install.sh');
  const env = {
    ...process.env,
    PATH: `${binDir}:/usr/bin:/bin:/usr/sbin:/sbin`,
    HAPPIER_CHANNEL: 'preview',
    HAPPIER_PRODUCT: 'cli',
    HAPPIER_INSTALL_DIR: installDir,
    HAPPIER_BIN_DIR: outBinDir,
    HAPPIER_NO_PATH_UPDATE: '1',
    HAPPIER_NONINTERACTIVE: '1',
    HAPPIER_GITHUB_TOKEN: '',
    GITHUB_TOKEN: '',
  };

  const res = spawnSync('bash', [installerPath], { env, encoding: 'utf8' });
  const stdout = String(res.stdout ?? '');
  const stderr = String(res.stderr ?? '');
  const combined = `${stdout}\n${stderr}`;

  assert.notEqual(res.status, 0, `expected non-zero exit:\n--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}\n`);
  assert.doesNotMatch(combined, /Unable to locate release assets/i, `unexpected asset lookup failure:\n${combined}`);
  assert.match(combined, /Checksum verification failed/i, `expected checksum failure after parsing assets:\n${combined}`);

  await rm(root, { recursive: true, force: true });
});
