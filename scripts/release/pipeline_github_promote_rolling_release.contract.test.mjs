import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const repoRoot = resolve(new URL('../..', import.meta.url).pathname);
const script = resolve(repoRoot, 'scripts/pipeline/github/promote-rolling-release.mjs');
const nodeArchiveScript = resolve(repoRoot, 'scripts/pipeline/release/node-archive.mjs');
const authorizedSha = '0123456789abcdef0123456789abcdef01234567';

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function executable(path, source) {
  writeFileSync(path, source, { encoding: 'utf8', mode: 0o755 });
  chmodSync(path, 0o755);
}

test('rolling promotion rejects an immutable tag not bound to the authorized SHA before any write', () => {
  const root = mkdtempSync(join(tmpdir(), 'rolling-authority-'));
  const bin = join(root, 'bin');
  const log = join(root, 'gh.log');
  mkdirSync(bin);
  writeFileSync(log, '');
  const gh = join(bin, 'gh');
  writeFileSync(gh, `#!/bin/sh
set -eu
echo "gh $*" >> ${JSON.stringify(log)}
if [ "$1" = api ] && echo "$*" | grep -q 'git/ref/tags/cli-v1.2.3-preview.4'; then
  printf '%s\n' aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
  exit 0
fi
echo "unexpected call" >&2
exit 2
`, { mode: 0o755 });
  chmodSync(gh, 0o755);
  try {
    const result = spawnSync(process.execPath, [
      script,
      '--source-tag', 'cli-v1.2.3-preview.4',
      '--rolling-tag', 'cli-preview',
      '--title', 'Happier CLI Preview',
      '--target-sha', authorizedSha,
      '--prerelease', 'true',
      '--repo', 'test/test',
      '--public-key', 'scripts/release/installers/happier-release.pub',
    ], {
      cwd: repoRoot,
      env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}` },
      encoding: 'utf8',
    });
    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}\n${result.stderr}`, /does not resolve to authorized SHA/i);
    const calls = readFileSync(log, 'utf8');
    assert.doesNotMatch(calls, /release upload|release edit|-X POST|-X PATCH|-X DELETE/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('rolling promotion plans against the real rolling tag without a temporary ref namespace', () => {
  const result = spawnSync(process.execPath, [
    script,
    '--source-tag', 'cli-v1.2.3-preview.4',
    '--rolling-tag', 'cli-preview',
    '--title', 'Happier CLI Preview',
    '--target-sha', authorizedSha,
    '--prerelease', 'true',
    '--repo', 'test/test',
    '--public-key', 'scripts/release/installers/happier-release.pub',
    '--dry-run',
  ], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  assert.equal(result.status, 0);
  const output = `${String(result.stdout ?? '')}\n${String(result.stderr ?? '')}`;
  assert.doesNotMatch(output, /happier-rolling-staging/);
  assert.match(output, /releases\/tags\/cli-preview/);
});

test('initial rolling publication retries one native draft on the real rolling tag and publishes only after asset audit', () => {
  const root = mkdtempSync(join(tmpdir(), 'rolling-native-draft-'));
  const bin = join(root, 'bin');
  const source = join(root, 'source');
  const rolling = join(root, 'rolling');
  const log = join(root, 'gh.log');
  const draftState = join(root, 'draft-state');
  const publishedState = join(root, 'published-state');
  const channelRef = join(root, 'channel-ref');
  const uploadCounter = join(root, 'upload-counter');
  mkdirSync(bin);
  mkdirSync(source);
  mkdirSync(rolling);
  writeFileSync(log, '');
  writeFileSync(uploadCounter, '0');

  const archiveName = 'happier-v1.2.3-preview.4-linux-x64.tar.gz';
  const archiveRoot = archiveName.slice(0, -'.tar.gz'.length);
  const archiveStageRoot = join(root, 'archive-stage');
  const archiveStageDir = join(archiveStageRoot, archiveRoot);
  mkdirSync(archiveStageDir, { recursive: true });
  writeFileSync(join(archiveStageDir, 'happier'), 'synthetic executable bytes\n', { mode: 0o755 });
  execFileSync(
    process.execPath,
    [
      nodeArchiveScript,
      '--artifact-path',
      join(source, archiveName),
      '--source-path',
      archiveStageRoot,
      '--source-name',
      archiveRoot,
    ],
    { cwd: repoRoot, stdio: 'pipe' },
  );
  const archive = readFileSync(join(source, archiveName));
  const checksumsName = 'checksums-happier-v1.2.3-preview.4.txt';
  writeFileSync(join(source, checksumsName), `${sha256(archive)}  ${archiveName}\n`);
  writeFileSync(join(source, `${checksumsName}.minisig`), 'signature\n');

  executable(join(bin, 'minisign'), '#!/bin/sh\nexit 0\n');
  executable(join(bin, 'gh'), `#!/bin/sh
set -eu
echo "gh $*" >> ${JSON.stringify(log)}

if [ "$1" = release ] && [ "$2" = download ]; then
  tag="$3"
  destination=""
  while [ "$#" -gt 0 ]; do
    if [ "$1" = --dir ]; then destination="$2"; break; fi
    shift
  done
  mkdir -p "$destination"
  if [ "$tag" = cli-v1.2.3-preview.4 ]; then
    cp ${JSON.stringify(source)}/* "$destination"/
  else
    cp ${JSON.stringify(rolling)}/* "$destination"/
  fi
  exit 0
fi

if [ "$1" = api ]; then
  case "$*" in
    *git/ref/tags/cli-v1.2.3-preview.4*) printf '%s\\n' ${JSON.stringify(authorizedSha)}; exit 0 ;;
    *git/ref/tags/cli-preview*)
      if [ -f ${JSON.stringify(channelRef)} ]; then cat ${JSON.stringify(channelRef)}; exit 0; fi
      exit 1
      ;;
    *releases/tags/cli-preview*)
      if [ -f ${JSON.stringify(publishedState)} ]; then printf '1\\n'; exit 0; fi
      exit 1
      ;;
    *"releases?per_page=100"*)
      if [ -f ${JSON.stringify(draftState)} ]; then printf '77\\n'; fi
      exit 0
      ;;
    *"-X POST repos/test/test/releases "*)
      tag_name=""
      target_commitish=""
      while [ "$#" -gt 0 ]; do
        case "$1" in
          tag_name=*) tag_name="\${1#tag_name=}" ;;
          target_commitish=*) target_commitish="\${1#target_commitish=}" ;;
        esac
        shift
      done
      if [ "$tag_name" != cli-preview ]; then
        echo "unexpected draft tag: $tag_name" >&2
        exit 3
      fi
      : > ${JSON.stringify(draftState)}
      printf '%s' "$target_commitish" > ${JSON.stringify(channelRef)}
      printf '77\\n'
      exit 0
      ;;
    *uploads.github.com*releases/77/assets*)
      count="$(cat ${JSON.stringify(uploadCounter)})"
      count=$((count + 1))
      printf '%s' "$count" > ${JSON.stringify(uploadCounter)}
      if [ "\${HAPPIER_TEST_FAIL_UPLOAD_NUMBER:-0}" = "$count" ]; then
        echo "injected upload failure" >&2
        exit 1
      fi
      endpoint=""
      input=""
      while [ "$#" -gt 0 ]; do
        case "$1" in
          *releases/77/assets*) endpoint="$1" ;;
          --input) input="$2"; shift ;;
        esac
        shift
      done
      name="\${endpoint##*name=}"
      cp "$input" ${JSON.stringify(rolling)}/"$name"
      exit 0
      ;;
    *"-X DELETE repos/test/test/releases/assets/"*)
      asset="\${4##*/}"
      rm -f ${JSON.stringify(rolling)}/"$asset"
      exit 0
      ;;
    *"repos/test/test/releases/assets/"*)
      asset="\${2##*/}"
      cat ${JSON.stringify(rolling)}/"$asset"
      exit 0
      ;;
    *releases/77*)
      if echo "$*" | grep -q -- "-X PATCH"; then
        : > ${JSON.stringify(publishedState)}
        rm -f ${JSON.stringify(draftState)}
        exit 0
      fi
      case "$*" in
        *"@tsv"*)
          for file in ${JSON.stringify(rolling)}/*; do
            [ -e "$file" ] || continue
            name="$(basename "$file")"
            printf '%s\\t%s\\n' "$name" "$name"
          done
          ;;
        *)
          for file in ${JSON.stringify(rolling)}/*; do
            [ -e "$file" ] || continue
            basename "$file"
          done
          ;;
      esac
      exit 0
      ;;
  esac
fi

echo "unexpected gh call: $*" >&2
exit 2
`);

  const args = [
    script,
    '--source-tag', 'cli-v1.2.3-preview.4',
    '--rolling-tag', 'cli-preview',
    '--title', 'Happier CLI Preview',
    '--target-sha', authorizedSha,
    '--prerelease', 'true',
    '--repo', 'test/test',
    '--public-key', 'scripts/release/installers/happier-release.pub',
  ];
  try {
    const failed = spawnSync(process.execPath, args, {
      cwd: repoRoot,
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH ?? ''}`,
        HAPPIER_TEST_FAIL_UPLOAD_NUMBER: '2',
      },
      encoding: 'utf8',
    });
    assert.notEqual(failed.status, 0);
    const failedLog = readFileSync(log, 'utf8');
    assert.match(
      failedLog,
      /POST repos\/test\/test\/releases .*tag_name=cli-preview/,
      `${String(failed.stdout ?? '')}\n${String(failed.stderr ?? '')}`,
    );
    assert.doesNotMatch(failedLog, /PATCH repos\/test\/test\/releases\/77/);
    assert.doesNotMatch(failedLog, /happier-rolling-staging/);
    assert.equal(existsSync(draftState), true);
    assert.equal(existsSync(publishedState), false);

    writeFileSync(log, '');
    writeFileSync(uploadCounter, '0');
    execFileSync(process.execPath, args, {
      cwd: repoRoot,
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH ?? ''}`,
        HAPPIER_TEST_FAIL_UPLOAD_NUMBER: '0',
      },
      encoding: 'utf8',
    });
    const retryLog = readFileSync(log, 'utf8');
    const findDraft = retryLog.indexOf('releases?per_page=100');
    const auditAsset = retryLog.lastIndexOf('Accept: application/octet-stream');
    const publishDraft = retryLog.lastIndexOf('PATCH repos/test/test/releases/77');
    assert.ok(findDraft >= 0);
    assert.ok(auditAsset > findDraft);
    assert.ok(publishDraft > auditAsset);
    assert.doesNotMatch(retryLog, /happier-rolling-staging|git\/refs\/tags\/cli-preview.*(?:POST|PATCH|DELETE)/);
    assert.equal(existsSync(draftState), false);
    assert.equal(existsSync(publishedState), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
