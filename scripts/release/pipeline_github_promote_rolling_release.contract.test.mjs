import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';

import { createBaseCliRuntimeSmokeFixtureFiles, createMinisignTestSigner } from '../testing/releaseArtifactFixtures.mjs';

const repoRoot = resolve(new URL('../..', import.meta.url).pathname);
const scriptPath = resolve(repoRoot, 'scripts/pipeline/github/promote-rolling-release.mjs');
const nodeArchiveScript = resolve(repoRoot, 'scripts/pipeline/release/node-archive.mjs');
const targetSha = '0123456789abcdef0123456789abcdef01234567';
const oldSha = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function writeExecutable(filePath, source) {
  writeFileSync(filePath, source, { encoding: 'utf8', mode: 0o755 });
  chmodSync(filePath, 0o755);
}

function fixture({ missingRolling = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'promote-rolling-release-'));
  const bin = join(root, 'bin');
  const source = join(root, 'source');
  const rolling = join(root, 'rolling');
  const staging = join(root, 'staging');
  mkdirSync(bin);
  mkdirSync(source);
  mkdirSync(rolling);
  mkdirSync(staging);
  const archivePlatform = process.platform === 'darwin' ? 'darwin' : 'linux';
  const archiveArch = process.arch === 'arm64' ? 'arm64' : 'x64';
  const archiveName = `happier-v1.2.3-preview.4-${archivePlatform}-${archiveArch}.tar.gz`;
  const aliasName = `happier-${archivePlatform}-${archiveArch}.tar.gz`;
  const archiveStem = archiveName.slice(0, -'.tar.gz'.length);
  const archiveStage = join(root, 'archive-stage');
  const archiveRoot = join(archiveStage, archiveStem);
  mkdirSync(archiveRoot, { recursive: true });
  // verify-artifacts always attests the base CLI runtime, even with --skip-smoke.
  for (const [relativePath, contents] of Object.entries(createBaseCliRuntimeSmokeFixtureFiles('1.2.3-preview.4'))) {
    mkdirSync(dirname(join(archiveRoot, relativePath)), { recursive: true });
    writeExecutable(join(archiveRoot, relativePath), contents);
  }
  // Archive admission accepts only producer modes; shared builders may run with a group-writable umask.
  for (const entry of readdirSync(archiveStage, { recursive: true, withFileTypes: true })) {
    if (entry.isDirectory()) chmodSync(join(entry.parentPath, entry.name), 0o755);
  }
  execFileSync(
    process.execPath,
    [
      nodeArchiveScript,
      '--artifact-path', join(source, archiveName),
      '--source-path', archiveStage,
      '--source-name', archiveStem,
    ],
    { cwd: repoRoot, stdio: 'pipe' },
  );
  const archive = readFileSync(join(source, archiveName));
  const checksumsName = 'checksums-happier-v1.2.3-preview.4.txt';
  const checksums = `${sha256(archive)}  ${archiveName}\n`;
  const signer = createMinisignTestSigner();
  const publicKey = join(root, 'release-test.pub');
  writeFileSync(publicKey, signer.publicKeyFile);
  writeFileSync(join(source, checksumsName), checksums);
  writeFileSync(join(source, `${checksumsName}.minisig`), signer.sign(checksums));
  writeFileSync(join(rolling, 'old-asset'), 'old\n');

  const log = join(root, 'gh.log');
  const uploadCounter = join(root, 'upload-counter');
  const draftState = join(root, 'draft-state');
  const staleOtherDraftState = join(root, 'stale-other-draft-state');
  const staleOtherRefState = join(root, 'stale-other-ref-state');
  const publishedState = join(root, 'published-state');
  const channelRef = join(root, 'channel-ref');
  const stagingRef = join(root, 'staging-ref');
  const backupRef = join(root, 'backup-ref');
  const release1Tag = join(root, 'release-1-tag');
  const release1Name = join(root, 'release-1-name');
  const release77Tag = join(root, 'release-77-tag');
  const rollingReadFailureMarker = join(root, 'rolling-read-failure-marker');
  const deleteConfirmFailureMarker = join(root, 'delete-confirm-failure-marker');
  const assetDownloadFailureMarker = join(root, 'asset-download-failure-marker');
  const downloadFailureCounter = join(root, 'download-failure-counter');
  const immutableChangeMarker = join(root, 'immutable-change-marker');
  writeFileSync(log, '');
  writeFileSync(uploadCounter, '0');
  writeFileSync(downloadFailureCounter, '0');
  if (missingRolling) {
    rmSync(join(rolling, 'old-asset'));
  } else {
    writeFileSync(channelRef, oldSha);
    writeFileSync(publishedState, '1');
    writeFileSync(release1Tag, 'cli-preview');
    writeFileSync(release1Name, 'Previous CLI Preview');
  }

  writeExecutable(
    join(bin, 'gh'),
    `#!/bin/sh
set -eu
echo "gh $*" >> ${JSON.stringify(log)}

not_found() {
  echo "gh: Not Found (HTTP 404)" >&2
  exit 1
}

fail_download_if_requested() {
  if [ "\${HAPPIER_TEST_DOWNLOAD_FAILURE_PHASE:-}" != "$1" ]; then return; fi
  count="$(cat ${JSON.stringify(downloadFailureCounter)})"
  count=$((count + 1))
  printf '%s' "$count" > ${JSON.stringify(downloadFailureCounter)}
  if [ "$count" -le "\${HAPPIER_TEST_DOWNLOAD_FAILURES:-1}" ]; then
    printf 'partial-bytes'
    echo "\${HAPPIER_TEST_DOWNLOAD_ERROR:-unexpected end of JSON input}" >&2
    exit 1
  fi
}

if [ "$1" = "release" ] && [ "$2" = "view" ]; then
  if [ "$3" = "cli-preview" ] && [ ! -f ${JSON.stringify(publishedState)} ]; then exit 1; fi
  printf '%s\\n' "$3"
  exit 0
fi

if [ "$1" = "release" ] && [ "$2" = "download" ]; then
  tag="$3"
  destination=""
  clobber=false
  case " $* " in *" --clobber "*) clobber=true ;; esac
  while [ "$#" -gt 0 ]; do
    if [ "$1" = "--dir" ]; then destination="$2"; break; fi
    shift
  done
  mkdir -p "$destination"
  if [ "$tag" = "cli-v1.2.3-preview.4" ]; then
    if [ -f "$destination"/${JSON.stringify(archiveName)} ] && [ "$clobber" = false ]; then echo 'file already exists; use --clobber' >&2; exit 1; fi
    fail_download_if_requested immutable > "$destination"/${JSON.stringify(archiveName)}
    cp ${JSON.stringify(source)}/* "$destination"/
  elif [ -f ${JSON.stringify(release77Tag)} ] && [ "$(cat ${JSON.stringify(release77Tag)})" = "$tag" ] && [ ! -f ${JSON.stringify(draftState)} ]; then
    if [ -f "$destination"/${JSON.stringify(aliasName)} ] && [ "$clobber" = false ]; then echo 'file already exists; use --clobber' >&2; exit 1; fi
    fail_download_if_requested published > "$destination"/${JSON.stringify(aliasName)}
    cp ${JSON.stringify(staging)}/* "$destination"/
  else
    cp ${JSON.stringify(rolling)}/* "$destination"/
  fi
  exit 0
fi

if [ "$1" = "release" ] && [ "$2" = "upload" ]; then
  count="$(cat ${JSON.stringify(uploadCounter)})"
  count=$((count + 1))
  printf '%s' "$count" > ${JSON.stringify(uploadCounter)}
  if [ "\${HAPPIER_TEST_FAIL_UPLOAD_NUMBER:-0}" = "$count" ]; then
    echo "injected upload failure" >&2
    exit 1
  fi
  cp "$4" ${JSON.stringify(rolling)}/"$(basename "$4")"
  exit 0
fi

if [ "$1" = "release" ] && [ "$2" = "edit" ]; then
  exit 0
fi

if [ "$1" = "release" ] && [ "$2" = "create" ]; then
  exit 0
fi

if [ "$1" = "api" ]; then
  if [ "\${HAPPIER_TEST_FAIL_ROLLING_RELEASE_READ:-0}" = "1" ] \
    && echo "$*" | grep -q "releases/tags/cli-preview" \
    && [ ! -f ${JSON.stringify(rollingReadFailureMarker)} ]; then
    : > ${JSON.stringify(rollingReadFailureMarker)}
    echo "gh: injected authorization failure (HTTP 401)" >&2
    exit 1
  fi
  case "$*" in
    *uploads.github.com*releases/77/assets*)
      count="$(cat ${JSON.stringify(uploadCounter)})"
      count=$((count + 1))
      printf '%s' "$count" > ${JSON.stringify(uploadCounter)}
      if [ "\${HAPPIER_TEST_FAIL_UPLOAD_NUMBER:-0}" = "$count" ]; then
        echo "injected upload failure" >&2
        exit 1
      fi
      if [ "\${HAPPIER_TEST_TRANSIENT_UPLOAD_NUMBER:-0}" = "$count" ]; then
        echo "error connecting to api.uploads.github.com" >&2
        echo "check your internet connection or https://githubstatus.com" >&2
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
      cp "$input" ${JSON.stringify(staging)}/"$name"
      if [ "\${HAPPIER_TEST_CORRUPT_ALIAS:-0}" = "1" ] && [ "$name" = ${JSON.stringify(aliasName)} ]; then
        printf 'corrupt\n' >> ${JSON.stringify(staging)}/"$name"
      fi
      exit 0
      ;;
  esac
  case "$*" in
    *git/ref/tags/cli-v1.2.3-preview.4*) printf '%s\\n' ${JSON.stringify(targetSha)} ;;
    *git/ref/tags/happier-rolling-staging-cli-preview-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb*) if [ -f ${JSON.stringify(staleOtherRefState)} ]; then cat ${JSON.stringify(staleOtherRefState)}; else not_found; fi ;;
    *git/ref/tags/happier-rolling-staging-*) if [ -f ${JSON.stringify(stagingRef)} ]; then cat ${JSON.stringify(stagingRef)}; else not_found; fi ;;
    *git/ref/tags/happier-rolling-backup-*) if [ -f ${JSON.stringify(backupRef)} ]; then cat ${JSON.stringify(backupRef)}; else not_found; fi ;;
    *git/ref/tags/cli-preview*) if [ -f ${JSON.stringify(channelRef)} ]; then cat ${JSON.stringify(channelRef)}; else not_found; fi ;;
    *releases/tags/cli-v1.2.3-preview.4*)
      printf '{"id":5,"tag_name":"cli-v1.2.3-preview.4","name":"Happier CLI v1.2.3-preview.4","body":"","prerelease":true,"draft":false}\\n'
      ;;
    *releases/5*)
      case "$*" in
        *"@tsv"*)
          for file in ${JSON.stringify(source)}/*; do [ -e "$file" ] || continue; name="$(basename "$file")"; printf '5-%s\\t%s\\n' "$name" "$name"; done
          if [ -f ${JSON.stringify(immutableChangeMarker)} ]; then printf '5-late.bin\\tlate.bin\\n'; fi
          ;;
        *) printf '{"id":5,"tag_name":"cli-v1.2.3-preview.4","name":"Happier CLI v1.2.3-preview.4","body":"","prerelease":true,"draft":false}\\n' ;;
      esac
      ;;
    *releases/tags/happier-rolling-backup-cli-preview*)
      if [ -f ${JSON.stringify(release1Tag)} ] && [ "$(cat ${JSON.stringify(release1Tag)})" = "happier-rolling-backup-cli-preview" ]; then
        printf '{"id":1,"tag_name":"happier-rolling-backup-cli-preview","name":"%s","body":"previous notes","prerelease":true,"draft":false}\\n' "$(cat ${JSON.stringify(release1Name)})"
      else
        not_found
      fi
      ;;
    *releases/tags/cli-preview*)
      if [ -f ${JSON.stringify(release1Tag)} ] && [ "$(cat ${JSON.stringify(release1Tag)})" = "cli-preview" ]; then
        printf '{"id":1,"tag_name":"cli-preview","name":"%s","body":"previous notes","prerelease":true,"draft":false}\\n' "$(cat ${JSON.stringify(release1Name)})"
      elif [ -f ${JSON.stringify(release77Tag)} ] && [ "$(cat ${JSON.stringify(release77Tag)})" = "cli-preview" ] && [ ! -f ${JSON.stringify(draftState)} ]; then
        printf '{"id":77,"tag_name":"cli-preview","name":"Happier CLI Preview","body":"Current version: 1.2.3-preview.4","prerelease":true,"draft":false}\\n'
      else
        not_found
      fi
      ;;
    *"releases?per_page=100"*)
      if echo "$*" | grep -q 'startswith'; then
        if [ -f ${JSON.stringify(staleOtherDraftState)} ]; then
          printf '88\\thappier-rolling-staging-cli-preview-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\\n'
        fi
      elif [ "\${HAPPIER_TEST_DELAY_DRAFT_VISIBILITY:-0}" != "1" ] \\
        && [ -f ${JSON.stringify(draftState)} ] && echo "$*" | grep -q "cli-preview"; then
        printf '%s\\n' "77"
      fi
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
      : > ${JSON.stringify(draftState)}
      printf '%s' "$tag_name" > ${JSON.stringify(release77Tag)}
      printf '{"id":77,"tag_name":"%s","name":"staging","body":"","prerelease":true,"draft":true}\\n' "$tag_name"
      ;;
    *"-X DELETE repos/test/test/releases/assets/"*)
      asset="\${4##*/}"
      case "$asset" in
        77-*) rm -f ${JSON.stringify(staging)}/"\${asset#77-}" ;;
        1-*) rm -f ${JSON.stringify(rolling)}/"\${asset#1-}" ;;
      esac
      ;;
    *"repos/test/test/releases/assets/"*)
      asset="\${2##*/}"
      if [ "$asset" = ${JSON.stringify(`77-${aliasName}`)} ]; then
        if [ -f ${JSON.stringify(draftState)} ]; then fail_download_if_requested staged; else fail_download_if_requested published; fi
      fi
      if [ "$asset" = ${JSON.stringify(`5-${archiveName}`)} ]; then fail_download_if_requested immutable; fi
      if [ "\${HAPPIER_TEST_RESET_FIRST_ASSET_DOWNLOAD:-0}" = "1" ] && [ ! -f ${JSON.stringify(assetDownloadFailureMarker)} ]; then
        : > ${JSON.stringify(assetDownloadFailureMarker)}
        printf 'partial-bytes'
        echo 'read: connection reset by peer' >&2
        exit 1
      fi
      case "$asset" in
        77-*) cat ${JSON.stringify(staging)}/"\${asset#77-}" ;;
        1-*) cat ${JSON.stringify(rolling)}/"\${asset#1-}" ;;
        5-*)
          if [ "\${HAPPIER_TEST_IMMUTABLE_ASSETS_CHANGE:-0}" = "1" ]; then : > ${JSON.stringify(immutableChangeMarker)}; fi
          cat ${JSON.stringify(source)}/"\${asset#5-}"
          ;;
      esac
      ;;
    *releases/77*)
      if echo "$*" | grep -q -- "-X PATCH"; then
        if [ "\${HAPPIER_TEST_FAIL_DRAFT_PUBLISH:-0}" = "1" ]; then
          echo "injected draft publish failure" >&2
          exit 1
        fi
        tag_name=""
        draft_value=""
        while [ "$#" -gt 0 ]; do
          case "$1" in
            tag_name=*) tag_name="\${1#tag_name=}" ;;
            draft=*) draft_value="\${1#draft=}" ;;
          esac
          shift
        done
        [ -n "$tag_name" ] && printf '%s' "$tag_name" > ${JSON.stringify(release77Tag)}
        if [ "$draft_value" = "false" ]; then : > ${JSON.stringify(publishedState)}; rm -f ${JSON.stringify(draftState)}; fi
        if [ "$draft_value" = "true" ]; then : > ${JSON.stringify(draftState)}; fi
      else
        case "$*" in
          *"@tsv"*) for file in ${JSON.stringify(staging)}/*; do [ -e "$file" ] || continue; name="$(basename "$file")"; printf '77-%s\\t%s\\n' "$name" "$name"; done ;;
          *) printf '{"id":77,"tag_name":"%s","name":"staging","body":"","prerelease":true,"draft":%s}\\n' "$(cat ${JSON.stringify(release77Tag)})" "$([ -f ${JSON.stringify(draftState)} ] && echo true || echo false)" ;;
        esac
      fi
      ;;
    *releases/88*)
      if echo "$*" | grep -q -- "-X DELETE"; then
        rm -f ${JSON.stringify(staleOtherDraftState)}
      elif [ -f ${JSON.stringify(staleOtherDraftState)} ]; then
        printf '{"id":88,"tag_name":"happier-rolling-staging-cli-preview-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","name":"old staging","body":"","prerelease":true,"draft":true}\\n'
      else
        not_found
      fi
      ;;
    *releases/1*)
      if echo "$*" | grep -q -- "-X PATCH"; then
        tag_name=""; name=""
        while [ "$#" -gt 0 ]; do
          case "$1" in tag_name=*) tag_name="\${1#tag_name=}" ;; name=*) name="\${1#name=}" ;; esac
          shift
        done
        [ -n "$tag_name" ] && printf '%s' "$tag_name" > ${JSON.stringify(release1Tag)}
        [ -n "$name" ] && printf '%s' "$name" > ${JSON.stringify(release1Name)}
      elif echo "$*" | grep -q -- "-X DELETE"; then
        rm -f ${JSON.stringify(release1Tag)} ${JSON.stringify(release1Name)} ${JSON.stringify(rolling)}/*
      elif echo "$*" | grep -q '@tsv'; then
        for file in ${JSON.stringify(rolling)}/*; do [ -e "$file" ] || continue; name="$(basename "$file")"; printf '1-%s\\t%s\\n' "$name" "$name"; done
      else
        if [ ! -f ${JSON.stringify(release1Tag)} ] \
          && [ "\${HAPPIER_TEST_FAIL_DELETE_CONFIRM_READ:-0}" = "1" ] \
          && [ ! -f ${JSON.stringify(deleteConfirmFailureMarker)} ]; then
          : > ${JSON.stringify(deleteConfirmFailureMarker)}
          echo "gh: injected service failure (HTTP 503)" >&2
          exit 1
        fi
        [ -f ${JSON.stringify(release1Tag)} ] || not_found
        printf '{"id":1,"tag_name":"%s","name":"%s","body":"previous notes","prerelease":true,"draft":false}\\n' "$(cat ${JSON.stringify(release1Tag)})" "$(cat ${JSON.stringify(release1Name)})"
      fi
      ;;
    *"-X POST repos/test/test/git/refs "*)
      ref=""; sha=""
      while [ "$#" -gt 0 ]; do
        case "$1" in ref=*) ref="\${1#ref=refs/tags/}" ;; sha=*) sha="\${1#sha=}" ;; esac
        shift
      done
      case "$ref" in
        cli-preview) printf '%s' "$sha" > ${JSON.stringify(channelRef)} ;;
        happier-rolling-staging-*) printf '%s' "$sha" > ${JSON.stringify(stagingRef)} ;;
        happier-rolling-backup-*) printf '%s' "$sha" > ${JSON.stringify(backupRef)} ;;
      esac
      ;;
    *"-X PATCH repos/test/test/git/refs/tags/"*)
      tag="\${4##*/}"; sha=""
      while [ "$#" -gt 0 ]; do case "$1" in sha=*) sha="\${1#sha=}" ;; esac; shift; done
      case "$tag" in
        cli-preview) printf '%s' "$sha" > ${JSON.stringify(channelRef)} ;;
        happier-rolling-staging-*) printf '%s' "$sha" > ${JSON.stringify(stagingRef)} ;;
        happier-rolling-backup-*) printf '%s' "$sha" > ${JSON.stringify(backupRef)} ;;
      esac
      ;;
    *"-X DELETE repos/test/test/git/refs/tags/"*)
      tag="\${4##*/}"
      case "$tag" in
        cli-preview) rm -f ${JSON.stringify(channelRef)} ;;
        happier-rolling-staging-cli-preview-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb) rm -f ${JSON.stringify(staleOtherRefState)} ;;
        happier-rolling-staging-*) rm -f ${JSON.stringify(stagingRef)} ;;
        happier-rolling-backup-*) rm -f ${JSON.stringify(backupRef)} ;;
      esac
      ;;
  esac
  exit 0
fi

echo "unexpected gh call: $*" >&2
exit 2
`,
  );

  return {
    root,
    bin,
    archiveName,
    aliasName,
    log,
    rolling,
    staging,
    uploadCounter,
    downloadFailureCounter,
    draftState,
    staleOtherDraftState,
    staleOtherRefState,
    publishedState,
    channelRef,
    stagingRef,
    backupRef,
    release1Tag,
    release77Tag,
    publicKey,
    source,
  };
}

function args(publicKey = 'scripts/release/installers/happier-release.pub') {
  return [
    scriptPath,
    '--source-tag', 'cli-v1.2.3-preview.4',
    '--rolling-tag', 'cli-preview',
    '--title', 'Happier CLI Preview',
    '--target-sha', targetSha,
    '--notes', 'Current version: 1.2.3-preview.4',
    '--prerelease', 'true',
    '--repo', 'test/test',
    '--public-key', publicKey,
  ];
}

test('rolling promotion dry-run shows private staging and whole-release backup cleanup', () => {
  const result = spawnSync(process.execPath, [...args(), '--dry-run'], { cwd: repoRoot, encoding: 'utf8' });
  assert.equal(result.status, 0);
  const output = `${String(result.stdout ?? '')}\n${String(result.stderr ?? '')}`;
  assert.match(output, /happier-rolling-staging-cli-preview-/);
  assert.match(output, /happier-rolling-backup-cli-preview/);
  assert.doesNotMatch(output, /releases\/assets\//);
});

test('rolling promotion removes an abandoned staging draft from an older target SHA', () => {
  const testFixture = fixture();
  try {
    writeFileSync(testFixture.staleOtherDraftState, '1');
    writeFileSync(testFixture.staleOtherRefState, oldSha);
    execFileSync(process.execPath, args(testFixture.publicKey), {
      cwd: repoRoot,
      env: {
        ...process.env,
        PATH: `${testFixture.bin}:${process.env.PATH ?? ''}`,
      },
      encoding: 'utf8',
    });
    assert.match(readFileSync(testFixture.log, 'utf8'), /make_latest=false/, 'rolling publication cannot claim Latest before channel promotion');
    assert.equal(existsSync(testFixture.staleOtherDraftState), false);
    assert.equal(existsSync(testFixture.staleOtherRefState), false);
    const log = readFileSync(testFixture.log, 'utf8');
    assert.match(log, /-X DELETE repos\/test\/test\/releases\/88/);
    assert.match(log, /-X DELETE repos\/test\/test\/git\/refs\/tags\/happier-rolling-staging-cli-preview-b+/);
  } finally {
    rmSync(testFixture.root, { recursive: true, force: true });
  }
});

test('rolling promotion retries a read-only asset audit without retaining partial bytes', () => {
  const testFixture = fixture();
  try {
    const result = spawnSync(process.execPath, args(testFixture.publicKey), {
      cwd: repoRoot,
      env: {
        ...process.env,
        PATH: `${testFixture.bin}:${process.env.PATH ?? ''}`,
        HAPPIER_TEST_RESET_FIRST_ASSET_DOWNLOAD: '1',
        HAPPIER_PIPELINE_GH_ASSET_READ_RETRY_DELAY_MS: '0',
      },
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, String(result.stderr));
    assert.match(String(result.stderr), /retrying.*(?:read|download)|download.*retrying/i);
  } finally {
    rmSync(testFixture.root, { recursive: true, force: true });
  }
});

test('rolling promotion rejects a corrupt channel alias after download recovery without replacing its predecessor', () => {
  const testFixture = fixture();
  try {
    const result = spawnSync(process.execPath, args(testFixture.publicKey), {
      cwd: repoRoot,
      env: {
        ...process.env,
        PATH: `${testFixture.bin}:${process.env.PATH ?? ''}`,
        HAPPIER_TEST_CORRUPT_ALIAS: '1',
        HAPPIER_TEST_DOWNLOAD_FAILURE_PHASE: 'staged',
        HAPPIER_PIPELINE_GH_ASSET_READ_RETRY_DELAY_MS: '0',
      },
      encoding: 'utf8',
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /(?:checksum mismatch|differs from immutable source bytes)/i);
    assert.equal(readFileSync(testFixture.release1Tag, 'utf8'), 'cli-preview');
    assert.equal(readFileSync(testFixture.channelRef, 'utf8'), oldSha);
    assert.deepEqual(readdirSync(testFixture.rolling), ['old-asset']);
  } finally {
    rmSync(testFixture.root, { recursive: true, force: true });
  }
});

for (const phase of ['immutable', 'staged', 'published']) {
  test(`rolling promotion retries a truncated ${phase} asset read with a complete fresh download`, () => {
    const testFixture = fixture();
    try {
      const result = spawnSync(process.execPath, args(testFixture.publicKey), {
        cwd: repoRoot,
        env: {
          ...process.env,
          PATH: `${testFixture.bin}:${process.env.PATH ?? ''}`,
          HAPPIER_TEST_DOWNLOAD_FAILURE_PHASE: phase,
          HAPPIER_PIPELINE_GH_ASSET_READ_RETRY_DELAY_MS: '0',
        },
        encoding: 'utf8',
      });
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stderr, /retrying.*(?:read|download)|download.*retrying/i);
      assert.equal(readFileSync(testFixture.channelRef, 'utf8'), targetSha);
      assert.deepEqual(
        readFileSync(join(testFixture.staging, testFixture.aliasName)),
        readFileSync(join(testFixture.root, 'source', testFixture.archiveName)),
      );
    } finally {
      rmSync(testFixture.root, { recursive: true, force: true });
    }
  });
}

for (const [error, attempts] of [
  ['unexpected end of JSON input', 4],
  ['gh: Bad credentials (HTTP 401)', 1],
  ['gh: Resource not accessible by integration (HTTP 403)', 1],
  ['gh: permanent download failure', 1],
]) {
  test(`rolling promotion leaves predecessor unchanged when asset reads fail: ${error}`, () => {
    const testFixture = fixture();
    try {
      const result = spawnSync(process.execPath, args(testFixture.publicKey), {
        cwd: repoRoot,
        env: {
          ...process.env,
          PATH: `${testFixture.bin}:${process.env.PATH ?? ''}`,
          HAPPIER_TEST_DOWNLOAD_FAILURE_PHASE: 'staged',
          HAPPIER_TEST_DOWNLOAD_FAILURES: '99',
          HAPPIER_TEST_DOWNLOAD_ERROR: error,
          HAPPIER_PIPELINE_GH_ASSET_READ_ATTEMPTS: '4',
          HAPPIER_PIPELINE_GH_ASSET_READ_RETRY_DELAY_MS: '0',
        },
        encoding: 'utf8',
      });
      assert.equal(result.status, 1);
      assert.ok(result.stderr.includes(error), result.stderr);
      assert.equal(Number(readFileSync(testFixture.downloadFailureCounter, 'utf8')), attempts);
      assert.equal(readFileSync(testFixture.release1Tag, 'utf8'), 'cli-preview');
      assert.equal(readFileSync(testFixture.channelRef, 'utf8'), oldSha);
      assert.deepEqual(readdirSync(testFixture.rolling), ['old-asset']);
      assert.doesNotMatch(readFileSync(testFixture.log, 'utf8'), /-X PATCH repos\/test\/test\/git\/refs\/tags\/cli-preview/);
    } finally {
      rmSync(testFixture.root, { recursive: true, force: true });
    }
  });
}

test('existing rolling replacement stages privately, restores after publish failure, and exposes only audited bytes', () => {
  const testFixture = fixture();
  try {
    const env = {
      ...process.env,
      PATH: `${testFixture.bin}:${process.env.PATH ?? ''}`,
      HAPPIER_TEST_FAIL_UPLOAD_NUMBER: '2',
    };
    const failed = spawnSync(process.execPath, args(testFixture.publicKey), {
      cwd: repoRoot,
      env,
      encoding: 'utf8',
    });
    assert.notEqual(failed.status, 0);
    const failedLog = readFileSync(testFixture.log, 'utf8');
    assert.doesNotMatch(failedLog, /git\/refs\/tags\/cli-preview/);
    assert.doesNotMatch(failedLog, /release edit cli-preview/);
    assert.deepEqual(
      readdirSync(testFixture.rolling),
      ['old-asset'],
      'a failed replacement must leave the published predecessor asset set untouched',
    );

    writeFileSync(testFixture.uploadCounter, '0');
    writeFileSync(testFixture.log, '');
    const failedSwitch = spawnSync(process.execPath, args(testFixture.publicKey), {
      cwd: repoRoot,
      env: {
        ...env,
        HAPPIER_TEST_FAIL_UPLOAD_NUMBER: '0',
        HAPPIER_TEST_FAIL_DRAFT_PUBLISH: '1',
      },
      encoding: 'utf8',
    });
    assert.notEqual(failedSwitch.status, 0);
    assert.equal(readFileSync(testFixture.release1Tag, 'utf8'), 'cli-preview');
    assert.equal(readFileSync(testFixture.channelRef, 'utf8'), oldSha);
    assert.deepEqual(readdirSync(testFixture.rolling), ['old-asset']);
    const failedSwitchLog = readFileSync(testFixture.log, 'utf8');
    assert.match(failedSwitchLog, /tag_name=happier-rolling-backup-cli-preview/);
    assert.match(failedSwitchLog, /releases\/1 .*tag_name=cli-preview/);
    assert.doesNotMatch(failedSwitchLog, /DELETE repos\/test\/test\/releases\/assets\/1-/);

    writeFileSync(testFixture.uploadCounter, '0');
    writeFileSync(testFixture.log, '');
    execFileSync(process.execPath, args(testFixture.publicKey), {
      cwd: repoRoot,
      env: { ...env, HAPPIER_TEST_FAIL_UPLOAD_NUMBER: '0' },
      encoding: 'utf8',
    });

    const successLog = readFileSync(testFixture.log, 'utf8');
    const stagedAudit = successLog.indexOf('repos/test/test/releases/assets/77-');
    const moveTag = successLog.lastIndexOf('gh api -X PATCH repos/test/test/git/refs/tags/cli-preview');
    const publishReplacement = successLog.lastIndexOf('PATCH repos/test/test/releases/77');
    const visibleAudit = successLog.lastIndexOf('repos/test/test/releases/assets/77-');
    const deleteBackup = successLog.lastIndexOf('DELETE repos/test/test/releases/1');
    assert.ok(stagedAudit >= 0);
    assert.ok(moveTag > stagedAudit, 'moving tag must follow the private draft byte/signature audit');
    assert.ok(publishReplacement > moveTag);
    assert.ok(visibleAudit > publishReplacement);
    assert.ok(deleteBackup > visibleAudit, 'predecessor deletion must follow visible replacement audit');
    assert.doesNotMatch(successLog, /DELETE repos\/test\/test\/releases\/assets\/1-/);
    assert.deepEqual(
      readdirSync(testFixture.staging).sort(),
      [
        'checksums-happier-v1.2.3-preview.4.txt',
        'checksums-happier-v1.2.3-preview.4.txt.minisig',
        testFixture.aliasName,
        testFixture.archiveName,
      ].sort(),
    );
    for (const name of readdirSync(testFixture.staging)) {
      const sourceName = name === testFixture.aliasName ? testFixture.archiveName : name;
      assert.deepEqual(
        readFileSync(join(testFixture.staging, name)),
        readFileSync(join(testFixture.root, 'source', basename(sourceName))),
      );
    }

    writeFileSync(testFixture.log, '');
    execFileSync(process.execPath, args(testFixture.publicKey), {
      cwd: repoRoot,
      env: { ...env, HAPPIER_TEST_FAIL_UPLOAD_NUMBER: '0' },
      encoding: 'utf8',
    });
    const idempotentLog = readFileSync(testFixture.log, 'utf8');
    assert.match(idempotentLog, /repos\/test\/test\/releases\/assets\/77-/);
    assert.doesNotMatch(idempotentLog, /-X PATCH repos\/test\/test\/releases|-X (?:POST|DELETE)[^\n]*releases\/assets|uploads\.github\.com/);
  } finally {
    rmSync(testFixture.root, { recursive: true, force: true });
  }
});

for (const [label, prepare, expected] of [
  ['an unsigned asset', (testFixture) => writeFileSync(join(testFixture.source, 'unbound.json'), '{}'), /unsigned assets: unbound\.json/],
  ['assets that change while they are downloaded', () => ({ HAPPIER_TEST_IMMUTABLE_ASSETS_CHANGE: '1' }), /changed while its assets were being audited/],
]) {
  test(`rolling promotion refuses an immutable release with ${label} before touching the channel`, () => {
    const testFixture = fixture();
    try {
      const extraEnv = prepare(testFixture) ?? {};
      const result = spawnSync(process.execPath, args(testFixture.publicKey), {
        cwd: repoRoot,
        env: { ...process.env, PATH: `${testFixture.bin}:${process.env.PATH ?? ''}`, ...extraEnv },
        encoding: 'utf8',
      });
      assert.equal(result.status, 1, result.stderr);
      assert.match(result.stderr, expected);
      assert.equal(readFileSync(testFixture.release1Tag, 'utf8'), 'cli-preview');
      assert.equal(readFileSync(testFixture.channelRef, 'utf8'), oldSha);
      assert.doesNotMatch(readFileSync(testFixture.log, 'utf8'), /uploads\.github\.com/);
    } finally {
      rmSync(testFixture.root, { recursive: true, force: true });
    }
  });
}

test('rolling promotion rejects an immutable tag whose SHA differs from the authorized SHA', () => {
  const testFixture = fixture();
  try {
    const mismatchedSha = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
    const result = spawnSync(
      process.execPath,
      args(testFixture.publicKey).map((arg, index, all) => (all[index - 1] === '--target-sha' ? mismatchedSha : arg)),
      {
        cwd: repoRoot,
        env: {
          ...process.env,
          PATH: `${testFixture.bin}:${process.env.PATH ?? ''}`,
        },
        encoding: 'utf8',
      },
    );

    assert.notEqual(result.status, 0);
    assert.match(String(result.stderr), /does not resolve to authorized SHA/i);
    assert.doesNotMatch(
      readFileSync(testFixture.log, 'utf8'),
      /releases\/assets\//,
      'mismatched immutable identity must fail before release assets are consumed',
    );
  } finally {
    rmSync(testFixture.root, { recursive: true, force: true });
  }
});

test('a non-404 predecessor read failure aborts before any release or tag mutation', () => {
  const testFixture = fixture();
  try {
    const result = spawnSync(process.execPath, args(testFixture.publicKey), {
      cwd: repoRoot,
      env: {
        ...process.env,
        PATH: `${testFixture.bin}:${process.env.PATH ?? ''}`,
        HAPPIER_TEST_FAIL_ROLLING_RELEASE_READ: '1',
      },
      encoding: 'utf8',
    });

    assert.notEqual(result.status, 0);
    assert.match(String(result.stderr), /HTTP 401/);
    assert.doesNotMatch(readFileSync(testFixture.log, 'utf8'), /gh api -X (?:POST|PATCH|DELETE)/);
    assert.equal(readFileSync(testFixture.release1Tag, 'utf8'), 'cli-preview');
    assert.equal(readFileSync(testFixture.channelRef, 'utf8'), oldSha);
    assert.deepEqual(readdirSync(testFixture.rolling), ['old-asset']);
  } finally {
    rmSync(testFixture.root, { recursive: true, force: true });
  }
});

test('a transport failure while confirming deletion is not accepted as successful absence', () => {
  const testFixture = fixture();
  try {
    const env = {
      ...process.env,
      PATH: `${testFixture.bin}:${process.env.PATH ?? ''}`,
      HAPPIER_TEST_FAIL_DELETE_CONFIRM_READ: '1',
    };
    const result = spawnSync(process.execPath, args(testFixture.publicKey), {
      cwd: repoRoot,
      env,
      encoding: 'utf8',
    });

    assert.notEqual(result.status, 0);
    assert.match(String(result.stderr), /HTTP 503/);
    assert.match(readFileSync(testFixture.log, 'utf8'), /-X DELETE repos\/test\/test\/releases\/1/);

    writeFileSync(testFixture.log, '');
    execFileSync(process.execPath, args(testFixture.publicKey), { cwd: repoRoot, env, encoding: 'utf8' });
    assert.equal(existsSync(testFixture.backupRef), false);
    assert.equal(existsSync(testFixture.stagingRef), false);
  } finally {
    rmSync(testFixture.root, { recursive: true, force: true });
  }
});

test('retry restores a predecessor stranded under the deterministic backup tag before staging again', () => {
  const testFixture = fixture();
  try {
    writeFileSync(testFixture.release1Tag, 'happier-rolling-backup-cli-preview');
    writeFileSync(
      join(testFixture.root, 'release-1-name'),
      '[backup:happier-rolling-backup-cli-preview] Previous CLI Preview',
    );
    writeFileSync(testFixture.backupRef, oldSha);
    writeFileSync(testFixture.channelRef, targetSha);
    const result = spawnSync(process.execPath, args(testFixture.publicKey), {
      cwd: repoRoot,
      env: {
        ...process.env,
        PATH: `${testFixture.bin}:${process.env.PATH ?? ''}`,
        HAPPIER_TEST_FAIL_UPLOAD_NUMBER: '1',
      },
      encoding: 'utf8',
    });
    assert.notEqual(result.status, 0);
    assert.equal(readFileSync(testFixture.release1Tag, 'utf8'), 'cli-preview');
    assert.equal(readFileSync(testFixture.channelRef, 'utf8'), oldSha);
    assert.equal(existsSync(testFixture.backupRef), false);
    assert.deepEqual(readdirSync(testFixture.rolling), ['old-asset']);
  } finally {
    rmSync(testFixture.root, { recursive: true, force: true });
  }
});

test('an initially missing rolling release retries one private draft before publishing the complete replacement', () => {
  const testFixture = fixture({ missingRolling: true });
  try {
    const failed = spawnSync(process.execPath, args(testFixture.publicKey), {
      cwd: repoRoot,
      env: {
        ...process.env,
        PATH: `${testFixture.bin}:${process.env.PATH ?? ''}`,
        HAPPIER_TEST_FAIL_UPLOAD_NUMBER: '2',
      },
      encoding: 'utf8',
    });
    assert.notEqual(failed.status, 0);
    const failedLog = readFileSync(testFixture.log, 'utf8');
    assert.match(failedLog, /POST repos\/test\/test\/releases .*tag_name=happier-rolling-staging-cli-preview-/);
    assert.doesNotMatch(failedLog, /PATCH repos\/test\/test\/releases\/77/);
    assert.match(failedLog, /happier-rolling-staging/);
    assert.equal(existsSync(testFixture.channelRef), false);
    assert.equal(existsSync(testFixture.stagingRef), true);
    assert.equal(existsSync(testFixture.draftState), true);
    assert.equal(existsSync(testFixture.publishedState), false);

    writeFileSync(testFixture.uploadCounter, '0');
    writeFileSync(testFixture.log, '');
    execFileSync(process.execPath, args(testFixture.publicKey), {
      cwd: repoRoot,
      env: {
        ...process.env,
        PATH: `${testFixture.bin}:${process.env.PATH ?? ''}`,
        HAPPIER_TEST_FAIL_UPLOAD_NUMBER: '0',
      },
      encoding: 'utf8',
    });
    const successLog = readFileSync(testFixture.log, 'utf8');
    const findExistingDraft = successLog.indexOf('releases?per_page=100');
    const stagedAssetDownload = successLog.indexOf('repos/test/test/releases/assets/77-');
    const publishDraft = successLog.lastIndexOf('PATCH repos/test/test/releases/77');
    assert.ok(findExistingDraft >= 0, 'same-version retry must find the private draft by staging tag');
    assert.ok(stagedAssetDownload > findExistingDraft);
    assert.ok(publishDraft > stagedAssetDownload, 'native draft publication must follow exact asset audit');
    assert.match(successLog, /happier-rolling-staging/);
    assert.equal(existsSync(testFixture.channelRef), true);
    assert.equal(existsSync(testFixture.draftState), false);
    assert.equal(existsSync(testFixture.publishedState), true);
  } finally {
    rmSync(testFixture.root, { recursive: true, force: true });
  }
});

test('rolling promotion retries a transient GitHub asset upload connectivity failure', () => {
  const testFixture = fixture();
  try {
    const result = spawnSync(process.execPath, args(testFixture.publicKey), {
      cwd: repoRoot,
      env: {
        ...process.env,
        PATH: `${testFixture.bin}:${process.env.PATH ?? ''}`,
        HAPPIER_TEST_TRANSIENT_UPLOAD_NUMBER: '1',
        HAPPIER_PIPELINE_GH_ROLLING_UPLOAD_RETRY_DELAY_MS: '1',
      },
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, String(result.stderr));
    const uploadCalls = readFileSync(testFixture.log, 'utf8').split('\n').filter((line) => line.includes('uploads.github.com'));
    const uploadedNames = new Set(uploadCalls.map((line) => line.match(/assets\?name=([^ ]+)/)?.[1]));
    assert.equal(uploadCalls.length, uploadedNames.size + 1, 'only the first asset upload retries, once');
    // gh maps `--hostname uploads.github.com` to api.uploads.github.com; uploads use the absolute endpoint.
    for (const line of uploadCalls) assert.match(line, /https:\/\/uploads\.github\.com\/repos\/test\/test\/releases\/77\/assets\?name=/);
  } finally {
    rmSync(testFixture.root, { recursive: true, force: true });
  }
});

test('draft creation uses the mutation response while GitHub release listings are stale', () => {
  const testFixture = fixture({ missingRolling: true });
  try {
    execFileSync(process.execPath, args(testFixture.publicKey), {
      cwd: repoRoot,
      env: { ...process.env, PATH: `${testFixture.bin}:${process.env.PATH ?? ''}`, HAPPIER_TEST_DELAY_DRAFT_VISIBILITY: '1' },
      encoding: 'utf8',
    });
    assert.equal(existsSync(testFixture.channelRef), true);
    assert.equal(existsSync(testFixture.draftState), false);
    assert.equal(existsSync(testFixture.publishedState), true);
  } finally {
    rmSync(testFixture.root, { recursive: true, force: true });
  }
});
