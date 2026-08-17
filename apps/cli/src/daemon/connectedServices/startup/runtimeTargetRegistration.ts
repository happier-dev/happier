import type { TrackedSession } from '../../types';
import { resolveTrackedSessionCatalogAgentId } from '../../sessions/resolveTrackedSessionCatalogAgentId';
import {
  ConnectedServiceBindingsV1Schema,
  type ConnectedServiceBindingsV1,
  type ConnectedServiceMaterializationIdentityV1,
} from '@happier-dev/protocol';
import { readConnectedServiceChildSelectionsFromEnv } from '../connectedServiceChildEnvironment';
import {
  readConnectedServiceMaterializationIdentityV1,
} from '../materialize/createConnectedServiceMaterializationIdentity';
import {
  ConnectedServiceRuntimeRegistry,
  type ConnectedServiceRuntimeTarget,
  type ConnectedServiceRuntimeTargetInput,
  type ConnectedServiceRuntimeTargetRegistration as RuntimeTargetRegistration,
} from '../runtimeRegistry/registry';
import { resolveTrackedConnectedServiceBindingsRaw } from '../trackedSessionConnectedServiceBindings';
import { readTrackedSessionBrokerSelectionIdentity } from '../broker/trackedSessionBrokerSelectionIdentity';

type AccessTokenRefreshResolver = (
  metadata: unknown,
) => ConnectedServiceRuntimeTargetInput['accessTokenRefresh'] | undefined;

export function shouldReconcileConnectedServiceRuntimeTargetRegistration(input: Readonly<{
  registration: Readonly<{
    key: RuntimeTargetRegistration['key'];
    target: Pick<ConnectedServiceRuntimeTarget, 'pid' | 'sessionId'>;
  }>;
  tracked: Pick<TrackedSession, 'pid' | 'happySessionId' | 'happySessionMetadataFromLocalWebhook'> | null;
}>): boolean {
  if (input.registration.key.kind === 'execution_run') return true;
  const tracked = input.tracked;
  if (!tracked || tracked.pid !== input.registration.key.pid) return false;
  if (!tracked.happySessionMetadataFromLocalWebhook) return false;
  const targetSessionId = input.registration.target.sessionId?.trim() ?? '';
  const trackedSessionId = input.tracked.happySessionId?.trim() ?? '';
  return !targetSessionId || !trackedSessionId || targetSessionId === trackedSessionId;
}

export function readTrackedConnectedServiceMaterializationIdentityId(tracked: TrackedSession): string | null {
  return readTrackedConnectedServiceMaterializationIdentity(tracked)?.id ?? null;
}

export function readTrackedConnectedServiceMaterializationIdentity(
  tracked: TrackedSession,
): ConnectedServiceMaterializationIdentityV1 | null {
  const fromSpawnOptions = readConnectedServiceMaterializationIdentityV1(
    tracked.spawnOptions?.connectedServiceMaterializationIdentityV1,
  );
  if (fromSpawnOptions) return fromSpawnOptions;
  return readConnectedServiceMaterializationIdentityV1(
    tracked.happySessionMetadataFromLocalWebhook?.connectedServiceMaterializationIdentityV1,
  );
}

export function readConnectedServiceBindingsOrEmpty(raw: unknown): ConnectedServiceBindingsV1 {
  const parsed = ConnectedServiceBindingsV1Schema.safeParse(raw);
  return parsed.success ? parsed.data : { v: 1 as const, bindingsByServiceId: {} };
}

function hasConnectedServiceRegistrationBindings(raw: unknown): boolean {
  const parsed = ConnectedServiceBindingsV1Schema.safeParse(raw);
  if (!parsed.success) return false;
  return Object.values(parsed.data.bindingsByServiceId).some((binding) => binding.source === 'connected');
}

type ConnectedServiceRuntimeTargetRegistration = ConnectedServiceRuntimeTargetInput & Readonly<{
  runtimeRegistry?: ConnectedServiceRuntimeRegistry | null;
  onRegisteredTarget?: (target: ConnectedServiceRuntimeTarget) => void;
}>;

export function registerConnectedServiceRuntimeTargetForDaemon(
  input: ConnectedServiceRuntimeTargetRegistration,
): ConnectedServiceRuntimeTarget | null {
  const registry = input.runtimeRegistry;
  if (!registry) return null;
  const pid = Math.trunc(Number(input.pid));
  if (!Number.isFinite(pid) || pid <= 0) return null;

  const sessionId = typeof input.sessionId === 'string' && input.sessionId.trim().length > 0
    ? input.sessionId.trim()
    : undefined;
  const brokerSelectionIdentity = typeof input.brokerSelectionIdentity === 'string'
    && input.brokerSelectionIdentity.trim().length > 0
    ? input.brokerSelectionIdentity.trim()
    : undefined;
  const previousTarget = registry.getByPid(pid);
  if (sessionId) {
    registry.adoptSessionId({ pid, sessionId });
  }

  const connectedServiceSelectionsEnv = input.connectedServiceSelectionsEnv ?? undefined;
  const hasRegistrationData =
    hasConnectedServiceRegistrationBindings(input.connectedServicesBindingsRaw)
    || readConnectedServiceChildSelectionsFromEnv(connectedServiceSelectionsEnv ?? {}).length > 0
    || (input.runtimeAccountIdentitySelections?.length ?? 0) > 0;
  if (!hasRegistrationData) return null;

  const target = registry.registerTarget({
    pid,
    ...(input.agentId === undefined ? {} : { agentId: input.agentId }),
    ...(sessionId ? { sessionId } : {}),
    ...(brokerSelectionIdentity ? { brokerSelectionIdentity } : {}),
    ...(input.connectedServicesBindingsRaw === undefined ? {} : {
      connectedServicesBindingsRaw: input.connectedServicesBindingsRaw,
    }),
    ...(connectedServiceSelectionsEnv ? { connectedServiceSelectionsEnv } : {}),
    ...(input.materializationKey === undefined ? {} : { materializationKey: input.materializationKey }),
    ...(input.connectedServiceMaterializationIdentityV1 === undefined ? {} : {
      connectedServiceMaterializationIdentityV1: input.connectedServiceMaterializationIdentityV1,
    }),
    ...(input.sessionDirectory === undefined ? {} : { sessionDirectory: input.sessionDirectory }),
    ...(input.runtimeAccountIdentitySelections === undefined ? {} : {
      runtimeAccountIdentitySelections: input.runtimeAccountIdentitySelections,
    }),
    ...(input.accessTokenRefresh === undefined ? {} : { accessTokenRefresh: input.accessTokenRefresh }),
  });
  if (target !== previousTarget) {
    input.onRegisteredTarget?.(target);
  }
  return target;
}

export function readNonEmptyMetadataString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

export function registerConnectedServiceTrackedSessionTargetsForDaemon(input: Readonly<{
  tracked: TrackedSession;
  runtimeRegistry?: ConnectedServiceRuntimeRegistry | null;
  resolveAccessTokenRefresh?: AccessTokenRefreshResolver;
  onRegisteredTarget?: (target: ConnectedServiceRuntimeTarget) => void;
}>): ConnectedServiceRuntimeTarget | null {
  const pid = Math.trunc(Number(input.tracked.pid));
  if (!Number.isFinite(pid) || pid <= 0) return null;

  const sessionId = typeof input.tracked.happySessionId === 'string' && input.tracked.happySessionId.trim().length > 0
    ? input.tracked.happySessionId.trim()
    : undefined;
  const brokerSelectionIdentityRaw = readTrackedSessionBrokerSelectionIdentity(input.tracked);
  const brokerSelectionIdentity = typeof brokerSelectionIdentityRaw === 'string'
    && brokerSelectionIdentityRaw.trim().length > 0
    ? brokerSelectionIdentityRaw.trim()
    : undefined;

  const connectedServicesBindingsRaw = resolveTrackedConnectedServiceBindingsRaw(input.tracked);
  const connectedServiceSelectionsEnv = input.tracked.spawnOptions?.environmentVariables;
  const materializationIdentity = readTrackedConnectedServiceMaterializationIdentity(input.tracked);
  return registerConnectedServiceRuntimeTargetForDaemon({
    runtimeRegistry: input.runtimeRegistry,
    pid,
    ...(sessionId ? { sessionId } : {}),
    ...(brokerSelectionIdentity ? { brokerSelectionIdentity } : {}),
    agentId: resolveTrackedSessionCatalogAgentId(input.tracked),
    connectedServicesBindingsRaw: connectedServicesBindingsRaw ?? {},
    ...(connectedServiceSelectionsEnv ? { connectedServiceSelectionsEnv } : {}),
    ...(materializationIdentity ? {
      materializationKey: materializationIdentity.id,
      connectedServiceMaterializationIdentityV1: materializationIdentity,
    } : {}),
    sessionDirectory: readNonEmptyMetadataString(input.tracked.spawnOptions?.directory)
      ?? readNonEmptyMetadataString(input.tracked.happySessionMetadataFromLocalWebhook?.path),
    accessTokenRefresh: input.resolveAccessTokenRefresh?.(input.tracked.happySessionMetadataFromLocalWebhook),
    ...(input.onRegisteredTarget ? { onRegisteredTarget: input.onRegisteredTarget } : {}),
  });
}

export type ConnectedServiceRuntimeTargetRegistrationInput = ConnectedServiceRuntimeTargetRegistration;
