import { resolveSshHostTrust } from '@happier-dev/protocol/ssh/hostTrust';
import { SystemTaskExecutionError } from '../runSystemTask.js';
import { parseSshKnownHostLine, type ParsedSshKnownHostLine } from './sshKnownHostLine.js';
import type { SystemTaskSshConnectionConfig } from './relayRuntimeKinds.js';

export { extractFirstScannedSshKnownHostLine, parseSshKnownHostLine, type ParsedSshKnownHostLine } from './sshKnownHostLine.js';

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

export function parseKnownHostsText(text: string): ParsedSshKnownHostLine[] {
  return String(text ?? '')
    .split(/\r?\n/u)
    .map((line) => parseSshKnownHostLine(line))
    .filter((line): line is ParsedSshKnownHostLine => line != null);
}

function splitKnownHostsHostToken(hostToken: string): readonly string[] {
  return String(hostToken ?? '')
    .split(',')
    .map((token) => token.trim())
    .filter((token) => token.length > 0);
}

export function hostTokenContains(hostToken: string, host: string): boolean {
  const normalized = String(host ?? '').trim();
  if (!normalized) return false;
  return splitKnownHostsHostToken(hostToken).some((token) => token === normalized);
}

function replaceHostEntries(
  text: string,
  matchHost: string,
  nextEntry: ParsedSshKnownHostLine,
): string {
  const retained = (text.match(/[^\n]*\n|[^\n]+$/gu) ?? []).filter(line => {
    const entry = parseSshKnownHostLine(line);
    return !(entry?.keyType === nextEntry.keyType && hostTokenContains(entry.host, matchHost));
  }).join('');
  const newline = text.includes('\r\n') ? '\r\n' : '\n';
  return `${retained}${retained && !retained.endsWith('\n') ? newline : ''}${nextEntry.line}`;
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

    const trust = resolveSshHostTrust({
      host: scanned.host,
      port: 22,
      algorithm: scanned.keyType,
      fingerprintSha256: scanned.fingerprint,
      trusted: {
        host: trustedEntry.host,
        port: 22,
        algorithm: trustedEntry.keyType,
        fingerprintSha256: trustedEntry.fingerprint,
      },
    });
    if (trust.status !== 'trusted' || trustedEntry.key !== scanned.key) {
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
      nextKnownHostsText: replaceHostEntries(params.knownHostsText ?? '', scanned.host, scanned),
    };
  }

  if (persistedEntry) {
    const trust = resolveSshHostTrust({
      host: scanned.host,
      port: 22,
      algorithm: scanned.keyType,
      fingerprintSha256: scanned.fingerprint,
      trusted: {
        host: persistedEntry.host,
        port: 22,
        algorithm: persistedEntry.keyType,
        fingerprintSha256: persistedEntry.fingerprint,
      },
    });
    if (trust.status === 'trusted' && persistedEntry.key === scanned.key) {
      return {
        status: 'trusted',
        scanned,
        nextKnownHostsText: params.knownHostsText ?? '',
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
      nextKnownHostsText: replaceHostEntries(params.knownHostsText ?? '', scanned.host, nextEntry),
    };
  }

  return {
    status: 'prompt',
    promptKind: 'ssh.trustHost',
    scanned,
    nextKnownHostsText: replaceHostEntries(params.knownHostsText ?? '', scanned.host, scanned),
  };
}

/** Explicit pins authorize this connection only; provider observations never grant trust. */
export function resolveSshBootstrapHostKeyPin(
  params: Pick<SystemTaskSshConnectionConfig, 'trustedHostKey' | 'hostKeyEvidence'>,
): string | undefined {
  if (params.trustedHostKey === undefined) return undefined;
  let trusted: ParsedSshKnownHostLine | null;
  try {
    trusted = parseSshKnownHostLine(params.trustedHostKey);
  } catch {
    trusted = null;
  }
  if (!trusted) {
    throw new SystemTaskExecutionError('invalid_trusted_host_key', 'Explicit trusted host key is invalid.');
  }
  const evidence = params.hostKeyEvidence;
  if (evidence) {
    let observed: ParsedSshKnownHostLine | null;
    try {
      observed = parseSshKnownHostLine(evidence.hostKey);
    } catch {
      observed = null;
    }
    if (!observed || observed.fingerprint !== evidence.fingerprint.trim()) {
      throw new SystemTaskExecutionError('trusted_host_key_mismatch', 'SSH host key evidence does not match its fingerprint.');
    }
    const resolution = resolveSshKnownHostTrust({
      scannedHostKeyLine: observed.line,
      trustedHostKey: trusted.line,
    });
    if (resolution.status !== 'trusted') {
      throw new SystemTaskExecutionError('trusted_host_key_mismatch', 'SSH host key evidence does not match the explicit trusted host key.');
    }
  }
  return trusted.fingerprint;
}
