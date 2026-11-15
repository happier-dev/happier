import { vi } from 'vitest';
import {
    ARTIFACT_PLAIN_DATA_KEY_MARKER, encodePlainArtifactStoredContent} from '@happier-dev/protocol/storage/artifactStoredContent';
import { materializeWorkflowAcceptedSnapshotV1} from '@happier-dev/protocol/workflows/materializeWorkflowAcceptedSnapshotV1';
import {
    sealWorkflowAcceptedSnapshotStoredEnvelopeV1, serializeWorkflowStoredContentEnvelopeV1} from '@happier-dev/protocol/workflows/workflowStoredContentV1';
import {
    WorkflowRunRecipientCensusResponseV1Schema} from '@happier-dev/protocol/workflows/workflowRunKeyV1';
import {
    type WorkflowRunSummaryV1,
} from '@happier-dev/protocol/workflows/workflowProgressV1';
import { createWorkflowDefinitionFixture } from '@/dev/testkit/fixtures/workflowRunFixtures';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { createArtifactListHttpResponse } from '@/dev/testkit/harness/artifactStoreBoundary';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { installRealActionExecutorModuleLoader } from '@/dev/testkit/harness/actionHomesHttpHarness';
import type { Artifact } from '@/sync/domains/artifacts/artifactTypes';

export const RUN_STORAGE_PATH = '/v3/automations/runs/workflow-storage';
export const ARTIFACT_LIST_PATH = `/v1/artifacts?${new URLSearchParams({ limit: '500', kinds: JSON.stringify(['workflow-definition.v1']) })}`;
export const AUTOMATION_QUERY_PATH = '/v3/automations/query';

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
        // This connected SDK fixture has no Engine.IO transport; presence
        // teardown stays real while outbound Socket.IO packets stop here.
        vi.spyOn(socket, 'emit').mockReturnValue(socket);
        vi.spyOn(socket, 'disconnect').mockImplementation(() => {
            socket.connected = false;
            return socket;
        });
    });
    let connection: Awaited<ReturnType<typeof restoreServerAccountForTest>> | undefined;
    let executorLoader: Awaited<ReturnType<typeof installRealActionExecutorModuleLoader>> | undefined;
    const restore = async (serverUrl: string, accountId: string) => {
        connection = await restoreServerAccountForTest({ serverUrl, accountId,
            request: home.request,
        });
    };
    return {
        home,
        /** Keep definition tests at the HTTP boundary while exact-kind headers and batch bodies stay real. */
        answerDefinitions(serverId: string, answer: Readonly<{
            body?: readonly Artifact[];
            respondAfter?: PromiseLike<void>;
            dispatchThenFail?: boolean;
        }>) {
            if (answer.body) {
                const artifacts = home.artifacts(serverId);
                artifacts.clear();
                for (const artifact of answer.body) artifacts.replaceStoredRow(artifact);
            }
            home.answer(serverId, `GET ${ARTIFACT_LIST_PATH}`, { select: async (_input, request) => {
                const response = createArtifactListHttpResponse(new URL(request.url), home.artifacts(serverId).list());
                return { ...answer, body: await response.json(), status: response.status };
            } });
        },
        async connect(serverUrl: string, accountId = 'account-a', serverIdentityId?: string) {
            await home.reset();
            installHomeGovernanceBoundaries(home);
            await loadSyncSingletonForTests();
            // Metro's lazy require is a loader boundary. Supply the real evaluated module.
            executorLoader = await installRealActionExecutorModuleLoader();
            const serverId = await home.addHome({ name: 'Board Home', serverUrl, accountId, serverIdentityId });
            home.answer(serverId, '/v1/account/encryption/currentness', { body: createPlainAccountEncryptionCurrentnessFixture() });
            home.answer(serverId, `POST ${AUTOMATION_QUERY_PATH}`, { body: { automations: [], nextCursor: null } });
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
        id, ownerAccountId: accountId, access: 'owner', publicAudience: 'none', encryptionMode: 'plain',
        kind: 'other', kindHint: 'workflow-definition.v1',
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
