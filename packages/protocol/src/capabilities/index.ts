import { parseQualifiedPluginContributionKey } from '../plugins/contributionIdentity.js';

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

export type CapabilityDescriptor = {
  id: CapabilityId;
  kind: CapabilityKind;
  title?: string;
  methods?: Record<string, { title?: string }>;
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
  | { ok: false; error: { message: string; code?: string }; logPath?: string };

export {
  CodexPassiveRealtimeSetupResultV1Schema,
  CodexPassiveRealtimeSetupStatusV1Schema,
  type CodexPassiveRealtimeSetupResultV1,
  type CodexPassiveRealtimeSetupStatusV1,
} from './codexPassiveRealtimeSetup.js';
