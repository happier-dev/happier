import { vi } from 'vitest';
import {
    ARTIFACT_PLAIN_DATA_KEY_MARKER, encodePlainArtifactStoredContent, materializeWorkflowAcceptedSnapshotV1,
    sealWorkflowAcceptedSnapshotStoredEnvelopeV1, serializeWorkflowStoredContentEnvelopeV1,
    WorkflowRunRecipientCensusResponseV1Schema,
    type WorkflowRunSummaryV1,
} from '@happier-dev/protocol';
import { createWorkflowDefinitionFixture } from '@/dev/testkit/fixtures/workflowRunFixtures';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { installRealActionExecutorModuleLoader } from '@/dev/testkit/harness/actionHomesHttpHarness';
import type { Artifact } from '@/sync/domains/artifacts/artifactTypes';

export const RUN_STORAGE_PATH = '/v3/automations/runs/workflow-storage';
export const ARTIFACT_LIST_PATH = '/v1/artifacts?limit=500&includeBody=true';
export const AUTOMATION_LIST_PATH = '/v3/automations?limit=100';

/** Board library tests stop at HTTP, credentials and Socket.IO, leaving Account ownership real. */
export function installBoardLibraryTestHarness() {
    const home = createHomeGovernanceHarness();
    installHomeGovernanceBoundaries(home);
    installDisconnectedServerSocketBoundary((socket) => {
        vi.mocked(socket.connect).mockImplementation(() => {
            socket.connected = true;
            for (const listener of socket.listeners('connect')) listener();
            return socket;
        });
        vi.spyOn(socket, 'disconnect').mockImplementation(() => {
            socket.connected = false;
            return socket;
        });
    });
    let connection: Awaited<ReturnType<typeof restoreServerAccountForTest>> | undefined;
    let executorLoader: Awaited<ReturnType<typeof installRealActionExecutorModuleLoader>> | undefined;
    const restore = async (serverUrl: string, accountId: string) => {
        connection = await restoreServerAccountForTest({ serverUrl, accountId,
            request: async (url, init) => {
                const { serverFetch } = await import('@/sync/http/client');
                const target = new URL(String(url));
                return serverFetch(`${target.pathname}${target.search}`, init);
            },
        });
    };
    return {
        home,
        async connect(serverUrl: string, accountId = 'account-a') {
            await home.reset();
            installHomeGovernanceBoundaries(home);
            await loadSyncSingletonForTests();
            // Metro's lazy require is a loader boundary. Supply the real evaluated module.
            executorLoader = await installRealActionExecutorModuleLoader();
            const serverId = await home.addHome({ name: 'Board Home', serverUrl, accountId });
            home.answer(serverId, '/v1/account/encryption/currentness', { body: createPlainAccountEncryptionCurrentnessFixture() });
            home.answer(serverId, AUTOMATION_LIST_PATH, { body: { automations: [], nextCursor: null } });
            await restore(serverUrl, accountId);
            return serverId;
        },
        async switchAccount(serverId: string, serverUrl: string, accountId: string) {
            await connection?.dispose();
            await home.switchAccount(serverId, accountId);
            installHomeGovernanceBoundaries(home);
            await restore(serverUrl, accountId);
        },
        async dispose() {
            await connection?.dispose();
            connection = undefined;
            executorLoader?.();
            executorLoader = undefined;
        },
    };
}

/** A Home's stored Plain Artifact, opened by the real Artifact codec and definition owner. */
export function boardDefinitionArtifact(id: string, title: string, accountId = 'account-a') {
    const definition = createWorkflowDefinitionFixture({ defaults: {
        agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.test', localId: 'test' } },
    } });
    return {
        id, ownerAccountId: accountId, access: 'owner', encryptionMode: 'plain',
        header: encodePlainArtifactStoredContent({ kind: 'workflow-definition.v1', definitionId: id,
            revision: { headerVersion: 1, bodyVersion: 1 }, metadata: { title } }),
        body: encodePlainArtifactStoredContent({ body: JSON.stringify({ kind: 'workflow-definition.v1', definition }) }),
        headerVersion: 1, bodyVersion: 1, dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER, seq: 0, createdAt: 1, updatedAt: 1,
    } satisfies Artifact;
}

/** Stored Run pages carry sealed accepted content; the real owner projects starter and location. */
export async function boardRunStoragePage(rows: readonly WorkflowRunSummaryV1[], nextCursor?: string) {
    const acceptedEnvelopesByRunId: Record<string, string> = {};
    const keyCensusByRunId: Record<string, ReturnType<typeof WorkflowRunRecipientCensusResponseV1Schema.parse>> = {};
    const runs = [];
    for (const row of rows) {
        const ownerAccountId = 'account-a';
        const accepted = await materializeWorkflowAcceptedSnapshotV1({
            definition: createWorkflowDefinitionFixture({ defaults: {
                agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.test', localId: 'test' } },
            } }),
            context: { source: { kind: 'saved', definitionId: 'board-source',
                revision: { headerVersion: 1, bodyVersion: 1 }, savedBy: null },
                inputs: {}, machineId: row.machineId, executionTarget: { kind: 'session' },
                workspaceTarget: { project: { machineId: row.machineId, directory: '/repo', checkoutRootPath: '/repo' } },
                origin: { kind: 'direct', originSessionId: 'board-origin' }, authorization: { principal: { kind: 'host' } } },
            admission: { kind: 'user' }, effects: { resolveTargetAvailability: async () => true },
        });
        if (!accepted.ok) throw new Error(`Board Run fixture admission failed: ${accepted.error.code}`);
        runs.push({ ...row, ownerAccountId });
        acceptedEnvelopesByRunId[row.id] = serializeWorkflowStoredContentEnvelopeV1(sealWorkflowAcceptedSnapshotStoredEnvelopeV1({
            mode: 'plain', binding: { v: 1, purpose: 'accepted_snapshot', accountId: ownerAccountId, runId: row.id },
            acceptedSnapshot: { ...accepted.snapshot, startedBy: row.startedBy ?? 'user' },
        }));
        keyCensusByRunId[row.id] = WorkflowRunRecipientCensusResponseV1Schema.parse({
            runId: row.id, ownerAccountId, visibleTeamId: null, encryptionMode: 'plain', access: 'owner',
            ownerAccountCurrentness: { mode: 'plain', version: 1, contentKeyFingerprint: null },
            dataEncryptionKey: null, callerDataEncryptionKey: null, recipients: [],
        });
    }
    return { runs, acceptedEnvelopesByRunId, keyCensusByRunId, ...(nextCursor ? { nextCursor } : {}) };
}
