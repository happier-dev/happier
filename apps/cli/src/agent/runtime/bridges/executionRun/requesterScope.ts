import type { RequesterWorkAttributionV1 } from '@/daemon/lifecycle/requesterWorkAttribution';

/** Explicit Run ownership wins; unattributed 0.2 Runs belong to the installed Account. */
export function resolveExecutionRunRequesterAccountId(
  run: Readonly<{ requesterWorkAttributionV1?: Pick<RequesterWorkAttributionV1, 'accountId'> }>,
  installedAccountId?: string,
): string | undefined {
  return run.requesterWorkAttributionV1?.accountId ?? installedAccountId;
}

export function isExecutionRunInRequesterAccountScope(
  run: Readonly<{ requesterWorkAttributionV1?: Pick<RequesterWorkAttributionV1, 'accountId'> }>,
  requesterAccountId: string | undefined,
  installedAccountId?: string,
): boolean {
  const ownerAccountId = resolveExecutionRunRequesterAccountId(run, installedAccountId);
  return Boolean(requesterAccountId && ownerAccountId === requesterAccountId);
}
