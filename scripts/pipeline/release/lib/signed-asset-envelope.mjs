// @ts-check

import { existsSync } from 'node:fs';
import { rm, stat, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { basename, join, resolve } from 'node:path';

import { fileSha256 } from './artifact-checksums.mjs';
import { prepareMinisignSecretKeyFile } from './minisign-secret-key.mjs';

function fail(message) {
  throw new Error(`[release] ${message}`);
}

/**
 * @param {unknown} value
 * @param {string} label
 */
function requireFilenameSegment(value, label) {
  const segment = String(value ?? '').trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._+-]*$/.test(segment)) {
    fail(`${label} must be a safe release filename segment.`);
  }
  return segment;
}

/**
 * @param {unknown} value
 */
function requireFlatAssetName(value) {
  const name = String(value ?? '').trim();
  if (!name || basename(name) !== name || name === '.' || name === '..') {
    fail(`release asset name must be a non-empty flat filename: ${name || '<empty>'}`);
  }
  return name;
}

/**
 * @param {{ command: string; args: string[]; env: NodeJS.ProcessEnv; input?: string }} params
 */
function runChecked({ command, args, env, input }) {
  const result = spawnSync(command, args, {
    env,
    input,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  if (result.error) {
    const code = typeof result.error === 'object' && result.error && 'code' in result.error
      ? String(result.error.code ?? '')
      : '';
    if (code === 'ENOENT') fail(`${command} is required to sign the release asset envelope.`);
    throw result.error;
  }
  if (result.status !== 0) {
    const output = [result.stdout, result.stderr].map((value) => String(value ?? '').trim()).filter(Boolean).join('\n');
    fail(`${command} exited with status ${result.status}${output ? `: ${output}` : ''}`);
  }
}

/**
 * Create a checksum manifest and minisign signature for one flat GitHub Release asset set.
 *
 * The declared paths are the complete release envelope payload. Callers retain ownership of
 * constructing their surface-specific artifacts; this helper only binds those exact bytes.
 *
 * @param {{
 *   assetsDir: string;
 *   product: string;
 *   version: string;
 *   assetNames: readonly string[];
 *   trustedComment: string;
 *   env?: NodeJS.ProcessEnv;
 * }} params
 */
export async function createSignedReleaseAssetEnvelope(params) {
  const assetsDir = resolve(String(params.assetsDir ?? '').trim());
  const product = requireFilenameSegment(params.product, 'product');
  const version = requireFilenameSegment(params.version, 'version');
  const assetNames = [...new Set(params.assetNames.map(requireFlatAssetName))].sort((left, right) => left.localeCompare(right));
  if (assetNames.length !== params.assetNames.length) {
    fail('release asset names must be unique.');
  }
  if (assetNames.length === 0) fail('release asset envelope requires at least one asset.');

  const stats = await Promise.all(assetNames.map(async (name) => {
    const assetPath = join(assetsDir, name);
    const info = await stat(assetPath).catch(() => null);
    if (!info?.isFile()) fail(`declared release asset is missing or not a file: ${name}`);
    return { name, path: assetPath };
  }));

  const checksumsName = `checksums-${product}-v${version}.txt`;
  const signatureName = `${checksumsName}.minisig`;
  const checksumsPath = join(assetsDir, checksumsName);
  const signaturePath = join(assetsDir, signatureName);
  if (existsSync(checksumsPath) || existsSync(signaturePath)) {
    fail(`release asset envelope already exists for ${product} v${version}; reuse the immutable release instead of replacing it.`);
  }

  const checksumLines = await Promise.all(stats.map(async ({ name, path }) => `${await fileSha256(path)}  ${name}`));
  await writeFile(checksumsPath, `${checksumLines.join('\n')}\n`, 'utf8');

  const env = { ...process.env, ...(params.env ?? {}) };
  const keyRaw = String(env.MINISIGN_SECRET_KEY ?? '').trim();
  if (!keyRaw) {
    await rm(checksumsPath, { force: true });
    fail('MINISIGN_SECRET_KEY is required to sign a release asset envelope.');
  }
  const preparedKey = await prepareMinisignSecretKeyFile(keyRaw);
  const hasPassphrase = Object.prototype.hasOwnProperty.call(env, 'MINISIGN_PASSPHRASE');
  const passphrase = String(env.MINISIGN_PASSPHRASE ?? '');
  try {
    runChecked({
      command: 'minisign',
      args: [
        '-S',
        '-s',
        preparedKey.path,
        '-m',
        checksumsPath,
        '-x',
        signaturePath,
        '-t',
        String(params.trustedComment ?? '').trim(),
      ],
      env,
      input: hasPassphrase ? `${passphrase}\n` : undefined,
    });
  } catch (error) {
    await rm(checksumsPath, { force: true });
    throw error;
  } finally {
    if (preparedKey.temp) {
      await rm(preparedKey.cleanupPath ?? preparedKey.path, { recursive: true, force: true });
    }
  }
  if (!existsSync(signaturePath)) {
    await rm(checksumsPath, { force: true });
    fail(`minisign did not create ${signatureName}.`);
  }

  return { checksumsName, signatureName };
}
