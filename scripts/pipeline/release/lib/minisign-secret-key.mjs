// @ts-check

import { chmod, mkdtemp, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * @param {string} raw
 */
export async function prepareMinisignSecretKeyFile(raw) {
  const value = String(raw ?? '').trim();
  if (!value) {
    throw new Error('[release] MINISIGN_SECRET_KEY is empty');
  }

  // minisign secret keys are multi-line. When operators try to paste them into dotenv files,
  // only the first line often survives, leading to confusing minisign errors later.
  if (value.startsWith('untrusted comment:') && !/[\r\n]/.test(value)) {
    throw new Error(
      '[release] MINISIGN_SECRET_KEY looks truncated (dotenv files cannot reliably store multiline minisign keys). ' +
        'Set MINISIGN_SECRET_KEY to a file path containing the full secret key, or load it via Keychain secrets.',
    );
  }

  const looksLikePath = !value.includes('\n') && !value.includes('\r');
  if (looksLikePath) {
    const info = await stat(value).catch(() => null);
    if (info?.isFile()) {
      return { path: value, temp: false, cleanupPath: null };
    }

    // If this looks like a path but doesn't exist, fail fast with guidance instead of writing
    // an invalid one-line key file and letting minisign error later.
    if (value.includes('/') || value.includes('\\') || value.endsWith('.key')) {
      throw new Error(`[release] MINISIGN_SECRET_KEY points to a missing file: ${value}`);
    }
    if (value.length < 128) {
      throw new Error(
        '[release] MINISIGN_SECRET_KEY looks truncated (dotenv files cannot reliably store multiline minisign keys). ' +
          'Set MINISIGN_SECRET_KEY to a file path containing the full secret key, or load it via Keychain secrets.',
      );
    }
  }

  const tempDir = await mkdtemp(join(tmpdir(), 'happier-minisign-key-'));
  const keyPath = join(tempDir, 'release.key');
  await writeFile(keyPath, `${value.endsWith('\n') ? value : `${value}\n`}`, 'utf-8');
  await chmodBestEffort600(keyPath);
  return { path: keyPath, temp: true, cleanupPath: tempDir };
}

/**
 * @param {string} path
 */
async function chmodBestEffort600(path) {
  try {
    await chmod(path, 0o600);
  } catch {
    // ignore on platforms where chmod is unavailable
  }
}
