// @ts-check

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { readTauriMainBinaryName } from './channel-config.mjs';

const MAX_FILE_BYTES = 768 * 1024 * 1024;

const PLATFORM_LAYOUTS = Object.freeze({
  'linux-x86_64': { os: 'ubuntu-22.04', target: 'x86_64-unknown-linux-gnu', sidecar: 'hsetup-x86_64-unknown-linux-gnu', gzip: true },
  'windows-x86_64': { os: 'windows-latest', target: 'x86_64-pc-windows-msvc', sidecar: 'hsetup-x86_64-pc-windows-msvc.exe', gzip: false },
  'darwin-aarch64': { os: 'macos-latest', target: 'aarch64-apple-darwin', sidecar: 'hsetup-aarch64-apple-darwin', gzip: false },
  'darwin-x86_64': { os: 'macos-latest', target: 'x86_64-apple-darwin', sidecar: 'hsetup-x86_64-apple-darwin', gzip: false },
});

export const BUNDLE_CANDIDATE_PLATFORMS = Object.freeze(Object.keys(PLATFORM_LAYOUTS));

/** @param {Partial<Record<string, { id: number; digest: string }>>} artifacts
 * @param {Partial<Record<string, { id: number; digest: string }>>} [finalizedArtifacts] */
export function planBundleCandidates(artifacts, finalizedArtifacts = {}) {
  const include = Object.entries(PLATFORM_LAYOUTS).map(([platform, layout]) => ({
    os: layout.os,
    platform_key: platform,
    tauri_target: platform.startsWith('darwin-') ? layout.target : '',
    artifact_id: artifacts[platform]?.id ?? '',
    artifact_digest: artifacts[platform]?.digest ?? '',
  }));
  const finalize = include.filter((entry) => !finalizedArtifacts[entry.platform_key]);
  const build = finalize.filter((entry) => entry.artifact_id === '');
  const reused = include.filter((entry) => finalizedArtifacts[entry.platform_key]).map((entry) => ({
    platform_key: entry.platform_key,
    artifact_id: finalizedArtifacts[entry.platform_key].id,
    artifact_digest: finalizedArtifacts[entry.platform_key].digest,
  }));
  return { buildNeeded: build.length > 0, buildMatrix: { include: build },
    finalizeNeeded: finalize.length > 0, finalizeMatrix: { include: finalize },
    reuseNeeded: reused.length > 0, reuseMatrix: { include: reused } };
}

function sha256(filePath) {
  return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function assertRegularBoundedFile(filePath) {
  const stat = fs.lstatSync(filePath);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`candidate input must be a regular file: ${filePath}`);
  if (stat.size <= 0 || stat.size > MAX_FILE_BYTES) throw new Error(`candidate input size is outside the bounded envelope: ${filePath}`);
  return stat;
}

function expectedFiles(layout, options) {
  const binaryName = readTauriMainBinaryName({ environment: options.environment, tauriDir: path.join(options.uiDir, 'src-tauri') });
  const files = [
    { role: 'executable', name: `${binaryName}${options.platformKey.startsWith('windows-') ? '.exe' : ''}`, executable: true },
    { role: 'sidecar', name: layout.sidecar, executable: true },
  ];
  if (layout.gzip) files.push({ role: 'resource', name: `${layout.sidecar}.gz`, executable: false });
  return files;
}

function assertExactKeys(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`${label} has unexpected fields`);
}

function resolveLayout(platformKey, tauriTarget) {
  const layout = PLATFORM_LAYOUTS[platformKey];
  if (!layout) throw new Error(`unsupported platform key: ${platformKey}`);
  const expectedTauriTarget = platformKey.startsWith('darwin-') ? layout.target : '';
  if (tauriTarget !== expectedTauriTarget) {
    throw new Error(`unexpected Tauri target for ${platformKey}: ${tauriTarget || '<empty>'}`);
  }
  return layout;
}

export function packBundleCandidate(options) {
  const layout = resolveLayout(options.platformKey, options.tauriTarget);
  if (!/^[0-9a-f]{40}$/u.test(options.sourceSha)) throw new Error('source SHA must be a full lowercase Git SHA');
  if (!['preview', 'dev', 'production'].includes(options.environment)) throw new Error('unsupported environment');
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(options.uiVersion)) throw new Error('invalid UI version');
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(options.buildVersion)) throw new Error('invalid build version');

  const uiDir = path.resolve(options.uiDir);
  const releaseDir = path.join(uiDir, 'src-tauri', 'target', ...(options.tauriTarget ? [options.tauriTarget] : []), 'release');
  const binariesDir = path.join(uiDir, 'src-tauri', 'binaries');
  const outDir = path.resolve(options.outDir);
  const filesDir = path.join(outDir, 'files');
  fs.mkdirSync(filesDir, { recursive: true });

  const manifestFiles = expectedFiles(layout, options).map((entry) => {
    const source = entry.role === 'executable'
      ? path.join(releaseDir, entry.name)
      : path.join(binariesDir, entry.name);
    const stat = assertRegularBoundedFile(source);
    const destination = path.join(filesDir, entry.name);
    fs.copyFileSync(source, destination);
    if (entry.executable && process.platform !== 'win32') fs.chmodSync(destination, 0o755);
    return { ...entry, size: stat.size, sha256: sha256(source) };
  });

  const manifest = {
    schema: 1,
    sourceSha: options.sourceSha,
    environment: options.environment,
    uiVersion: options.uiVersion,
    buildVersion: options.buildVersion,
    platformKey: options.platformKey,
    tauriTarget: options.tauriTarget,
    files: manifestFiles,
  };
  fs.writeFileSync(path.join(outDir, 'candidate.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  return manifest;
}

export function materializeBundleCandidate(options) {
  const layout = resolveLayout(options.platformKey, options.tauriTarget);
  const candidateDir = path.resolve(options.candidateDir);
  const manifest = JSON.parse(fs.readFileSync(path.join(candidateDir, 'candidate.json'), 'utf8'));
  assertExactKeys(manifest, ['schema', 'sourceSha', 'environment', 'uiVersion', 'buildVersion', 'platformKey', 'tauriTarget', 'files'], 'candidate manifest');
  if (manifest.schema !== 1) throw new Error('unsupported candidate manifest schema');
  for (const [field, expected] of [
    ['sourceSha', options.sourceSha],
    ['environment', options.environment],
    ['uiVersion', options.uiVersion],
    ['buildVersion', options.buildVersion],
    ['platformKey', options.platformKey],
    ['tauriTarget', options.tauriTarget],
  ]) {
    if (manifest[field] !== expected) throw new Error(`candidate ${field} does not match the trusted workflow input`);
  }

  const expected = expectedFiles(layout, options);
  if (!Array.isArray(manifest.files) || manifest.files.length !== expected.length) throw new Error('candidate file list is not exact');
  const filesDir = path.join(candidateDir, 'files');
  const onDiskNames = fs.readdirSync(filesDir).sort();
  if (JSON.stringify(onDiskNames) !== JSON.stringify(expected.map((entry) => entry.name).sort())) {
    throw new Error('candidate files directory contains unexpected entries');
  }

  const uiDir = path.resolve(options.uiDir);
  const releaseDir = path.join(uiDir, 'src-tauri', 'target', ...(options.tauriTarget ? [options.tauriTarget] : []), 'release');
  const binariesDir = path.join(uiDir, 'src-tauri', 'binaries');
  fs.mkdirSync(releaseDir, { recursive: true });
  fs.mkdirSync(binariesDir, { recursive: true });

  for (let index = 0; index < expected.length; index += 1) {
    const descriptor = manifest.files[index];
    const expectedDescriptor = expected[index];
    assertExactKeys(descriptor, ['role', 'name', 'executable', 'size', 'sha256'], `candidate file ${index}`);
    for (const field of ['role', 'name', 'executable']) {
      if (descriptor[field] !== expectedDescriptor[field]) throw new Error(`candidate file ${index} ${field} is not exact`);
    }
    if (!Number.isSafeInteger(descriptor.size) || descriptor.size <= 0 || descriptor.size > MAX_FILE_BYTES) throw new Error('candidate file size is invalid');
    if (!/^[0-9a-f]{64}$/u.test(descriptor.sha256)) throw new Error('candidate file hash is invalid');
    const source = path.join(filesDir, expectedDescriptor.name);
    const stat = assertRegularBoundedFile(source);
    if (stat.size !== descriptor.size || sha256(source) !== descriptor.sha256) throw new Error(`candidate file integrity mismatch: ${expectedDescriptor.name}`);
    const destination = expectedDescriptor.role === 'executable'
      ? path.join(releaseDir, expectedDescriptor.name)
      : path.join(binariesDir, expectedDescriptor.name);
    fs.copyFileSync(source, destination);
    if (expectedDescriptor.executable && process.platform !== 'win32') fs.chmodSync(destination, 0o755);
  }
}

function main() {
  const { values } = parseArgs({
    options: {
      mode: { type: 'string' },
      'resume-artifacts-json': { type: 'string', default: '{}' },
      'resume-finalized-artifacts-json': { type: 'string', default: '{}' },
      'github-output': { type: 'string' },
      'platform-key': { type: 'string' },
      'source-sha': { type: 'string', default: '' },
      'expected-source-sha': { type: 'string', default: '' },
      environment: { type: 'string', default: '' },
      'expected-environment': { type: 'string', default: '' },
      'ui-version': { type: 'string', default: '' },
      'expected-ui-version': { type: 'string', default: '' },
      'build-version': { type: 'string', default: '' },
      'expected-build-version': { type: 'string', default: '' },
      'tauri-target': { type: 'string', default: '' },
      'ui-dir': { type: 'string', default: 'apps/ui' },
      'out-dir': { type: 'string', default: '' },
      'candidate-dir': { type: 'string', default: '' },
    },
    allowPositionals: false,
  });
  if (values.mode === 'plan') {
    const planned = planBundleCandidates(JSON.parse(String(values['resume-artifacts-json'])),
      JSON.parse(String(values['resume-finalized-artifacts-json'])));
    if (values['github-output']) {
      fs.appendFileSync(String(values['github-output']),
        `build_needed=${planned.buildNeeded}\nbuild_matrix=${JSON.stringify(planned.buildMatrix)}\nfinalize_needed=${planned.finalizeNeeded}\nfinalize_matrix=${JSON.stringify(planned.finalizeMatrix)}\nreuse_needed=${planned.reuseNeeded}\nreuse_matrix=${JSON.stringify(planned.reuseMatrix)}\n`);
    }
    console.log(JSON.stringify(planned));
    return;
  }
  const platformKey = String(values['platform-key'] ?? '').trim();
  const tauriTarget = String(values['tauri-target'] ?? '').trim();
  const uiDir = String(values['ui-dir'] ?? '').trim() || 'apps/ui';
  if (values.mode === 'pack') {
    packBundleCandidate({ platformKey, tauriTarget, uiDir, sourceSha: String(values['source-sha']), environment: String(values.environment), uiVersion: String(values['ui-version']), buildVersion: String(values['build-version']), outDir: String(values['out-dir']) });
    return;
  }
  if (values.mode === 'materialize') {
    materializeBundleCandidate({ platformKey, tauriTarget, uiDir, sourceSha: String(values['expected-source-sha']), environment: String(values['expected-environment']), uiVersion: String(values['expected-ui-version']), buildVersion: String(values['expected-build-version']), candidateDir: String(values['candidate-dir']) });
    return;
  }
  throw new Error('--mode must be pack or materialize');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
