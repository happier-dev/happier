import * as React from 'react';
import tweetnacl from 'tweetnacl';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';
import { SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc';
import { PluginProjectionV2Schema} from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import { type MachineAgentInventoryItem } from '@happier-dev/protocol/capabilities/machineAgentInventory';
import { ACP_CATALOG_ROWS_ROUTE_V1, AcpCatalogRecordV1Schema, AcpCatalogRowReadResponseV1Schema } from '@happier-dev/protocol/acp/catalog/catalogRowsV1';
import { buildMachineAgentInventoryDescriptors, projectAcpCatalogForMachineInventory } from '@happier-dev/protocol/capabilities';
import { buildBackendTargetKeyV2 } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';
import { CUSTOM_ACP_AGENT_CONTRIBUTION_IDENTITY_V1 } from '@happier-dev/protocol/agents/executionTargetV1';
import { createDeferred, createMachineFixture, createPlainMachineRowFixture, createSessionFixture, flushHookEffects, renderHook, standardCleanup } from '@/dev/testkit';
import { createSessionSystemRecordHttpFixture } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { createCompactSessionListFetchBoundary, createSessionReadBatchFetchBoundary } from '@/dev/testkit/harness/sessionReadBatchHttpBoundary';
import { createSessionMetadataHttpBoundary } from '@/dev/testkit/harness/sessionMetadataHttpBoundary';
import { createAccountTokenForTests } from '@/dev/testkit/harness/homeGovernanceHarness';
import { waitForNetworkResponseForTests } from '@/dev/testkit/mocks/runtimeFetch';
import { bindExternalActionExecutionAuthorizationHttpPathV1, ExternalActionRequestEnvelopeV1Schema, ExternalActionExecutionAuthorizationV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { computeExternalActionRequestEnvelopeDigestV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import type { RuntimeFetch } from '@/utils/system/runtimeFetch';
import type { SessionExecutionRunStartResult } from '@/sync/ops/sessionExecutionRuns';
import { ScmComparisonCaptureInputSchema, ScmComparisonCaptureOutputSchema } from '@happier-dev/protocol/scm/diffSummary';
import { EXECUTION_RUN_CAPABILITIES_DESCRIBE_FIXTURE } from '@/dev/testkit/fixtures/executionRunCapabilitiesDescribe';
import { createSessionFilesViewFixture, fileViewSnapshot, installSessionFilesViewBoundaries, prepareSessionFilesViewTestkit, type FileViewRpcRequest } from '@/components/sessions/files/views/sessionFilesViewTestkit';

installSessionFilesViewBoundaries();
await prepareSessionFilesViewTestkit();
const { useComparisonReviewDraft } = await import('./useComparisonReviewDraft');
const { useReviewEngineInventory } = await import('./useReviewEngineInventory');
const { useExecutionRunLaunchContext } = await import('./useExecutionRunLaunchContext');
const { TokenStorage } = await import('@/auth/storage/tokenStorage');
let fixture: Awaited<ReturnType<typeof createSessionFilesViewFixture>>;
let machineSequence = 0;
const COMPARISON_ID = 'a'.repeat(64);
const SELECTED_COMPARISON_ID = 'b'.repeat(64);
const CAPTURED_COMPARISON_ID = '1'.padStart(64, '0');
afterEach(async () => { standardCleanup(); await fixture?.dispose(); });

const reviewHome = {
    settings: { experiments: true, featureToggles: { 'execution.runs': true } },
} satisfies Parameters<typeof createSessionFilesViewFixture>[0];

const isStart = (request: FileViewRpcRequest) => request.method === SESSION_RPC_METHODS.EXECUTION_RUN_START
    || request.method === SESSION_RPC_METHODS.EXECUTION_RUN_ENSURE_OR_START_PROVIDER_SAFE_V1;

// Daemon ACKs are the boundary. Exercise the real Machine Agent projection and readiness owner.
const agentProjection = PluginProjectionV2Schema.parse({ v: 2, generation: 1, installedPackagesById: {},
    agentsById: { claude: { id: 'claude', title: 'Claude', capabilities: {
        surfaces: [], sessions: { open: ['create'], delivery: ['newTurn'], cancel: true },
    } } }, actionsById: {}, familiesById: {}, resourcesById: {}, settingsById: {}, diagnostics: [] });
function reviewerFixture(kind: 'configured' | 'external') {
    const agentId = 'acme.review/reviewer';
    const record = AcpCatalogRecordV1Schema.parse({ v: 1, definitions: kind === 'configured' ? [{
        id: 'configured-reviewer', name: 'reviewer', title: 'Configured reviewer',
        launch: { kind: 'npm', package: 'reviewer', version: '1.0', args: [] }, createdAt: 1, updatedAt: 1,
    }] : [] });
    const definitions = projectAcpCatalogForMachineInventory({ status: 'ready', revision: 1, record }).definitions;
    const projection = PluginProjectionV2Schema.parse({ ...agentProjection, agentsById: kind === 'configured' ? {} : {
        [agentId]: { ...agentProjection.agentsById.claude, id: agentId, title: 'External reviewer' },
    } });
    const descriptor = buildMachineAgentInventoryDescriptors(projection, definitions)[0]!;
    const engineId = kind === 'configured' ? buildBackendTargetKeyV2({ kind: 'agent',
        identity: CUSTOM_ACP_AGENT_CONTRIBUTION_IDENTITY_V1, definitionId: record.definitions[0]!.id }) : agentId;
    return { record, projection, descriptor, engineId };
}

function readinessResponse(request: FileViewRpcRequest, signedIn = true,
    reviewer?: ReturnType<typeof reviewerFixture>, missingReadiness = false): unknown {
    if (request.method === 'capabilities.describe') return EXECUTION_RUN_CAPABILITIES_DESCRIBE_FIXTURE;
    if (request.method.includes('contributionRegistryProjection.describe')) return { protocolVersion: 1, projection: reviewer?.projection ?? agentProjection };
    if (request.method !== 'capabilities.detect') return undefined;
    const agent: MachineAgentInventoryItem = { ...(reviewer?.descriptor ?? { agentId: 'claude', title: 'Claude' }), installed: true, version: '1', latestVersion: null,
        update: { supported: false, command: null }, signIn: { status: signedIn ? 'signedIn' : 'signedOut', loginSupport: 'status_only' },
        platform: { supported: true }, install: { available: false, mode: 'manual', sizeBytes: null, guideUrl: null }, dependencies: [],
        ...(reviewer?.descriptor.definitionId ? { managed: true, fit: { kind: 'can_run', via: 'npm' } } : {}) };
    return { protocolVersion: 1, results: {
        ...(missingReadiness ? {} : reviewer?.descriptor.definitionId
            ? { 'tool.acpAgentInventory': { ok: true, checkedAt: Date.now(), data: { items: [agent] } } }
            : { [`cli.${agent.agentId}`]: { ok: true, checkedAt: Date.now(), data: { ...agent, isLoggedIn: signedIn,
                authStatus: { state: signedIn ? 'logged_in' : 'logged_out', checkedAt: Date.now() } } } }),
        'tool.executionRuns': { ok: true, checkedAt: Date.now(), data: { protocolVersion: 2,
            backends: { [reviewer?.engineId ?? 'claude']: { available: true, intents: ['review'], supportsVendorResume: true } },
            features: { detachedScope: true, startAndWait: true, runScopedAgentBindings: true, secretReferenceOverlay: true } } },
    } };
}

// HTTP is the external boundary: keep Account capture, binding and private requester sealing real.
function reviewInventoryResponse(url: Parameters<RuntimeFetch>[0], init: Parameters<RuntimeFetch>[1], foreign = false,
    reviewer?: ReturnType<typeof reviewerFixture>, readiness: 'ready' | 'needsSignIn' | 'unknown' = 'ready',
    refused = false): Response | null {
    const path = new URL(String(url)).pathname;
    if (!path.startsWith('/v1/actions/review.engines.list')) return null;
    const body: unknown = JSON.parse(String(init?.body));
    const nested = body && typeof body === 'object' && 'envelope' in body ? body.envelope : body;
    const envelope = ExternalActionRequestEnvelopeV1Schema.parse(nested);
    if (path === bindExternalActionExecutionAuthorizationHttpPathV1('review.engines.list')) {
        return Response.json(ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'home-read-authorization', binding: {
            accountId: 'alice', authentication: { kind: 'account', tokenEpoch: 0 }, serverIdentityId: 'srv_review_lifetime',
            machineId: 'm1', installationId: 'foreign-installation', custodianAccountId: 'machine-owner', accountEncryptionMode: 'plain',
            actionId: 'review.engines.list', requestId: envelope.requestId, target: envelope.target,
            requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope),
        } }));
    }
    if (foreign) expect(body).toHaveProperty('executionAuthorization.requesterAccountContext');
    return Response.json({ v: 1, actionId: 'review.engines.list', requestId: envelope.requestId,
        execution: refused ? { ok: false, errorCode: 'inventory_unavailable', errorMessage: 'Inventory unavailable' }
            : { ok: true, result: { sessionId: null, items: [{ engineId: reviewer?.engineId ?? 'claude', value: reviewer?.engineId ?? 'claude', label: reviewer?.descriptor.title ?? 'Claude',
                enabled: readiness === 'ready', readiness, backendId: reviewer?.engineId ?? 'claude', capabilities: { structuredNarration: true } }] } } });
}

async function mountController(machineId: string, engineId = 'claude', comparisonId: string | null = COMPARISON_ID) {
    return renderHook(() => {
        const [actionInput, setActionInput] = React.useState<Record<string, unknown>>({ reviewers: [{ kind: 'engine', engineId }] });
        const launcher = useExecutionRunLaunchContext('s1', fixture.home.id);
        const inventory = useReviewEngineInventory({ enabled: true, sessionId: 's1', machineId,
            serverId: fixture.home.id, accountBinding: launcher.accountBinding });
        const comparison = useComparisonReviewDraft({ sessionId: 's1', machineId, serverId: fixture.home.id,
            comparisonReview: { cwd: '/repo', comparison: { kind: 'workingTree' }, comparisonId,
                scopeLabel: 'Pending changes', defaultWalkthrough: false },
            actionInput, setActionInput, reviewInventory: inventory });
        return { comparison, launcher, inventory, actionInput };
    });
}
type Controller = Awaited<ReturnType<typeof mountController>>;
async function submit(controller: Controller, input?: Record<string, unknown>) {
    let pending!: ReturnType<ReturnType<typeof controller.getCurrent>['comparison']['submit']>;
    await act(async () => {
        const current = controller.getCurrent();
        pending = current.comparison.submit({ start: current.launcher.startAction,
            input: input ?? current.actionInput, instructions: 'Inspect these changes', operationId: 'review-operation' });
        // Cancellation may settle before the assertion waiting on its transport; observe it immediately.
        void pending.catch(() => undefined);
    });
    return { pending };
}
async function setup(options: Readonly<{ signedIn?: boolean; reviewer?: 'configured' | 'external'; missingReadiness?: boolean;
    inventoryRead?: () => unknown | Promise<unknown>; comparisonId?: string | null;
    capture?: () => unknown; start?: (request: FileViewRpcRequest) => unknown }> = {}) {
    const reviewer = options.reviewer ? reviewerFixture(options.reviewer) : undefined;
    const machineId = `review-machine-${++machineSequence}`;
    const admission = createDeferred<SessionExecutionRunStartResult>();
    const retainedComparisons = new Map<string, ReturnType<typeof ScmComparisonCaptureOutputSchema.parse>>();
    const initialComparisonId = options.comparisonId === undefined ? COMPARISON_ID : options.comparisonId;
    if (initialComparisonId) retainedComparisons.set(initialComparisonId, ScmComparisonCaptureOutputSchema.parse({
        success: true, comparison: { id: initialComparisonId, source: { kind: 'workingTree' },
            repository: { rootPath: '/repo' }, endpoints: {}, inventory: { state: 'complete', files: [], reasons: [] } },
        metadata: { source: { kind: 'workingTree' }, sourceKey: initialComparisonId },
    }));
    const capture = (input: unknown) => {
        const request = ScmComparisonCaptureInputSchema.parse(input);
        if (request.comparisonId) {
            const retained = retainedComparisons.get(request.comparisonId);
            if (!retained) throw new Error(`Unexpected retained comparison: ${request.comparisonId}`);
            return retained;
        }
        if (!options.capture) throw new Error('Unexpected new comparison capture');
        const captured = ScmComparisonCaptureOutputSchema.parse(options.capture());
        if (captured.success) retainedComparisons.set(captured.comparison.id, captured);
        return captured;
    };
    const sessionHttp = createSessionSystemRecordHttpFixture({ sessionId: 's1', records: [] });
    const session = createSessionFixture({ id: 's1', active: true, metadata: { path: '/repo', machineId, host: 'test' } });
    const metadataHttp = createSessionMetadataHttpBoundary(() => ({ [session.id]: session }));
    const sessionReads = createCompactSessionListFetchBoundary(createSessionReadBatchFetchBoundary(async (url, init) => {
        return metadataHttp.handle(url, init) ?? sessionHttp.request(url, init);
    }));
    fixture = await createSessionFilesViewFixture({ ...reviewHome, rootPath: '/repo', machineId,
        credentials: { token: createAccountTokenForTests('alice', { currentAccount: true }) }, serverIdentityId: 'srv_review_lifetime',
        machine: createMachineFixture({ id: machineId, kind: 'persistent', storageMode: 'plain', revokedAt: null, replacedByMachineId: null,
            installationId: 'test-installation', access: createPlainMachineRowFixture({ id: machineId, accountId: 'alice' }).access }),
        rpc: request => {
            if (request.method === 'scm.status.snapshot') return { success: true, snapshot: fileViewSnapshot({ rootPath: '/repo' }) };
            if (request.method === 'scm.diffSummary.capture') return capture(request.payload);
            if (isStart(request)) return options.start ? options.start(request) : admission.promise;
            return readinessResponse(request, options.signedIn ?? true, reviewer, options.missingReadiness);
        }, request: async (url, init) => {
            const path = new URL(String(url)).pathname;
            const observed = path === '/v1/actions/review.engines.list' ? await options.inventoryRead?.() : undefined;
            const refused = Boolean(observed && typeof observed === 'object' && 'ok' in observed && observed.ok === false);
            const readiness = options.signedIn === false ? 'needsSignIn' : options.missingReadiness ? 'unknown' : 'ready';
            return reviewInventoryResponse(url, init, false, reviewer, readiness, refused) ?? (path === ACP_CATALOG_ROWS_ROUTE_V1
            ? Response.json(AcpCatalogRowReadResponseV1Schema.parse({ status: 'present', revision: 1, content: { t: 'plain', v: reviewer?.record ?? { v: 1, definitions: [] } } }))
            : sessionReads(url, init));
        },
    });
    const controller = await mountController(machineId, reviewer?.engineId, options.comparisonId);
    return { controller, admission, engineId: reviewer?.engineId ?? 'claude' };
}
async function ready(controller: Controller) {
    await vi.waitFor(() => {
        const current = controller.getCurrent();
        expect(current.comparison.plan.canStart).toBe(true);
        expect(current.launcher.acpCatalogReady).toBe(true);
        expect(current.launcher.profileCatalogReady).toBe(true);
        expect(current.launcher.exactSettings).not.toBeNull();
    });
}

describe('comparison review controller — real readiness and admission lifetime', () => {
    it('retries a refused start against one captured 54,849-file comparison even when working changes advance', async () => {
        let captures = 0;
        // PERF-E2E's observed large working-tree census, not a product limit.
        const files = Array.from({ length: 54_849 }, (_, index) => ({
            path: `src/changed-${index}.ts`, changeKind: 'modified' as const,
            binary: false, generated: false, lockfile: false,
            evidence: { state: 'unavailable' as const, reason: 'patch_unavailable' as const }, occurrences: [],
        }));
        const { controller } = await setup({ comparisonId: null,
            capture: () => ScmComparisonCaptureOutputSchema.parse({ success: true, comparison: { id: String(++captures).padStart(64, '0'),
                source: { kind: 'workingTree' }, repository: { rootPath: '/repo' }, endpoints: {},
                inventory: { state: 'complete', files, reasons: [] } },
                metadata: { source: { kind: 'workingTree' }, sourceKey: `captured-${captures}` } }),
            start: () => ({ ok: false, errorCode: 'review_engine_unavailable', error: 'review_engine_unavailable' }) });
        await ready(controller);
        const first = await submit(controller);
        const firstResult = await first.pending;
        expect(captures, JSON.stringify(firstResult)).toBe(1);
        expect(firstResult.comparison.ok).toBe(false);
        await vi.waitFor(() => expect(controller.getCurrent().actionInput.comparisonId, JSON.stringify(firstResult)).toBe(CAPTURED_COMPARISON_ID));
        const retry = await submit(controller);
        expect((await retry.pending).comparison.ok).toBe(false);
        expect(captures).toBe(1);
        const requests = fixture.requests.filter(isStart);
        expect(requests).toHaveLength(2);
        for (const request of requests) {
            const start = expect.objectContaining({ intentInput: expect.objectContaining({ comparisonId: CAPTURED_COMPARISON_ID }) });
            expect(request.payload).toEqual(request.method === SESSION_RPC_METHODS.EXECUTION_RUN_START
                ? start : expect.objectContaining({ start }));
        }
    });
    it('starts the selected comparison without capturing or reading another comparison', async () => {
        let captures = 0;
        const { controller } = await setup({ comparisonId: SELECTED_COMPARISON_ID,
            capture: () => { captures += 1; throw new Error('Selected comparison must not recapture the working tree'); },
            start: () => ({ runId: 'selected-review', callId: 'selected-review-call', sidechainId: 'selected-review-call' }) });
        await ready(controller);
        expect(fixture.requests.filter(isStart)).toHaveLength(0);
        const { pending } = await submit(controller);
        const result = await pending;
        expect(result.comparison, JSON.stringify({ actionResult: result.actionResult, requests: fixture.requests })).toMatchObject({ ok: true, reviewRunIds: ['selected-review'] });
        expect(captures).toBe(0);
        const requests = fixture.requests.filter(isStart);
        expect(requests).toHaveLength(1);
        const start = expect.objectContaining({ intentInput: expect.objectContaining({ comparisonId: SELECTED_COMPARISON_ID }) });
        expect(requests[0]?.payload).toEqual(requests[0]?.method === SESSION_RPC_METHODS.EXECUTION_RUN_START
            ? start : expect.objectContaining({ start }));
    });
    it('keeps a selected reviewer unavailable while the Machine inventory is unanswered', async () => {
        const inventory = createDeferred<unknown>();
        const { controller } = await setup({ inventoryRead: () => inventory.promise });
        try {
            expect(controller.getCurrent().comparison.plan.canStart).toBe(false);
            expect(fixture.requests.filter(isStart)).toHaveLength(0);
        } finally {
            await act(async () => inventory.resolve({ protocolVersion: 1, projection: agentProjection }));
        }
        await ready(controller);
    });
    it('recovers failed Machine inventory through the existing readiness owner retry', async () => {
        let failed = true;
        const { controller } = await setup({ inventoryRead: () => failed
            ? { ok: false, errorCode: 'inventory_unavailable', error: 'Inventory unavailable' }
            : { protocolVersion: 1, projection: agentProjection } });
        await vi.waitFor(() => expect(controller.getCurrent().inventory.status).toBe('error'));
        expect(controller.getCurrent().comparison.plan.canStart).toBe(false);
        failed = false;
        await act(async () => controller.getCurrent().inventory.refresh());
        await ready(controller);
        expect(fixture.requests.filter(isStart)).toHaveLength(0);
    });
    it.each(['configured', 'external'] as const)('admits a ready %s reviewer with its original target identity', async reviewer => {
        const { controller, engineId, admission } = await setup({ reviewer });
        await ready(controller);
        const { pending } = await submit(controller, { reviewers: [{ kind: 'engine', engineId, modelId: 'chosen-review-model' }] });
        let outcome: unknown;
        void pending.then(value => { outcome = value; }, error => { outcome = error; });
        await vi.waitFor(() => expect(fixture.requests.filter(isStart), JSON.stringify(outcome)).toHaveLength(1));
        const request = fixture.requests.find(isStart)!;
        const expectedStart = expect.objectContaining({ modelId: 'chosen-review-model' });
        expect(request.payload).toEqual(request.method === SESSION_RPC_METHODS.EXECUTION_RUN_START
            ? expectedStart : expect.objectContaining({ start: expectedStart }));
        await act(async () => admission.resolve({ runId: 'review-run', callId: 'review-call', sidechainId: 'review-call' }));
        const result = await pending;
        expect(result.comparison).toMatchObject({ ok: true, reviewRunIds: ['review-run'], comparisonId: COMPARISON_ID });
        expect(controller.getCurrent().comparison.plan.selected.map(engine => engine.engineId)).toEqual([engineId]);
    });
    it.each([{ reviewer: 'configured' as const, missingReadiness: true }, { signedIn: false }])(
        'keeps a selected reviewer unavailable when canonical readiness refuses it (%j)', async options => {
            const { controller } = await setup(options);
            await vi.waitFor(() => expect(controller.getCurrent().inventory.status).toBe('ready'));
            await flushHookEffects();
            expect(controller.getCurrent().comparison.plan.canStart).toBe(false);
            expect(fixture.requests.filter(isStart)).toHaveLength(0);
        });
    it('preserves a typed Run admission refusal for the shared form', async () => {
        const { controller, admission } = await setup();
        await ready(controller);
        const { pending } = await submit(controller);
        await vi.waitFor(() => expect(fixture.requests.filter(isStart)).toHaveLength(1));
        const code = 'RUNNER_AGENT_SESSION_RUNTIME_SOURCE_MISSING';
        await act(async () => admission.resolve({ ok: false, error: code, errorCode: code }));
        const result = await pending;
        expect(result.comparison.ok).toBe(false);
        expect(result.actionResult).toMatchObject({ ok: true, result: { results: [
            { ok: false, errorCode: code },
        ] } });
    });
    it.each(['cancel', 'unmount', 'account retirement'] as const)('cancels pending admission on %s and ignores a late acknowledgement without replay', async departure => {
        const { controller, admission } = await setup();
        await ready(controller);
        const { pending } = await submit(controller);
        await vi.waitFor(() => expect(fixture.requests.filter(isStart)).toHaveLength(1));
        if (departure === 'cancel') await act(async () => controller.getCurrent().launcher.cancelStart());
        else if (departure === 'account retirement') await act(async () => {
            expect(await TokenStorage.removeCredentialsForServerUrl(fixture.home.serverUrl, { serverId: fixture.home.id })).toBe(true);
        });
        else await controller.unmount();
        await vi.waitFor(() => expect(fixture.emissions.filter(item => item.event === SOCKET_RPC_EVENTS.CANCEL)).toHaveLength(1));
        await act(async () => admission.resolve({ runId: 'late-review', callId: 'late-call', sidechainId: 'late-call' }));
        expect((await pending).comparison.ok).toBe(false);
        expect(fixture.requests.filter(isStart)).toHaveLength(1);
    });
    it('accepts a delayed valid admission once while its controller is mounted', async () => {
        const { controller, admission } = await setup();
        await ready(controller);
        const { pending } = await submit(controller);
        await vi.waitFor(() => expect(fixture.requests.filter(isStart)).toHaveLength(1));
        await act(async () => admission.resolve({ runId: 'review-run', callId: 'review-call', sidechainId: 'review-call' }));
        expect((await pending).comparison).toMatchObject({ ok: true, reviewRunIds: ['review-run'] });
        expect(fixture.requests.filter(isStart)).toHaveLength(1);
        expect(fixture.emissions.filter(item => item.event === SOCKET_RPC_EVENTS.CANCEL)).toHaveLength(0);
    });
    it.each(['cancel', 'unmount'] as const)('cancels foreign Session resume HTTP on %s before Run admission without replay', async departure => {
        const response = createDeferred<Response>();
        let resumeSignal: AbortSignal | null | undefined;
        let resumeRequests = 0;
        const foreignMachine = createMachineFixture({ id: 'm1', kind: 'persistent', storageMode: 'plain', revokedAt: null, replacedByMachineId: null,
            installationId: 'foreign-installation', installationPublicKey: Buffer.from(tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(5)).publicKey).toString('base64'),
            access: createPlainMachineRowFixture({ id: 'm1', accountId: 'machine-owner' }).access,
        });
        fixture = await createSessionFilesViewFixture({ ...reviewHome, rootPath: '/repo', machine: foreignMachine,
            credentials: { token: createAccountTokenForTests('alice', { currentAccount: true }) }, serverIdentityId: 'srv_review_lifetime',
            rpc: request => readinessResponse(request),
            request: async (url, init) => {
                const inventory = reviewInventoryResponse(url, init, true);
                if (inventory) return inventory;
                const path = new URL(String(url)).pathname;
                if (path === ACP_CATALOG_ROWS_ROUTE_V1) return Response.json(AcpCatalogRowReadResponseV1Schema.parse({
                    status: 'present', revision: 1, content: { t: 'plain', v: { v: 1, definitions: [] } },
                }));
                if (path === bindExternalActionExecutionAuthorizationHttpPathV1('session.open')) {
                    resumeRequests += 1;
                    resumeSignal = init?.signal;
                    return await waitForNetworkResponseForTests(response.promise, init?.signal);
                }
                return Response.json({}, { status: 404 });
            },
        });
        fixture.storage.getState().applySessions([{ ...fixture.session, active: false,
            metadata: { ...fixture.session.metadata!, flavor: 'claude', claudeSessionId: 'native-resume' } }]);
        const { captureLazyActionAccountContext } = await import('@/sync/ops/actions/actionAccountContext');
        const { readOriginalAccountActionMachine } = await import('@/sync/api/externalActionAccountTransport');
        const account = await captureLazyActionAccountContext(fixture.home.id);
        try {
            expect({ identity: account.serverIdentityId, authority: account.credentialAuthorityKind,
                machine: await readOriginalAccountActionMachine(account, 'm1') }).toMatchObject({
                identity: 'srv_review_lifetime', authority: 'account', machine: { kind: 'persistent', revokedAt: null,
                    replacedByMachineId: null, installationId: 'foreign-installation', installationPublicKey: expect.any(Uint8Array),
                    access: { custodian: { accountId: 'machine-owner' }, accessState: 'ready' } },
            });
        } finally { account.dispose(); }
        const controller = await mountController('m1');
        await ready(controller);
        const { pending } = await submit(controller);
        await vi.waitFor(() => expect(resumeRequests).toBe(1));
        if (departure === 'cancel') await act(async () => controller.getCurrent().launcher.cancelStart());
        else await controller.unmount();
        await vi.waitFor(() => expect(resumeSignal?.aborted).toBe(true));
        await act(async () => response.resolve(Response.json({ error: 'late-refusal' }, { status: 403 })));
        await flushHookEffects();
        await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
        expect(resumeRequests).toBe(1);
        expect(fixture.requests.filter(isStart)).toHaveLength(0);
    });

});
