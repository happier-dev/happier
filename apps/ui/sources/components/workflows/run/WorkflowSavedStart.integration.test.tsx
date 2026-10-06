import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    ArtifactAccessRecipientCensusResponseV1Schema,
    CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION,
    WorkflowDefinitionGetResultV1Schema,
    WorkflowRunRecipientCensusResponseV1Schema,
    WorkflowRunRecipientKeyEnvelopesV1Schema,
    WorkflowRunStartRequestV1Schema,
    TargetedActionRpcRequestV1Schema,
    createAccountScopedCryptoMaterialSnapshotV1,
    convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1,
    createWorkflowAccountRunActionOwner,
    resolveWorkflowRunDataKeyV1,
    openWorkflowAcceptedSnapshotStoredEnvelopeV1,
    parseWorkflowStoredContentEnvelopeV1,
    type AvailableAutomationAccountEncryptionV1,
    type WorkflowRunStartRequestV1,
} from '@happier-dev/protocol';
import { createWorkflowDefinitionActions } from '@happier-dev/protocol/actions';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { renderScreen } from '@/dev/testkit';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { createWorkflowDefinitionFixture, createWorkflowRunSummaryFixture } from '@/dev/testkit/fixtures/workflowRunFixtures';
import { withPopoverWebGlobals } from '@/dev/testkit/harness/popoverHarness';
import { installShippedNativeFrameScheduler } from '@/dev/testkit/legend/shippedNativeLegendRuntime';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { captureLazyActionAccountContext } from '@/sync/ops/actions/actionAccountContext';
import { callWorkflowAction } from '@/sync/domains/workflows/callWorkflowAction';
import { storage } from '@/sync/domains/state/storageStore';
import type { Artifact, ArtifactCreateRequest } from '@/sync/domains/artifacts/artifactTypes';
import { Modal } from '@/modal';
import { resolveAbsolutePath } from '@/utils/path/pathUtils';
import { AppPaneProvider } from '@/components/appShell/panes/AppPaneProvider';
import { WorkflowEditorHostScreen } from '../screens/WorkflowEditorHostScreen';
import { WorkflowEditorBody } from '../screens/WorkflowEditorBody';

// Only network, credentials and platform rendering/loading are replaced. The
// saved Artifact writer/opener, front door, controller and admission stay real.
installDisconnectedServerSocketBoundary();
const machineRpc = vi.hoisted(() => vi.fn());
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({ machineRpcWithServerScope: machineRpc }));
vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock());
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock().module);
const router = await vi.hoisted(async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock());
vi.mock('expo-router', () => router.module);
vi.mock('expo-crypto', async () => ({ randomUUID: (await import('node:crypto')).randomUUID }));
await vi.hoisted(async () => { vi.stubGlobal('React', await import('react')); });
// Adapt Metro's synchronous require to Vitest without replacing execution.
vi.mock('@/sync/ops/actions/frontDoorRuntimeActionExecutor', async (importOriginal) => {
    const original = await importOriginal<typeof import('@/sync/ops/actions/frontDoorRuntimeActionExecutor')>();
    return { ...original, createFrontDoorActionExecute: () => {
        let execute: ReturnType<typeof original.createFrontDoorActionExecute> | undefined;
        return async (...args: Parameters<ReturnType<typeof original.createFrontDoorActionExecute>>) => {
            execute ??= original.createFrontDoorActionExecute((await import('@/sync/ops/actions/defaultActionExecutor')).createDefaultActionExecutor());
            return execute(...args);
        };
    } };
});

const accountId = 'saved-start-account';
const definitionId = '8fab3a81-5e64-4000-8000-000000000001';
const savedDefinition = createWorkflowDefinitionFixture({ inputs: [], defaults: {}, blocks: [{ kind: 'wait', id: 'wait',
    document: { text: 'Saved fieldless Wait', references: [], attachments: [] } }] });
const reviewedDefinition = { ...savedDefinition, blocks: [{ ...savedDefinition.blocks[0],
    document: { text: 'Reviewed unsaved Wait', references: [], attachments: [] } }] };
const disposals: Array<() => Promise<void>> = [];
afterEach(async () => {
    for (const dispose of disposals.splice(0).reverse()) await dispose();
    machineRpc.mockReset();
    router.spies.push.mockClear();
    vi.mocked(Modal.alert).mockClear();
    vi.unstubAllGlobals();
});

describe('saved editor Start through the real front door and Account admission', () => {
    it.each(['plain', 'e2ee'] as const)('admits the reviewed inline draft bound to a readable %s Artifact', async (mode) => {
        vi.stubGlobal('React', React);
        installShippedNativeFrameScheduler();
        const restorePlatform = withPopoverWebGlobals();
        disposals.push(async () => restorePlatform());
        await loadSyncSingletonForTests();
        const secret = new Uint8Array(32).fill(24);
        const material = createAccountScopedCryptoMaterialSnapshotV1({ accountEncryptionMode: 'e2ee', material: { type: 'legacy', secret } });
        const encryption: AvailableAutomationAccountEncryptionV1 = mode === 'plain'
            ? { kind: 'available', witness: { mode, version: 1, contentKeyFingerprint: null } }
            : { kind: 'available', material, witness: { mode, version: 1,
                contentKeyFingerprint: convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1(material.contentPublicKeyFingerprint) } };
        const token = `e30.${Buffer.from(JSON.stringify({ sub: accountId })).toString('base64url')}.signature`;
        const artifacts = new Map<string, Artifact>();
        const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
        const account = await restoreServerAccountForTest({ serverUrl: `https://saved-start-${crypto.randomUUID()}.test`, accountId,
            credentials: mode === 'plain' ? { token } : { token, secret: Buffer.from(secret).toString('base64url') },
            request: async (url, init) => {
                const path = new URL(String(url)).pathname;
                if (path === '/health') return json({});
                if (path === '/v1/features') return json({ features: { automations: { enabled: true }, workflows: { enabled: true } }, capabilities: {
                    accountStoredContentCompatibility: { v: 1, minimumProtocolVersion: CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION,
                        currentProtocolVersion: CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION, declarationTransport: 'http-header-and-socket-auth-v1' },
                } });
                if (path === '/v1/account/encryption') return json({ mode, updatedAt: 0 });
                if (path === '/v2/account/settings') return json({ content: null, version: 0 });
                if (path === '/v1/account/encryption/currentness') return json({ ...encryption.witness, signingKeyFingerprint: null, updatedAt: 0,
                    recipientEnvelopeReadiness: mode === 'plain' ? { status: 'unavailable', reason: 'plain_account' } : { status: 'available' } });
                if (path === '/v3/automations') return json({ automations: [], nextCursor: null });
                if (path === '/v1/artifacts') {
                    if (init?.method !== 'POST') return json([...artifacts.values()]);
                    const input = JSON.parse(String(init.body)) as ArtifactCreateRequest;
                    const row: Artifact = { ...input, ownerAccountId: accountId, access: 'owner', encryptionMode: mode,
                        headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 };
                    artifacts.set(row.id, row);
                    return json(row);
                }
                if (path === `/v1/artifacts/${definitionId}/access/grants`) return json({ artifactId: definitionId, ownerAccountId: accountId, access: 'owner', grants: [] });
                const artifact = artifacts.get(definitionId);
                if (artifact && path === `/v1/artifacts/${definitionId}/access/recipients`) return json(ArtifactAccessRecipientCensusResponseV1Schema.parse({
                    artifactId: definitionId, ownerAccountId: accountId, access: 'owner', encryptionMode: mode,
                    dataEncryptionKey: mode === 'plain' ? null : artifact.dataEncryptionKey,
                    callerDataEncryptionKey: mode === 'plain' ? null : artifact.dataEncryptionKey,
                    provenanceDataEncryptionKey: artifact.provenanceDataEncryptionKey ?? null,
                    callerProvenanceDataEncryptionKey: artifact.provenanceDataEncryptionKey ?? null, recipients: [],
                }));
                if (artifact && path === `/v1/artifacts/${definitionId}`) return json(artifact);
                return json({}, 404);
            } });
        disposals.push(account.dispose);
        // Use the current real writer, rather than reconstructing a saved header.
        await callWorkflowAction({ actionId: 'workflow.definition.create', input: { definitionId, definition: savedDefinition, metadata: { title: 'Saved Wait' } },
            parseResult: value => WorkflowDefinitionGetResultV1Schema.parse(value) });
        const captured = await captureLazyActionAccountContext(account.home.id);
        disposals.push(async () => captured.dispose());
        const definitions = createWorkflowDefinitionActions({ artifactStore: captured.workflowArtifacts,
            encodeListCursor: captured.encodeArtifactListCursor,
            assertDefinitionWriteAllowed: () => { throw new Error('admission_must_not_write_saved_definition'); },
        });
        const operations: Readonly<Record<string, unknown>>[] = [];
        let submitted: WorkflowRunStartRequestV1 | undefined;
        let rpcFailure: unknown;
        const owner = createWorkflowAccountRunActionOwner({ definitions, resolveAccountId: async () => accountId,
            resolveEncryption: async () => encryption, normalizeAbsolutePath: resolveAbsolutePath,
            randomBytes: length => {
                if (mode === 'plain') throw new Error('plain_account_must_not_require_keys');
                return crypto.getRandomValues(new Uint8Array(length));
            },
            prepareWorkspace: async () => ({ ok: true, workspaceTarget: { project: { machineId: 'machine-1', directory: '/repo', checkoutRootPath: '/repo' } } }),
            resolveMaterializationContext: async () => ({ effects: { resolveTargetAvailability: async () => true } }),
            storage: { execute: async operation => {
                operations.push(operation);
                if (operation.operation === 'get') throw Object.assign(new Error('run_not_found'), { code: 'run_not_found' });
                if (operation.operation === 'run-key.census') return WorkflowRunRecipientCensusResponseV1Schema.parse({
                    runId: operation.runId, ownerAccountId: accountId, visibleTeamId: null, encryptionMode: mode, access: 'owner',
                    ownerAccountCurrentness: encryption.witness, dataEncryptionKey: null, callerDataEncryptionKey: null, recipients: [],
                });
                if (operation.operation === 'admit') return { kind: 'created', run: createWorkflowRunSummaryFixture({
                    id: String(operation.runId), machineId: 'machine-1', ownerAccountId: accountId,
                    sourceArtifactId: String(operation.sourceArtifactId), state: 'queued', origin: { kind: 'direct' },
                }) };
                throw new Error(`unexpected_storage_operation:${operation.operation}`);
            } },
        });
        machineRpc.mockImplementation(async request => {
            if (request.method !== getActionSpec('workflow.run.start').bindings?.rpcMethod) {
                // Native/plugin catalog network reads are unavailable in this fixture;
                // the fieldless Wait needs no Agent or Provider contribution.
                return { error: 'method_not_found' };
            }
            try {
                const targeted = TargetedActionRpcRequestV1Schema.parse(request.payload);
                submitted = WorkflowRunStartRequestV1Schema.parse(targeted.input);
                return await owner.execute({ actionId: 'workflow.run.start', input: submitted,
                    context: { surface: 'ui', authority: 'present_user', callerPermissionMode: 'default', externalActionTarget: targeted.target } });
            } catch (error) { rpcFailure = error; throw error; }
        });
        const machine = createMachineFixture();
        storage.setState({ machines: { [machine.id]: machine }, machineListByServerId: {} });
        const screen = await renderScreen(<AppPaneProvider><WorkflowEditorHostScreen source={{ kind: 'saved', definitionId }} /></AppPaneProvider>, {
            createNodeMock: () => ({ getBoundingClientRect: () => ({ left: 600, top: 100, width: 160, height: 40 }), contains: () => false, focus: () => {},
                addEventListener: () => {}, removeEventListener: () => {},
                measureInWindow: (receive: (x: number, y: number, width: number, height: number) => void) => receive(600, 100, 160, 40) }),
        });
        disposals.push(screen.unmount);
        await vi.waitFor(() => expect(screen.root.findByType(WorkflowEditorBody).props.draft).not.toBeNull());
        await act(async () => {
            const body = screen.root.findByType(WorkflowEditorBody);
            body.props.onChange({ ...body.props.draft, blocks: reviewedDefinition.blocks });
            body.props.onChangeProjectTarget({ machineId: 'machine-1', directory: '/repo' });
        });
        await screen.pressByTestIdAsync('workflow-editor-run-now');
        await vi.waitFor(() => expect(screen.findByTestId('workflow-run-inputs-run')?.props.disabled).toBe(false));
        await screen.pressByTestIdAsync('workflow-run-inputs-run');
        await vi.waitFor(() => expect(router.spies.push.mock.calls.length + vi.mocked(Modal.alert).mock.calls.length).toBeGreaterThan(0));
        expect(rpcFailure).toBeUndefined();
        expect(Modal.alert).not.toHaveBeenCalled();
        expect(router.spies.push).toHaveBeenCalled();
        expect(submitted?.source).toMatchObject({ kind: 'inline', sourceArtifactId: definitionId, definition: reviewedDefinition });
        const admits = operations.filter(operation => operation.operation === 'admit');
        expect(admits).toHaveLength(1);
        const admitted = admits[0]!;
        expect(admitted.sourceArtifactId).toBe(definitionId);
        if (!submitted) throw new Error('missing_start_request');
        const census = WorkflowRunRecipientCensusResponseV1Schema.parse({ runId: submitted.runId, ownerAccountId: accountId,
            visibleTeamId: null, encryptionMode: mode, access: 'owner', ownerAccountCurrentness: encryption.witness,
            recipients: [], dataEncryptionKey: null, callerDataEncryptionKey: null });
        const keyRows = WorkflowRunRecipientKeyEnvelopesV1Schema.parse(admitted.recipientKeyEnvelopes);
        const ownerKey = keyRows.find(row => row.recipientAccountId === accountId)?.encryptedDataKey ?? null;
        const resolved = resolveWorkflowRunDataKeyV1({ encryption, census: { ...census, dataEncryptionKey: ownerKey, callerDataEncryptionKey: ownerKey } });
        if (resolved.kind !== 'available') throw new Error('admitted_run_key_unavailable');
        const opened = openWorkflowAcceptedSnapshotStoredEnvelopeV1({ ...resolved.encryption.runCrypto,
            binding: { v: 1, purpose: 'accepted_snapshot', accountId, runId: submitted.runId },
            envelope: parseWorkflowStoredContentEnvelopeV1(String(admitted.acceptedEnvelope)) });
        expect(opened).toMatchObject({ kind: 'available', content: { authoredDefinition: reviewedDefinition,
            source: { kind: 'inline', sourceArtifactId: definitionId } } });
        expect(router.spies.push).toHaveBeenLastCalledWith({ pathname: '/workflows/runs/[runId]', params: { runId: submitted.runId } });
        expect(artifacts.get(definitionId)?.bodyVersion).toBe(1);
    });
});
