import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    ArtifactAccessRecipientCensusResponseV1Schema} from '@happier-dev/protocol/artifacts/artifactAccessV1';
import {
    CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION} from '@happier-dev/protocol/clientCompatibility/accountStoredContentCompatibilityV1';
import {
    WorkflowDefinitionGetResultV1Schema,
    WorkflowRunStartRequestV1Schema,
    type WorkflowRunStartRequestV1,
} from '@happier-dev/protocol/workflows/actionsV1';
import {
    WorkflowRunAdmissionPreparationResultV1Schema,
    WorkflowRunRecipientCensusResponseV1Schema,
    WorkflowRunRecipientKeyEnvelopesV1Schema} from '@happier-dev/protocol/workflows/workflowRunKeyV1';
import {
    WorkflowDefinitionV1Schema} from '@happier-dev/protocol/workflows/workflowV1';
import {
    createAccountScopedCryptoMaterialSnapshotV1} from '@happier-dev/protocol/crypto/accountScopedCipher';
import {
    convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1} from '@happier-dev/protocol/account/encryptionKeyFingerprintV1';
import {
    createWorkflowAccountRunActionOwner} from '@happier-dev/protocol/actions/executor/workflowRunActions';
import {
    resolveWorkflowRunDataKeyV1} from '@happier-dev/protocol/workflows/workflowRunDataKeyV1';
import {
    openWorkflowAcceptedSnapshotStoredEnvelopeV1,
    parseWorkflowStoredContentEnvelopeV1} from '@happier-dev/protocol/workflows/workflowStoredContentV1';
import {
    type AvailableAutomationAccountEncryptionV1} from '@happier-dev/protocol/automations/automationAccountCurrentnessV1';
import { createWorkflowDefinitionActions } from '@happier-dev/protocol/actions';
import { ActionExecuteFailureSchema } from '@happier-dev/protocol/actions/actionExecutionResult';
import { renderScreen } from '@/dev/testkit';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { createWorkflowDefinitionFixture, createWorkflowRunSummaryFixture } from '@/dev/testkit/fixtures/workflowRunFixtures';
import { withPopoverWebGlobals } from '@/dev/testkit/harness/popoverHarness';
import { installShippedNativeFrameScheduler } from '@/dev/testkit/legend/shippedNativeLegendRuntime';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import type { Artifact, ArtifactCreateRequest } from '@/sync/domains/artifacts/artifactTypes';
import { resolveAbsolutePath } from '@/utils/path/pathUtils';
import { createArtifactReadBatchHttpResponse, projectArtifactStoredKind } from '@/dev/testkit/harness/artifactStoreBoundary';
import { createExternalActionAccountHttpBoundary } from '@/dev/testkit/harness/externalActionAccountHttpBoundary';
import { t } from '@/text';
import { createWorkflowRunRoute } from '@/sync/domains/workflows/workflowRunRoute';

// Only network, credentials and platform rendering/loading are replaced. The
// saved Artifact writer/opener, front door, controller and admission stay real.
installDisconnectedServerSocketBoundary();
const { createAccountTokenForTests } = await import('@/dev/testkit/harness/homeGovernanceHarness');
const { createEncryptionFromAuthCredentials } = await import('@/auth/encryption/createEncryptionFromAuthCredentials');
const { captureLazyActionAccountContext } = await import('@/sync/ops/actions/actionAccountContext');
const { callWorkflowAction } = await import('@/sync/domains/workflows/callWorkflowAction');
const { storage } = await import('@/sync/domains/state/storageStore');
const { AppPaneProvider } = await import('@/components/appShell/panes/AppPaneProvider');
const { ModalProvider, useModal } = await import('@/modal/ModalProvider');
const { WorkflowEditorHostScreen } = await import('../screens/WorkflowEditorHostScreen');
const { WorkflowEditorBody } = await import('../screens/WorkflowEditorBody');
const machineRpc = vi.hoisted(() => vi.fn());
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({ machineRpcWithServerScope: machineRpc }));
vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock());
// DOM painting is external; the host provider, registry and alert/composer custody stay real.
vi.mock('@/utils/web/radixCjs', async () => {
    const boundary = (await import('@/dev/testkit/mocks/radixCjs')).createRadixCjsModuleMock();
    // The SDK's CJS modules retain component identity across every require.
    const dialog = boundary.requireRadixDialog();
    const layer = boundary.requireRadixDismissableLayer();
    const focus = boundary.requireRadixFocusScope();
    return { requireRadixDialog: () => dialog, requireRadixDismissableLayer: () => layer,
        requireRadixFocusScope: () => focus };
});
const router = await vi.hoisted(async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock());
vi.mock('expo-router', () => router.module);
vi.mock('expo-crypto', async () => ({ randomUUID: (await import('node:crypto')).randomUUID }));
await vi.hoisted(async () => { vi.stubGlobal('React', await import('react')); });
const accountId = 'saved-start-account';
const definitionId = '8fab3a81-5e64-4000-8000-000000000001';
const savedWaitDefinition = createWorkflowDefinitionFixture({ inputs: [], defaults: {}, blocks: [{ kind: 'wait', id: 'wait',
    document: { text: 'Saved fieldless Wait', references: [], attachments: [] } }] });
const disposals: Array<() => Promise<void>> = [];
afterEach(async () => {
    for (const dispose of disposals.splice(0).reverse()) await dispose();
    machineRpc.mockReset();
    router.spies.push.mockClear();
    vi.unstubAllGlobals();
});

describe('saved editor Start through the real front door and Account admission', () => {
    it.each(['plain', 'e2ee', 'agent', 'shared'] as const)('admits the reviewed inline draft bound to a readable %s Artifact', async (fixture) => {
        const mode = fixture === 'e2ee' ? 'e2ee' : 'plain';
        const savedDefinition = fixture === 'agent' || fixture === 'shared' ? WorkflowDefinitionV1Schema.parse({ version: 1, inputs: [],
            defaults: { agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.claude', localId: 'claude' } } },
            blocks: [{ kind: 'step', id: 'reply', document: { text: 'Reply exactly QA_FIN20_AGENT_READY. Do not use tools, edit files, or run commands.', references: [], attachments: [] },
                execution: { acpSessionModeId: 'default', connectedServices: { v: 2, bindingsByServiceId: {
                    'happier.agent.claude/claude-subscription': { source: 'connected', selection: 'profile', profileId: '00ae5eea-6286-48bc-b82a-30a5f8492864' },
                    'happier.agent.claude/anthropic': { source: 'native' },
                } }, engine: { agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.claude', localId: 'claude' } },
                    modelSelection: { v: 1, ref: { agentTargetKey: 'agent:happier.agent.claude/claude', providerConnectionId: null, modelId: 'claude-haiku-4-5' }, updatedAt: 1791577000000 }, effort: 'low' } }, input: [], result: { kind: 'text' } }],
        }) : savedWaitDefinition;
        const reviewedDefinition = { ...savedDefinition, blocks: [{ ...savedDefinition.blocks[0],
            document: { text: 'Reviewed unsaved prompt', references: [], attachments: [] } }] };
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
        const token = createAccountTokenForTests(accountId, { currentAccount: true });
        const credentials = mode === 'plain' ? { token } : { token, secret: Buffer.from(secret).toString('base64url') };
        const serverUrl = `https://saved-start-${crypto.randomUUID()}.test`;
        const serverIdentityId = 'srv_saved_workflow_start';
        let dispatch: (input: unknown) => Promise<unknown> = async () => { throw new Error('start_fixture_not_ready'); };
        let deliveredRequesterToken: string | undefined;
        const external = await createExternalActionAccountHttpBoundary({ serverUrl, serverIdentityId, accountId,
            machineId: 'machine-1', actionId: 'workflow.run.start', tokenEpoch: 0,
            ...(fixture === 'shared' ? { custodian: { accountId: 'machine-owner', displayName: 'Machine owner' } } : {}),
            ...(mode === 'e2ee' ? { encryption: await createEncryptionFromAuthCredentials(credentials) } : {}),
            execute: (input, context) => {
                deliveredRequesterToken = context.requesterAccountContext.token;
                return dispatch(input);
            }, failure: value => {
                const parsed = ActionExecuteFailureSchema.safeParse(value);
                return parsed.success ? parsed.data : null;
            } });
        const artifacts = new Map<string, Artifact>();
        const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
        const account = await restoreServerAccountForTest({ serverUrl, serverIdentityId, accountId, credentials,
            request: async (url, init) => {
                const handled = await external.handle(new URL(String(url)), init);
                if (handled) return handled;
                const path = new URL(String(url)).pathname;
                if (path === '/health') return json({});
                if (path === '/v1/features' || path === '/v1/features/authenticated') return json({ features: { automations: { enabled: true }, workflows: { enabled: true } }, capabilities: {
                    accountStoredContentCompatibility: { v: 1, minimumProtocolVersion: CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION,
                        currentProtocolVersion: CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION, declarationTransport: 'http-header-and-socket-auth-v1' },
                } });
                if (path === '/v1/account/encryption') return json({ mode, updatedAt: 0 });
                if (path === '/v2/account/settings') return json({ content: null, version: 0 });
                if (path === '/v1/account/encryption/currentness') return json({ ...encryption.witness, signingKeyFingerprint: null, updatedAt: 0,
                    recipientEnvelopeReadiness: mode === 'plain' ? { status: 'unavailable', reason: 'plain_account' } : { status: 'available' } });
                if (path === '/v3/automations') return json({ automations: [], nextCursor: null });
                if (path === '/v1/artifacts/read') return createArtifactReadBatchHttpResponse(JSON.parse(String(init?.body)), artifactId => {
                    const artifact = artifacts.get(artifactId);
                    if (!artifact) return { artifactId, ok: false, error: 'artifact_not_found', status: 404, retryable: false };
                    return { artifactId, ok: true, artifact, recipientCensus: mode === 'plain' ? null
                        : ArtifactAccessRecipientCensusResponseV1Schema.parse({
                            artifactId, ownerAccountId: accountId, access: 'owner', encryptionMode: mode,
                            dataEncryptionKey: artifact.dataEncryptionKey, callerDataEncryptionKey: artifact.dataEncryptionKey,
                            provenanceDataEncryptionKey: artifact.provenanceDataEncryptionKey ?? null,
                            callerProvenanceDataEncryptionKey: artifact.provenanceDataEncryptionKey ?? null, recipients: [],
                        }) };
                });
                if (path === '/v1/artifacts') {
                    if (init?.method !== 'POST') return json([...artifacts.values()]);
                    const input = JSON.parse(String(init.body)) as ArtifactCreateRequest;
                    const row: Artifact = { ...input, ...projectArtifactStoredKind(input.kind), ownerAccountId: accountId, access: 'owner', publicAudience: 'none', encryptionMode: mode,
                        headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 };
                    artifacts.set(row.id, row);
                    return json(row);
                }
                // A guest on a shared Machine typically starts a Workflow someone shared with them.
                if (path === `/v1/artifacts/${definitionId}/access/grants`) return json({ artifactId: definitionId, ownerAccountId: accountId,
                    access: fixture === 'shared' ? 'edit' : 'owner', grants: [] });
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
        const readRunCensus = (runId: unknown) => WorkflowRunRecipientCensusResponseV1Schema.parse({
            runId, ownerAccountId: accountId, visibleTeamId: null, encryptionMode: mode, access: 'owner',
            ownerAccountCurrentness: encryption.witness, dataEncryptionKey: null, callerDataEncryptionKey: null, recipients: [],
        });
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
                if (operation.operation === 'get') {
                    if (operation.prepareAdmission !== undefined) return WorkflowRunAdmissionPreparationResultV1Schema.parse({
                        run: null, keyCensus: readRunCensus(operation.runId),
                    });
                    throw Object.assign(new Error('run_not_found'), { code: 'run_not_found' });
                }
                if (operation.operation === 'run-key.census') return readRunCensus(operation.runId);
                if (operation.operation === 'admit') return { kind: 'created', run: createWorkflowRunSummaryFixture({
                    id: String(operation.runId), machineId: 'machine-1', ownerAccountId: accountId,
                    sourceArtifactId: String(operation.sourceArtifactId), state: 'queued', origin: { kind: 'direct' },
                }) };
                throw new Error(`unexpected_storage_operation:${operation.operation}`);
            } },
        });
        dispatch = async input => {
            try {
                submitted = WorkflowRunStartRequestV1Schema.parse(input);
                return await owner.execute({ actionId: 'workflow.run.start', input: submitted,
                    context: { surface: 'ui', authority: 'present_user', callerPermissionMode: 'default',
                        externalActionTarget: { kind: 'machine', machineId: 'machine-1', project: { machineId: 'machine-1', directory: '/repo' } } } });
            } catch (error) { rpcFailure = error; throw error; }
        };
        // Native/plugin catalog transport is unavailable; Run admission uses the current HTTP boundary above.
        machineRpc.mockResolvedValue({ error: 'method_not_found' });
        const machine = createMachineFixture({ access: external.machine.access });
        storage.setState({ machines: { [machine.id]: machine }, machineListByServerId: {} });
        let modals: ReturnType<typeof useModal>['state']['modals'] = [];
        function ObserveModals() { modals = useModal().state.modals; return null; }
        const screen = await renderScreen(<ModalProvider><ObserveModals /><AppPaneProvider>
            <WorkflowEditorHostScreen source={{ kind: 'saved', definitionId }} />
        </AppPaneProvider></ModalProvider>, {
            createNodeMock: () => ({ getBoundingClientRect: () => ({ left: 600, top: 100, width: 160, height: 40 }), contains: () => false, focus: () => {},
                addEventListener: () => {}, removeEventListener: () => {},
                ownerDocument: { addEventListener: () => {}, removeEventListener: () => {} },
                measureInWindow: (receive: (x: number, y: number, width: number, height: number) => void) => receive(600, 100, 160, 40) }),
        });
        disposals.push(screen.unmount);
        await vi.waitFor(() => expect(screen.root.findByType(WorkflowEditorBody).props.draftStore.get()).not.toBeNull());
        await act(async () => {
            const body = screen.root.findByType(WorkflowEditorBody);
            body.props.onChange({ ...body.props.draftStore.get(), blocks: reviewedDefinition.blocks });
            const onChangeProjectTarget = body.props.onChangeProjectTarget;
            if (!onChangeProjectTarget) throw new Error('Missing workflow Project target handler');
            onChangeProjectTarget({ machineId: 'machine-1', directory: '/repo' });
        });
        await screen.pressByTestIdAsync('workflow-editor-run-now');
        await vi.waitFor(() => expect(screen.findByTestId('workflow-run-inputs-run')?.props.disabled).toBe(false));
        if (fixture === 'shared') {
            await vi.waitFor(() => expect(screen.getTextContent()).toContain(t('machineRequester.fullSignIn', { machine: 'tester.local', retention: 'run' })));
            expect(screen.getTextContent()).toContain(t('machineRequester.osVisibility', { owner: 'Machine owner', machine: 'tester.local' }));
            // The footnote never contradicts the disclosure: the guest's run is not on their own machines.
            expect(screen.findByTestId('workflow-run-inputs-own-machines')).toBeNull();
        } else {
            expect(screen.getTextContent()).not.toContain('machineRequester.fullSignIn');
        }
        await screen.pressByTestIdAsync('workflow-run-inputs-run');
        await vi.waitFor(() => expect(router.spies.push.mock.calls.length > 0, JSON.stringify({
            submitted: submitted !== undefined,
            operations: operations.map(operation => operation.operation),
        })).toBe(true));
        expect(rpcFailure).toBeUndefined();
        expect(modals.filter(entry => entry.type === 'alert')).toEqual([]);
        expect(router.spies.push).toHaveBeenCalled();
        expect(deliveredRequesterToken).toBe(token);
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
        expect(router.spies.push).toHaveBeenLastCalledWith(createWorkflowRunRoute(submitted.runId, serverIdentityId));
        expect(artifacts.get(definitionId)?.bodyVersion).toBe(1);
    });
});
