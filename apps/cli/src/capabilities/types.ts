import type { ChecklistId } from './checklistIds';
import type { CapabilityDescriptor } from '@happier-dev/protocol/capabilities';

export type { ChecklistId } from './checklistIds';
export type { CapabilityDescriptor } from '@happier-dev/protocol/capabilities';

// Capability IDs are namespaced strings returned by the daemon.
// Keep this flexible so new capabilities (including new `cli.<agent>` ids) do not require constant churn.
export type CliCapabilityId = `cli.${string}`;
export type ToolCapabilityId = `tool.${string}`;
export type DepCapabilityId = `dep.${string}`;

export type CapabilityId =
    | CliCapabilityId
    | ToolCapabilityId
    | DepCapabilityId;

export type CapabilityKind = 'cli' | 'tool' | 'dep';

export type CapabilityDetectRequest = {
    id: CapabilityId;
    params?: Record<string, unknown>;
};

export type CapabilitiesDescribeResponse = {
    protocolVersion: 1;
    capabilities: CapabilityDescriptor[];
    checklists: Record<ChecklistId, CapabilityDetectRequest[]>;
};

export type CapabilityDetectResult =
    | { ok: true; checkedAt: number; data: unknown }
    | { ok: false; checkedAt: number; error: { message: string; code?: string } };

export type CapabilitiesDetectRequest = {
    checklistId?: ChecklistId;
    requests?: CapabilityDetectRequest[];
    overrides?: Partial<Record<CapabilityId, { params?: Record<string, unknown> }>>;
    bypassCache?: boolean;
};

export type CapabilitiesDetectResponse = {
    protocolVersion: 1;
    results: Partial<Record<CapabilityId, CapabilityDetectResult>>;
};

export type CapabilitiesInvokeRequest = {
    id: CapabilityId;
    method: string;
    params?: Record<string, unknown>;
};

export type { CapabilitiesInvokeResponse } from '@happier-dev/protocol/capabilities';
