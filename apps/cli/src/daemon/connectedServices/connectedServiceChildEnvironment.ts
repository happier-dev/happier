import {
  ConnectedServiceBindingsV1Schema,
  type ConnectedAccountServiceKey,
  type ConnectedServiceBindingSelectionV1,
  type ConnectedServiceProfileId,
  type ConnectedServiceCredentialRevisionV1,
} from '@happier-dev/protocol';

import type { ConnectedServiceResolvedSelection } from './materialization/materializer';

export const HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY = 'HAPPIER_CONNECTED_SERVICE_SELECTIONS_JSON';
export const HAPPIER_CONNECTED_SERVICE_MATERIALIZED_ENV_KEYS_ENV_KEY =
  'HAPPIER_CONNECTED_SERVICE_MATERIALIZED_ENV_KEYS_JSON';
export const HAPPIER_CONNECTED_SERVICE_TARGET_MATERIALIZED_ROOT_ENV_KEY =
  'HAPPIER_CONNECTED_SERVICE_TARGET_MATERIALIZED_ROOT';

type SerializedConnectedServiceSelection =
  | Readonly<{
      kind: 'profile';
      serviceId: ConnectedAccountServiceKey;
      profileId: string;
      credentialRevision?: ConnectedServiceCredentialRevisionV1;
    }>
  | Readonly<{
      kind: 'group';
      serviceId: ConnectedAccountServiceKey;
      groupId: string;
      activeProfileId: string;
      fallbackProfileId: string;
      generation: number;
      policy: unknown;
      credentialRevision?: ConnectedServiceCredentialRevisionV1;
    }>;

export type ConnectedServiceChildSelection = SerializedConnectedServiceSelection;

export type ConnectedServiceRuntimeAuthContext = Readonly<{
  serviceId: ConnectedAccountServiceKey;
  profileId: string | null;
  groupId: string | null;
  groupGeneration?: number | null;
}>;

export type ConnectedServiceRuntimeAuthMetadataSession = Readonly<{
  getMetadataSnapshot?: () => unknown;
}>;

function serializeSelection(
  selection: ConnectedServiceResolvedSelection | ConnectedServiceChildSelection,
): SerializedConnectedServiceSelection {
  if (selection.kind === 'profile') {
    return {
      kind: 'profile',
      serviceId: selection.serviceId,
      profileId: selection.profileId,
      credentialRevision: selection.credentialRevision,
    };
  }
  return {
    kind: 'group',
    serviceId: selection.serviceId,
    groupId: selection.groupId,
    activeProfileId: selection.activeProfileId,
    fallbackProfileId: selection.fallbackProfileId,
    generation: selection.generation,
    policy: selection.policy,
    credentialRevision: selection.credentialRevision,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function readTrimmedString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function readNonnegativeInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.trunc(value)
    : null;
}

function parseSelection(value: unknown): SerializedConnectedServiceSelection | null {
  if (!isRecord(value)) return null;
  const kind = value.kind;
  const serviceId = readTrimmedString(value.serviceId) as ConnectedAccountServiceKey;
  const credentialRevision = readTrimmedString(value.credentialRevision) as ConnectedServiceCredentialRevisionV1;
  if (!serviceId) return null;
  if (kind === 'profile') {
    const profileId = readTrimmedString(value.profileId);
    return profileId ? {
      kind,
      serviceId,
      profileId,
      ...(credentialRevision ? { credentialRevision } : {}),
    } : null;
  }
  if (kind !== 'group') return null;
  const groupId = readTrimmedString(value.groupId);
  const activeProfileId = readTrimmedString(value.activeProfileId);
  const fallbackProfileId = readTrimmedString(value.fallbackProfileId);
  const generation = typeof value.generation === 'number' && Number.isFinite(value.generation)
    ? Math.trunc(value.generation)
    : 0;
  if (!groupId || !activeProfileId || !fallbackProfileId) return null;
  return {
    kind,
    serviceId,
    groupId,
    activeProfileId,
    fallbackProfileId,
    generation,
    policy: value.policy ?? null,
    ...(credentialRevision ? { credentialRevision } : {}),
  };
}

export function serializeConnectedServiceChildSelectionValues(
  selections: Iterable<ConnectedServiceChildSelection>,
): string | null {
  const serialized = Array.from(selections, serializeSelection);
  return serialized.length > 0 ? JSON.stringify(serialized) : null;
}

export function serializeConnectedServiceChildSelections(
  selectionsByServiceId: ReadonlyMap<ConnectedAccountServiceKey, ConnectedServiceResolvedSelection> | undefined,
): string | null {
  if (!selectionsByServiceId || selectionsByServiceId.size === 0) return null;
  return JSON.stringify([...selectionsByServiceId.values()].map(serializeSelection));
}

export function readConnectedServiceChildSelectionsFromEnv(
  env: Readonly<Record<string, string | undefined>>,
): Map<ConnectedAccountServiceKey, SerializedConnectedServiceSelection> | null {
  const raw = env[HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY];
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  const selections = new Map<ConnectedAccountServiceKey, SerializedConnectedServiceSelection>();
  for (const item of parsed) {
    const selection = parseSelection(item);
    if (selection) selections.set(selection.serviceId, selection);
  }
  return selections.size > 0 ? selections : null;
}

export function serializeConnectedServiceMaterializedEnvKeys(
  env: Readonly<Record<string, string>>,
): string | null {
  const keys = Object.keys(env)
    .map((key) => key.trim())
    .filter(Boolean);
  return keys.length > 0 ? JSON.stringify(Array.from(new Set(keys)).sort()) : null;
}

export function readConnectedServiceMaterializedEnvKeysFromEnv(
  env: Readonly<Record<string, string | undefined>>,
): string[] {
  const raw = env[HAPPIER_CONNECTED_SERVICE_MATERIALIZED_ENV_KEYS_ENV_KEY];
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return Array.from(new Set(parsed
    .filter((key): key is string => typeof key === 'string')
    .map((key) => key.trim())
    .filter(Boolean)));
}

export function findConnectedServiceChildSelection(
  env: Readonly<Record<string, string | undefined>>,
  serviceId: ConnectedAccountServiceKey,
): ConnectedServiceChildSelection | null {
  return readConnectedServiceChildSelectionsFromEnv(env)?.get(serviceId) ?? null;
}

export function resolveConnectedServiceRuntimeAuthContextFromSelection(
  selection: unknown,
  fallbackServiceId: ConnectedAccountServiceKey,
): ConnectedServiceRuntimeAuthContext {
  if (!isRecord(selection)) {
    return { serviceId: fallbackServiceId, profileId: null, groupId: null };
  }
  const serviceId = (readTrimmedString(selection.serviceId) || fallbackServiceId) as ConnectedAccountServiceKey;
  if (selection.kind === 'group') {
    const groupGeneration = readNonnegativeInteger(selection.generation);
    return {
      serviceId,
      profileId: readTrimmedString(selection.activeProfileId) || null,
      groupId: readTrimmedString(selection.groupId) || null,
      ...(groupGeneration !== null ? { groupGeneration } : {}),
    };
  }
  if (selection.kind === 'profile') {
    return {
      serviceId,
      profileId: readTrimmedString(selection.profileId) || null,
      groupId: null,
    };
  }
  return {
    serviceId,
    profileId: readTrimmedString(selection.profileId) || readTrimmedString(selection.activeProfileId) || null,
    groupId: readTrimmedString(selection.groupId) || null,
  };
}

export function resolveConnectedServiceRuntimeAuthContextFromEnv(
  env: Readonly<Record<string, string | undefined>>,
  serviceId: ConnectedAccountServiceKey,
): ConnectedServiceRuntimeAuthContext {
  return resolveConnectedServiceRuntimeAuthContextFromSelection(
    readConnectedServiceChildSelectionsFromEnv(env)?.get(serviceId),
    serviceId,
  );
}

export function findConnectedServiceBindingSelectionFromSessionMetadata(
  session: ConnectedServiceRuntimeAuthMetadataSession,
  serviceId: ConnectedAccountServiceKey,
): ConnectedServiceBindingSelectionV1 | null {
  const metadata = typeof session.getMetadataSnapshot === 'function' ? session.getMetadataSnapshot() : null;
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return null;

  const parsed = ConnectedServiceBindingsV1Schema.safeParse((metadata as Record<string, unknown>).connectedServices);
  if (!parsed.success) return null;

  return parsed.data.bindingsByServiceId[serviceId] ?? null;
}

export function resolveConnectedServiceRuntimeAuthContextFromSessionMetadata(
  session: ConnectedServiceRuntimeAuthMetadataSession,
  serviceId: ConnectedAccountServiceKey,
): ConnectedServiceRuntimeAuthContext {
  const binding = findConnectedServiceBindingSelectionFromSessionMetadata(session, serviceId);
  if (!binding || binding.source !== 'connected') {
    return { serviceId, profileId: null, groupId: null };
  }

  if (binding.selection === 'group') {
    const groupGeneration = readNonnegativeInteger((binding as Record<string, unknown>).groupGeneration);
    return {
      serviceId,
      profileId: binding.profileId ?? null,
      groupId: binding.groupId,
      ...(groupGeneration !== null ? { groupGeneration } : {}),
    };
  }

  return {
    serviceId,
    profileId: binding.profileId as ConnectedServiceProfileId,
    groupId: null,
  };
}
