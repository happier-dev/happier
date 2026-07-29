// @ts-check

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

import { buildRollingReleaseEditArgs } from './lib/gh-release-commands.mjs';

const FULL_SHA = /^[a-f0-9]{40}$/;

function fail(message) {
  throw new Error(message);
}

function parseBool(value, name) {
  const raw = String(value ?? '').trim().toLowerCase();
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  fail(`${name} must be true or false.`);
}

function run(cmd, args, opts = {}) {
  const printable = `${cmd} ${args.map((arg) => (arg.includes(' ') ? JSON.stringify(arg) : arg)).join(' ')}`;
  if (opts.dryRun) {
    console.log(`[dry-run] ${printable}`);
    return '';
  }
  try {
    return execFileSync(cmd, args, {
      cwd: opts.cwd ?? process.cwd(),
      env: { ...process.env, ...(opts.env ?? {}) },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 10 * 60_000,
    });
  } catch (error) {
    if (opts.allowFailure) return '';
    throw error;
  }
}

function runBuffer(cmd, args, opts = {}) {
  const printable = `${cmd} ${args.map((arg) => (arg.includes(' ') ? JSON.stringify(arg) : arg)).join(' ')}`;
  if (opts.dryRun) {
    console.log(`[dry-run] ${printable}`);
    return Buffer.alloc(0);
  }
  return execFileSync(cmd, args, {
    cwd: opts.cwd ?? process.cwd(),
    env: { ...process.env, ...(opts.env ?? {}) },
    encoding: 'buffer',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 10 * 60_000,
  });
}

async function fileSha256(filePath) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest('hex');
}

async function assertSignedBundle(directory) {
  const names = (await readdir(directory)).sort();
  const checksumNames = names.filter((name) => /^checksums-.+\.txt$/.test(name));
  if (checksumNames.length !== 1) {
    fail(`Release bundle must contain exactly one checksums file (found ${checksumNames.length}).`);
  }
  const checksumsName = checksumNames[0];
  const signatureName = `${checksumsName}.minisig`;
  const checksums = await readFile(join(directory, checksumsName), 'utf8');
  const archiveNames = checksums
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const match = /^[a-f0-9]{64}\s{2}(.+)$/.exec(line);
      if (!match) fail(`Invalid checksum line in ${checksumsName}: ${line}`);
      return match[1];
    });
  const required = new Set([...archiveNames, checksumsName, signatureName]);
  const missing = [...required].filter((name) => !names.includes(name));
  const unsupportedExtras = names.filter((name) => !required.has(name) && !name.endsWith('.json'));
  if (missing.length > 0 || unsupportedExtras.length > 0) {
    fail(
      `Release bundle file set does not match its signed checksums`
      + `${missing.length > 0 ? `; missing ${missing.join(', ')}` : ''}`
      + `${unsupportedExtras.length > 0 ? `; unsupported extras ${unsupportedExtras.join(', ')}` : ''}`,
    );
  }
  return { names, checksumsName };
}

async function assertDirectoriesEqual(leftDir, rightDir) {
  const leftNames = (await readdir(leftDir)).sort();
  const rightNames = (await readdir(rightDir)).sort();
  if (leftNames.length !== rightNames.length || leftNames.some((name, index) => name !== rightNames[index])) {
    fail('Rolling release asset names differ from the immutable release.');
  }
  for (const name of leftNames) {
    const [leftSha, rightSha] = await Promise.all([
      fileSha256(join(leftDir, name)),
      fileSha256(join(rightDir, name)),
    ]);
    if (leftSha !== rightSha) fail(`Rolling release asset differs from immutable source bytes: ${name}`);
  }
}

function readTagSha({ repo, tag, env, dryRun }) {
  return run('gh', ['api', `repos/${repo}/git/ref/tags/${tag}`, '--jq', '.object.sha'], {
    env,
    dryRun,
    allowFailure: true,
  }).trim().toLowerCase();
}

function findDraftReleaseId({ repo, tag, env, dryRun }) {
  const jqTag = JSON.stringify(tag);
  return run('gh', [
    'api',
    `repos/${repo}/releases?per_page=100`,
    '--paginate',
    '--jq',
    `.[] | select(.draft == true and .tag_name == ${jqTag}) | .id`,
  ], {
    env,
    dryRun,
    allowFailure: true,
  }).trim().split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? '';
}

async function downloadReleaseAssetsById({ repo, releaseId, destination, env, dryRun }) {
  const assets = run('gh', [
    'api',
    `repos/${repo}/releases/${releaseId}`,
    '--jq',
    '.assets[] | [.id, .name] | @tsv',
  ], { env, dryRun }).trim();
  for (const line of assets.split(/\r?\n/).map((entry) => entry.trim()).filter(Boolean)) {
    const separator = line.indexOf('\t');
    if (separator <= 0) fail(`Invalid release asset row: ${line}`);
    const assetId = line.slice(0, separator);
    const name = line.slice(separator + 1);
    const bytes = runBuffer('gh', [
      'api',
      `repos/${repo}/releases/assets/${assetId}`,
      '-H',
      'Accept: application/octet-stream',
    ], { env, dryRun });
    if (!dryRun) await writeFile(join(destination, name), bytes);
  }
}

async function main() {
  const { values } = parseArgs({
    options: {
      'source-tag': { type: 'string' },
      'rolling-tag': { type: 'string' },
      title: { type: 'string' },
      'target-sha': { type: 'string' },
      prerelease: { type: 'string' },
      notes: { type: 'string', default: '' },
      'release-message': { type: 'string', default: '' },
      repo: { type: 'string', default: '' },
      'public-key': { type: 'string' },
      'dry-run': { type: 'boolean', default: false },
    },
    allowPositionals: false,
  });
  const sourceTag = String(values['source-tag'] ?? '').trim();
  const rollingTag = String(values['rolling-tag'] ?? '').trim();
  const title = String(values.title ?? '').trim();
  const targetSha = String(values['target-sha'] ?? '').trim().toLowerCase();
  const repo = String(values.repo ?? '').trim()
    || String(process.env.GH_REPO ?? '').trim()
    || String(process.env.GITHUB_REPOSITORY ?? '').trim();
  const publicKey = resolve(String(values['public-key'] ?? '').trim());
  const prerelease = parseBool(values.prerelease, '--prerelease');
  const notes = String(values.notes ?? '').trim();
  const releaseMessage = String(values['release-message'] ?? '').trim();
  const dryRun = values['dry-run'] === true;
  if (!sourceTag) fail('--source-tag is required');
  if (!rollingTag) fail('--rolling-tag is required');
  if (!title) fail('--title is required');
  if (!FULL_SHA.test(targetSha)) fail('--target-sha must be a full 40-character commit id');
  if (!repo) fail('--repo or GH_REPO/GITHUB_REPOSITORY is required');
  if (!String(values['public-key'] ?? '').trim()) fail('--public-key is required');

  const ghEnv = {
    GH_REPO: repo,
    ...(String(process.env.GH_TOKEN ?? '').trim() ? { GH_TOKEN: String(process.env.GH_TOKEN) } : {}),
  };
  const sourceDir = await mkdtemp(join(tmpdir(), 'happier-immutable-release-'));
  const auditDir = await mkdtemp(join(tmpdir(), 'happier-rolling-release-audit-'));
  try {
    const immutableSha = readTagSha({ repo, tag: sourceTag, env: ghEnv, dryRun });
    if (!dryRun && immutableSha !== targetSha) {
      fail(`Immutable source tag ${sourceTag} does not resolve to authorized SHA ${targetSha}.`);
    }
    run('gh', ['release', 'download', sourceTag, '--repo', repo, '--dir', sourceDir], { env: ghEnv, dryRun });
    if (!dryRun) {
      const { checksumsName } = await assertSignedBundle(sourceDir);
      run(process.execPath, [
        'scripts/pipeline/release/verify-artifacts.mjs',
        '--artifacts-dir', sourceDir,
        '--checksums', join(sourceDir, checksumsName),
        '--public-key', publicKey,
        '--skip-smoke',
      ]);
    }

    const oldRollingSha = readTagSha({ repo, tag: rollingTag, env: ghEnv, dryRun });
    const publishedReleaseId = run('gh', [
      'api', `repos/${repo}/releases/tags/${rollingTag}`, '--jq', '.id',
    ], {
      env: ghEnv,
      dryRun,
      allowFailure: true,
    }).trim();
    if (!dryRun && !publishedReleaseId && oldRollingSha && oldRollingSha !== targetSha) {
      fail(`Existing rolling draft tag ${rollingTag} does not resolve to authorized SHA ${targetSha}.`);
    }
    let draftReleaseId = publishedReleaseId
      ? ''
      : findDraftReleaseId({ repo, tag: rollingTag, env: ghEnv, dryRun });
    if (!publishedReleaseId && !draftReleaseId && !dryRun) {
      draftReleaseId = run('gh', [
        'api', '-X', 'POST', `repos/${repo}/releases`,
        '-f', `tag_name=${rollingTag}`,
        '-f', `target_commitish=${targetSha}`,
        '-f', `name=${title}`,
        '-f', 'body=',
        '-F', 'draft=true',
        '-F', `prerelease=${prerelease}`,
        '--jq', '.id',
      ], { env: ghEnv }).trim();
      if (!draftReleaseId) fail(`GitHub did not return an id for rolling draft release ${rollingTag}.`);
    }

    const releaseAssetEndpoint = draftReleaseId
      ? `repos/${repo}/releases/${draftReleaseId}`
      : `repos/${repo}/releases/tags/${rollingTag}`;
    const assetIds = run('gh', ['api', releaseAssetEndpoint, '--jq', '.assets[].id'], {
      env: ghEnv,
      dryRun,
    }).trim();
    for (const id of assetIds.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)) {
      run('gh', ['api', '-X', 'DELETE', `repos/${repo}/releases/assets/${id}`], { env: ghEnv, dryRun });
    }

    if (!dryRun) {
      const { names } = await assertSignedBundle(sourceDir);
      for (const name of names) {
        if (draftReleaseId) {
          run('gh', [
            'api',
            '--hostname', 'uploads.github.com',
            '-X', 'POST',
            `repos/${repo}/releases/${draftReleaseId}/assets?name=${encodeURIComponent(name)}`,
            '-H', 'Content-Type: application/octet-stream',
            '--input', join(sourceDir, name),
            '--silent',
          ], { env: ghEnv });
        } else {
          run('gh', ['release', 'upload', rollingTag, join(sourceDir, name), '--repo', repo], { env: ghEnv });
        }
      }
    } else {
      console.log(`[dry-run] upload every verified asset from ${sourceTag} to ${rollingTag}`);
    }

    if (draftReleaseId) {
      await downloadReleaseAssetsById({ repo, releaseId: draftReleaseId, destination: auditDir, env: ghEnv, dryRun });
    } else {
      run('gh', ['release', 'download', rollingTag, '--repo', repo, '--dir', auditDir], { env: ghEnv, dryRun });
    }
    if (!dryRun) {
      const { checksumsName } = await assertSignedBundle(auditDir);
      await assertDirectoriesEqual(sourceDir, auditDir);
      run(process.execPath, [
        'scripts/pipeline/release/verify-artifacts.mjs',
        '--artifacts-dir', auditDir,
        '--checksums', join(auditDir, checksumsName),
        '--public-key', publicKey,
        '--skip-smoke',
      ]);
    }

    if (!draftReleaseId) {
      if (oldRollingSha) {
        run('gh', [
          'api', '-X', 'PATCH', `repos/${repo}/git/refs/tags/${rollingTag}`,
          '-f', `sha=${targetSha}`, '-F', 'force=true',
        ], { env: ghEnv, dryRun });
      } else {
        run('gh', [
          'api', '-X', 'POST', `repos/${repo}/git/refs`,
          '-f', `ref=refs/tags/${rollingTag}`, '-f', `sha=${targetSha}`,
        ], { env: ghEnv, dryRun });
      }
    }

    const body = releaseMessage && notes ? `${releaseMessage}\n\n${notes}` : releaseMessage || notes;
    if (draftReleaseId) {
      run('gh', [
        'api', '-X', 'PATCH', `repos/${repo}/releases/${draftReleaseId}`,
        '-f', `tag_name=${rollingTag}`,
        '-f', `target_commitish=${targetSha}`,
        '-f', `name=${title}`,
        '-f', `body=${body}`,
        '-F', 'draft=false',
        '-F', `prerelease=${prerelease}`,
      ], { env: ghEnv, dryRun });
      const publishedRollingSha = readTagSha({ repo, tag: rollingTag, env: ghEnv, dryRun });
      if (!dryRun && publishedRollingSha !== targetSha) {
        fail(`Published rolling tag ${rollingTag} did not resolve to audited target ${targetSha}.`);
      }
    } else {
      run('gh', [...buildRollingReleaseEditArgs({ tag: rollingTag, title, notes: body }), '--repo', repo], {
        env: ghEnv,
        dryRun,
      });
    }
    console.log(`[pipeline] promoted immutable release ${sourceTag} to ${rollingTag} after exact remote audit.`);
  } finally {
    await Promise.all([
      rm(sourceDir, { recursive: true, force: true }),
      rm(auditDir, { recursive: true, force: true }),
    ]);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
