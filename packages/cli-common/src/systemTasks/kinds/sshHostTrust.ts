import { createHash } from 'node:crypto';

export interface ParsedSshKnownHostLine {
  host: string;
  keyType: string;
  key: string;
  line: string;
  fingerprint: string;
}

export type ResolvedSshHostTrust =
  | Readonly<{
      status: 'trusted';
      scanned: ParsedSshKnownHostLine;
      nextKnownHostsText: string;
    }>
  | Readonly<{
      status: 'rejected';
      reason: 'invalidTrustedHostKey' | 'trustedHostKeyMismatch';
      scanned: ParsedSshKnownHostLine;
      message: string;
      trustedFingerprint?: string;
    }>
  | Readonly<{
      status: 'prompt';
      promptKind: 'ssh.trustHost' | 'ssh.replaceHostKey';
      scanned: ParsedSshKnownHostLine;
      nextKnownHostsText: string;
      existingFingerprint?: string;
    }>;

function computeSshFingerprint(key: string): string {
  const digest = createHash('sha256')
    .update(Buffer.from(String(key ?? '').trim(), 'base64'))
    .digest('base64')
    .replace(/=+$/u, '');
  return `SHA256:${digest}`;
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
    fingerprint: computeSshFingerprint(key),
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

function parseKnownHostsText(text: string): ParsedSshKnownHostLine[] {
  return String(text ?? '')
    .split(/\r?\n/u)
    .map((line) => parseSshKnownHostLine(line))
    .filter((line): line is ParsedSshKnownHostLine => line != null);
}

function renderKnownHostsText(entries: readonly ParsedSshKnownHostLine[]): string {
  return entries.map((entry) => entry.line).join('\n');
}

function splitKnownHostsHostToken(hostToken: string): readonly string[] {
  return String(hostToken ?? '')
    .split(',')
    .map((token) => token.trim())
    .filter((token) => token.length > 0);
}

function hostTokenContains(hostToken: string, host: string): boolean {
  const normalized = String(host ?? '').trim();
  if (!normalized) return false;
  return splitKnownHostsHostToken(hostToken).some((token) => token === normalized);
}

function replaceHostEntries(
  entries: readonly ParsedSshKnownHostLine[],
  matchHost: string,
  nextEntry: ParsedSshKnownHostLine,
): string {
  return renderKnownHostsText([
    ...entries.filter((entry) => !(entry.keyType === nextEntry.keyType && hostTokenContains(entry.host, matchHost))),
    nextEntry,
  ]);
}

export function resolveSshKnownHostTrust(params: Readonly<{
  knownHostsText?: string;
  scannedHostKeyLine: string;
  trustedHostKey?: string;
}>): ResolvedSshHostTrust {
  const scanned = parseSshKnownHostLine(params.scannedHostKeyLine);
  if (!scanned) {
    throw new Error('ssh-keyscan returned an invalid host key line');
  }

  const entries = parseKnownHostsText(params.knownHostsText ?? '');
  const persistedEntry = entries.find((entry) => entry.keyType === scanned.keyType && hostTokenContains(entry.host, scanned.host));
  const trustedHostKey = String(params.trustedHostKey ?? '').trim();

  if (trustedHostKey) {
    const trustedEntry = parseSshKnownHostLine(trustedHostKey);
    if (!trustedEntry) {
      return {
        status: 'rejected',
        reason: 'invalidTrustedHostKey',
        scanned,
        message: 'Explicit trusted host key is invalid.',
      };
    }

    if (
      trustedEntry.host !== scanned.host
      || trustedEntry.keyType !== scanned.keyType
      || trustedEntry.key !== scanned.key
    ) {
      return {
        status: 'rejected',
        reason: 'trustedHostKeyMismatch',
        scanned,
        message: `Explicit trusted host key does not match fresh SSH host scan for ${scanned.host}.`,
        trustedFingerprint: trustedEntry.fingerprint,
      };
    }

    return {
      status: 'trusted',
      scanned,
      nextKnownHostsText: replaceHostEntries(entries, scanned.host, scanned),
    };
  }

  if (persistedEntry) {
    if (persistedEntry.key === scanned.key) {
      return {
        status: 'trusted',
        scanned,
        nextKnownHostsText: renderKnownHostsText(entries),
      };
    }
    const nextLine = `${persistedEntry.host} ${scanned.keyType} ${scanned.key}`;
    const nextEntry = parseSshKnownHostLine(nextLine);
    if (!nextEntry) {
      throw new Error('Unable to build replacement known_hosts entry');
    }
    return {
      status: 'prompt',
      promptKind: 'ssh.replaceHostKey',
      scanned,
      existingFingerprint: persistedEntry.fingerprint,
      nextKnownHostsText: replaceHostEntries(entries, scanned.host, nextEntry),
    };
  }

  return {
    status: 'prompt',
    promptKind: 'ssh.trustHost',
    scanned,
    nextKnownHostsText: replaceHostEntries(entries, scanned.host, scanned),
  };
}
