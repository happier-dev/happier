import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

type SshKnownHostEntry = Readonly<{
  host: string;
  keyType: string;
  key: string;
}>;

export type SshKnownHostStatus = 'added' | 'unchanged' | 'mismatch';

export type SshKnownHostRememberResult = Readonly<{
  status: SshKnownHostStatus;
  fingerprint: string;
  existingFingerprint?: string;
}>;

function computeSshFingerprint(key: string): string {
  const digest = createHash('sha256')
    .update(Buffer.from(String(key ?? '').trim(), 'base64'))
    .digest('base64')
    .replace(/=+$/u, '');
  return `SHA256:${digest}`;
}

function parseKnownHosts(text: string): SshKnownHostEntry[] {
  return String(text ?? '')
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
    .flatMap((line) => {
      const [host, keyType, key] = line.split(/\s+/u);
      if (!host || !keyType || !key) return [];
      return [{ host, keyType, key }];
    });
}

function renderKnownHosts(entries: readonly SshKnownHostEntry[]): string {
  return entries.map((entry) => `${entry.host} ${entry.keyType} ${entry.key}`).join('\n');
}

export function normalizeKnownHostsText(text: string): string {
  const normalized = String(text ?? '').trimEnd();
  return normalized ? `${normalized}${text.includes('\r\n') ? '\r\n' : '\n'}` : '';
}

export function readKnownHostsTextSync(knownHostsPath: string | undefined): string {
  return readKnownHostsTextSyncWithFs(knownHostsPath);
}

export function readKnownHostsTextSyncWithFs(
  knownHostsPath: string | undefined,
  fsDeps: Readonly<Pick<typeof import('node:fs'), 'readFileSync'>> = { readFileSync },
): string {
  if (!knownHostsPath) return '';
  try {
    return fsDeps.readFileSync(knownHostsPath, 'utf8');
  } catch {
    return '';
  }
}

export function writeKnownHostsTextSync(knownHostsPath: string | undefined, text: string | ((currentText: string) => string)): void {
  return writeKnownHostsTextSyncWithFs(knownHostsPath, text);
}

export function writeKnownHostsTextSyncWithFs(
  knownHostsPath: string | undefined,
  text: string | ((currentText: string) => string),
  fsDeps: Readonly<Pick<typeof import('node:fs'), 'readFileSync' | 'mkdirSync' | 'writeFileSync' | 'chmodSync' | 'renameSync' | 'unlinkSync'>>
    = { readFileSync, mkdirSync, writeFileSync, chmodSync, renameSync, unlinkSync },
): void {
  if (!knownHostsPath) return;
  let nextText: string;
  if (typeof text === 'function') {
    let currentText = '';
    try {
      currentText = fsDeps.readFileSync(knownHostsPath, 'utf8');
    } catch (error) {
      // Only an absent file is an empty trust store. An unreadable store must not be replaced.
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    nextText = text(currentText);
    if (nextText === currentText) return;
  } else {
    nextText = text;
  }
  // No await separates reading, merging and replacement: approvals in this process
  // cannot interleave a second read/write within the current-file update.
  fsDeps.mkdirSync(dirname(knownHostsPath), { recursive: true, mode: 0o700 });
  const temporaryPath = `${knownHostsPath}.${randomUUID()}.tmp`;
  try {
    fsDeps.writeFileSync(temporaryPath, normalizeKnownHostsText(nextText), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    fsDeps.renameSync(temporaryPath, knownHostsPath);
  } finally {
    try { fsDeps.unlinkSync(temporaryPath); } catch { /* Renamed or already absent. */ }
  }
}

export async function readKnownHostsText(knownHostsPath: string | undefined): Promise<string> {
  if (!knownHostsPath) return '';
  try {
    return await readFile(knownHostsPath, 'utf8');
  } catch {
    return '';
  }
}

export async function writeKnownHostsText(knownHostsPath: string | undefined, text: string): Promise<void> {
  if (!knownHostsPath) return;
  await mkdir(dirname(knownHostsPath), { recursive: true, mode: 0o700 });
  await writeFile(knownHostsPath, normalizeKnownHostsText(text), { encoding: 'utf8', mode: 0o600 });
  await chmod(knownHostsPath, 0o600).catch(() => {});
}

export class SshKnownHostsStore {
  private entries: SshKnownHostEntry[];

  constructor(params: Readonly<{ initialText?: string }> = {}) {
    this.entries = parseKnownHosts(params.initialText ?? '');
  }

  private static normalizeKnownHostToken(value: unknown, field: 'host' | 'keyType' | 'key'): string {
    const normalized = String(value ?? '').trim();
    if (!normalized) {
      throw new Error(`${field} is required`);
    }
    if (normalized.startsWith('-')) {
      throw new Error(`${field} must not start with "-"`);
    }
    if (/\s/u.test(normalized)) {
      throw new Error(`${field} must not contain whitespace`);
    }
    return normalized;
  }

  remember(params: Readonly<{
    host: string;
    keyType: string;
    key: string;
  }>): SshKnownHostRememberResult {
    const entry: SshKnownHostEntry = {
      host: SshKnownHostsStore.normalizeKnownHostToken(params.host, 'host'),
      keyType: SshKnownHostsStore.normalizeKnownHostToken(params.keyType, 'keyType'),
      key: SshKnownHostsStore.normalizeKnownHostToken(params.key, 'key'),
    };
    const fingerprint = computeSshFingerprint(entry.key);
    const existing = this.entries.find((candidate) => candidate.host === entry.host && candidate.keyType === entry.keyType);
    if (!existing) {
      this.entries.push(entry);
      return { status: 'added', fingerprint };
    }

    const existingFingerprint = computeSshFingerprint(existing.key);
    if (existing.key === entry.key) {
      return { status: 'unchanged', fingerprint };
    }

    return {
      status: 'mismatch',
      fingerprint,
      existingFingerprint,
    };
  }

  forget(host: string): void {
    const normalizedHost = String(host ?? '').trim();
    this.entries = this.entries.filter((entry) => entry.host !== normalizedHost);
  }

  toString(): string {
    return renderKnownHosts(this.entries);
  }
}
