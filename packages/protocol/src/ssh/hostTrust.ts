export type SshHostTrustPromptKind = 'ssh.trustHost' | 'ssh.replaceHostKey';

export type SshTrustedHostKey = Readonly<{
  host: string;
  port: number;
  algorithm: string;
  fingerprintSha256: string;
}>;

export type ResolvedSshHostTrust =
  | Readonly<{ status: 'trusted' }>
  | Readonly<{
    status: 'prompt';
    promptKind: SshHostTrustPromptKind;
    existingFingerprintSha256?: string;
  }>;

export function normalizeSshHostTrustHost(host: string): string {
  return String(host ?? '').trim().toLowerCase();
}

export function normalizeSshHostKeyAlgorithm(algorithm: string): string {
  return String(algorithm ?? '').trim();
}

export function normalizeSshHostKeyFingerprintSha256(fingerprintSha256: string): string {
  return String(fingerprintSha256 ?? '').trim();
}

export function buildSshHostTrustKey(params: Readonly<{
  host: string;
  port: number;
  algorithm: string;
}>): string {
  return [
    normalizeSshHostTrustHost(params.host),
    normalizeSshHostTrustPort(params.port),
    normalizeSshHostKeyAlgorithm(params.algorithm),
  ].join(':');
}

export function normalizeSshHostTrustPort(port: number): number {
  return Number.isInteger(port) && port > 0 && port <= 65_535 ? port : 22;
}

export function resolveSshHostTrust(params: Readonly<{
  host: string;
  port: number;
  algorithm: string;
  fingerprintSha256: string;
  trusted?: SshTrustedHostKey | null;
}>): ResolvedSshHostTrust {
  const trusted = params.trusted ?? null;
  if (!trusted) {
    return {
      status: 'prompt',
      promptKind: 'ssh.trustHost',
    };
  }

  const observedKey = buildSshHostTrustKey(params);
  const trustedKey = buildSshHostTrustKey(trusted);
  const observedFingerprint = normalizeSshHostKeyFingerprintSha256(params.fingerprintSha256);
  const trustedFingerprint = normalizeSshHostKeyFingerprintSha256(trusted.fingerprintSha256);
  if (observedKey === trustedKey && observedFingerprint === trustedFingerprint) {
    return { status: 'trusted' };
  }

  return {
    status: 'prompt',
    promptKind: 'ssh.replaceHostKey',
    existingFingerprintSha256: trustedFingerprint || undefined,
  };
}
