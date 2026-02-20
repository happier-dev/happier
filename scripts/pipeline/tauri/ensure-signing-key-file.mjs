// @ts-check

import fs from 'node:fs';
import path from 'node:path';

/**
 * @param {{ tmpRoot: string; keyValue: string; dryRun: boolean }} opts
 * @returns {string}
 */
export function ensureTauriSigningKeyFile(opts) {
  const raw = String(opts.keyValue ?? '').trim();
  if (!raw) return '';

  const asPath = path.resolve(raw);
  if (fs.existsSync(asPath) && fs.statSync(asPath).isFile()) {
    return asPath;
  }

  const looksLikePath =
    raw.includes('/') ||
    raw.includes('\\') ||
    raw.startsWith('.') ||
    raw.endsWith('.key') ||
    raw.endsWith('.txt') ||
    raw.endsWith('.pem');
  const looksLikeInline =
    raw.includes('\n') || raw.includes('\\n') || raw.startsWith('untrusted comment:') || raw.includes('BEGIN ');

  if (looksLikePath && !looksLikeInline) {
    if (opts.dryRun) return asPath;
    throw new Error(`TAURI_SIGNING_PRIVATE_KEY points at a missing file path: ${raw}`);
  }

  const normalized = raw.includes('\\n') ? raw.replaceAll('\\n', '\n') : raw;
  const withNewline = normalized.endsWith('\n') ? normalized : `${normalized}\n`;

  const tmpRoot = path.resolve(String(opts.tmpRoot ?? '').trim() || process.cwd());
  const outPath = path.join(tmpRoot, 'tauri.signing.key');

  if (!opts.dryRun) {
    fs.mkdirSync(tmpRoot, { recursive: true });
    fs.writeFileSync(outPath, withNewline, { encoding: 'utf8', mode: 0o600 });
    try {
      fs.chmodSync(outPath, 0o600);
    } catch {
      // best effort
    }
  }

  return outPath;
}
