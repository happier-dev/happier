import { ConnectedServiceBindingsV2Schema, readBuiltInLegacyConnectedAccountServiceKeyIngress } from './connectedServiceBindings.js';
import type { ConnectedServiceBindingSelectionV2, ConnectedServiceBindingsV2 } from './connectedServiceBindings.js';
import type { ConnectedServicesLaunchAuthIntentV1 } from './connectedServicesLaunchAuthIntentV1.js';

type InventoryCandidate = Readonly<{
  serviceId: string;
  selection: 'group' | 'profile';
  id: string;
}>;

function formatConnectedIntent(intent: Extract<ConnectedServicesLaunchAuthIntentV1, { kind: 'connected' }>): string {
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
    // Selection resolves identity; the daemon owns credential health and recovery.
    if (!id) continue;
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

function nativeBindings(supportedServiceIds: readonly string[]): Record<string, ConnectedServiceBindingSelectionV2> {
  return Object.fromEntries(supportedServiceIds.map((serviceId) => [serviceId, { source: 'native' as const }]));
}

export function resolveConnectedServicesLaunchAuth(params: Readonly<{
  intent: ConnectedServicesLaunchAuthIntentV1;
  supportedServiceIds: readonly string[];
  inventory: unknown;
}>): ConnectedServiceBindingsV2 | null {
  if (params.intent.kind === 'default') return null;
  if (params.supportedServiceIds.length === 0) {
    throw new Error('connected_service_auth_unsupported');
  }
  if (params.intent.kind === 'native') {
    return ConnectedServiceBindingsV2Schema.parse({
      v: 2,
      bindingsByServiceId: nativeBindings(params.supportedServiceIds),
    });
  }

  const connectedIntent = params.intent;
  // Normalize only the released built-in selector through the existing ingress
  // owner. Unknown service ids remain exact selectors, never aliases.
  const selectedServiceId = connectedIntent.serviceId === null ? null
    : readBuiltInLegacyConnectedAccountServiceKeyIngress(connectedIntent.serviceId) ?? connectedIntent.serviceId;
  const supported = new Set(params.supportedServiceIds);
  // A qualified selector already names one identity. Discovery is only needed
  // to disambiguate shorthand; the spawn owner still admits its live group,
  // profile and credential rather than trusting this projection as authority.
  const candidates: readonly InventoryCandidate[] = selectedServiceId && connectedIntent.selection
    ? [{ serviceId: selectedServiceId, selection: connectedIntent.selection, id: connectedIntent.id }]
    : readInventoryCandidates(params.inventory);
  const matches = candidates.filter((candidate) => (
    supported.has(candidate.serviceId)
    && candidate.id === connectedIntent.id
    && (selectedServiceId === null || candidate.serviceId === selectedServiceId)
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
  const binding: ConnectedServiceBindingSelectionV2 = match.selection === 'group'
    ? { source: 'connected', selection: 'group', groupId: match.id }
    : { source: 'connected', selection: 'profile', profileId: match.id };
  return ConnectedServiceBindingsV2Schema.parse({
    v: 2,
    bindingsByServiceId: {
      ...nativeBindings(params.supportedServiceIds),
      [match.serviceId]: binding,
    },
  });
}

export async function resolveConnectedServicesLaunchAuthWithInventory(params: Readonly<{
  intent: ConnectedServicesLaunchAuthIntentV1;
  supportedServiceIds: readonly string[];
  listInventory: () => Promise<unknown>;
}>): Promise<ConnectedServiceBindingsV2 | null> {
  const inventory = params.intent.kind === 'connected' && (!params.intent.serviceId || !params.intent.selection)
    ? await params.listInventory()
    : null;
  return resolveConnectedServicesLaunchAuth({
    intent: params.intent,
    supportedServiceIds: params.supportedServiceIds,
    inventory,
  });
}
