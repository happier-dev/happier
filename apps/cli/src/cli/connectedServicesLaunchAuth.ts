import {
  ConnectedServiceBindingsV1Schema,
  type ConnectedServiceBindingSelectionV1,
  type ConnectedServiceBindingsV1,
} from '@happier-dev/protocol';

export type ConnectedServicesLaunchAuthIntent =
  | Readonly<{ kind: 'default' }>
  | Readonly<{ kind: 'native' }>
  | Readonly<{
      kind: 'connected';
      serviceId: string | null;
      selection: 'group' | 'profile' | null;
      id: string;
    }>;

function invalidLaunchAuth(message: string): never {
  throw new Error(
    `${message} Expected default, native, cs:<id>, cs:group:<id>, cs:profile:<id>, `
    + 'cs:<serviceId>:group:<id>, or cs:<serviceId>:profile:<id>.',
  );
}

function readNonBlank(value: string | undefined, message: string): string {
  const normalized = value?.trim() ?? '';
  if (!normalized) invalidLaunchAuth(message);
  return normalized;
}

export function parseConnectedServicesLaunchAuth(raw: string): ConnectedServicesLaunchAuthIntent {
  const normalized = raw.trim();
  if (normalized === 'default') return { kind: 'default' };
  if (normalized === 'native') return { kind: 'native' };
  if (!normalized.startsWith('cs:')) {
    return invalidLaunchAuth(`Invalid connected-services auth selector "${normalized}".`);
  }

  const body = normalized.slice(3);
  const parts = body.split(':');
  if (parts.length === 1) {
    return {
      kind: 'connected',
      serviceId: null,
      selection: null,
      id: readNonBlank(parts[0], 'Missing connected-service id.'),
    };
  }
  if (parts[0] === 'group' || parts[0] === 'profile') {
    return {
      kind: 'connected',
      serviceId: null,
      selection: parts[0],
      id: readNonBlank(parts.slice(1).join(':'), `Missing connected-service ${parts[0]} id.`),
    };
  }
  if (parts.length >= 3 && (parts[1] === 'group' || parts[1] === 'profile')) {
    return {
      kind: 'connected',
      serviceId: readNonBlank(parts[0], 'Missing connected-service service id.'),
      selection: parts[1],
      id: readNonBlank(parts.slice(2).join(':'), `Missing connected-service ${parts[1]} id.`),
    };
  }
  return invalidLaunchAuth(`Invalid connected-services auth selector "${normalized}".`);
}

type InventoryCandidate = Readonly<{
  serviceId: string;
  selection: 'group' | 'profile';
  id: string;
}>;

function formatConnectedIntent(intent: Extract<ConnectedServicesLaunchAuthIntent, { kind: 'connected' }>): string {
  if (intent.serviceId && intent.selection) {
    return `cs:${intent.serviceId}:${intent.selection}:${intent.id}`;
  }
  if (intent.selection) return `cs:${intent.selection}:${intent.id}`;
  return `cs:${intent.id}`;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function collectOptions(
  candidates: InventoryCandidate[],
  serviceId: string,
  selection: 'group' | 'profile',
  options: unknown,
): void {
  if (!Array.isArray(options)) return;
  const idKey = selection === 'group' ? 'groupId' : 'profileId';
  for (const raw of options) {
    const option = asRecord(raw);
    const id = readString(option?.[idKey]);
    const status = readString(option?.status);
    if (!id || (selection === 'profile' && status && status !== 'connected')) continue;
    candidates.push({ serviceId, selection, id });
  }
}

function readInventoryCandidates(inventory: unknown): InventoryCandidate[] {
  const record = asRecord(inventory);
  if (!record) return [];
  const candidates: InventoryCandidate[] = [];

  if (Array.isArray(record.items)) {
    for (const raw of record.items) {
      const item = asRecord(raw);
      const serviceId = readString(item?.serviceId);
      if (!item || !serviceId) continue;
      collectOptions(candidates, serviceId, 'profile', item.profiles);
      collectOptions(candidates, serviceId, 'group', item.accountGroups);
    }
  }

  const profilesByService = asRecord(record.profileOptionsByServiceId);
  for (const [serviceId, options] of Object.entries(profilesByService ?? {})) {
    collectOptions(candidates, serviceId, 'profile', options);
  }
  const groupsByService = asRecord(record.groupOptionsByServiceId);
  for (const [serviceId, options] of Object.entries(groupsByService ?? {})) {
    collectOptions(candidates, serviceId, 'group', options);
  }

  return candidates.filter((candidate, index, all) => all.findIndex((entry) => (
    entry.serviceId === candidate.serviceId
    && entry.selection === candidate.selection
    && entry.id === candidate.id
  )) === index);
}

function nativeBindings(supportedServiceIds: readonly string[]): Record<string, ConnectedServiceBindingSelectionV1> {
  return Object.fromEntries(supportedServiceIds.map((serviceId) => [serviceId, { source: 'native' as const }]));
}

export function resolveConnectedServicesLaunchAuth(params: Readonly<{
  intent: ConnectedServicesLaunchAuthIntent;
  supportedServiceIds: readonly string[];
  inventory: unknown;
}>): ConnectedServiceBindingsV1 | null {
  if (params.intent.kind === 'default') return null;
  if (params.supportedServiceIds.length === 0) {
    throw new Error('connected_service_auth_unsupported');
  }
  if (params.intent.kind === 'native') {
    return ConnectedServiceBindingsV1Schema.parse({
      v: 1,
      bindingsByServiceId: nativeBindings(params.supportedServiceIds),
    });
  }

  const connectedIntent = params.intent;
  const supported = new Set(params.supportedServiceIds);
  const matches = readInventoryCandidates(params.inventory).filter((candidate) => (
    supported.has(candidate.serviceId)
    && candidate.id === connectedIntent.id
    && (connectedIntent.serviceId === null || candidate.serviceId === connectedIntent.serviceId)
    && (connectedIntent.selection === null || candidate.selection === connectedIntent.selection)
  ));
  if (matches.length === 0) {
    throw new Error(`connected_service_auth_not_found:${formatConnectedIntent(connectedIntent)}`);
  }
  if (matches.length > 1) {
    const qualified = matches.map((candidate) => (
      `cs:${candidate.serviceId}:${candidate.selection}:${candidate.id}`
    )).join(',');
    throw new Error(`connected_service_auth_ambiguous:${qualified}`);
  }

  const match = matches[0];
  const binding: ConnectedServiceBindingSelectionV1 = match.selection === 'group'
    ? { source: 'connected', selection: 'group', groupId: match.id }
    : { source: 'connected', selection: 'profile', profileId: match.id };
  return ConnectedServiceBindingsV1Schema.parse({
    v: 1,
    bindingsByServiceId: {
      ...nativeBindings(params.supportedServiceIds),
      [match.serviceId]: binding,
    },
  });
}

export async function resolveConnectedServicesLaunchAuthWithInventory(params: Readonly<{
  intent: ConnectedServicesLaunchAuthIntent;
  supportedServiceIds: readonly string[];
  listInventory: () => Promise<unknown>;
}>): Promise<ConnectedServiceBindingsV1 | null> {
  const inventory = params.intent.kind === 'connected'
    ? await params.listInventory()
    : null;
  return resolveConnectedServicesLaunchAuth({
    intent: params.intent,
    supportedServiceIds: params.supportedServiceIds,
    inventory,
  });
}

type ConnectedServicesLaunchDefaultDisposition =
  | Readonly<{ kind: 'connected'; bindings: ConnectedServiceBindingsV1 }>
  | Readonly<{ kind: 'native' }>
  | Readonly<{ kind: 'unavailable'; reason: string }>;

export async function resolveCliConnectedServicesLaunchBindings(params: Readonly<{
  authRaw: string | undefined;
  authJsonRaw: string | undefined;
  supportedServiceIds: readonly string[];
  defaultDisposition: ConnectedServicesLaunchDefaultDisposition;
  listInventory: () => Promise<unknown>;
}>): Promise<ConnectedServiceBindingsV1 | null> {
  if (params.authRaw !== undefined && params.authJsonRaw !== undefined) {
    throw new Error('connected_service_auth_conflict');
  }
  if (params.authJsonRaw !== undefined) {
    if (params.supportedServiceIds.length === 0) {
      throw new Error('connected_service_auth_unsupported');
    }
    try {
      return ConnectedServiceBindingsV1Schema.parse(JSON.parse(params.authJsonRaw));
    } catch {
      throw new Error('connected_service_auth_json_invalid');
    }
  }

  const intent = parseConnectedServicesLaunchAuth(params.authRaw ?? 'default');
  if (intent.kind === 'default') {
    if (params.defaultDisposition.kind === 'unavailable') {
      throw new Error('connected_services_default_unavailable');
    }
    return params.defaultDisposition.kind === 'connected'
      ? params.defaultDisposition.bindings
      : null;
  }
  return await resolveConnectedServicesLaunchAuthWithInventory({
    intent,
    supportedServiceIds: params.supportedServiceIds,
    listInventory: params.listInventory,
  });
}
