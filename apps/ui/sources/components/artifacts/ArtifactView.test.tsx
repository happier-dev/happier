import * as React from 'react';
import { Platform } from 'react-native';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, encodePlainArtifactStoredContent } from '@happier-dev/protocol/storage/artifactStoredContent';
import { createDeferred, flushHookEffects, renderHook, renderScreen } from '@/dev/testkit';
import { serveActionHomes, type ServedHomeRequest } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { createArtifactStoreBoundary, createPlainArtifactHttpFixture } from '@/dev/testkit/harness/artifactStoreBoundary';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { TokenStorage, type AuthCredentials } from '@/auth/storage/tokenStorage';
import { getStorage } from '@/sync/domains/state/storage';
import { captureActiveServerAccountScopeLifetime, retireActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { getActiveServerSnapshot, upsertAndActivateServer } from '@/sync/domains/server/serverRuntime';
import { publishAppliedActiveServerSnapshot } from '@/sync/runtime/orchestration/appliedActiveServerRuntime';
import { publishHomeAccountChange } from '@/sync/runtime/orchestration/homeAccountChange';
import { setServerReachabilityNetworkAllowed } from '@/sync/runtime/connectivity/serverReachabilitySupervisorPool';
import { encodeBase64 } from '@/encryption/base64';
import { hashArtifactBinaryContent } from '@/sync/domains/artifacts/artifactBinaryContent';
import type { Encryption } from '@/sync/encryption/encryption';
import type { Artifact, DecryptedArtifact } from '@/sync/domains/artifacts/artifactTypes';
import { decryptArtifactWithBody } from '@/sync/engine/artifacts/syncArtifacts';
import { sync } from '@/sync/sync';
import { AgentInput } from '@/components/sessions/agentInput';
import { PageHeader } from '@/components/ui/layout/PageHeader';
import type { CodeEditorProps } from '@/components/ui/code/editor/codeEditorTypes';
import { buildWidgetSurfaceArtifactHeaderV1, buildWidgetSurfaceArtifactIdV1, flattenWidgetLayoutWidgetsV1, projectOverviewPresetV1, WidgetLayoutItemsV1Schema } from '@happier-dev/protocol/widgets';
import { createProjectAccountRowsFixture } from '@/dev/testkit/fixtures/projectAccountRows';
import { buildReviewCommentFixture, storePlainReviewCommentFixture } from '@/dev/testkit/fixtures/reviewComments';
import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { createMachineFixture, createPlainMachineRowFixture, createPlainMachineReadHttpResponseFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { createSessionMetadataHttpBoundary } from '@/dev/testkit/harness/sessionMetadataHttpBoundary';
import { createEmptyAccountBootstrapHttpResponse } from '@/dev/testkit/fixtures/accountBootstrapHttpBoundary';
import { loadPendingOutboxForSession } from '@/sync/domains/state/pendingOutboxPersistence';
import { prepareSessionDraftPersistenceStorage } from '@/sync/ops/sessionDrafts/sessionDraftPersistenceStorage';
import { openStoredReviewCommentV1 } from '@happier-dev/protocol/reviews/comments/content';
import { deriveReviewCommentStructuralMutationV1, ReviewCommentPrepareMutationRequestV1Schema,
    ReviewCommentPrepareMutationResponseV1Schema, ReviewCommentCommitMutationRequestV1Schema,
    type ReviewCommentPrepareMutationResponseV1 } from '@happier-dev/protocol/reviews/comments/mutation';
import { DEPLOYMENT_ENVIRONMENT_ARTIFACT_KIND_V1 } from '@happier-dev/deployment-protocol/v1';
import { Modal } from '@/modal';
import { waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { PluginSurfaceFocusEligibilityProvider } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import { useArtifactNetworkEditor } from './useArtifactNetworkEditor';
import { FeaturesResponseSchema } from '@happier-dev/protocol/features/payload/featuresResponseSchema';
import { ExecutionRunPublicStateSchema } from '@happier-dev/protocol/execution/runs/responseSchemas';
import { createScmRunActionHttpBoundary } from '@/dev/testkit/harness/scmActionTransport';
import { setServerProfileIdentityForUrl } from '@/sync/domains/server/serverProfiles';
import type { CustomModalInjectedProps } from '@/modal/types';
import { ReviewStartInputSchema } from '@happier-dev/protocol/reviews/reviewStart';
import { buildReviewStepsWorkflowV1 } from '@happier-dev/protocol/workflows/builtins/reviewAndConverge';
import { materializeWorkflowAcceptedSnapshotV1 } from '@happier-dev/protocol/workflows/materializeWorkflowAcceptedSnapshotV1';
import { actionSpecToActionDefinitionV1 } from '@happier-dev/protocol/actions/actionCatalog';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { ActionIdSchema } from '@happier-dev/protocol/actions/actionIds';
import { StrictJsonValueSchema } from '@happier-dev/protocol/json/strictJsonValue';
import { sealWorkflowAcceptedSnapshotStoredEnvelopeV1, serializeWorkflowStoredContentEnvelopeV1 } from '@happier-dev/protocol/workflows/workflowStoredContentV1';
import { WorkflowRunRecipientCensusResponseV1Schema } from '@happier-dev/protocol/workflows/workflowRunKeyV1';
import { createWorkflowRunSummaryFixture } from '@/dev/testkit/fixtures/workflowRunFixtures';
import { installSessionActionRpcBoundary } from '@/dev/testkit/harness/sessionActionRpcBoundary';
import { SESSION_RPC_METHODS, RPC_METHODS } from '@happier-dev/protocol/rpc';
import { EXECUTION_RUN_CAPABILITIES_DESCRIBE_FIXTURE } from '@/dev/testkit/fixtures/executionRunCapabilitiesDescribe';

vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock().module;
});
vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock().module;
});
vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock();
});
// IndexedDB is device-local storage; the real composer/outbox owners remain in this journey.
vi.mock('@/sync/domains/state/browserRecordStorage', async () =>
    (await import('@/dev/testkit/mocks/browserRecordStorage')).createBrowserRecordStorageModuleMock());
// Monaco/WebView is a platform boundary. Keep the real route, editor draft and
// hydration path; this Node renderer observes the source field's admitted value.
vi.mock('@/components/ui/code/editor/CodeEditor', async () => {
    const React = await import('react');
    return { CodeEditor: React.forwardRef(function SourceField(props: CodeEditorProps, _ref) {
        return React.createElement('CodeEditor', { testID: props.testID, value: props.value, onChangeText: props.onChange });
    }) };
});
import { ArtifactView } from './ArtifactView';
import { useArtifactOperations } from './useArtifactOperations';
import { useArtifactTitleProjections } from './useArtifactTitleProjections';
import { ArtifactDetailContent } from '@/app/(app)/artifacts/[id]';
import { EditArtifactContent } from '@/app/(app)/artifacts/edit/[id]';

const initialState = getStorage().getState();
const platform = Platform.OS;
let disposeHome: (() => Promise<void>) | undefined;
afterEach(async () => {
    await act(async () => {
        sync?.disconnectServer();
        await disposeHome?.();
        disposeHome = undefined;
        retireActiveServerAccountScopeLifetime();
        getStorage().setState(initialState, true);
    });
    Object.defineProperty(Platform, 'OS', { configurable: true, value: platform });
    vi.restoreAllMocks();
});

function OpenView({ id, edit = false }: Readonly<{ id: string; edit?: boolean }>) {
    const artifact = getStorage()(state => state.artifacts[id] ?? null);
    return edit ? <EditArtifactContent id={id} artifact={artifact} /> : <ArtifactDetailContent id={id} artifact={artifact} />;
}

// The shared image preview cache is process-wide and keyed by content, so every setup serves
// distinct bytes: each test then starts from a cold preview rather than a cache hit.
let setupSequence = 0;

async function setup(kind: 'image' | 'html' | 'file' | 'document', delayBlob?: Promise<Response>, warm = false,
    override?: (request: ServedHomeRequest) => Response | Promise<Response> | undefined, cold = false, currentAccount = false) {
    Object.defineProperty(Platform, 'OS', { configurable: true, value: 'web' });
    const bytes = new TextEncoder().encode(kind === 'html' ? '<!doctype html><h1>Saved HTML</h1>' : `Private bytes ${++setupSequence}`);
    const reference = { blobId: 'e704b26f-9c31-4728-9590-858378e34ed9', mime: kind === 'html' ? 'text/html' : kind === 'image' ? 'image/png' : 'application/zip',
        sizeBytes: bytes.length, sha256: hashArtifactBinaryContent(bytes) };
    const row: DecryptedArtifact = { id: 'document', title: 'Saved', header: { kind: kind === 'html' ? 'html' : kind === 'document' ? 'markdown' : 'artifact.legacy', title: 'Saved' },
        isDecrypted: true, body: warm ? reference : undefined, storageMode: 'plain', ownerAccountId: 'owner', access: 'owner',
        headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 };
    const head: Artifact = { id: row.id, ownerAccountId: 'owner', access: 'owner', publicAudience: 'none', encryptionMode: 'plain',
        headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1,
        header: encodePlainArtifactStoredContent(row.header), body: encodePlainArtifactStoredContent({ body: kind === 'document' ? 'The garden keeps one cedar tree.' : reference }),
        dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER };
    const artifacts = createArtifactStoreBoundary({ ownerAccountId: () => 'owner', encryptionMode: 'plain' });
    artifacts.replaceStoredRow(head);
    const served = await serveActionHomes({ homes: [{ key: 'owner', serverUrl: `https://view-${setupSequence}.test`, accountId: 'owner', currentAccount }], route: request => {
        const overridden = override?.(request);
        if (overridden !== undefined) return overridden;
        if (request.path === '/v1/artifacts/document') return Response.json(head);
        if (request.path === '/v1/artifacts/document/access/grants') return artifacts.handle(request.path, { method: request.method }) ?? undefined;
        if (request.path.includes('/blobs/')) return delayBlob ?? Response.json({ blobId: reference.blobId, content: { t: 'plain', v: encodeBase64(bytes) } });
        if (request.path.endsWith('/html-preview')) return Response.json({ error: 'artifact_html_isolation_unavailable' }, { status: 503 });
        return createEmptyAccountBootstrapHttpResponse(request.url.pathname + request.url.search, { method: request.method,
            ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }) }) ?? undefined;
    } });
    disposeHome = served.dispose;
    await loadSyncSingletonForTests();
    // This Node renderer has no browser sessionStorage for a tab-scoped selection.
    await upsertAndActivateServer({ serverUrl: served.homes.owner!.serverUrl, scope: 'device' });
    expect(getActiveServerSnapshot().serverUrl).toBe(served.homes.owner!.serverUrl);
    // Seed the real singleton's authenticated state; no sync or crypto behavior is substituted.
    const initialized = sync as unknown as { credentials: AuthCredentials | null; encryption: Encryption | null };
    initialized.credentials = await TokenStorage.getCredentialsForServerUrl(served.homes.owner!.serverUrl);
    initialized.encryption = null;
    publishAppliedActiveServerSnapshot(getActiveServerSnapshot());
    setServerReachabilityNetworkAllowed(true);
    const storedRow = warm ? await decryptArtifactWithBody({ artifact: head, encryption: null, artifactDataKeys: new Map() }) : row;
    if (!storedRow) throw new Error('Missing warm Artifact');
    if (!cold) getStorage().getState().addArtifact(storedRow);
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:private-preview');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    return { served, head, row, bytes, reference };
}

describe('Artifact composed view reads', () => {
    it('retains the typed network editor open refusal and allows another open', async () => {
        let refused = true;
        const { row, head, served } = await setup('html', undefined, false, request =>
            refused && request.path === '/v1/artifacts/document'
                ? Response.json({ error: 'database_transaction_timeout' }, { status: 503 }) : undefined);
        head.body = encodePlainArtifactStoredContent({ body: '<!doctype html><h1>Saved HTML</h1>' });
        const anchorRef = React.createRef<React.ComponentRef<typeof import('react-native').View>>();
        const hook = await renderHook(() => useArtifactNetworkEditor(row, true, anchorRef));
        vi.mocked(Modal.alert).mockClear();
        await act(async () => { await hook.getCurrent().open(); });
        await waitForHomeGovernance(() => expect(Modal.alert).toHaveBeenCalled());
        expect(served.requests).toContainEqual(expect.objectContaining({ path: '/v1/artifacts/document', method: 'GET' }));
        const details = vi.mocked(Modal.alert).mock.calls.at(-1)?.[2]?.find(button => button.text === 'approvals.technicalDetails');
        expect(details).toBeDefined();
        await act(async () => { details?.onPress?.(); });
        expect(Modal.alert).toHaveBeenLastCalledWith('approvals.technicalDetails', 'database_transaction_timeout');
        expect(hook.getCurrent().panel).toBeNull();
        refused = false;
        await act(async () => { await hook.getCurrent().open(); });
        expect(hook.getCurrent().panel).not.toBeNull();
        await hook.unmount();
    });

    it('retains the typed network save refusal and keeps the editor open for retry', async () => {
        let refused = true;
        const artifacts = createArtifactStoreBoundary({ ownerAccountId: () => 'owner', encryptionMode: 'plain' });
        const { row, head, served } = await setup('html', undefined, false, request => {
            if (request.path !== '/v1/artifacts/document' || request.method === 'GET') return undefined;
            return refused ? Response.json({ error: 'database_transaction_timeout' }, { status: 503 })
                : artifacts.handle(request.path, { method: request.method, body: JSON.stringify(request.body) }) ?? undefined;
        });
        head.body = encodePlainArtifactStoredContent({ body: '<!doctype html><h1>Saved HTML</h1>' });
        artifacts.replaceStoredRow(head);
        const anchorRef = React.createRef<React.ComponentRef<typeof import('react-native').View>>();
        const hook = await renderHook(() => useArtifactNetworkEditor(row, true, anchorRef));
        await act(async () => { await hook.getCurrent().open(); });
        const panel = hook.getCurrent().panel;
        if (!panel) throw new Error('Expected the opened network editor');
        vi.mocked(Modal.alert).mockClear();
        const choice = { mode: 'origins' as const, origins: ['https://example.com'] };
        await act(async () => {
            await expect(panel.props.children.props.onSave(choice)).resolves.toMatchObject({ ok: false, message: expect.any(String) });
        });
        expect(served.requests).toContainEqual(expect.objectContaining({ path: '/v1/artifacts/document', method: 'POST' }));
        const details = vi.mocked(Modal.alert).mock.calls.at(-1)?.[2]?.find(button => button.text === 'approvals.technicalDetails');
        expect(details).toBeDefined();
        await act(async () => { details?.onPress?.(); });
        expect(Modal.alert).toHaveBeenLastCalledWith('approvals.technicalDetails', 'database_transaction_timeout');
        expect(hook.getCurrent().panel).not.toBeNull();
        refused = false;
        await act(async () => { await expect(panel.props.children.props.onSave(choice)).resolves.toEqual({ ok: true }); });
        await hook.unmount();
    });

    it('hydrates presented Doc titles only for the current Account scope', async () => {
        const artifactHome = createArtifactStoreBoundary({ ownerAccountId: () => 'owner', encryptionMode: 'plain' });
        const { served, head } = await setup('document', undefined, false, request => request.path === '/v1/artifacts/read'
            ? artifactHome.handle(request.path, { method: request.method, body: JSON.stringify(request.body) }) ?? undefined : undefined, true);
        artifactHome.replaceStoredRow(head);
        const scope = captureActiveServerAccountScopeLifetime()?.scope;
        if (!scope) throw new Error('The test Home must be applied');
        getStorage().setState({ profileScope: scope });
        const artifactIds = ['document'];
        function Presented({ children }: React.PropsWithChildren) {
            return <PluginSurfaceFocusEligibilityProvider active={false} presentationActive>{children}</PluginSurfaceFocusEligibilityProvider>;
        }
        const hook = await renderHook(({ subject }) => useArtifactTitleProjections(subject, artifactIds), {
            initialProps: { subject: { ...scope, accountId: 'retired-owner' } }, wrapper: Presented,
        });
        try {
            expect(hook.getCurrent()).toEqual([null]);
            expect(served.requests.filter(request => request.path === '/v1/artifacts/read')).toHaveLength(0);
            await hook.rerender({ subject: scope });
            await vi.waitFor(() => expect(hook.getCurrent()).toEqual(['Saved']));
            expect(served.requests.filter(request => request.path === '/v1/artifacts/read')).toHaveLength(1);
        } finally {
            await hook.unmount();
        }
    });

    it('previews the accepted mixed Review New round roster and replays its Workflow once', async () => {
        const reviewId = 'review-workflow-new-round';
        const nativeReads = installSessionActionRpcBoundary(request => {
            if (request.method.endsWith(RPC_METHODS.CAPABILITIES_DESCRIBE)) return EXECUTION_RUN_CAPABILITIES_DESCRIBE_FIXTURE;
            if (request.method.endsWith(SESSION_RPC_METHODS.EXECUTION_RUN_GET)
                && request.params && typeof request.params === 'object' && 'includeStructured' in request.params
                && request.params.includeStructured === true) {
                return { ok: false, errorCode: 'run_not_found', error: 'This prior executable leaf is no longer available' };
            }
            throw new Error(`A Workflow repeat must not replay its leaf RPC: ${request.method}`);
        });
        const runId = '11111111-1111-4111-8111-111111111111';
        const selected = ReviewStartInputSchema.parse({ scope: 'repository', instructions: 'Review this repository.', reviewers: [
            { kind: 'engine', engineId: 'codex' },
            { kind: 'session', session: { serverId: 'review-home', sessionId: 'existing-reviewer' } },
            { kind: 'person', principal: { kind: 'account', accountId: 'owner' }, required: false },
        ] });
        const built = buildReviewStepsWorkflowV1(selected, { reviewId, roundOrdinal: 1 });
        const accepted = await materializeWorkflowAcceptedSnapshotV1({ definition: built.definition,
            context: { source: { kind: 'inline' }, inputs: built.inputs, machineId: 'review-machine', executionTarget: { kind: 'session' },
                workspaceTarget: { project: { machineId: 'review-machine', directory: '/repo', checkoutRootPath: '/repo' } },
                origin: { kind: 'direct' }, authorization: { principal: { kind: 'host' } } }, admission: { kind: 'user' },
            effects: { resolveTargetAvailability: async () => true,
                resolveSessionTarget: async () => ({ address: { serverId: 'review-home', sessionId: 'existing-reviewer' }, machineId: 'review-machine' }),
                admitSessionAuthority: async () => true,
                readActionContract: async id => {
                    const action = actionSpecToActionDefinitionV1(getActionSpec(ActionIdSchema.parse(id)));
                    return { inputSchema: StrictJsonValueSchema.parse(action.inputSchema), outputSchema: StrictJsonValueSchema.parse(action.outputSchema ?? {}) };
                } } });
        if (!accepted.ok) throw new Error(`Review fixture admission failed: ${accepted.error.code}`);
        const run = createWorkflowRunSummaryFixture({ id: runId, ownerAccountId: 'owner', origin: { kind: 'direct' },
            machineId: 'review-machine', state: 'succeeded' });
        const acceptedEnvelope = serializeWorkflowStoredContentEnvelopeV1(sealWorkflowAcceptedSnapshotStoredEnvelopeV1({ mode: 'plain',
            binding: { v: 1, purpose: 'accepted_snapshot', accountId: 'owner', runId }, acceptedSnapshot: accepted.snapshot }));
        const keyCensus = WorkflowRunRecipientCensusResponseV1Schema.parse({ runId, ownerAccountId: 'owner', access: 'owner',
            encryptionMode: 'plain', dataEncryptionKey: null, callerDataEncryptionKey: null, recipients: [], visibleTeamId: null,
            ownerAccountCurrentness: { mode: 'plain', version: 1, contentKeyFingerprint: null } });
        const record: DecryptedArtifact = { id: reviewId, title: 'Composed Review', isDecrypted: true,
            header: { kind: 'review.v1', v: 1, reviewId, title: 'Composed Review' },
            body: JSON.stringify({ v: 1, rounds: [{ ordinal: 1, state: 'completed', startedAt: 1, finishedAt: 2,
                reviewerIds: ['step-1-reviewer-1', 'step-1-reviewer-2'], runs: [{ kind: 'workflow', runId },
                    { kind: 'execution', runId: 'leaf-that-must-not-repeat', machineId: 'review-machine' }] }] }),
            ownerAccountId: 'owner', access: 'owner', storageMode: 'plain', headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 };
        let http: Awaited<ReturnType<typeof createScmRunActionHttpBoundary>> | undefined;
        const starts: unknown[] = [];
        const { served } = await setup('document', undefined, false, request => {
            if (request.path === '/v1/features' || request.path === '/v1/features/authenticated') return Response.json(FeaturesResponseSchema.parse({ features: {
                workflows: { enabled: true }, automations: { enabled: true }, execution: { runs: { enabled: true } },
                encryption: { plaintextStorage: { enabled: true }, accountOptOut: { enabled: true } } },
                capabilities: { serverIdentity: { serverIdentityId: 'srv_review_new_round_workflow' } } }));
            if (request.path === '/v3/automations/runs/workflow-storage') {
                const operation = (request.body as { operation: string }).operation;
                if (operation === 'get') return Response.json({ run, acceptedEnvelope, checkpointEnvelope: null, resultEnvelope: null, keyCensus });
                if (operation === 'invocations.list') return Response.json({ invocations: [], parentRevision: run.revision, keyCensus, progressEnvelopesByInvocationId: {} });
                if (operation === 'run-key.census') return Response.json(keyCensus);
            }
            if (http && (request.path.startsWith('/v1/actions/') || request.path.startsWith('/v1/machines')))
                return http.handle(request.url, { method: request.method, headers: request.headers,
                    ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }) }).then(response => {
                    if (!response) throw new Error(`Unserved Workflow boundary: ${request.path}`);
                    return response;
                });
        }, false, true);
        if (!await setServerProfileIdentityForUrl(served.homes.owner!.serverUrl, 'srv_review_new_round_workflow')) {
            throw new Error('The Workflow Home fixture must have its published identity');
        }
        http = await createScmRunActionHttpBoundary({ serverUrl: served.homes.owner!.serverUrl, serverIdentityId: 'srv_review_new_round_workflow',
            accountId: 'owner', machineId: 'review-machine', actionIds: ['workflow.run.start'], execute(_id, input) {
                starts.push(input);
                return { run: createWorkflowRunSummaryFixture({ id: (input as { runId: string }).runId,
                    ownerAccountId: 'owner', origin: { kind: 'direct' }, machineId: 'review-machine' }), admission: 'created' };
            } });
        const scope = captureActiveServerAccountScopeLifetime()?.scope;
        if (!scope) throw new Error('The test Home must be applied');
        vi.mocked(Modal.show).mockClear();
        vi.mocked(Modal.confirm).mockResolvedValue(true);
        const row = { ...record, sourceServerId: scope.serverId };
        const screen = await renderScreen(<ArtifactView artifactId={row.id} artifact={row} presentation="page" />);
        let confirmation: Awaited<ReturnType<typeof renderScreen>> | undefined;
        try {
            expect(served.requests.filter(request => (request.body as { operation?: string })?.operation === 'get')).toHaveLength(0);
            await waitForHomeGovernance(() => expect(screen.tree.root.findByProps({ testID: 'review-detail:header' }).props.primaryAction?.title)
                .toBe('reviewWalkthrough.detail.newRound'));
            await act(async () => screen.tree.root.findByProps({ testID: 'review-detail:header' }).props.primaryAction.onPress());
            const dialog = vi.mocked(Modal.show).mock.calls.at(-1)?.[0];
            if (!dialog) throw new Error('Expected New round confirmation');
            const chrome = { current: null as import('@/modal/types').CustomModalChromeCardConfig | null };
            const Component = dialog.component as React.ComponentType<CustomModalInjectedProps>;
            const closed = vi.fn();
            confirmation = await renderScreen(<Component {...dialog.props} onClose={closed}
                setChrome={value => { chrome.current = value as typeof chrome.current; }} />);
            await waitForHomeGovernance(() => expect(confirmation!.findByTestId('review-new-round:reviewer:step-1-reviewer-3')).not.toBeNull());
            const text = JSON.stringify(confirmation.tree.toJSON());
            expect(text).toContain('reviewWalkthrough.detail.startsFresh');
            expect(text).toContain('reviewWalkthrough.detail.continuesSession');
            expect(text).toContain('reviewWalkthrough.detail.askedAgain');
            expect(text).toContain('reviewWalkthrough.detail.optional');
            if (!chrome.current) throw new Error('Expected confirmation footer');
            const footer = await renderScreen(<>{chrome.current.footer}</>);
            try { await footer.pressByTestIdAsync('review-new-round:start');
                await waitForHomeGovernance(() => expect(closed).toHaveBeenCalledOnce());
            } finally { await footer.unmount(); }
            expect(starts).toHaveLength(1);
            expect(starts[0]).toMatchObject({ source: { replay: { runId, intent: 'another_round' } } });
            expect(served.requests.filter(request => request.path === '/v1/actions/execution.run.get'
                || request.path === '/v1/actions/execution.run.action')).toHaveLength(0);
            expect(nativeReads.filter(request => request.method.endsWith(SESSION_RPC_METHODS.EXECUTION_RUN_ACTION)
                || request.method.endsWith(SESSION_RPC_METHODS.EXECUTION_RUN_GET) && !(request.params && typeof request.params === 'object'
                    && 'includeStructured' in request.params && request.params.includeStructured === true))).toHaveLength(0);
        } finally { await confirmation?.unmount(); await screen.unmount(); }
    });
    it.each(['session', 'detached', 'unavailable', 'late-unavailable'] as const)('previews native Review New round continuity before one explicit start (%s)', async mode => {
        const serverIdentityId = `srv_review_new_round_${mode}`;
        const reviewId = `review-new-round-${mode}`;
        const run = ExecutionRunPublicStateSchema.parse({ runId: 'retained-reviewer', callId: 'call', sidechainId: 'sidechain',
            intent: 'review', backendTarget: { kind: 'builtInAgent', agentId: 'claude' }, display: { title: 'Retained reviewer' },
            permissionMode: 'default', retentionPolicy: mode === 'detached' ? 'ephemeral' : 'resumable',
            runClass: 'bounded', ioMode: 'request_response', status: 'succeeded', startedAtMs: 1, finishedAtMs: 2,
            lifecycle: { v: 1, state: mode === 'unavailable' ? 'unavailable' : 'current' } });
        const reference = { kind: 'execution', runId: run.runId, machineId: 'review-machine',
            ...(mode === 'session' ? { sessionId: 'review-session' } : {}) };
        const record: DecryptedArtifact = { id: reviewId, title: 'Native Review', isDecrypted: true,
            header: { kind: 'review.v1', v: 1, reviewId, title: 'Native Review' },
            body: JSON.stringify({ v: 1, rounds: [{ ordinal: 1, state: 'completed', startedAt: 1, finishedAt: 2,
                reviewerIds: ['step-1-reviewer-1'], runs: [reference] }] }), ownerAccountId: 'owner', access: 'owner', storageMode: 'plain',
            headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 };
        const starts: unknown[] = [];
        let reads = 0;
        const nativeStart = (input: unknown) => {
            starts.push(input);
            if (mode === 'late-unavailable' && starts.length === 1) return { ok: false,
                errorCode: 'review_follow_up_resume_unavailable', error: 'The retained reviewer session is unavailable' };
            return { ok: true, result: { runId: 'next-reviewer', callId: 'next-call', sidechainId: 'next-sidechain',
                reviewRound: { reviewId, roundOrdinal: 2 } } };
        };
        installSessionActionRpcBoundary(request => {
            if (request.method.endsWith(SESSION_RPC_METHODS.EXECUTION_RUN_GET)) {
                if (!(request.params && typeof request.params === 'object' && 'includeStructured' in request.params
                    && request.params.includeStructured === true)) reads++;
                return { run };
            }
            if (request.method.endsWith(RPC_METHODS.CAPABILITIES_DESCRIBE)) return EXECUTION_RUN_CAPABILITIES_DESCRIBE_FIXTURE;
            if (request.method.endsWith(SESSION_RPC_METHODS.EXECUTION_RUN_ACTION)) {
                return nativeStart(request.params);
            }
            throw new Error(`Unexpected native Review RPC: ${request.method}`);
        });
        const reviewerSession = createSessionFixture({ id: 'review-session', active: true,
            metadata: { path: '/repo', host: 'test', machineId: 'review-machine' } });
        const sessions = createSessionMetadataHttpBoundary(() => ({ 'review-session': reviewerSession }));
        const { served } = await setup('document', undefined, false, request => {
            if (request.path === '/v1/features') return Response.json(FeaturesResponseSchema.parse({ features: {
                execution: { runs: { enabled: true } }, encryption: { plaintextStorage: { enabled: true }, accountOptOut: { enabled: true } } },
                capabilities: { serverIdentity: { serverIdentityId } } }));
            const machine = createPlainMachineReadHttpResponseFixture(request.path, { method: request.method,
                ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }) }, 'owner');
            if (machine) return machine;
            const response = sessions.handle(request.url, { method: request.method,
                ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }) });
            if (response) return response;
        });
        if (!await setServerProfileIdentityForUrl(served.homes.owner!.serverUrl, serverIdentityId)) {
            throw new Error('The native Home fixture must have its published identity');
        }
        const scope = captureActiveServerAccountScopeLifetime()?.scope;
        if (!scope) throw new Error('The test Home must be applied');
        if (mode === 'session') getStorage().getState().applySessions([{ ...reviewerSession, serverId: scope.serverId }]);
        vi.mocked(Modal.show).mockClear();
        vi.mocked(Modal.confirm).mockResolvedValue(true);
        const row = { ...record, sourceServerId: scope.serverId };
        const screen = await renderScreen(<ArtifactView artifactId={row.id} artifact={row} presentation="page" />);
        let confirmation: Awaited<ReturnType<typeof renderScreen>> | undefined;
        try {
            expect(reads).toBe(0);
            await waitForHomeGovernance(() => expect(screen.tree.root.findByProps({ testID: 'review-detail:header' }).props.primaryAction?.title)
                .toBe('reviewWalkthrough.detail.newRound'));
            await act(async () => screen.tree.root.findByProps({ testID: 'review-detail:header' }).props.primaryAction.onPress());
            const dialog = vi.mocked(Modal.show).mock.calls.at(-1)?.[0];
            if (!dialog) throw new Error('Expected New round confirmation');
            const chrome = { current: null as import('@/modal/types').CustomModalChromeCardConfig | null };
            // Modal hosting is a platform boundary; the confirmation, header demand and Action stay real.
            const Component = dialog.component as React.ComponentType<CustomModalInjectedProps>;
            const closed = vi.fn();
            confirmation = await renderScreen(<Component {...dialog.props} onClose={closed}
                setChrome={value => { chrome.current = value as typeof chrome.current; }} />);
            await waitForHomeGovernance(() => expect(confirmation!.findByTestId(`review-new-round:reviewer:${run.runId}`)).not.toBeNull());
            expect(reads).toBe(1);
            expect(starts).toHaveLength(0);
            expect(JSON.stringify(confirmation.tree.toJSON())).toContain(mode === 'session' || mode === 'late-unavailable'
                ? 'reviewWalkthrough.detail.continuesSession' : mode === 'detached' ? 'reviewWalkthrough.detail.startsFresh' : 'common.unavailable');
            if (mode === 'unavailable') await confirmation.pressByTestIdAsync('review-new-round:fresh');
            if (!chrome.current) throw new Error('Expected confirmation footer');
            const footer = await renderScreen(<>{chrome.current.footer}</>);
            try { await footer.pressByTestIdAsync('review-new-round:start');
                await waitForHomeGovernance(() => expect(starts).toHaveLength(1));
            } finally { await footer.unmount(); }
            if (mode === 'late-unavailable') {
                await waitForHomeGovernance(() => expect(confirmation!.findByTestId('review-new-round:fresh')).not.toBeNull());
                expect(closed).not.toHaveBeenCalled();
                expect(starts).toHaveLength(1);
                await confirmation.pressByTestIdAsync('review-new-round:fresh');
                const retryFooter = await renderScreen(<>{chrome.current!.footer}</>);
                try { await retryFooter.pressByTestIdAsync('review-new-round:start');
                    await waitForHomeGovernance(() => expect(starts).toHaveLength(2));
                } finally { await retryFooter.unmount(); }
                expect(starts[1]).toMatchObject({ input: { fresh: true } });
            }
            await waitForHomeGovernance(() => expect(closed).toHaveBeenCalledOnce());
            expect(starts[0]).toMatchObject({ runId: run.runId, actionId: 'review.new_round',
                input: mode === 'unavailable' ? { fresh: true } : {} });
        } finally { await confirmation?.unmount(); await screen.unmount(); }
    });
    it('starts a completed person-only Review New round from the menu while its verdict remains editable', async () => {
        const reviewId = 'review-people-new-round';
        const runRequests = installSessionActionRpcBoundary(request => {
            throw new Error(`A person-only Review has no executable Run: ${request.method}`);
        });
        const record: DecryptedArtifact = { id: reviewId, title: 'People Review', isDecrypted: true,
            header: { kind: 'review.v1', v: 1, reviewId, title: 'People Review' },
            body: JSON.stringify({ v: 1, rounds: [{ ordinal: 1, state: 'completed', startedAt: 1, finishedAt: 2,
                reviewerIds: [], runs: [] }] }), ownerAccountId: 'owner', access: 'owner', storageMode: 'plain',
            headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 };
        const artifacts = createArtifactStoreBoundary({ ownerAccountId: () => 'owner', encryptionMode: 'plain' });
        artifacts.replaceStoredRow(createPlainArtifactHttpFixture(record, 'owner'));
        const { served } = await setup('document', undefined, false, request => {
            if (request.path === '/v1/reviews/get') return Response.json({ review: {
                reviewId, projectSourceId: null, workflowId: null, subjectKind: 'repository', sourceKind: 'direct',
                state: 'completed', currentRoundOrdinal: 1, startedAt: 1, finishedAt: 2, createdAt: 1, updatedAt: 2,
                counts: { total: 0, needsDecision: 0 } }, human: { reviewId, roundOrdinal: 1,
                requests: [{ id: 'required-person', roundOrdinal: 1, principal: { kind: 'account', accountId: 'owner' }, required: true, needsAccess: false },
                    { id: 'optional-person', roundOrdinal: 1, principal: { kind: 'account', accountId: 'other' }, required: false, needsAccess: false }],
                verdicts: [{ accountId: 'owner', roundOrdinal: 1, verdict: 'approve', submittedAt: 2, revision: 1 }],
                needsYou: { reviewId, roundOrdinal: 1, reason: 'review_needs_you', needsYou: false,
                    requestedVerdict: false, pendingDecisions: false, canSubmitVerdict: true } } });
            if (request.path.startsWith('/v1/artifacts') && !request.path.includes('/document'))
                return artifacts.handle(request.path, { method: request.method,
                    ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }) }) ?? undefined;
        });
        const scope = captureActiveServerAccountScopeLifetime()?.scope;
        if (!scope) throw new Error('The test Home must be applied');
        vi.mocked(Modal.show).mockClear();
        const row = { ...record, sourceServerId: scope.serverId };
        const screen = await renderScreen(<ArtifactView artifactId={row.id} artifact={row} presentation="page" />);
        try {
            await waitForHomeGovernance(() => expect(screen.tree.root.findByProps({ testID: 'review-detail:header' }).props.primaryAction?.title)
                .toBe('reviewWalkthrough.detail.submitReview'));
            const repeat = screen.tree.root.findByProps({ testID: 'review-detail:more' }).props.actions
                .find((action: { id: string }) => action.id === 'new-round');
            expect(repeat).toBeDefined();
            await act(async () => { await repeat.onSelect(); });
            await waitForHomeGovernance(() => expect(Modal.show).toHaveBeenCalled());
            const dialog = vi.mocked(Modal.show).mock.calls.at(-1)?.[0];
            const props = dialog?.props as { previousRound: number; reviewers: readonly { id: string; continuity: string; required: boolean }[];
                onStart(): Promise<{ ok: boolean }> };
            expect(props.previousRound).toBe(1);
            expect(props.reviewers).toEqual([expect.objectContaining({ id: 'required-person', continuity: 'asked_again', required: true }),
                expect.objectContaining({ id: 'optional-person', continuity: 'asked_again', required: false })]);
            await act(async () => { expect(await props.onStart()).toEqual({ ok: true }); });
            const saved = JSON.parse(artifacts.readPlainBody(reviewId) ?? 'null');
            expect(saved.rounds).toHaveLength(2);
            expect(saved.rounds[1]).toMatchObject({ ordinal: 2, state: 'completed', reviewerIds: [], runs: [] });
            expect(runRequests).toHaveLength(0);
            expect(served.requests.filter(request => request.path === '/v3/automations/runs/workflow-storage'
                || request.path.startsWith('/v1/actions/execution.run.') || request.path.startsWith('/v1/actions/workflow.run.'))).toHaveLength(0);
        } finally { await screen.unmount(); }
    });
    it.each([
        { access: 'owner', canEdit: true, canManage: true, canShare: true },
        { access: 'admin', canEdit: true, canManage: true, canShare: true },
        { access: 'edit', canEdit: true, canManage: false, canShare: false },
        { access: 'view', canEdit: false, canManage: false, canShare: false },
        { access: undefined, canEdit: true, canManage: true, canShare: false },
    ] satisfies ReadonlyArray<{ access: DecryptedArtifact['access']; canEdit: boolean; canManage: boolean; canShare: boolean }>)('reports the document edit capability for $access access', async ({ access, canEdit, canManage, canShare }) => {
        const { row } = await setup('document');
        const hook = await renderHook(() => useArtifactOperations({ ...row, access }));
        try {
            expect(hook.getCurrent().canRead).toBe(true);
            expect(hook.getCurrent()).toMatchObject({ canEdit, canManage, canShare });
        } finally {
            await hook.unmount();
        }
    });

    it('keeps Share unavailable for an owner opening an unlisted Deployment Artifact URL', async () => {
        const { head, row } = await setup('file');
        const header = { kind: DEPLOYMENT_ENVIRONMENT_ARTIFACT_KIND_V1, title: 'Production' };
        head.header = encodePlainArtifactStoredContent(header);
        head.body = encodePlainArtifactStoredContent({ body: '{}' });
        const artifact = { ...row, title: header.title, header, body: '{}' };
        getStorage().getState().addArtifact(artifact);
        const screen = await renderScreen(<ArtifactDetailContent id={row.id} artifact={artifact} />);
        try {
            await vi.waitFor(() => expect(screen.findByTestId('artifact:history')).not.toBeNull());
            expect(screen.findByTestId('artifact:share') === null).toBe(true);
        } finally {
            await screen.unmount();
        }
    });
    it.each([false, true])('names a busy body read and safely retries without an inventory reload (edit=%s)', async edit => {
        let busy = true;
        const { served } = await setup('document', undefined, false, request => request.path === '/v1/artifacts/document' && busy
            ? Response.json({ error: 'database_transaction_timeout' }, { status: 503 }) : undefined);
        const screen = await renderScreen(<OpenView id="document" edit={edit} />);
        const failedId = edit ? 'artifact-editor:failed' : 'artifact:bodyFailed';
        try {
            await vi.waitFor(() => expect(screen.findByTestId(failedId)).not.toBeNull(), { timeout: 10_000 });
            expect(screen.getTextContent()).toContain('approvals.transientFailureTitle');
            busy = false;
            await screen.pressByTestIdAsync(`${failedId}-action`);
            await vi.waitFor(() => edit
                ? expect(screen.findByTestId('artifact-editor:body:source')?.props.value).toBe('The garden keeps one cedar tree.')
                : expect(screen.getTextContent()).toContain('The garden keeps one cedar tree.'));
            expect(served.requests.filter(request => request.path === '/v1/artifacts')).toHaveLength(0);
        } finally { await screen.unmount(); }
    });
    it('keeps one cold edit body read when its inventory header arrives during the opening read', async () => {
        const pending = createDeferred<Response>();
        const { served, head, row } = await setup('document', undefined, false,
            request => request.path === '/v1/artifacts/document' ? pending.promise.then(response => response.clone()) : undefined, true);
        const screen = await renderScreen(<OpenView id="document" edit />);
        try {
            await vi.waitFor(() => expect(served.requests.filter(request => request.path === '/v1/artifacts/document')).toHaveLength(1));
            // The real inventory/socket publisher can deliver the head while the exact
            // body is still in flight. That publication is not another open intent.
            await act(async () => { getStorage().getState().addArtifact(row); });
            await flushHookEffects();
            await act(async () => { pending.resolve(Response.json(head)); });
            await vi.waitFor(() => expect(screen.findByTestId('artifact-editor:body:source')?.props.value).toBe('The garden keeps one cedar tree.'));
            await flushHookEffects();
            expect(served.requests.filter(request => request.path === '/v1/artifacts/document')).toHaveLength(1);
        } finally {
            pending.resolve(Response.json(head));
            await screen.unmount();
        }
    });

    it.each([false, true])('opens an unloaded own Doc with one exact read and no inventory read (edit=%s)', async edit => {
        const pending = createDeferred<Response>();
        const { served, head } = await setup('document', undefined, false,
            request => request.path === '/v1/artifacts/document' ? pending.promise.then(response => response.clone()) : undefined, true);
        const screen = await renderScreen(<OpenView id="document" edit={edit} />);
        try {
            expect(screen.findByTestId(edit ? 'artifact-editor:unavailable' : 'artifact:notFound') === null).toBe(true);
            expect(screen.findByTestId(edit ? 'artifact-editor:loading' : 'artifact:bodyLoading') !== null).toBe(true);
            await act(async () => { pending.resolve(Response.json(head)); });
            await vi.waitFor(() => expect(screen.findByTestId(edit ? 'artifact-editor:save' : 'artifact:body') !== null).toBe(true));
            if (edit) expect(screen.findByTestId('artifact-editor:body:source')?.props.value).toBe('The garden keeps one cedar tree.');
            else expect(screen.getTextContent()).toContain('The garden keeps one cedar tree.');
            // A successful audience roster read must not initiate another body read.
            if (!edit) {
                await vi.waitFor(() => expect(screen.findByType(PageHeader).props.meta)
                    .toEqual(expect.arrayContaining([expect.objectContaining({ key: 'audience' })])));
                expect(served.requests.filter(request => request.path.endsWith('/access/grants'))).toHaveLength(1);
            }
            await flushHookEffects();
            expect(served.requests.filter(request => request.path === '/v1/artifacts/document')).toHaveLength(1);
            expect(served.requests.filter(request => request.path === '/v1/artifacts')).toHaveLength(0);
        } finally {
            pending.resolve(Response.json(head));
            await screen.unmount();
        }
    });

    it('re-reads the header audience when the Account wake says the Doc changed, without a reload', async () => {
        let roster: unknown = null;
        const { served } = await setup('document', undefined, false,
            request => request.path === '/v1/artifacts/document/access/grants' && roster !== null ? Response.json(roster) : undefined);
        const screen = await renderScreen(<OpenView id="document" />);
        const audience = () => (screen.findByType(PageHeader).props.meta as readonly { key: string; icon?: string }[])
            .find(fact => fact.key === 'audience')?.icon;
        try {
            await vi.waitFor(() => expect(audience()).toBe('lock'));
            // Sharing it from the sheet: the grant lands, and the Account wake names the Doc (no new revision).
            roster = { artifactId: 'document', ownerAccountId: 'owner', access: 'owner', grants: [{
                principal: { kind: 'account', accountId: 'ana' }, accessLevel: 'view', createdByAccountId: 'owner', createdAt: 2,
                display: { name: 'Ana' } }] };
            await act(async () => {
                publishHomeAccountChange(getActiveServerSnapshot().serverId, ['document'], { changeKinds: ['artifact'] });
            });
            await vi.waitFor(() => expect(audience()).toBe('users'));
            expect(served.requests.filter(request => request.path.endsWith('/access/grants')).length).toBeGreaterThan(1);
        } finally {
            await screen.unmount();
        }
    });

    it.each([
        { edit: false, failure: '503' }, { edit: true, failure: '503' },
        { edit: false, failure: 'network' }, { edit: true, failure: 'network' },
    ])('keeps a cold Doc $failure failure retryable and recovers once (edit=$edit)', async ({ edit, failure }) => {
        let recovered = false;
        const { served } = await setup('document', undefined, false, request => {
            if (request.path !== '/v1/artifacts/document' || recovered) return;
            if (failure === 'network') throw new TypeError('Network request failed');
            return Response.json({ error: 'temporarily_unavailable' }, { status: 503 });
        }, true);
        const screen = await renderScreen(<OpenView id="document" edit={edit} />);
        const failedId = edit ? 'artifact-editor:failed' : 'artifact:bodyFailed';
        try {
            // The API owner exhausts its existing transient-read backoff before this finite opening fails.
            await vi.waitFor(() => expect(screen.findByTestId(failedId) !== null).toBe(true), { timeout: 10_000 });
            expect(screen.findByTestId(edit ? 'artifact-editor:unavailable' : 'artifact:notFound') === null).toBe(true);
            const failedReads = served.requests.filter(request => request.path === '/v1/artifacts/document').length;
            expect(failedReads).toBeGreaterThan(0);
            recovered = true;
            await screen.pressByTestIdAsync(`${failedId}-action`);
            await vi.waitFor(() => expect(screen.findByTestId(edit ? 'artifact-editor:save' : 'artifact:body') !== null).toBe(true));
            await flushHookEffects();
            expect(served.requests.filter(request => request.path === '/v1/artifacts/document')).toHaveLength(failedReads + 1);
            expect(served.requests.filter(request => request.path === '/v1/artifacts')).toHaveLength(0);
        } finally {
            await screen.unmount();
        }
    });

    it.each([404, 503])('settles a cold Doc-backed widget definition read without treating HTTP %s as a missing definition', async status => {
        await setup('document', undefined, false, request => request.path === '/v1/artifacts/document'
            ? Response.json({ error: status === 404 ? 'not_found' : 'temporarily_unavailable' }, { status }) : undefined, true);
        const scope = captureActiveServerAccountScopeLifetime()?.scope;
        if (!scope) throw new Error('The test Home must be applied');
        const { useWidgetDefinition } = await import('@/sync/domains/widgets/useWidgetDefinition');
        const hook = await renderHook(() => useWidgetDefinition({ ...scope, owner: { kind: 'home' } },
            { kind: 'artifact', artifactId: 'document' }));
        try {
            await vi.waitFor(() => expect(hook.getCurrent()).toEqual({ definition: null, state: 'unavailable',
                reasonCode: status === 404 ? 'widget_definition_not_found' : 'widget_definition_unavailable' }), { timeout: 10_000 });
        } finally {
            await hook.unmount();
        }
    });

    it.each([{ status: 404, edit: false }, { status: 403, edit: false }, { status: 404, edit: true }, { status: 403, edit: true }])('settles an inaccessible cold Doc as unavailable after one exact read (HTTP $status, edit=$edit)', async ({ status, edit }) => {
        const { served } = await setup('document', undefined, false,
            request => request.path === '/v1/artifacts/document'
                ? Response.json({ error: status === 404 ? 'not_found' : 'forbidden' }, { status }) : undefined, true);
        const screen = await renderScreen(<OpenView id="document" edit={edit} />);
        try {
            await vi.waitFor(() => expect(screen.findByTestId(status === 403
                ? edit ? 'artifact-editor:failed' : 'artifact:bodyFailed'
                : edit ? 'artifact-editor:unavailable' : 'artifact:notFound') !== null).toBe(true));
            await flushHookEffects();
            expect(screen.findByTestId('artifact:body') === null).toBe(true);
            expect(served.requests.filter(request => request.path === '/v1/artifacts/document')).toHaveLength(1);
            expect(served.requests.filter(request => request.path === '/v1/artifacts')).toHaveLength(0);
            if (status === 404 && !edit) {
                // A missing Artifact's own page is not a dead end: it leads back to the Artifacts list.
                const { router } = await import('expo-router');
                await screen.pressByTestIdAsync('artifact:notFound-action');
                await vi.waitFor(() => expect(vi.mocked(router.push)).toHaveBeenCalledWith('/artifacts'));
            }
        } finally {
            await screen.unmount();
        }
    });

    it('displays a workspace copy without fabricating a Session destination', async () => {
        const row: DecryptedArtifact = { id: 'workspace-copy', title: 'Copied note', isDecrypted: true,
            header: { kind: 'published.v1', title: 'Copied note' }, body: 'Frozen workspace bytes',
            ownerAccountId: 'owner', access: 'owner', storageMode: 'plain',
            headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1,
            provenance: { savedBy: { kind: 'person', accountId: 'owner' }, source: {
                machineId: 'machine', rootPath: '/repo', path: 'docs/note.txt', sha: 'a'.repeat(64),
            } } };
        const screen = await renderScreen(<ArtifactView artifactId={row.id} artifact={row} presentation="page" />);
        expect(screen.findByTestId('artifact:provenance')).not.toBeNull();
        expect(screen.findByTestId('artifact:provenance:open')).toBeNull();
        await screen.unmount();
    });
    it.each(['pane', 'page'] as const)('never mounts cached approval custody as a Document in the %s', async presentation => {
        const row: DecryptedArtifact = { id: 'approval', title: 'Review request', isDecrypted: true,
            header: { kind: 'approval_request.v1', title: 'Review request', serverIdentityId: 'home' },
            body: 'retained request envelope', headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 };
        const screen = await renderScreen(<ArtifactView artifactId={row.id} artifact={row} presentation={presentation} />);
        // Keep even a failing privacy assertion from dumping the renderer's custody tree.
        expect(screen.findByTestId('artifact:body') !== null).toBe(false);
        expect(screen.findByTestId('artifact:actions') !== null).toBe(false);
        expect(screen.tree.root.findByType('Redirect').props.href).toBe('/inbox?item=approval%3Ahome%3Aapproval');
        await screen.unmount();
    });
    it('shows a saved widget as the widget itself, never its stored definition as a document', async () => {
        const definition = { v: 1, id: 'saved-widget', name: 'Tokens per day', sizeDeclaration: { sizes: ['medium'], defaultSize: 'medium' } };
        const row: DecryptedArtifact = { id: 'saved-widget', title: 'Tokens per day', isDecrypted: true,
            header: { kind: 'widget-definition.v1', v: 1, title: 'Tokens per day' },
            body: JSON.stringify(definition), ownerAccountId: 'owner', access: 'owner', storageMode: 'plain',
            headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 };
        const screen = await renderScreen(<ArtifactView artifactId={row.id} artifact={row} presentation="page" />);
        expect(screen.findByTestId('artifact:widget')).not.toBeNull();
        expect(screen.findByTestId('artifact:body') === null).toBe(true);
        // It is a widget, not a text document: named so, and never offered to the text editor.
        expect(screen.tree.root.findByProps({ testID: 'artifact:header' }).props.meta[0]).toMatchObject({ key: 'kind', text: 'artifacts.browser.kindOne.widget' });
        expect(screen.findByTestId('artifact:edit') === null).toBe(true);
        expect(screen.findByTestId('artifact:history') !== null).toBe(true);
        await screen.unmount();
    });
    it('opens a Review as its Review page, never its stored rounds as a document', async () => {
        await setup('document');
        const rounds = [{ ordinal: 1, state: 'completed', startedAt: 1, finishedAt: 2, reviewerIds: ['s0:r0', 's0:r1'],
            runs: [{ kind: 'execution', runId: 'run-claude', machineId: 'machine-1', sessionId: 'session-1' }] }];
        const row: DecryptedArtifact = { id: 'review-1', title: 'Fix settings modal remount', isDecrypted: true,
            header: { kind: 'review.v1', v: 1, reviewId: 'review-1', title: 'Fix settings modal remount' },
            body: JSON.stringify({ v: 1, rounds }), ownerAccountId: 'owner', access: 'owner', storageMode: 'plain',
            headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 };
        const screen = await renderScreen(<ArtifactView artifactId={row.id} artifact={row} presentation="page" />);
        expect(screen.findByTestId('review-detail')).not.toBeNull();
        expect(screen.findByTestId('artifact:body') === null).toBe(true);
        expect(screen.tree.root.findByProps({ testID: 'review-detail:header' }).props.title).toBe('Fix settings modal remount');
        expect(screen.findByTestId('review-detail:run:run-claude')).toBeNull();
        await screen.pressByTestIdAsync('review-detail:tab:runs');
        // The Runs tab opens the round's original result.
        expect(screen.findByTestId('review-detail:run:run-claude')).not.toBeNull();
        await screen.unmount();
    });
    it.each([
        { state: 'completed', total: 7, needsDecision: 2, sentence: 'reviewWalkthrough.detail.glanceToDecide(count=2)', countFact: true },
        { state: 'completed', total: 7, needsDecision: 0, sentence: 'reviewWalkthrough.detail.glanceAllDecided', countFact: true },
        { state: 'completed', total: 0, needsDecision: 0, sentence: 'reviewWalkthrough.detail.glanceNoFindings', countFact: false },
        { state: 'running', total: 7, needsDecision: 2, sentence: 'reviewWalkthrough.detail.glanceRunning', countFact: false },
        { state: 'failed', total: 7, needsDecision: 2, sentence: 'reviewWalkthrough.detail.glanceFailed', countFact: false },
        { state: 'completed', total: null, needsDecision: 0, sentence: 'Stored round summary', countFact: false },
    ] as const)('renders the Review owner count verdict for $state ($total findings, $needsDecision undecided)', async testCase => {
        const reviewId = `review-counts-${testCase.state}-${testCase.total}-${testCase.needsDecision}`;
        await setup('document', undefined, false, request => request.path === '/v1/reviews/get'
            ? testCase.total === null ? Response.json({ error: 'temporarily_unavailable' }, { status: 503 })
                : Response.json({ review: { reviewId, projectSourceId: null, workflowId: null,
                    subjectKind: 'repository', sourceKind: 'direct', state: testCase.state, currentRoundOrdinal: 2,
                    startedAt: 1, finishedAt: testCase.state === 'running' ? null : 2, createdAt: 1, updatedAt: 2,
                    counts: { total: testCase.total, needsDecision: testCase.needsDecision } },
                    human: { reviewId, roundOrdinal: 2, requests: [], verdicts: [], needsYou: {
                        reviewId, roundOrdinal: 2, reason: 'review_needs_you', needsYou: testCase.needsDecision > 0,
                        requestedVerdict: false, pendingDecisions: testCase.needsDecision > 0, canSubmitVerdict: false } } }) : undefined);
        const scope = captureActiveServerAccountScopeLifetime()?.scope;
        if (!scope) throw new Error('The test Home must be applied');
        const row: DecryptedArtifact = { id: reviewId, sourceServerId: scope.serverId, title: 'Counted Review', isDecrypted: true,
            header: { kind: 'review.v1', v: 1, reviewId, title: 'Counted Review' },
            body: JSON.stringify({ v: 1, rounds: [
                { ordinal: 1, state: 'completed', startedAt: 1, finishedAt: 2, reviewerIds: ['first'], runs: [] },
                { ordinal: 2, state: testCase.state, startedAt: 3, finishedAt: testCase.state === 'running' ? null : 4,
                    reviewerIds: ['second'], runs: [], summary: 'Stored round summary' },
            ] }), ownerAccountId: 'owner', access: 'owner', storageMode: 'plain',
            headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 };
        const screen = await renderScreen(<ArtifactView artifactId={row.id} artifact={row} presentation="page" />);
        try {
            await waitForHomeGovernance(() => expect(screen.findByTestId('review-detail:glance')?.findAll(node =>
                typeof node.type === 'string' && node.children.includes(testCase.sentence)).length).toBeGreaterThan(0));
            const facts = screen.tree.root.findByProps({ testID: 'review-detail:facts' }).props.facts;
            expect(facts.includes(`reviewWalkthrough.detail.findingsCount(count=${testCase.total})`)).toBe(testCase.countFact);
            if (testCase.state === 'completed' && testCase.total !== null) expect(facts).toContain('Stored round summary');
        } finally {
            await screen.unmount();
        }
    });
    it('opens native Review findings, continues their durable window and decides the root without a Session', async () => {
        const reviewId = 'review-native-findings';
        const makeComment = (id: string, title: string, identity: string) => buildReviewCommentFixture({ id,
            accountId: 'owner', reviewId, roundOrdinal: 1, findingIdentity: identity.repeat(64),
            body: `Sealed explanation ${id}`,
            appearances: [{ roundOrdinal: 1, reviewerId: 'reviewer', runId: 'run-native' }],
            finding: { id: `finding-${id}`, title, summary: `Sealed explanation ${id}`, category: 'correctness', severity: 'high',
                evidence: 'Verified against the captured code.', patch: '--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-old\n+new' } });
        let first = makeComment('native-first', 'First durable finding', 'a');
        const second = makeComment('native-second', 'Later durable finding', 'b');
        const cursors: (string | null)[] = [];
        const transitions: Record<string, unknown>[] = [];
        // Shared editable Sessions use the real Account-pending transport; owned Sessions dispatch to their Machine.
        const fixSession = createSessionFixture({ id: 'native-fix-session', accessLevel: 'edit', active: true, pendingVersion: 2 });
        const sessionHttp = createSessionMetadataHttpBoundary(() => ({ [fixSession.id]: fixSession }));
        const fixMachine = createMachineFixture({ id: 'machine-1', active: true, activeAt: Date.now() });
        let preparation: ReviewCommentPrepareMutationResponseV1 | undefined;
        const record: DecryptedArtifact = { id: reviewId, title: 'Native Review', isDecrypted: true,
            header: { kind: 'review.v1', v: 1, reviewId, title: 'Native Review' },
            body: JSON.stringify({ v: 1, rounds: [{ ordinal: 1, state: 'completed', startedAt: 1, finishedAt: 2,
                reviewerIds: ['reviewer'], runs: [] }] }), ownerAccountId: 'owner', access: 'owner', storageMode: 'plain',
            headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 };
        const { served } = await setup('document', undefined, false, request => {
            if (request.path.endsWith('/pending') && request.method === 'POST') throw new TypeError('Network unavailable');
            const sessionResponse = sessionHttp.handle(request.url, { method: request.method,
                ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }) });
            if (sessionResponse) return sessionResponse;
            if (request.path === '/v1/machines') return Response.json([createPlainMachineRowFixture({ id: fixMachine.id, accountId: 'owner', machine: fixMachine })]);
            const machineResponse = createPlainMachineReadHttpResponseFixture(request.path, { method: request.method,
                ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }) }, 'owner', fixMachine);
            if (machineResponse) return machineResponse;
            if (request.path === `/v1/artifacts/${reviewId}`) return Response.json(createPlainArtifactHttpFixture(record, 'owner'));
            if (request.path === '/v1/reviews/get') return Response.json({ review: {
                reviewId, projectSourceId: null, workflowId: null, subjectKind: 'repository', sourceKind: 'direct',
                state: 'completed', currentRoundOrdinal: 1, startedAt: 1, finishedAt: 2, createdAt: 1, updatedAt: 2,
                counts: { total: 2, needsDecision: 2 } }, human: { reviewId, roundOrdinal: 1, requests: [], verdicts: [],
                needsYou: { reviewId, roundOrdinal: 1, reason: 'review_needs_you', needsYou: true,
                    requestedVerdict: false, pendingDecisions: true, canSubmitVerdict: false } } });
            if (request.path === '/v1/reviews/comments' && request.method === 'GET') {
                const cursor = request.url.searchParams.get('cursor'); cursors.push(cursor);
                return Response.json(cursor ? { items: [storePlainReviewCommentFixture(second)], cursor: null }
                    : { items: [storePlainReviewCommentFixture(first)], cursor: 'native-next' });
            }
            if (request.path === '/v1/reviews/comments/mutations/prepare') {
                const input = ReviewCommentPrepareMutationRequestV1Schema.parse(request.body);
                const prior = storePlainReviewCommentFixture(first);
                const derived = deriveReviewCommentStructuralMutationV1({ mutation: input.mutation, accountId: 'owner',
                    actor: { kind: 'user', userId: 'owner' }, current: [prior.structural],
                    runtime: { now: () => 3, createId: prefix => `${prefix}-native-decision` } });
                transitions.push(input.mutation.input);
                preparation = ReviewCommentPrepareMutationResponseV1Schema.parse({ v: 1, request: input, receipt: 'native-decision',
                    replayed: false, ...derived, records: derived.records.map(item => ({ ...item,
                        previous: { structural: prior.structural, source: { v: 1, layout: 'canonical_v1', envelope: prior.sensitiveEnvelope } } })) });
                return Response.json(preparation);
            }
            if (request.path === '/v1/reviews/comments/mutations/commit') {
                const input = ReviewCommentCommitMutationRequestV1Schema.parse(request.body);
                const structural = preparation?.records[0]?.structural;
                if (!structural || input.receipt !== preparation?.receipt || !input.records[0]) throw new Error('Missing admitted comment mutation');
                const stored = { v: 1 as const, structural, sensitiveEnvelope: input.records[0].sensitiveEnvelope };
                const opened = openStoredReviewCommentV1({ stored, mode: 'plain' });
                if (opened.status !== 'available') throw new Error('The committed plain fixture must open');
                first = opened.comment;
                return Response.json({ v: 1, comments: [stored], replayed: false, failed: [] });
            }
        });
        const scope = captureActiveServerAccountScopeLifetime()?.scope;
        if (!scope) throw new Error('The test Home must be applied');
        await prepareSessionDraftPersistenceStorage();
        getStorage().getState().applySessions([{ ...fixSession, serverId: scope.serverId }]);
        const row = { ...record, sourceServerId: scope.serverId };
        const screen = await renderScreen(<ArtifactView artifactId={row.id} artifact={row} presentation="page" focusThreadId="native-second" />);
        try {
            expect(screen.findByTestId('review-detail:tab:findings')).not.toBeNull();
            await screen.pressByTestIdAsync('review-detail:tab:findings');
            await waitForHomeGovernance(() => expect(screen.findByTestId('review-finding-toggle:native-first')).not.toBeNull());
            expect(screen.findByTestId('review-finding-toggle:native-second')).toBeNull();
            await screen.pressByTestIdAsync('review-findings-load-more-comments');
            await waitForHomeGovernance(() => expect(screen.findByTestId('review-finding-toggle:native-second')).not.toBeNull());
            expect(cursors).toEqual([null, 'native-next']);
            expect(screen.findByTestId('review-finding-body:native-second')).not.toBeNull();
            await screen.pressByTestIdAsync('review-finding-toggle:native-first');
            expect(JSON.stringify(screen.tree.toJSON())).toContain('Sealed explanation native-first');
            await screen.pressByTestIdAsync('review-finding-triage:native-first:accept');
            await waitForHomeGovernance(() => expect(transitions).toHaveLength(1));
            expect(transitions[0]).toMatchObject({ reviewId, expectedServerRevision: 1, reviewTriageStatus: 'accept' });
            expect(served.requests.filter(request => request.path.includes('/execution-runs'))).toHaveLength(0);
            await waitForHomeGovernance(() => expect(screen.findByTestId('review-detail:implement')?.props.disabled).toBe(false));
            vi.mocked(Modal.show).mockReturnValue('native-fix-destination');
            await screen.pressByTestIdAsync('review-detail:implement');
            const chooser = vi.mocked(Modal.show).mock.calls.at(-1)?.[0];
            const chooserProps = chooser?.props;
            if (!chooserProps || !('onResolve' in chooserProps) || typeof chooserProps.onResolve !== 'function') throw new Error('Missing Session chooser');
            const resolveDestination = chooserProps.onResolve;
            await act(async () => resolveDestination({ kind: 'existingSession', serverId: scope.serverId, sessionId: 'native-fix-session' }));
            await waitForHomeGovernance(async () => expect(await loadPendingOutboxForSession('native-fix-session', scope),
                `${screen.getTextContent()}\n${JSON.stringify(served.requests.map(request => ({ path: request.path, method: request.method })))}`).toEqual([
                    expect.objectContaining({ text: expect.stringContaining('native-first'), operation: 'enqueue' }),
                ]));
            expect(await loadPendingOutboxForSession('run-native', scope)).toEqual([]);
        } finally { await screen.unmount(); }
    });
    it.each([false, true])('reads native Review questions only for presented findings from their retained Machine and Home (Session: %s)', async withSession => {
        const reviewId = 'native-review-questions';
        const run = ExecutionRunPublicStateSchema.parse({ runId: 'question-run', callId: 'question-call', sidechainId: 'sidechain',
            intent: 'review', backendTarget: { kind: 'builtInAgent', agentId: 'claude' }, display: { title: 'Retained reviewer' },
            permissionMode: 'default', retentionPolicy: 'resumable', runClass: 'bounded', ioMode: 'request_response',
            status: 'succeeded', startedAtMs: 1, finishedAtMs: 2 });
        const record: DecryptedArtifact = { id: reviewId, title: 'Questions', isDecrypted: true,
            header: { kind: 'review.v1', v: 1, reviewId, title: 'Questions' },
            body: JSON.stringify({ v: 1, rounds: [{ ordinal: 1, state: 'completed', startedAt: 1, finishedAt: 2,
                reviewerIds: ['opaque-participant'], runs: [{ kind: 'execution', runId: run.runId, machineId: 'question-machine', ...(withSession ? { sessionId: 'question-session' } : {}) }] }] }),
            ownerAccountId: 'owner', access: 'owner', storageMode: 'plain', headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 };
        const reads: unknown[] = [];
        const retained = { run, structuredMeta: { kind: 'review_narration.v1', payload: {} }, reviewFindings: {
            runRef: { runId: run.runId, callId: run.callId, backendId: 'claude', backendTarget: run.backendTarget, retentionPolicy: 'resumable' },
            summary: 'A question remains', overviewMarkdown: 'A question remains', findings: [], assumptions: [], generatedAtMs: 2,
            questions: [{ id: 'retained-question', text: 'Which Account owns this data?', status: 'open', findingIds: [] }],
        } };
        const actions: unknown[] = [];
        const rpc = installSessionActionRpcBoundary((request, context) => {
            if (request.method.endsWith(SESSION_RPC_METHODS.EXECUTION_RUN_GET)) {
                reads.push({ method: request.method, serverUrl: context.serverUrl, input: request.params });
                return retained;
            }
            if (request.method.endsWith(RPC_METHODS.CAPABILITIES_DESCRIBE)) return EXECUTION_RUN_CAPABILITIES_DESCRIBE_FIXTURE;
            if (request.method.endsWith(SESSION_RPC_METHODS.EXECUTION_RUN_ACTION)) {
                actions.push(request.params);
                retained.reviewFindings.questions[0]!.status = 'answered';
                return { ok: true };
            }
            throw new Error(`Unexpected question RPC: ${request.method}`);
        });
        const reviewerSession = createSessionFixture({ id: 'question-session', active: true,
            metadata: { path: '/repo', host: 'test', machineId: 'question-machine' } });
        const sessions = createSessionMetadataHttpBoundary(() => ({ 'question-session': reviewerSession }));
        const { served } = await setup('document', undefined, false, request => {
            if (request.path === `/v1/artifacts/${reviewId}`) return Response.json(createPlainArtifactHttpFixture(record, 'owner'));
            if (request.path === '/v1/features') return Response.json(FeaturesResponseSchema.parse({ features: {
                execution: { runs: { enabled: true } }, encryption: { plaintextStorage: { enabled: true }, accountOptOut: { enabled: true } } },
                capabilities: { serverIdentity: { serverIdentityId: 'question-home' } } }));
            const machine = createPlainMachineReadHttpResponseFixture(request.path, { method: request.method,
                ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }) }, 'owner');
            if (machine) return machine;
            if (request.path === '/v1/reviews/comments') return Response.json({ items: [], cursor: null });
            return sessions.handle(request.url, { method: request.method,
                ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }) }) ?? undefined;
        });
        await setServerProfileIdentityForUrl(served.homes.owner!.serverUrl, 'question-home');
        const scope = captureActiveServerAccountScopeLifetime()!.scope;
        if (withSession) {
            await prepareSessionDraftPersistenceStorage();
            getStorage().getState().applySessions([{ ...reviewerSession, serverId: scope.serverId }]);
        }
        const page = (active: boolean) => <PluginSurfaceFocusEligibilityProvider active={active} presentationActive={active}>
            <ArtifactView artifactId={reviewId} artifact={{ ...record, sourceServerId: scope.serverId }} presentation="page" />
        </PluginSurfaceFocusEligibilityProvider>;
        const screen = await renderScreen(page(false));
        try {
            await flushHookEffects();
            expect(reads).toEqual([]);
            await act(async () => { screen.update(page(true)); });
            await waitForHomeGovernance(() => expect(screen.findByTestId('review-question:retained-question'),
                `${screen.getTextContent()}\n${JSON.stringify({ reads, requests: served.requests.map(request => ({ path: request.path, method: request.method, body: request.body })) })}`).not.toBeNull());
            expect(screen.getTextContent()).toContain('Which Account owns this data?');
            expect(reads).toEqual([{ method: `${withSession ? 'question-session' : 'question-machine'}:${SESSION_RPC_METHODS.EXECUTION_RUN_GET}`,
                serverUrl: served.homes.owner!.serverUrl,
                input: { runId: 'question-run', includeStructured: true, includeLatestToolResult: false } }]);
            if (withSession) {
                await screen.pressByTestIdAsync('review-question-answer:retained-question');
                const input = screen.findByTestId('review-findings-follow-up')!.findByType(AgentInput);
                await act(async () => input.props.onChangeText('The original Account'));
                await act(async () => input.props.onSend({ inputTextOverride: 'The original Account' }));
                await waitForHomeGovernance(() => expect(actions).toEqual([{ runId: 'question-run', actionId: 'review.follow_up',
                    input: { findingIds: [], replyToQuestionId: 'retained-question', messageMarkdown: 'The original Account' } }]));
                expect(rpc.filter(request => request.method.endsWith(SESSION_RPC_METHODS.EXECUTION_RUN_ACTION))
                    .map(request => request.method)).toEqual([`question-session:${SESSION_RPC_METHODS.EXECUTION_RUN_ACTION}`]);
                await waitForHomeGovernance(() => {
                    expect(screen.findByTestId('review-question:retained-question')).not.toBeNull();
                    expect(screen.findByTestId('review-question-answer:retained-question')).toBeNull();
                });
            } else {
                expect(screen.findByTestId('review-question-answer:retained-question')).toBeNull();
                expect(screen.findByTestId('review-findings-follow-up-unavailable')).not.toBeNull();
            }
            const readsBeforeActivity = reads.length;
            await screen.pressByTestIdAsync('review-detail:tab:activity');
            await flushHookEffects();
            expect(reads).toHaveLength(readsBeforeActivity);
        } finally { await screen.unmount(); }
    });
    it('keeps an unreadable durable finding visible as unavailable rather than a clean Review', async () => {
        const reviewId = 'review-unreadable-finding';
        const root = buildReviewCommentFixture({ id: 'unreadable-root', reviewId, roundOrdinal: 1,
            findingIdentity: 'c'.repeat(64), body: '' });
        const record: DecryptedArtifact = { id: reviewId, title: 'Review', isDecrypted: true,
            header: { kind: 'review.v1', v: 1, reviewId, title: 'Review' },
            body: JSON.stringify({ v: 1, rounds: [{ ordinal: 1, state: 'completed', startedAt: 1, finishedAt: 2,
                reviewerIds: ['reviewer'], runs: [] }] }), ownerAccountId: 'owner', access: 'owner', storageMode: 'plain',
            headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 };
        await setup('document', undefined, false, request => {
            if (request.path === `/v1/artifacts/${reviewId}`) return Response.json(createPlainArtifactHttpFixture(record, 'owner'));
            if (request.path === '/v1/reviews/comments' && request.method === 'GET') return Response.json({ items: [storePlainReviewCommentFixture(root)], cursor: null });
        });
        const scope = captureActiveServerAccountScopeLifetime()!.scope;
        const screen = await renderScreen(<ArtifactView artifactId={reviewId} artifact={{ ...record, sourceServerId: scope.serverId }} presentation="page" />);
        try {
            await waitForHomeGovernance(() => expect(screen.findByTestId('review-detail:unavailable-finding:unreadable-root')).not.toBeNull());
            expect(screen.findByTestId('review-findings:empty')).toBeNull();
            expect(screen.findByTestId('review-finding-triage:unreadable-root:accept')).toBeNull();
        } finally { await screen.unmount(); }
    });
    it('opens workflow finding history only from the Review Activity tab and makes no history read for a direct Review', async () => {
        const { served } = await setup('document', undefined, false, request => {
            if (request.path === '/v1/reviews/get') {
                const reviewId = (request.body as { reviewId: string }).reviewId;
                return Response.json({ review: { reviewId, projectSourceId: null,
                    workflowId: reviewId === 'workflow-review-history' ? 'repository-hunt' : null,
                    subjectKind: 'repository', sourceKind: reviewId === 'workflow-review-history' ? 'workflow' : 'direct',
                    state: 'completed', currentRoundOrdinal: 1, startedAt: 1, finishedAt: 2, createdAt: 1, updatedAt: 2,
                    counts: { total: 0, needsDecision: 0 } },
                    human: { reviewId, roundOrdinal: 1, requests: [], verdicts: [], needsYou: {
                        reviewId, roundOrdinal: 1, reason: 'review_needs_you', needsYou: false,
                        requestedVerdict: false, pendingDecisions: false, canSubmitVerdict: false } } });
            }
            if (request.path === '/v1/reviews/history/list') return Response.json({ previousReviewId: 'earlier-review', items: [{
                findingIdentity: 'f'.repeat(64), priorReviewCount: 2, priorRunCount: 4, firstObservedAt: 1,
                inCurrentReview: true, inPreviousReview: true, currentAppearances: [], previousAppearances: [],
                newSincePrevious: false, openReviewCount: 1,
            }] });
        });
        const scope = captureActiveServerAccountScopeLifetime()!.scope;
        const review = (id: string): DecryptedArtifact => ({ id, sourceServerId: scope.serverId, title: 'Repository Review', isDecrypted: true,
            header: { kind: 'review.v1', v: 1, reviewId: id, title: 'Repository Review' },
            body: JSON.stringify({ v: 1, rounds: [{ ordinal: 1, state: 'completed', startedAt: 1, finishedAt: 2, reviewerIds: [], runs: [] }] }),
            ownerAccountId: 'owner', access: 'view', storageMode: 'plain', headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 });
        const screen = await renderScreen(<ArtifactView artifactId="workflow-review-history" artifact={review('workflow-review-history')} presentation="page" />);
        try {
            await waitForHomeGovernance(() => expect(served.requests.filter(request => request.path === '/v1/reviews/get')).toHaveLength(1));
            expect(served.requests.filter(request => request.path === '/v1/reviews/history/list')).toHaveLength(0);
            await screen.pressByTestIdAsync('review-detail:tab:activity');
            await waitForHomeGovernance(() => expect(screen.findByTestId(`review-history:finding:${'f'.repeat(64)}`)).not.toBeNull());
            expect(served.requests.filter(request => request.path === '/v1/reviews/history/list')).toMatchObject([
                { accountId: 'owner', body: { workflowId: 'repository-hunt', reviewId: 'workflow-review-history' } },
            ]);
            await screen.update(<ArtifactView artifactId="direct-review-history" artifact={review('direct-review-history')} presentation="page" />);
            await waitForHomeGovernance(() => expect(served.requests.filter(request => request.path === '/v1/reviews/get')).toHaveLength(2));
            await flushHookEffects();
            expect(served.requests.filter(request => request.path === '/v1/reviews/history/list')).toHaveLength(1);
            expect(screen.findByTestId(`review-history:finding:${'f'.repeat(64)}`)).toBeNull();
        } finally { await screen.unmount(); }
    });
    it('demands Review metadata only in the opened Artifact Home', async () => {
        const { served } = await setup('document', undefined, false, request => request.path === '/v1/reviews/get'
            ? Response.json({ review: { reviewId: 'review-scope', projectSourceId: null, workflowId: null,
                subjectKind: 'repository', sourceKind: 'direct', state: 'completed', currentRoundOrdinal: 1,
                startedAt: 1, finishedAt: 2, createdAt: 1, updatedAt: 2, counts: { total: 0, needsDecision: 0 } },
                human: { reviewId: 'review-scope', roundOrdinal: 1, requests: [], verdicts: [], needsYou: {
                    reviewId: 'review-scope', roundOrdinal: 1, reason: 'review_needs_you', needsYou: false,
                    requestedVerdict: false, pendingDecisions: false, canSubmitVerdict: false } } }) : undefined);
        const scope = captureActiveServerAccountScopeLifetime()?.scope;
        expect(scope).not.toBeNull();
        const row: DecryptedArtifact = { id: 'review-scope', sourceServerId: scope!.serverId, title: 'Scoped Review', isDecrypted: true,
            header: { kind: 'review.v1', v: 1, reviewId: 'review-scope', title: 'Scoped Review' },
            body: JSON.stringify({ v: 1, rounds: [] }), ownerAccountId: 'another-person', access: 'view', storageMode: 'plain',
            headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 };
        const screen = await renderScreen(<ArtifactView artifactId={row.id} artifact={row} presentation="page" />);
        await waitForHomeGovernance(() => expect(served.requests.filter(request => request.path === '/v1/reviews/get')).toHaveLength(1));
        await screen.update(<ArtifactView artifactId="review-other-home" artifact={{ ...row, id: 'review-other-home',
            sourceServerId: 'a-different-home', header: { ...row.header!, reviewId: 'review-other-home' } }} presentation="page" />);
        await flushHookEffects({ cycles: 20 });
        expect(served.requests.filter(request => request.path === '/v1/reviews/get')).toHaveLength(1);
        await screen.unmount();
    });
    it.each([{ kind: 'image', warm: false }, { kind: 'html', warm: false }, { kind: 'image', warm: true }, { kind: 'html', warm: true }] as const)(
        'opens $kind (warm=$warm) through one authenticated head and renders its private preview', async ({ kind, warm }) => {
        const { served } = await setup(kind, undefined, warm);
        const screen = await renderScreen(<OpenView id="document" />);
        await vi.waitFor(() => expect(kind === 'image' ? screen.findByTestId('artifact:viewerBody') : screen.findHostByTestId('artifact:htmlPreview-navigation-shell')).not.toBeNull());
        const heads = served.requests.filter(request => request.path === '/v1/artifacts/document');
        console.info('Artifact view measurement', { kind, warm, heads: heads.length,
            blobs: served.requests.filter(request => request.path.includes('/blobs/')).length,
            shells: served.requests.filter(request => request.path.endsWith('/html-preview')).length });
        expect(heads).toHaveLength(1);
        expect(served.requests.filter(request => request.path.endsWith('/html-preview'))).toHaveLength(0);
        // Public feature discovery may be anonymous; every private Artifact operation must authenticate.
        const privateRequests = served.requests.filter(request => request.path === '/v1/artifacts' || request.path.startsWith('/v1/artifacts/'));
        expect(privateRequests.every(request => request.accountId === 'owner')).toBe(true);
        await screen.unmount();
    });

    it('leaves a generic file download deferred and suppresses the retired preview while renewed authority reads again', async () => {
        const { served } = await setup('file');
        const file = await renderScreen(<OpenView id="document" />);
        await flushHookEffects();
        await vi.waitFor(() => expect(file.findByTestId('artifact:download')).not.toBeNull());
        expect(served.requests.some(request => request.path.includes('/blobs/'))).toBe(false);
        await file.unmount();
        await disposeHome?.();
        const pending = createDeferred<Response>();
        const renewed = createDeferred<Response>();
        let blobReads = 0;
        const next = await setup('image', undefined, false, request => request.path.includes('/blobs/')
            ? ++blobReads === 1 ? pending.promise : renewed.promise : undefined);
        const image = await renderScreen(<OpenView id="document" />);
        const response = () => Response.json({ blobId: next.reference.blobId, content: { t: 'plain', v: encodeBase64(next.bytes) } });
        try {
            await vi.waitFor(() => expect(blobReads).toBe(1));
            await act(async () => { retireActiveServerAccountScopeLifetime(); });
            await vi.waitFor(() => expect(blobReads).toBe(2));
            await act(async () => { pending.resolve(response()); });
            await flushHookEffects();
            expect(image.findByTestId('artifact:viewerBody') === null).toBe(true);
            expect(URL.createObjectURL).not.toHaveBeenCalled();
            await act(async () => { renewed.resolve(response()); });
            await vi.waitFor(() => expect(image.findByTestId('artifact:viewerBody')).not.toBeNull());
        } finally {
            pending.resolve(response());
            renewed.resolve(response());
            await image.unmount();
        }
    });

    it('reopens an HTML frame retry through fresh Account authority without repeating a head within either operation', async () => {
        const { served } = await setup('html');
        const screen = await renderScreen(<OpenView id="document" />);
        await vi.waitFor(() => expect(screen.findHostByTestId('artifact:htmlPreview-navigation-shell')).not.toBeNull());
        await act(async () => { screen.findHostByTestId('artifact:htmlPreview-navigation-shell')!.props.onError(); });
        await screen.pressByTestIdAsync('artifact:htmlPreviewRetry');
        await vi.waitFor(() => expect(screen.findHostByTestId('artifact:htmlPreview-navigation-shell')).not.toBeNull());
        expect(served.requests.filter(request => request.path === '/v1/artifacts/document')).toHaveLength(2);
        expect(served.requests.filter(request => request.path.endsWith('/html-preview'))).toHaveLength(0);
        await screen.unmount();
    });

    it('cancels a superseded revision and does not install its late private preview', async () => {
        const pending = createDeferred<Response>();
        let blobReads = 0;
        const { served, head, row, bytes, reference } = await setup('image', undefined, false, request => {
            if (!request.path.includes('/blobs/')) return;
            if (++blobReads === 1) return pending.promise;
            return Response.json({ blobId: reference.blobId, content: { t: 'plain', v: encodeBase64(bytes) } });
        });
        const screen = await renderScreen(<OpenView id="document" />);
        await vi.waitFor(() => expect(blobReads).toBe(1));
        head.headerVersion = 2;
        head.bodyVersion = 2;
        await act(async () => { getStorage().getState().updateArtifact({ ...row, headerVersion: 2, bodyVersion: 2 }); });
        await vi.waitFor(() => expect(screen.findByTestId('artifact:viewerBody')).not.toBeNull());
        expect(getStorage().getState().artifacts.document?.bodyVersion).toBe(2);
        expect(served.requests.filter(request => request.path === '/v1/artifacts/document')).toHaveLength(2);
        expect(URL.createObjectURL).toHaveBeenCalledTimes(1);
        pending.resolve(Response.json({ blobId: reference.blobId, content: { t: 'plain', v: encodeBase64(bytes) } }));
        await flushHookEffects();
        expect(URL.createObjectURL).toHaveBeenCalledTimes(1);
        await screen.unmount();
    });
});

describe('dashboard Artifacts', () => {
    const scope = { serverId: 'home', accountId: 'owner' };
    function dashboardRow(owner: Readonly<{ kind: 'project'; projectId: string; layoutId?: string }>, name?: string): DecryptedArtifact {
        const surface = { ...scope, owner };
        const layout = { v: 1 as const, surface, ...(name ? { name } : {}), items: WidgetLayoutItemsV1Schema.parse(projectOverviewPresetV1().items) };
        const header = buildWidgetSurfaceArtifactHeaderV1(layout);
        return { id: buildWidgetSurfaceArtifactIdV1(surface), title: String(header.title), header: { ...header, title: String(header.title) }, rawHeader: header, isDecrypted: true,
            body: JSON.stringify(layout), ownerAccountId: 'owner', access: 'owner', storageMode: 'plain',
            headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 };
    }
    function seedProject(projectKey: string) {
        getStorage().setState({ profileScope: scope, settingsScope: scope, projectAccountRows: createProjectAccountRowsFixture(scope, {
            workspaceRefs: [{ id: 'checkout-1', serverId: 'home', machineId: 'machine', projectKey, rootPath: '/src/happier', createdAtMs: 1 }],
        }) });
    }
    const widgetIds = () => flattenWidgetLayoutWidgetsV1(WidgetLayoutItemsV1Schema.parse(projectOverviewPresetV1().items)).map(widget => widget.instance.id);

    it.each(['pane', 'page'] as const)('shows a named dashboard as its widgets with Open in Project, never as editable or commentable text (%s)', async presentation => {
        seedProject('happier-app');
        const row = dashboardRow({ kind: 'project', projectId: 'happier-app', layoutId: 'release' }, 'Release review');
        const screen = await renderScreen(<ArtifactView artifactId={row.id} artifact={row} presentation={presentation} />);
        try {
            await flushHookEffects();
            expect(screen.findByTestId('artifact:dashboard')).not.toBeNull();
            for (const id of widgetIds()) expect(screen.findByTestId(`artifact:dashboard.widget:${id}`)).not.toBeNull();
            // Its stored layout is never offered as a text document.
            expect(screen.findByTestId('artifact:body') === null).toBe(true);
            expect(screen.findByTestId('artifact:dashboard.unattached') === null).toBe(true);
            expect(screen.findByTestId('artifact:edit') === null).toBe(true);
            expect(screen.findByTestId('artifact:comments') === null).toBe(true);
            expect(screen.findByTestId('artifact:share')).not.toBeNull();
            const { router } = await import('expo-router');
            await act(async () => { screen.findByTestId('artifact:dashboard.open')?.props.onPress(); });
            await vi.waitFor(() => expect(vi.mocked(router.push)).toHaveBeenCalledWith(expect.stringMatching(/^\/projects\/checkout-1\/overview\?.*layoutId=release/)));
        } finally {
            await screen.unmount();
        }
    });

    it('shows an orphaned default dashboard by its widgets, says it is not attached to a Project, and offers no Open action', async () => {
        seedProject('another-project');
        const row = dashboardRow({ kind: 'project', projectId: 'forgotten-project' });
        const screen = await renderScreen(<ArtifactView artifactId={row.id} artifact={row} presentation="page" />);
        try {
            await flushHookEffects();
            const header = screen.tree.root.findByProps({ testID: 'artifact:header' }).props;
            expect(header.title).toBe('Overview');
            // Its header names what it is, a dashboard, never a Document.
            expect(header.meta[0]).toMatchObject({ key: 'kind', text: 'artifacts.browser.kindOne.dashboard' });
            for (const id of widgetIds()) expect(screen.findByTestId(`artifact:dashboard.widget:${id}`)).not.toBeNull();
            expect(screen.findByTestId('artifact:dashboard.open') === null).toBe(true);
            expect(screen.findByTestId('artifact:dashboard.unattached')).not.toBeNull();
            expect(screen.findByTestId('artifact:edit') === null).toBe(true);
            expect(screen.findByTestId('artifact:comments') === null).toBe(true);
        } finally {
            await screen.unmount();
        }
    });

    it('sends a typed edit link for a held dashboard to its view, never the text editor', async () => {
        const row = dashboardRow({ kind: 'project', projectId: 'happier-app' });
        const screen = await renderScreen(<EditArtifactContent id={row.id} artifact={row} />);
        try {
            expect(screen.findByTestId('artifact-editor:body:source')).toBeNull();
            expect(screen.tree.root.findByType('Redirect').props.href).toBe(`/artifacts/${row.id}`);
        } finally {
            await screen.unmount();
        }
    });

    it('sends a typed edit link for a dashboard it has not opened yet to its view once its header arrives', async () => {
        const header = { kind: 'widget-area-layout.v1', v: 1, title: 'Overview' };
        const { served } = await setup('document', undefined, false, request => request.path === '/v1/artifacts/document'
            ? Response.json({ id: 'document', ownerAccountId: 'owner', access: 'owner', publicAudience: 'none', encryptionMode: 'plain',
                headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1,
                header: encodePlainArtifactStoredContent(header), body: encodePlainArtifactStoredContent({ body: '{"v":1}' }),
                dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER })
            : undefined, true);
        const screen = await renderScreen(<OpenView id="document" edit />);
        try {
            await vi.waitFor(() => expect(served.requests.some(request => request.path === '/v1/artifacts/document')).toBe(true));
            await vi.waitFor(() => expect(screen.tree.root.findAllByType('Redirect').map(node => node.props.href)).toContain('/artifacts/document'));
            expect(screen.findByTestId('artifact-editor:body:source')).toBeNull();
        } finally {
            await screen.unmount();
        }
    });
});
