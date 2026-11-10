import type { AgentSessionHostServices, AgentSessionRuntimeContext } from '@happier-dev/plugin-sdk/agents/runtime';
import { MUSE_ACCOUNT_SERVICE_ID, museAccountDescriptor } from '../connectedAccounts/declarations.js';
import { mapMuseUsageObservationMeters, parseMuseUsageObservation } from '../connectedAccounts/observations.js';

/** Native allowance is evidence; the host owns source qualification, identity and publication. */
export async function recordMuseUsageObservation(input: Readonly<{
  params: unknown;
  accountUsage: AgentSessionHostServices['accountUsage'];
  sessionId: string;
  env?: Readonly<Record<string, string>>;
  signal: AbortSignal;
  logger: Pick<AgentSessionRuntimeContext['services']['logger'], 'warn'>;
}>): Promise<void> {
  const parsed = parseMuseUsageObservation({ usage: input.params });
  if (parsed.status !== 'supported') return;
  const source = await input.accountUsage.resolveSourceContext({ serviceId: MUSE_ACCOUNT_SERVICE_ID,
    env: input.env }, { signal: input.signal });
  const providerId = museAccountDescriptor.usageIdentity.providerId;
  const observation = parsed.observation;
  const result = await input.accountUsage.recordSnapshot({
    snapshot: { v: 1, providerId,
      recordKey: { providerId, accountSubjectId: input.sessionId, subjectKind: 'unknown', quotaScope: 'account' },
      accountSubject: { kind: 'provisionalLocalSubject', id: input.sessionId },
      observedAtMs: observation.observedAtMs, fetchedAtMs: observation.observedAtMs,
      // Protocol requires a positive horizon; use its minimum because MSP supplies no freshness promise.
      staleAfterMs: 1, source: 'runtimeSignal', confidence: 'confirmed', state: 'loaded_data',
      ...(observation.planLabel ? { planLabel: observation.planLabel } : {}),
      meters: mapMuseUsageObservationMeters(observation, 'provider_event'),
    },
    ...(source ? { source: { serviceId: source.serviceId, env: input.env } } : {}),
  }, { signal: input.signal });
  if (result.status !== 'recorded') input.logger.warn('Muse usage observation was not recorded', {
    status: result.status, reason: result.reason,
  });
}
