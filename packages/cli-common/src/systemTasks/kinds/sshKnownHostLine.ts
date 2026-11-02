import { computeSshHostKeyFingerprint } from '@happier-dev/protocol/ssh/hostTrust';

export interface ParsedSshKnownHostLine {
  host: string;
  keyType: string;
  key: string;
  line: string;
  fingerprint: string;
}

export function parseSshKnownHostLine(line: string): ParsedSshKnownHostLine | null {
  const normalizedLine = String(line ?? '').trim();
  if (!normalizedLine || normalizedLine.startsWith('#')) {
    return null;
  }
  const [host, keyType, key] = normalizedLine.split(/\s+/u);
  if (!host || !keyType || !key) {
    return null;
  }
  return {
    host,
    keyType,
    key,
    line: `${host} ${keyType} ${key}`,
    fingerprint: computeSshHostKeyFingerprint(key),
  };
}

export function extractFirstScannedSshKnownHostLine(output: string): ParsedSshKnownHostLine {
  const parsed = String(output ?? '')
    .split(/\r?\n/u)
    .map((line) => parseSshKnownHostLine(line))
    .find((line) => line != null);
  if (!parsed) {
    throw new Error('ssh-keyscan did not return a host key');
  }
  return parsed;
}
