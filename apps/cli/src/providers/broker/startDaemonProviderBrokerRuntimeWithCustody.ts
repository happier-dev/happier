import type { ApiClient } from '@/api/api';
import type { ApiMachineClient } from '@/api/apiMachine';
import { readHttpStatus } from '@/api/client/httpStatusError';
import type { ManagedProviderExplicitStartCustody } from '@/providers/connections/publicManagedRuntimeStart';
import type { TeamCredentialResourceSummaryV1 } from '@happier-dev/protocol/teams';

import {
  startDaemonProviderBrokerRuntime,
  type DaemonProviderBrokerRuntime,
} from './daemonProviderBrokerRuntime';

type BrokerRuntimeInput = Parameters<typeof startDaemonProviderBrokerRuntime>[0];

export async function readTeamCredentialBrokerResource(
  api: Pick<ApiClient, 'getTeamCredentialResource'>,
  resourceId: string,
  signal: AbortSignal,
): Promise<TeamCredentialResourceSummaryV1 | null> {
  try {
    return await api.getTeamCredentialResource(resourceId, { signal });
  } catch (error) {
    signal.throwIfAborted();
    // Resource absence is an authority answer. Authentication and transport
    // failures leave retained currentness unknown rather than ending custody.
    if (readHttpStatus(error) === 404) return null;
    throw error;
  }
}

/** Production composition of broker streams, retained custody and Home wakes. */
export async function startDaemonProviderBrokerRuntimeWithCustody(input: Readonly<{
  runtime: Omit<BrokerRuntimeInput,
    'revalidateOperationCurrentness' | 'accountConnection'> & Readonly<{
      accountConnection?: Omit<NonNullable<BrokerRuntimeInput['accountConnection']>, 'revalidateCurrentness'>;
    }>;
  apiMachine: Pick<ApiMachineClient, 'onManagedProviderRetainedCurrentnessInvalidation'>;
  custody: ManagedProviderExplicitStartCustody;
}>): Promise<DaemonProviderBrokerRuntime & Readonly<{ retireAllClaims(): Promise<void> }>> {
  let current = true;
  const accountConnection = input.runtime.accountConnection;
  const runtime = await startDaemonProviderBrokerRuntime({
    ...input.runtime,
    ...(accountConnection ? {
      accountConnection: {
        ...accountConnection,
        revalidateCurrentness: async (
          { authority }: Parameters<NonNullable<NonNullable<BrokerRuntimeInput['accountConnection']>['revalidateCurrentness']>>[0],
          signal?: AbortSignal,
        ) => {
          if (!current) return;
          await input.custody.revalidateRetainedClaims(signal, {
            identity: authority.payload.application.implementationIdentity,
            operationClaim: { kind: 'providerBroker', operation: authority.payload.consumer },
            sharedGateway: {
              homeId: accountConnection.homeId,
              accountId: accountConnection.accountId,
              machineId: input.runtime.machineId,
              connectionId: authority.payload.source.connectionId,
              consumerId: JSON.stringify(authority.payload.consumer),
            },
          });
        },
      },
    } : {}),
    revalidateOperationCurrentness: async ({ operation, application }, signal) => {
      if (!current) return;
      await input.custody.revalidateRetainedClaims(signal, {
        identity: application.implementationIdentity,
        operationClaim: { kind: 'providerBroker', operation },
      });
    },
  });
  const unsubscribeCurrentness = input.apiMachine.onManagedProviderRetainedCurrentnessInvalidation(
    async ({ signal, facts, connectedServiceRefs }) => {
      if (!current) return;
      await input.custody.revalidateRetainedClaims(signal, undefined, {
        facts,
        ...(connectedServiceRefs ? { connectedServiceRefs } : {}),
      });
    },
  );
  const retireAllClaims = async (): Promise<void> => {
    if (!current) return;
    await input.custody.retireAll();
  };
  return Object.freeze({
    ...runtime,
    retireAllClaims,
    async close() {
      if (!current) return;
      current = false;
      unsubscribeCurrentness();
      try {
        await runtime.close();
      } finally {
        await input.custody.retireAll();
      }
    },
  });
}
