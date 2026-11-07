import { parseQualifiedPluginContributionKey } from '../plugins/contributionIdentity.js';

export * from './probedCatalogOption.js';
export * from './agentProbeObservation.js';
export * from './pluginMarketplace.js';
export * from './invokeFailure.js';

export type CapabilityKind = 'cli' | 'tool' | 'dep';

// Capability IDs are namespaced strings returned by the daemon.
// Keep this flexible so new capabilities (including new `cli.<agent>` ids) do not require UI code changes.
export type CapabilityId = `cli.${string}` | `tool.${string}` | `dep.${string}`;

/** Canonical capability-id parser shared by daemon producers and UI readers. */
export function parseCapabilityId(value: unknown): CapabilityId | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const separator = trimmed.indexOf('.');
  if (separator <= 0) return null;
  const namespace = trimmed.slice(0, separator);
  const suffix = trimmed.slice(separator + 1);
  if (namespace === 'cli' && parseQualifiedPluginContributionKey(suffix)) {
    return trimmed as CapabilityId;
  }
  if ((namespace === 'cli' || namespace === 'tool' || namespace === 'dep')
    && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(suffix)) {
    return trimmed as CapabilityId;
  }
  return null;
}

export type CapabilityDetectRequest = {
  id: CapabilityId;
  params?: Record<string, unknown>;
};

/** Host-authored protocol metadata only; never native discovery or caller authority. */
export type CapabilityProtocol = Readonly<{
  version: number;
  available: boolean;
  features: Readonly<Record<string, boolean>>;
}>;

export function parseCapabilityProtocol(value: unknown): CapabilityProtocol | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const protocol = value as Readonly<Record<string, unknown>>;
  if (typeof protocol.version !== 'number' || !Number.isSafeInteger(protocol.version) || protocol.version < 1
    || typeof protocol.available !== 'boolean' || protocol.features === null
    || typeof protocol.features !== 'object' || Array.isArray(protocol.features)) return null;
  const features: Record<string, boolean> = {};
  for (const [key, enabled] of Object.entries(protocol.features)) {
    if (typeof enabled !== 'boolean') return null;
    Object.defineProperty(features, key, { value: enabled, enumerable: true });
  }
  return { version: protocol.version, available: protocol.available, features };
}

export type CapabilityDescriptor = {
  id: CapabilityId;
  kind: CapabilityKind;
  title?: string;
  methods?: Record<string, { title?: string }>;
  protocol?: CapabilityProtocol;
};

export type CapabilitiesDescribeResponse = {
  protocolVersion: 1;
  capabilities: CapabilityDescriptor[];
  checklists: Record<string, CapabilityDetectRequest[]>;
};

export type CapabilityDetectResult =
  | { ok: true; checkedAt: number; data: unknown }
  | { ok: false; checkedAt: number; error: { message: string; code?: string } };

export type CapabilitiesDetectResponse = {
  protocolVersion: 1;
  results: Partial<Record<CapabilityId, CapabilityDetectResult>>;
};

function isCapabilityRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** Keep valid capability leaves when another installed contribution is unknown or malformed. */
export function parseCapabilitiesDetectResponse(raw: unknown): CapabilitiesDetectResponse | null {
  if (!isCapabilityRecord(raw) || raw.protocolVersion !== 1 || !isCapabilityRecord(raw.results)) return null;
  const results: Partial<Record<CapabilityId, CapabilityDetectResult>> = {};
  for (const [key, value] of Object.entries(raw.results)) {
    const id = parseCapabilityId(key);
    if (!id || !isCapabilityRecord(value) || typeof value.ok !== 'boolean' || typeof value.checkedAt !== 'number') continue;
    if (value.ok) {
      results[id] = { ok: true, checkedAt: value.checkedAt, data: value.data };
    } else if (isCapabilityRecord(value.error) && typeof value.error.message === 'string') {
      results[id] = { ok: false, checkedAt: value.checkedAt, error: { message: value.error.message,
        ...(typeof value.error.code === 'string' ? { code: value.error.code } : {}) } };
    }
  }
  return { protocolVersion: 1, results };
}

export type CapabilitiesDetectRequest = {
  checklistId?: string;
  requests?: CapabilityDetectRequest[];
  overrides?: Partial<Record<CapabilityId, { params?: Record<string, unknown> }>>;
  bypassCache?: boolean;
};

export type CapabilitiesInvokeRequest = {
  id: CapabilityId;
  method: string;
  params?: Record<string, unknown>;
};

export type CapabilitiesInvokeResponse =
  | { ok: true; result: unknown }
  | { ok: false; error: { message: string; code?: string; retryable?: boolean; details?: Readonly<Record<string, string>> }; logPath?: string };

export {
  CodexPassiveRealtimeSetupResultV1Schema,
  CodexPassiveRealtimeSetupStatusV1Schema,
  type CodexPassiveRealtimeSetupResultV1,
  type CodexPassiveRealtimeSetupStatusV1,
} from './codexPassiveRealtimeSetup.js';

export {
  MachineAgentInventoryItemSchema,
  MachineAcpInventoryDefinitionSchema,
  MachineAcpInventoryRequestSchema,
  buildMachineAgentInventoryKey,
  projectAcpCatalogForMachineInventory,
  MachineAgentInventoryUnavailableSchema,
  MachinesAgentsListInputSchema,
  MachinesAgentsListOutputSchema,
  buildMachineAgentsDetectRequest,
  buildMachineAgentInventoryDescriptors,
  projectMachineAgentsDetectResponse,
  MachineAgentInventoryUnavailableError,
  type MachineAgentInventoryItem,
  type MachineAcpInventoryDefinition,
  type MachineAgentInventoryUnavailable,
  type MachineAgentInventoryDescriptor,
  type MachinesAgentsListInput,
  type MachinesAgentsListOutput,
} from './machineAgentInventory.js';
