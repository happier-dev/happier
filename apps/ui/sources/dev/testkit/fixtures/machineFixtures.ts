import type { Machine } from '@/sync/domains/state/storageTypes';
import type { FetchedMachineRow } from '@/sync/engine/machines/syncMachines';
import { AccessibleMachineAccessV1Schema } from '@happier-dev/protocol/machines/machineAccessV1';
import { encodePlainMachineStoredContent, MACHINE_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol/machines/machineStoredContent';
import { PluginProjectionV2Schema, type PluginProjectionV2 } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import { MachineAgentInventoryItemSchema, type CapabilitiesDetectResponse } from '@happier-dev/protocol/capabilities';
import { MachineReadBatchRequestV1Schema, MachineReadBatchResponseV1Schema } from '@happier-dev/protocol/machines/machineReadBatchV1';
import type { BugReportMachineDiagnosticsSnapshot } from '@happier-dev/protocol/diagnostics/bugReportMachineDiagnostics';

/** Complete daemon RPC wire response; doctor-only tests replace the snapshot they exercise. */
export function createMachineDiagnosticsFixture(overrides: Partial<BugReportMachineDiagnosticsSnapshot> = {}): BugReportMachineDiagnosticsSnapshot {
    return {
        daemonState: null,
        daemonLogs: [],
        doctorSnapshot: null,
        runtime: { cwd: '/project', platform: 'linux', nodeVersion: 'v22' },
        stackContext: null,
        ...overrides,
    };
}

/** Current HTTP batch wire, backed by the same explicit external rows as exact reads. */
export function createMachineReadBatchResponseFixture(body: unknown, readMachine: (machineId: string) => unknown | null): Response {
    const input = MachineReadBatchRequestV1Schema.parse(typeof body === 'string' ? JSON.parse(body) : body);
    return Response.json(MachineReadBatchResponseV1Schema.parse({ results: input.machineIds.map(machineId => {
        const machine = readMachine(machineId);
        return machine === null ? { machineId, status: 'not_found' } : { machineId, status: 'found', machine };
    }) }));
}

/** Plain transport fixtures intentionally admit any requested Machine ID for this Account. */
export function createPlainMachineReadHttpResponseFixture(path: string, init?: RequestInit, accountId = 'artifact-account'): Response | null {
    const read = (id: string) => createPlainMachineRowFixture({ id, accountId });
    if (path === '/v1/machines/read-batch' && init?.method === 'POST') return createMachineReadBatchResponseFixture(init.body, read);
    const exact = /^\/v1\/machines\/([^/]+)$/.exec(path);
    if (exact && (init?.method ?? 'GET') === 'GET') return Response.json({ machine: read(decodeURIComponent(exact[1]!)) });
    return null;
}

export type ReadyMachineAgentInventoryFixture = {
    projection: PluginProjectionV2;
    capabilities: {
        protocolVersion: 1;
        results: Record<string, {
            ok: true;
            checkedAt: number;
            data: ReturnType<typeof MachineAgentInventoryItemSchema.parse> & {
                isLoggedIn: boolean;
                authStatus: { state: string; checkedAt: number };
            };
        }>;
    };
};

/** Daemon declarations and native probe facts; catalog/admission projections stay real. */
export function createReadyMachineAgentInventoryFixture(agents: readonly Readonly<{ agentId: string; title: string }>[]): ReadyMachineAgentInventoryFixture {
    const items = agents.map(agent => MachineAgentInventoryItemSchema.parse({ ...agent,
        installed: true, version: '1.0.0', latestVersion: null, update: { supported: false, command: null },
        signIn: { status: 'signedIn', loginSupport: 'status_only' }, platform: { supported: true },
        install: { available: false, mode: 'manual', sizeBytes: null, guideUrl: null }, dependencies: [],
    }));
    return {
        projection: PluginProjectionV2Schema.parse({ v: 2, generation: 1, agentsById: Object.fromEntries(items.map(item => [item.agentId, {
            id: item.agentId, title: item.title, isBuiltIn: true, providerOwnedEnvironmentKeys: [],
            capabilities: { surfaces: [], sessions: { open: ['create'], delivery: ['newTurn'], cancel: true } },
        }])) }),
        capabilities: { protocolVersion: 1, results: Object.fromEntries(items.map(item => [`cli.${item.agentId}`, {
            ok: true, checkedAt: 1, data: { ...item, isLoggedIn: true, authStatus: { state: 'logged_in', checkedAt: 1 } },
        }])) } satisfies CapabilitiesDetectResponse,
    };
}

/** Already-hydrated client row; pending/locked fixtures override its admitted availability. */
export function createMachineFixture(overrides: Partial<Machine> = {}): Machine {
    const createdAt = overrides.createdAt ?? 1;
    const updatedAt = overrides.updatedAt ?? createdAt;

    return {
        id: 'machine-1',
        managedMachineRef: null,
        seq: 1,
        createdAt,
        updatedAt,
        active: true,
        activeAt: updatedAt,
        metadata: {
            host: 'tester.local',
            platform: 'darwin',
            happyCliVersion: '0.0.0-test',
            happyHomeDir: '/Users/tester/.happy-dev',
            homeDir: '/Users/tester',
        },
        metadataVersion: 1,
        daemonState: null,
        daemonStateVersion: 1,
        availability: { kind: 'available' },
        ...overrides,
    };
}

export function createMachineListByServerIdFixture(
    machines: Machine[],
    serverId: string = 'server-a',
): Record<string, Machine[]> {
    return {
        [serverId]: machines,
    };
}

/** A Home census row, not an already-opened client projection. */
export function createPlainMachineRowFixture(input: Readonly<{ id: string; accountId: string; machine?: Machine }>): FetchedMachineRow {
    const machine = input.machine ?? createMachineFixture({ id: input.id, activeAt: Date.now() });
    return {
        id: machine.id, kind: 'persistent', seq: machine.seq,
        managedMachineRef: machine.managedMachineRef ?? null,
        createdAt: machine.createdAt, updatedAt: machine.updatedAt,
        active: machine.active, activeAt: machine.activeAt,
        ...(machine.presenceProtocolVersion === 1 ? { presenceProtocolVersion: 1 as const } : {}),
        metadata: encodePlainMachineStoredContent(machine.metadata), metadataVersion: machine.metadataVersion,
        daemonState: machine.daemonState == null ? null : encodePlainMachineStoredContent(machine.daemonState), daemonStateVersion: machine.daemonStateVersion,
        dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER,
        revokedAt: null, replacedByMachineId: null, installationId: 'test-installation',
        access: AccessibleMachineAccessV1Schema.parse(machine.access ?? { custodian: { accountId: input.accountId, displayName: 'Test Account' },
            role: 'manage', resourceMode: 'plain', accessState: 'ready' }),
    };
}
