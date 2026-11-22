// The existing usage-limit fingerprint stores the agent/provider id before its turn-specific parts.
export function readUsageLimitIssueFingerprintAgentId(fingerprint: string): string | undefined {
  const [kind, agentId] = fingerprint.split(':', 3);
  return kind === 'usage-limit' && agentId ? agentId : undefined;
}
