export type CodexUsageLimitSuppressionDecision =
  | Readonly<{ kind: 'proceed' }>
  | Readonly<{ kind: 'wait_until_reset'; nextCheckAtMs: number }>;

type CodexUsageLimitSuppressionStore = Readonly<{
  getActiveSuppression(input: Readonly<{
    serviceId: string;
    accountId: string;
    resetAtMs: number | null;
  }>): Readonly<{
    resetAtMs: number | null;
    expiresAtMs: number;
  }> | null;
}>;

function normalizeAccountId(value: string | null | undefined): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

export function resolveCodexUsageLimitSuppressionWait(input: Readonly<{
  suppression: CodexUsageLimitSuppressionStore;
  serviceId: string;
  accountId: string | null | undefined;
  resetAtMs: number | null;
  nowMs: number;
}>): CodexUsageLimitSuppressionDecision {
  const accountId = normalizeAccountId(input.accountId);
  if (!accountId) return { kind: 'proceed' };

  const active = input.suppression.getActiveSuppression({
    serviceId: input.serviceId,
    accountId,
    resetAtMs: input.resetAtMs,
  });
  if (!active) return { kind: 'proceed' };

  return {
    kind: 'wait_until_reset',
    nextCheckAtMs: active.resetAtMs ?? active.expiresAtMs,
  };
}
