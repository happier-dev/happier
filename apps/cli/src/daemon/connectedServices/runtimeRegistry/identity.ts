import {
  ConnectedAccountServiceKeySchema,
  BuiltInLegacyConnectedServiceBindingsV1IngressSchema,
  type ConnectedAccountServiceKey,
} from '@happier-dev/protocol';

import { parseConnectedServicesBindings } from '../parseConnectedServicesBindings';
import {
  HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY,
  readConnectedServiceChildSelectionsFromEnv,
  type ConnectedServiceChildSelection,
} from '../connectedServiceChildEnvironment';
import type {
  ConnectedServiceRuntimeBindingIdentity,
  ConnectedServiceRuntimeBoundProfile,
  ConnectedServiceRuntimeTarget,
} from './target';

type ObjectRecord = Record<string, unknown>;

function isRecord(value: unknown): value is ObjectRecord {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function readTrimmedString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeObject(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(normalizeObject);
  }
  if (!isRecord(value)) {
    return value;
  }
  const out: ObjectRecord = {};
  for (const key of Object.keys(value).sort()) {
    const normalized = normalizeObject(value[key]);
    if (normalized !== undefined) {
      out[key] = normalized;
    }
  }
  return out;
}

export function stableRuntimeRegistryFingerprint(value: unknown): string {
  return JSON.stringify(normalizeObject(value));
}

export function normalizeRuntimeRegistryEnv(
  env: Pick<NodeJS.ProcessEnv, string> | null | undefined,
): Readonly<Record<string, string>> {
  if (!env) return {};
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === 'string') {
      out[key] = value;
    }
  }
  return out;
}

export function normalizeRuntimeRegistryEnvRaw(value: unknown): Readonly<Record<string, string>> {
  return typeof value === 'string'
    ? { [HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY]: value }
    : {};
}

export function normalizeConnectedServicesBindingsRaw(raw: unknown): Readonly<{
  v?: unknown;
  bindingsByServiceId?: Record<string, unknown>;
}> {
  const compatible = BuiltInLegacyConnectedServiceBindingsV1IngressSchema.safeParse(raw);
  if (compatible.success) return compatible.data;
  if (!isRecord(raw)) return {};
  const bindings = isRecord(raw.bindingsByServiceId)
    ? raw.bindingsByServiceId
    : {};
  return {
    ...(raw.v !== undefined ? { v: raw.v } : {}),
    bindingsByServiceId: { ...bindings },
  };
}

export function readRuntimeChildSelections(
  env: Pick<NodeJS.ProcessEnv, string> | null | undefined,
): ReadonlyArray<ConnectedServiceChildSelection> {
  return Array.from(readConnectedServiceChildSelectionsFromEnv(env ?? {})?.values() ?? []);
}

export function buildRuntimeBoundProfiles(input: Readonly<{
  connectedServicesBindingsRaw: unknown;
  connectedServiceSelections: ReadonlyArray<ConnectedServiceChildSelection>;
}>): ReadonlyArray<ConnectedServiceRuntimeBoundProfile> {
  const fromSelections = input.connectedServiceSelections.map((selection) => (
    selection.kind === 'profile'
      ? {
          serviceId: selection.serviceId,
          profileId: selection.profileId,
        }
      : {
          serviceId: selection.serviceId,
          profileId: selection.activeProfileId,
        }
  ));
  const profiles = fromSelections.length > 0
    ? fromSelections
    : parseConnectedServicesBindings(input.connectedServicesBindingsRaw);
  return profiles
    .filter((profile) => profile.profileId.trim().length > 0)
    .sort((left, right) => (
      left.serviceId.localeCompare(right.serviceId)
      || left.profileId.localeCompare(right.profileId)
    ));
}

function buildSelectionByServiceId(
  selections: ReadonlyArray<ConnectedServiceChildSelection>,
): ReadonlyMap<ConnectedAccountServiceKey, ConnectedServiceChildSelection> {
  return new Map(selections.map((selection) => [selection.serviceId, selection]));
}

export function buildRuntimeActiveBindings(input: Readonly<{
  connectedServicesBindingsRaw: unknown;
  connectedServiceSelections: ReadonlyArray<ConnectedServiceChildSelection>;
}>): ReadonlyArray<ConnectedServiceRuntimeBindingIdentity> {
  const out: ConnectedServiceRuntimeBindingIdentity[] = [];
  const selectionsByServiceId = buildSelectionByServiceId(input.connectedServiceSelections);
  const raw = normalizeConnectedServicesBindingsRaw(input.connectedServicesBindingsRaw);
  const bindings = raw.bindingsByServiceId ?? {};
  for (const [serviceIdRaw, bindingRaw] of Object.entries(bindings)) {
    const parsedServiceId = ConnectedAccountServiceKeySchema.safeParse(serviceIdRaw);
    if (!parsedServiceId.success || !isRecord(bindingRaw)) continue;
    if (bindingRaw.source !== 'connected') continue;
    const selection = selectionsByServiceId.get(parsedServiceId.data);
    const explicitProfileId = readTrimmedString(bindingRaw.profileId);
    const profileId = selection?.kind === 'profile'
      ? selection.profileId
      : selection?.kind === 'group'
        ? selection.activeProfileId
        : explicitProfileId;
    if (!profileId) continue;
    const groupId = selection?.kind === 'group'
      ? selection.groupId
      : readTrimmedString(bindingRaw.selection) === 'group'
        ? readTrimmedString(bindingRaw.groupId)
        : '';
    out.push({
      serviceId: parsedServiceId.data,
      profileId,
      groupId: groupId || null,
      groupGeneration: selection?.kind === 'group' ? selection.generation : null,
      credentialRevision: selection?.credentialRevision ?? null,
    });
  }
  return out.sort((left, right) => (
    left.serviceId.localeCompare(right.serviceId)
    || (left.groupId ?? '').localeCompare(right.groupId ?? '')
    || left.profileId.localeCompare(right.profileId)
    || (left.groupGeneration ?? -1) - (right.groupGeneration ?? -1)
  ));
}

export type ConnectedServiceRuntimeIdentity = Readonly<{
  pid: number;
  sessionId: string | null;
  agentId: string | null;
  materializationKey: string | null;
  bindings: ReadonlyArray<ConnectedServiceRuntimeBindingIdentity>;
}>;

export function readConnectedServiceRuntimeTargetIdentity(
  target: Pick<
    ConnectedServiceRuntimeTarget,
    'pid' | 'sessionId' | 'agentId' | 'materializationKey' | 'activeBindings'
  >,
): ConnectedServiceRuntimeIdentity {
  return {
    pid: target.pid,
    sessionId: target.sessionId,
    agentId: target.agentId,
    materializationKey: target.materializationKey,
    bindings: target.activeBindings,
  };
}

export function buildConnectedServiceRuntimeIdentityKey(
  identity: ConnectedServiceRuntimeIdentity,
): string {
  return stableRuntimeRegistryFingerprint(identity);
}
