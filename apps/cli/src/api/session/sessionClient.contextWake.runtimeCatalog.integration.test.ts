import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import axios from 'axios';
import { Server } from 'socket.io';
import { io } from 'socket.io-client';
import { expect, it, vi } from 'vitest';
import { createSocketTransportAdapter } from '@happier-dev/sync-client';
import { FeaturesResponseSchema, deriveWorkflowSessionInputLocalIdV2, sealWorkflowAcceptedSnapshotStoredEnvelopeV1,
    sealWorkflowProgressStoredEnvelopeV1, serializeWorkflowStoredContentEnvelopeV1,
    type WorkflowRunSummaryV1 } from '@happier-dev/protocol';
import { SessionBroadcastContainerSchema } from '@happier-dev/protocol/updates';
import { UpdateSchema } from '@/api/types';
import type { ChangeEntry } from '@/api/changes';
import { MessageQueue2 } from '@/agent/runtime/modeMessageQueue';
import { createSessionProviderInputConsumerSessionAdapter } from '@/agent/runtime/waitForNextPermissionModeMessage';
import { createSessionProviderInputConsumer } from '@/agent/runtime/session/input/sessionProviderInputConsumer';
import { createWorkflowOriginContextInputPort } from '@/agent/runtime/session/contextOnly/workflowOriginInput';
import { resolveAutomationWorkerAccountEncryption } from '@/plugins/runtime/automations/automationAccountCurrentness';
import { createSessionFollowWakeSignal, publishSessionFollowWakeInvalidation } from '@/agent/runtime/session/follow/sessionFollowWakeSignal';
import { resolveApiSessionSocketDefaultAck } from '@/testkit/backends/apiSessionSocketHarness';
import { createPlainSessionFixture, createSessionRecordFixture } from '@/testkit/backends/sessionFixtures';
import { ApiSessionClient } from './sessionClient';

it('keeps unrelated writes quiet and releases frozen Workflow input after a new Account wake supersedes an empty page', async () => {
    const sessionId = 'wake-destination';
    const accountId = 'wake-account';
    const machineId = 'wake-machine';
    const runId = 'origin-run';
    const invocationId = 'step';
    const localInputId = deriveWorkflowSessionInputLocalIdV2({ purpose: 'invocation', runId, invocationRecordId: invocationId });
    const frozenText = 'Frozen role instructions\n\nCommitted input\n\nFrozen result contract';
    const run: WorkflowRunSummaryV1 = { id: runId, sourceArtifactId: null, ownerAccountId: accountId, visibleTeamId: null,
        origin: { kind: 'direct', originSessionId: sessionId }, machineId, state: 'running', revision: 2,
        workflowCustodyState: 'settled', originDeliveryAckRevision: null, attentionRequired: false,
        failureUnseen: false, invocationAttentionRequired: false, attentionSeenFailureAt: null, finishedAt: null,
        createdAt: '2026-09-30T00:00:00.000Z', updatedAt: '2026-09-30T00:00:00.000Z',
        availability: { pause: false, resumeBoundary: false, restoreWorkspace: false, cancel: false, inspectExecution: true, disabledReasons: [] } };
    const definition = { version: 1 as const, inputs: [], defaults: {}, blocks: [
        { kind: 'step' as const, id: 'work', document: { text: 'Committed input', references: [], attachments: [] }, input: [], result: { kind: 'text' as const } },
    ] };
    // Use the same canonical sealing owners as workflowOriginInput.test.ts;
    // storage supplies committed bytes while all opening and input selection stay real.
    const acceptedEnvelope = serializeWorkflowStoredContentEnvelopeV1(sealWorkflowAcceptedSnapshotStoredEnvelopeV1({
        mode: 'plain', binding: { v: 1, purpose: 'accepted_snapshot', accountId, runId },
        acceptedSnapshot: { startedBy: 'user', authoredDefinition: definition, definition, materializedLeaves: [], frozenChildren: {}, metadata: null,
            source: { kind: 'inline' }, inputs: {}, machineId, executionTarget: { kind: 'session' },
            workspaceTarget: { project: { machineId, directory: '/repo', checkoutRootPath: '/repo' } },
            origin: { kind: 'direct', originSessionId: sessionId },
            authorization: { principal: { kind: 'host' }, admittedPermissionCeiling: 'default' }, workDepth: 1 } }));
    const index = { id: invocationId, runId, sequence: '1', parentRecordId: 'root', memberOrdinal: '0', attempt: '0',
        lifecycle: 'admitting', contentRevision: '0', createdAt: run.createdAt, updatedAt: run.updatedAt };
    const contentEnvelope = serializeWorkflowStoredContentEnvelopeV1(sealWorkflowProgressStoredEnvelopeV1({ mode: 'plain',
        binding: { v: 1, purpose: 'invocation_progress', accountId, runId, recordId: invocationId,
            sequence: '1', parentRecordId: 'root', memberOrdinal: '0', attempt: '0' },
        progress: { kind: 'happier.workflow-progress.v1', blockKind: 'step', invocationPath: { blockId: 'work', scope: [] },
            attempt: '0', logicalInvocationRecordId: invocationId,
            input: { document: definition.blocks[0]!.document, input: [], renderedText: frozenText }, resultContract: { kind: 'text' },
            execution: { kind: 'session', sessionId, localInputId } } }));
    const initialSession = createPlainSessionFixture({ id: sessionId });
    const credentials = { token: 'context-wake-owner', encryption: null };
    const features = FeaturesResponseSchema.parse({ features: {}, capabilities: {} });
    const http = createServer((_request, response) => {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify(features));
    });
    const sockets = new Server(http, { path: '/v1/updates' });
    sockets.on('connection', socket => {
        void socket.join(socket.handshake.auth.clientType === 'user-scoped' ? 'account' : 'destination');
        socket.onAny((event: string, ...args: unknown[]) => {
            const ack = args.at(-1);
            if (typeof ack === 'function') ack(resolveApiSessionSocketDefaultAck(event, args[0]));
        });
    });
    await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
    const home = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
    let changes: ChangeEntry[] = [];
    let cursor = 0;
    const feedReads: number[] = [];
    // Home HTTP/authentication are system boundaries. The socket ingress,
    // changes parser/cursor, Session client, workflow port and consumer are real.
    const get = vi.spyOn(axios, 'get').mockImplementation(async url => {
        const path = new URL(String(url)).pathname;
        if (path === '/v1/account/profile') return { status: 200, data: { id: 'wake-account' } };
        if (path === '/v2/changes') {
            feedReads.push(Number(new URL(String(url)).searchParams.get('after')));
            return { status: 200, data: { nextCursor: cursor, changes } };
        }
        if (path === '/v1/account/encryption/currentness') return { status: 200, data: {
            mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1,
        } };
        if (path === `/v2/sessions/${sessionId}`) return { status: 200, data: {
            session: createSessionRecordFixture({ id: sessionId, encryptionMode: 'plain',
                metadata: JSON.stringify(initialSession.metadata), metadataVersion: initialSession.metadataVersion, share: null }),
        } };
        return { status: 404, data: {} };
    });
    const accountSocket = io(home, { path: '/v1/updates', transports: ['websocket'],
        auth: { clientType: 'user-scoped' }, reconnection: false });
    const sessionSocket = io(home, { path: '/v1/updates', transports: ['websocket'],
        auth: { clientType: 'session-scoped' }, autoConnect: false, reconnection: false });
    const lifetime = new AbortController();
    const followWake = createSessionFollowWakeSignal(() => sessionId);
    let client: ApiSessionClient | undefined;
    let waiting: Promise<unknown> | undefined;
    let workflowReads = 0;
    let takes = 0;
    let invalidations = 0;
    let offered = false;
    let dispatched = false;
    const releasedInputs: Array<{ text: string; localId: string; hash: string }> = [];
    const observedDispatches: string[] = [];
    try {
        await new Promise<void>((resolve, reject) => {
            accountSocket.once('connect', resolve);
            accountSocket.once('connect_error', reject);
        });
        client = new ApiSessionClient(credentials.token, initialSession, {
            localMachineId: 'wake-machine',
            metadataAuthority: { kind: 'owner', credentials, readCurrentCredentials: async () => credentials },
            onSessionFollowInvalidated: (sessionId, workflowOriginMayHaveChanged) => {
                invalidations++;
                publishSessionFollowWakeInvalidation(sessionId, workflowOriginMayHaveChanged);
            },
            transport: { serverId: 'context-wake-home', serverUrl: home,
                createAccountUpdatesSocket: () => accountSocket,
                createSessionSocketTransport: () => ({ socket: sessionSocket, transport: createSocketTransportAdapter(sessionSocket) }) },
        });
        // Production bindModeQueue attaches a provider consumer. That attachment
        // owns the Account socket lifetime while the provider is waiting idle.
        client.onUserMessage(() => { throw new Error('This fixture offers Workflow input only'); });
        await vi.waitFor(() => expect(invalidations).toBeGreaterThan(0));
        const workflow = createWorkflowOriginContextInputPort({
            accountId, originSessionId: sessionId, machineId, deliveryWake: followWake.workflowOrigin,
            storage: { execute: async operation => {
                if (operation.operation === 'delivery.pull') {
                    workflowReads++;
                    return { runs: offered ? [{ run, acceptedEnvelope, hasOriginInputCandidates: true }] : [] };
                }
                if (operation.operation === 'run-key.census') return { runId, ownerAccountId: accountId, access: 'owner',
                    encryptionMode: 'plain', visibleTeamId: null, ownerAccountCurrentness: { mode: 'plain', version: 1, contentKeyFingerprint: null },
                    dataEncryptionKey: null, callerDataEncryptionKey: null, recipients: [] };
                if (operation.operation === 'invocations.list') return { invocations: [index], progressEnvelopesByInvocationId: { [invocationId]: contentEnvelope } };
                throw new Error(`Unexpected Workflow storage operation: ${operation.operation}`);
            } },
            resolveEncryption: async signal => await resolveAutomationWorkerAccountEncryption({ token: credentials.token, credentials, signal }),
            // Durable transcript/host commitment is a storage boundary; no
            // native dispatch is simulated inside the input-consumer owner.
            readDispatchFact: async () => dispatched ? 'dispatched' : 'not_dispatched',
            onDispatchedInput: input => { observedDispatches.push(input.localInputId); },
            onError: error => { throw error; },
        });
        const consumer = createSessionProviderInputConsumer({
            messageQueue: new MessageQueue2<string, { text: string; localId: string }>(() => 'mode'),
            session: createSessionProviderInputConsumerSessionAdapter(client),
            reconcileWhenEmpty: 'skip', refreshBeforeQueuedBatch: false,
            waitForContextOnlyInputChange: signal => workflow.waitForChange(signal),
            takeContextOnlyInput: async signal => {
                takes++;
                const source = await workflow.take(signal);
                if (!source) return null;
                if (source.kind !== 'workflow_step') throw new Error('Expected the offered Workflow step');
                return { message: { text: source.text, localId: source.localInputId }, mode: 'mode', isolate: true, hash: source.localInputId };
            },
        });
        const wait = () => consumer.waitForNextInput({ abortSignal: lifetime.signal }).then(input => {
            if (input) releasedInputs.push({ ...input.message, hash: input.hash });
            return input;
        });
        waiting = wait();
        await vi.waitFor(() => expect(workflowReads).toBe(1));
        const drain = async () => { for (let turn = 0; turn < 5; turn++) await new Promise<void>(resolve => setImmediate(resolve)); };
        await drain();
        const baseline = takes;
        for (const entityId of ['other-session-a', 'other-session-b', 'other-session-c']) {
            cursor++;
            changes = [{ cursor, kind: 'session', entityId, changedAt: cursor }];
            const received = new Promise<void>(resolve => accountSocket.once('update', () => resolve()));
            sockets.to('account').emit('update', UpdateSchema.parse({ id: `account-${cursor}`, seq: cursor,
                createdAt: cursor, body: { t: 'account-change', changeKinds: ['session'], entityIds: [entityId] } }));
            await received;
            await drain();
        }
        expect({ takes, workflowReads }).toEqual({ takes: baseline, workflowReads: 1 });

        for (let turn = 0; turn < 3; turn++) {
            cursor++;
            changes = [{ cursor, kind: 'session', entityId: sessionId, changedAt: cursor,
                hint: { workflowOriginUnchangedSinceCursor: 0 } }];
            const beforeInvalidation = invalidations;
            sockets.to('account').emit('update', UpdateSchema.parse({ id: `account-${cursor}`, seq: cursor,
                createdAt: cursor, body: { t: 'account-change', changeKinds: ['session'], entityIds: [sessionId] } }));
            await vi.waitFor(() => expect(invalidations).toBeGreaterThan(beforeInvalidation));
            await drain();
        }
        expect({ takes, workflowReads }).toEqual({ takes: baseline, workflowReads: 1 });

        // Prime a successful empty live page at the settled cursor. The next
        // distinct Account wake must retire that page, even at the same cursor.
        changes = [];
        for (const id of ['account-settle-cursor', 'account-empty-at-settled-cursor']) {
            const receivedEmpty = new Promise<void>(resolve => accountSocket.once('update', () => resolve()));
            sockets.to('account').emit('update', UpdateSchema.parse({ id, seq: cursor,
                createdAt: cursor, body: { t: 'account-change', changeKinds: ['session'], entityIds: [sessionId] } }));
            await receivedEmpty;
            await drain();
        }
        const emptyReadCursor = feedReads.at(-1);

        // Workflow delivery is durable on its origin Session; this path has no
        // exact Session socket broadcast to compensate for a missing Account wake.
        const beforeOwnChange = { workflowReads, invalidations };
        offered = true;
        cursor++;
        changes = [{ cursor, kind: 'session', entityId: sessionId, changedAt: cursor,
            hint: { kind: 'workflow-run-delivery', runId: 'origin-run', revision: 2 } }];
        sockets.to('account').emit('update', UpdateSchema.parse({ id: `account-${cursor}`, seq: cursor,
            createdAt: cursor, body: { t: 'account-change', changeKinds: ['session'], entityIds: [sessionId] } }));
        await vi.waitFor(() => expect(releasedInputs).toEqual([{ text: frozenText, localId: localInputId, hash: localInputId }]));
        await expect(waiting).resolves.toMatchObject({ message: { text: frozenText, localId: localInputId }, hash: localInputId });
        expect(invalidations).toBeGreaterThan(beforeOwnChange.invalidations);
        expect(workflowReads).toBeGreaterThan(beforeOwnChange.workflowReads);
        expect(feedReads.at(-1)).toBe(emptyReadCursor);
        // The transcript/host boundary now proves dispatch of this exact identity.
        dispatched = true;
        consumer.releaseInputBatch();
        waiting = wait();
        await drain();
        // The existing destination broadcast remains the direct Follow path.
        const beforeExactChange = workflowReads;
        sockets.to('destination').emit('session', SessionBroadcastContainerSchema.parse({ id: 'source-message', createdAt: 10,
            body: { t: 'session-changed', sessionId } }));
        await vi.waitFor(() => expect(workflowReads).toBeGreaterThan(beforeExactChange));
        await drain();
        expect(releasedInputs).toEqual([{ text: frozenText, localId: localInputId, hash: localInputId }]);
        expect(observedDispatches).toContain(localInputId);
    } finally {
        lifetime.abort();
        await waiting;
        await client?.close();
        accountSocket.close(); sessionSocket.close();
        await new Promise<void>(resolve => sockets.close(() => resolve()));
        get.mockRestore();
        followWake.dispose();
    }
});
