import {
  deriveProviderConnectionSummaryHealthV1,
  type ProviderEndpointRuntimeStateV1,
  type ProviderEndpointRuntimeStateRecordV1,
} from '@happier-dev/protocol';

import type { ProviderConnectionRuntimeSummary } from './service';

type CurrentProviderEndpointHealthInput = Readonly<{
  machineId: string;
  connectionId: string;
  expectedEndpoints: readonly Readonly<{
    endpointTemplateId: string;
    endpointFingerprint: string;
  }>[];
  allowedObservationAuthorizationFingerprints: readonly string[];
  endpointHealth: readonly ProviderEndpointRuntimeStateRecordV1[];
}>;

type CurrentProviderEndpointHealthSelection = Readonly<{
  state: ProviderEndpointRuntimeStateV1;
  activity: ProviderEndpointRuntimeStateV1['activity'];
  observedAt: number;
  expectedOrder: number;
  authorizationFingerprint: string;
}>;

/** Selects one aggregate state per endpoint from the current request and authorization facts. */
export function selectCurrentProviderEndpointHealthByTemplateId(
  input: CurrentProviderEndpointHealthInput,
): ReadonlyMap<string, ProviderEndpointRuntimeStateV1> {
  const expectedOrderByKey = new Map(input.expectedEndpoints.map((endpoint, index) => [
    JSON.stringify([endpoint.endpointTemplateId, endpoint.endpointFingerprint]),
    index,
  ]));
  const allowedAuthorization = new Set(input.allowedObservationAuthorizationFingerprints);
  const selections = new Map<string, CurrentProviderEndpointHealthSelection>();
  for (const record of input.endpointHealth) {
    const expectedOrder = expectedOrderByKey.get(
      JSON.stringify([record.key.endpointTemplateId, record.key.endpointFingerprint]),
    );
    if (record.key.machineId !== input.machineId
      || record.key.connectionId !== input.connectionId
      || expectedOrder === undefined
      || !allowedAuthorization.has(record.key.observationAuthorizationFingerprint)) continue;
    const previous = selections.get(record.key.endpointTemplateId);
    const observedAt = 'observedAt' in record.state ? record.state.observedAt : -1;
    const activity = previous?.activity === 'checking' || record.state.activity === 'checking'
      ? 'checking' as const
      : 'idle' as const;
    const authorizationFingerprint = record.key.observationAuthorizationFingerprint;
    const replacesPrevious = !previous
      || observedAt > previous.observedAt
      || (observedAt === previous.observedAt && expectedOrder > previous.expectedOrder)
      || (observedAt === previous.observedAt
        && expectedOrder === previous.expectedOrder
        && authorizationFingerprint > previous.authorizationFingerprint);
    if (replacesPrevious) {
      selections.set(record.key.endpointTemplateId, {
        state: record.state,
        activity,
        observedAt,
        expectedOrder,
        authorizationFingerprint,
      });
    } else if (activity !== previous.activity) {
      selections.set(record.key.endpointTemplateId, { ...previous, activity });
    }
  }
  return new Map([...selections].map(([endpointTemplateId, selection]) => [
    endpointTemplateId,
    selection.state.activity === selection.activity
      ? selection.state
      : { ...selection.state, activity: selection.activity },
  ]));
}

export function selectProviderConnectionRuntimeSummary(input: CurrentProviderEndpointHealthInput & Readonly<{
  modelCount: number | null;
}>): ProviderConnectionRuntimeSummary {
  const stateByEndpoint = selectCurrentProviderEndpointHealthByTemplateId(input);
  const selected = [...stateByEndpoint.values()];
  const checkedAt = selected.reduce<number | null>((latest, state) => {
    const observedAt = 'observedAt' in state ? state.observedAt : null;
    return observedAt === null ? latest : Math.max(latest ?? observedAt, observedAt);
  }, null);
  const endpointTemplateIds = [...new Set(
    input.expectedEndpoints.map((endpoint) => endpoint.endpointTemplateId),
  )];
  return {
    health: deriveProviderConnectionSummaryHealthV1(selected),
    modelCount: input.modelCount,
    checkedAt,
    endpoints: endpointTemplateIds.map((endpointTemplateId) => {
      const state = stateByEndpoint.get(endpointTemplateId);
      return {
        endpointTemplateId,
        status: state?.status ?? 'not_checked',
        activity: state?.activity ?? 'idle',
        observedAt: state && 'observedAt' in state ? state.observedAt : null,
        errorCode: state && 'errorCode' in state ? state.errorCode : null,
        retryAt: state && 'retryAt' in state ? state.retryAt ?? null : null,
      };
    }),
  };
}
