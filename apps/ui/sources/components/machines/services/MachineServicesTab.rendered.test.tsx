import * as React from 'react';
import { createHash } from 'node:crypto';
import sodium from 'libsodium-wrappers';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { router } from 'expo-router';
import { MachineServiceRowV1Schema, MachineServicesListResultV1Schema, ManagedServiceNativeLogResultV1Schema, type MachineServiceRowV1 } from '@happier-dev/protocol';
import { ExternalActionExecutionAuthorizationRequestV1Schema, ExternalActionRequestEnvelopeV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import type { ActionExecuteResult } from '@happier-dev/protocol/actions/actionExecutionResult';
import { computeExternalActionRequestEnvelopeDigestV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import type { PluginUiHostReadReferenceV1 } from '@happier-dev/protocol/plugins/ui/client';
import { resolvePluginUiHostReadActionIdV1 } from '@happier-dev/protocol/plugins/ui/subscriptions';
import { readSessionInputForgeEvidenceAttachmentV1 } from '@happier-dev/protocol/sessions/messages/sessionInputForgeEvidenceV1';
import { encodeBase64 } from '@happier-dev/protocol/crypto/base64';
import { createDeploymentEnvironmentHeaderV1 } from '@happier-dev/deployment-protocol/testing/v1';
import { DEPLOYMENT_ENVIRONMENT_ARTIFACT_KIND_V1 } from '@happier-dev/deployment-protocol/v1';

import { createDeferred, createMachineFixture, flushHookEffects, renderHook, renderScreen, standardCleanup, reportPopoverContentLayout, withPopoverWebGlobals } from '@/dev/testkit';
import { Modal } from '@/modal';
import type { ServiceCommandSheetProps } from './command/ServiceCommandSheet';
import { createHydratedPlainMachineFixture, createMachineReadBatchResponseFixture, createPlainMachineRowFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries, waitForHomeGovernance, type HomeDomainAnswer } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installHostResourceWatchSocket, type SelectResourceWatchFixture } from '@/components/projects/deployments/resourceWatchSocket.testFixture';
import { initializeRealAppRuntimeForTests } from '@/dev/testkit/harness/realAppRuntimeHarness';
import { publishMachineInventoryForTest } from '@/dev/testkit/harness/machinePresence';
import { measureMountedCollections } from '@/dev/testkit/render/renderInCollectionLayout';
import type { MachinePageTabParams } from '@/components/machines/page/machinePageTabQuery';
import { ListPresentationProvider } from '@/components/ui/lists/listPresentation';
import { t } from '@/text';
import { AccountNoticeInvestigationBoundary } from '@/hooks/inbox/AccountNoticeInvestigationProvider';
import { AgentActionButton } from '@happier-dev/plugin-ui/components';

// The log viewport's recycler depends on native layout; render its rows deterministically at that boundary.
vi.mock('@legendapp/list/react-native', async () =>
    (await import('@/dev/testkit/mocks/legendList')).createLegendListModuleMock({ renderItems: true }));

// Only Home HTTP, Machine RPC and Socket boundaries are substituted. The tab, Actions,
// credential admission, Resource lifecycle, collection and detail hooks stay real.
const machineTransport = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock().module);
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', async () => {
    const { createServerScopedMachineRpcBoundaryMock } = await import('@/dev/testkit/mocks/serverScopedRpc');
    return createServerScopedMachineRpcBoundaryMock(machineTransport.rpc);
});
// Load the native Triage Action through the test realm; its nested Actions use the real front door.
vi.mock('@/sync/ops/actions/frontDoorRuntimeActionExecutor', async importOriginal => {
    const original = await importOriginal<typeof import('@/sync/ops/actions/frontDoorRuntimeActionExecutor')>();
    const { createFrontDoorActionExecuteForVitest } = await import('@/dev/testkit/harness/frontDoorActionExecutorBoundary');
    const { createTriageFailureFrontDoorForTest } = await import('@/dev/testkit/harness/triageFailureActionBoundary');
    return { ...original, createFrontDoorActionExecute: createTriageFailureFrontDoorForTest({
        ...original, createFrontDoorActionExecute: createFrontDoorActionExecuteForVitest(original),
    }) };
});
const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
const { storage } = await import('@/sync/domains/state/storageStore');
const { MachineServicesTab } = await import('./MachineServicesTab');
await import('@/sync/ops/actions/defaultActionExecutor');

let serverId: string;
const accountId = 'account';
const machineId = 'machine';
const machineName = 'Development machine';
const serverIdentityId = 'srv_services_rendered';
let custodianAccountId = accountId;
type Envelope = ReturnType<typeof ExternalActionRequestEnvelopeV1Schema.parse>;
type Request = Parameters<NonNullable<HomeDomainAnswer['select']>>[1];
const resourceWatches = new Map<string, SelectResourceWatchFixture>();
let resourceSocket: ReturnType<typeof installHostResourceWatchSocket>;

function service(name: string, overrides: Partial<MachineServiceRowV1> = {}) {
    return MachineServiceRowV1Schema.parse({
        serviceId: name.toLowerCase(), name, authority: 'machine', lifecyclePurpose: 'development',
        generation: 'generation-a', state: 'running', watchId: `watch-${name}`, watchRevision: 'revision-a',
        capabilities: { exec: true, start: true, stop: true, restart: true, logs: true, accounting: true },
        ...overrides,
    });
}

function answerActionExecution(actionId: string, execute: (envelope: Envelope, request: Request) => ActionExecuteResult | Promise<ActionExecuteResult>) {
    const path = `/v1/actions/${actionId}`;
    homes.answer(serverId, `${path}/execution-authorization`, { select: body => {
        const envelope = ExternalActionRequestEnvelopeV1Schema.parse((body as { envelope: unknown }).envelope);
        return { body: { v: 1, token: 'services-rendered-admission', binding: {
            serverIdentityId, accountId, authentication: { kind: 'account', tokenEpoch: 0 }, actionId,
            requestId: envelope.requestId, target: { kind: 'machine', machineId }, machineId,
            installationId: 'installation', custodianAccountId, accountEncryptionMode: 'plain',
            requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope),
        } } };
    } });
    homes.answer(serverId, path, { select: async (body, request) => {
        const authorized = ExternalActionExecutionAuthorizationRequestV1Schema.safeParse(body);
        const envelope = ExternalActionRequestEnvelopeV1Schema.parse(authorized.success ? authorized.data.envelope : body);
        return { body: { v: 1, actionId, requestId: envelope.requestId,
            execution: await execute(envelope, request) } };
    } });
}

function answerAction(actionId: string, read: (envelope: Envelope, request: Request) => unknown | Promise<unknown>) {
    answerActionExecution(actionId, async (envelope, request) => ({ ok: true, result: await read(envelope, request) }));
}

/** Emulate the daemon's Resource wire; the production Resource store owns demand and refresh. */
function answerResource<T>(initial: T, actionId: 'machines.services.list' | 'machines.services.logs.read' = 'machines.services.list',
    select: (value: T, reference: PluginUiHostReadReferenceV1) => T = value => value) {
    let value = initial;
    let failureCode: string | null = null;
    const deliver = new Set<() => void>();
    let reads = 0;
    const readValues: T[] = [];
    const content = (reference: PluginUiHostReadReferenceV1) => {
        const bytes = Buffer.from(JSON.stringify(select(value, reference)));
        return { contentType: 'application/json', bytesBase64: bytes.toString('base64'),
            digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}` };
    };
    answerAction(actionId, envelope => {
        const continuation = envelope.resourceContinuation;
        if (!continuation) return value;
        const reference = continuation.params.resource;
        if (continuation.method !== RPC_METHODS.DAEMON_PLUGIN_UI_RESOURCE_READ) throw new Error('Expected finite Resource read');
        reads++;
        readValues.push(select(value, reference));
        return failureCode ? { ok: false, code: failureCode, reason: 'unavailable' }
            : { ok: true, resource: reference, ...content(reference) };
    });
    resourceWatches.set(actionId, reference => {
        let invalidate: (() => void) | undefined;
        return { actionId, digest: () => content(reference).digest,
            onOpen(watch) {
                invalidate = () => watch.invalidate(failureCode ? `sha256:${'0'.repeat(64)}` : content(reference).digest);
                deliver.add(invalidate);
            },
            onDisconnect() { if (invalidate) deliver.delete(invalidate); },
        };
    });
    return {
        fail(code = 'service_transport_unavailable') { failureCode = code; },
        async publish(next: typeof value) {
            value = next;
            await vi.waitFor(() => expect(deliver.size).toBeGreaterThan(0));
            await act(async () => { for (const invalidate of deliver) invalidate(); });
        },
        get reads() { return reads; },
        readValues,
    };
}

it.each([undefined, 'web'])('reads only the requested Environment services (composeService=%s) and follows genuine changes', async composeService => {
    // QA-DEPLOY-PERF-1109 measured M7 / Environment S3 / selected log service S1.
    const environmentId = 'serving-environment';
    const rows = ['web', 'worker', 'database'].map(name => service(name, { authority: 'project', environmentId,
        deployment: { deploymentId: 'deployment', installationId: 'installation', service: {
            kind: 'deployment', machineId, environmentId, environmentInstanceId: 'instance', composeService: name,
            serviceId: `instance/${name}` } }, serviceId: `instance/${name}` }));
    const unrelated = Array.from({ length: 4 }, (_, index) => service(`unrelated-${index}`, { environmentId: 'other-environment' }));
    const initial = MachineServicesListResultV1Schema.parse({ kind: 'snapshot', services: [...rows, ...unrelated] });
    if (initial.kind !== 'snapshot') throw new Error('Expected a Services snapshot');
    const resource = answerResource<ReturnType<typeof MachineServicesListResultV1Schema.parse>>(initial, 'machines.services.list', (value, reference) => {
        if (value.kind !== 'snapshot' || reference.hostRead !== 'machines.services.list') return value;
        const selection = reference.input;
        return { ...value, services: value.services.filter(row => (!selection.environmentId || row.environmentId === selection.environmentId)
            && (!selection.composeService || row.deployment?.service.composeService === selection.composeService)) };
    });
    const { useMachineServicesList } = await import('./useMachineServicesList');
    const input = { serverId, machineId, environmentId, composeService, active: true };
    const publications: unknown[] = [];
    const hook = await renderHook((selection: typeof input) => {
        const list = useMachineServicesList(selection);
        React.useEffect(() => { if (list.rows) publications.push(list.rows); }, [list.rows]);
        return list;
    }, { initialProps: input });
    const shown = composeService ? 1 : 3;
    try {
        await waitForHomeGovernance(async () => { await flushHookEffects(); expect(hook.getCurrent().pending).toBe(false); });
        expect(resource.reads).toBe(1);
        expect(resource.readValues.flatMap(value => value.kind === 'snapshot' ? value.services : [])).toHaveLength(shown);
        expect(hook.getCurrent().rows).toHaveLength(shown);
        expect(hook.getCurrent()).toHaveProperty('firstInventoryCount', shown);
        const settled = hook.getCurrent().rows;
        publications.length = 0;
        // This boundary deliberately emits an invalidation even for equal bytes.
        // Hints require a canonical reread; the daemon owns suppressing unrelated changes.
        await resource.publish(initial);
        await flushHookEffects();
        expect(resource.reads).toBe(2);
        expect(resource.readValues.flatMap(value => value.kind === 'snapshot' ? value.services : [])).toHaveLength(shown * 2);
        expect(publications).toHaveLength(0);
        expect(hook.getCurrent().rows).toBe(settled);
        await resource.publish({ ...initial, services: initial.services.map(row => row.serviceId === 'instance/web'
            ? { ...row, state: 'stopped' } : row) });
        await vi.waitFor(async () => { await flushHookEffects(); expect(hook.getCurrent().rows?.[0]?.state).toBe('stopped'); });
        expect(resource.readValues.flatMap(value => value.kind === 'snapshot' ? value.services : [])).toHaveLength(shown * 3);
        expect(publications).toHaveLength(1);
        if (!composeService) expect(hook.getCurrent().rows?.[1]).toBe(settled?.[1]);
        await hook.rerender({ ...input, composeService: 'worker' });
        await vi.waitFor(async () => { await flushHookEffects(); expect(hook.getCurrent().rows?.map(row => row.serviceId)).toEqual(['instance/worker']); });
        expect(hook.getCurrent()).toHaveProperty('firstInventoryCount', 1);
        expect(resource.readValues.flatMap(value => value.kind === 'snapshot' ? value.services : [])).toHaveLength(shown * 3 + 1);
    } finally { await hook.unmount(); }
});

it('SV-C15 carries the Resource refusal metadata through the Services list hook', async () => {
    const resource = answerResource(MachineServicesListResultV1Schema.parse({ kind: 'snapshot', services: [] }));
    resource.fail('credential_scope_denied');
    const { useMachineServicesList } = await import('./useMachineServicesList');
    const hook = await renderHook(() => useMachineServicesList({ serverId, machineId, active: true }));
    try {
        await vi.waitFor(async () => { await flushHookEffects(); expect(hook.getCurrent().error).not.toBeNull(); });
        expect(hook.getCurrent().error).toMatchObject({ code: 'credential_scope_denied', retryable: false, details: { layer: 'transport', phase: 'invocation' } });
    } finally { await hook.unmount(); }
});

it('shows a watched service in Machine Overview from the same live Resource as Services', async () => {
    // QA-B B21: the Machine inventory metadata had no usable watch, but its admitted Services list did.
    const watchId = '38e09b4f-a87e-4fe2-8a27-1e968d0bce9a';
    const row = service('happier-qa-b-orch1520-fixture.service', {
        serviceId: watchId, watchId, lifecyclePurpose: 'infrastructure',
        identity: { kind: 'adopted', machineId, serviceId: watchId, watchId, watchRevision: 'revision-a' },
        nativeInstance: { adapter: { pluginId: 'happier.machine.services', localId: 'systemd' },
            nativeResourceId: 'user/happier-qa-b-orch1520-fixture.service' },
    });
    const resource = answerResource(MachineServicesListResultV1Schema.parse({ kind: 'snapshot', services: [row] }),
        'machines.services.list', (value, reference) => {
            expect(reference).toEqual({ hostRead: 'machines.services.list', input: { serverId, machineId } });
            return value;
        });
    const { useManagedInventory } = await import('@/components/store/inventory/useManagedInventory');
    const { InboxArtifactSourceBoundary } = await import('@/hooks/inbox/useInboxArtifactSource');
    const { useMachineServicesList } = await import('./useMachineServicesList');
    const scope = { serverId, accountId };
    const query = { scope, machine: { serverIdentityId, machineId }, projectKey: null, presented: true,
        kinds: ['watchedService'] as const };
    const hook = await renderHook(() => ({
        overview: useManagedInventory(query).operationalFamilies.watchedService,
        services: useMachineServicesList({ serverId, machineId, active: true }),
    }), { wrapper: InboxArtifactSourceBoundary });
    try {
        await vi.waitFor(() => expect(hook.getCurrent().services.rows?.map(service => service.serviceId)).toEqual([watchId]));
        await vi.waitFor(() => expect(hook.getCurrent().overview.rows.map(watch => watch.native.watchId)).toEqual([watchId]));
        expect(resource.reads).toBe(1);

        await resource.publish({ kind: 'snapshot', services: [] });
        await vi.waitFor(() => expect(hook.getCurrent().overview.rows).toEqual([]));
        expect(hook.getCurrent().services.rows).toEqual([]);
        expect(resource.reads).toBe(2);

        await resource.publish({ kind: 'snapshot', services: [row] });
        await vi.waitFor(() => expect(hook.getCurrent().overview.rows.map(watch => watch.native.watchId)).toEqual([watchId]));
        expect(hook.getCurrent().services.rows?.map(service => service.serviceId)).toEqual([watchId]);
        expect(resource.reads).toBe(3);
    } finally { await hook.unmount(); }
});

it('opens Overview inventory with one Services acquisition and no Account Check subscriptions', async () => {
    const row = service('Overview watch');
    const resource = answerResource(MachineServicesListResultV1Schema.parse({ kind: 'snapshot', services: [row] }));
    const { MachineInventoryBlock } = await import('@/components/machines/page/MachineInventoryBlock');
    const subscriptions = vi.spyOn(await import('@/sync/domains/state/storageSubscriptions'), 'subscribeStoragePaths');
    const screen = await renderScreen(<AccountNoticeInvestigationBoundary>
        <MachineInventoryBlock serverId={serverId} machineId={machineId} scope={{ serverId, accountId }} />
    </AccountNoticeInvestigationBoundary>);
    try {
        await vi.waitFor(() => expect(resource.reads).toBe(1));
        const checkAcquisitions = subscriptions.mock.calls.filter(([paths]) => paths.some(path =>
            path[0] === 'state' && (path[1] === 'automations' || path[1] === 'automationDefinitionNextCursor')));
        expect(checkAcquisitions).toHaveLength(0);
    } finally {
        subscriptions.mockRestore();
        await screen.unmount();
    }
});

it('retains settled Services during credential resolution, publishes changes once and retires another Account\'s rows', async () => {
    const row = service('Continuity');
    const stableRow = service('Unchanged');
    const resource = answerResource(MachineServicesListResultV1Schema.parse({ kind: 'snapshot', services: [row, stableRow] }));
    const { useMachineServicesList } = await import('./useMachineServicesList');
    const publications: unknown[] = [];
    const hook = await renderHook(() => {
        const list = useMachineServicesList({ serverId, machineId, active: true });
        React.useEffect(() => { publications.push(list.rows); }, [list.rows]);
        return list;
    });
    try {
        await vi.waitFor(async () => { await flushHookEffects(); expect(hook.getCurrent().rows).toHaveLength(2); });
        expect(hook.getCurrent()).toHaveProperty('firstInventoryCount', 2);
        const settled = hook.getCurrent().rows;
        publications.length = 0;
        await act(async () => { await homes.switchAccount(serverId, accountId, { currentAccount: true }); });
        await vi.waitFor(async () => { await flushHookEffects(); expect(hook.getCurrent().pending).toBe(false); });
        expect(publications).toHaveLength(0);
        expect(hook.getCurrent().rows).toBe(settled);
        expect(hook.getCurrent()).toHaveProperty('firstInventoryCount', 2);
        await resource.publish(MachineServicesListResultV1Schema.parse({ kind: 'snapshot',
            services: [{ ...row, name: 'Changed continuity' }, stableRow] }));
        await vi.waitFor(async () => { await flushHookEffects(); expect(hook.getCurrent().rows?.[0]?.name).toBe('Changed continuity'); });
        expect(publications).toHaveLength(1);
        expect(hook.getCurrent().rows?.[1]).toBe(settled?.[1]);
        await act(async () => { await homes.switchAccount(serverId, 'another-account', { currentAccount: true }); });
        expect(hook.getCurrent().rows).toBeNull();
        expect(hook.getCurrent()).toHaveProperty('firstInventoryCount', null);
    } finally { await hook.unmount(); }
});

/** The words a rendered node draws, joined. */
function textOf(node: { children: readonly unknown[] }): string {
    return node.children.map(child => typeof child === 'string' ? child : textOf(child as { children: readonly unknown[] })).join('');
}

async function mount(options: Readonly<{ online?: boolean; params?: MachinePageTabParams; serverId?: string }> = {}) {
    const setParams = vi.fn();
    // The Machine page shell's presence fact, which the tab consumes as `online`.
    let setPresence: (online: boolean) => void = () => {};
    function Route() {
        const [params, update] = React.useState<MachinePageTabParams>(options.params ?? { id: 'services' });
        const [online, setOnline] = React.useState(options.online ?? true);
        setPresence = setOnline;
        return <MachineServicesTab serverId={options.serverId ?? serverId} machineId={machineId} machineName={machineName}
            online={online} params={params} setParams={next => { setParams(next); update(next); }} />;
    }
    // The Machine page shell presents its tabs as a page, which is where the page sentence and its action show.
    const screen = await renderScreen(<AccountNoticeInvestigationBoundary><ListPresentationProvider value="page"><Route /></ListPresentationProvider></AccountNoticeInvestigationBoundary>);
    await measureMountedCollections(screen);
    return { screen, setParams, goOffline: async () => { await act(async () => { setPresence(false); }); } };
}

beforeEach(async () => {
    await homes.reset();
    machineTransport.rpc.mockReset();
    custodianAccountId = accountId;
    await initializeRealAppRuntimeForTests();
    installHomeGovernanceBoundaries(homes);
    resourceSocket = installHostResourceWatchSocket(reference => {
        const actionId = resolvePluginUiHostReadActionIdV1(reference.hostRead);
        const selectWatch = resourceWatches.get(actionId);
        if (!selectWatch) throw new Error(`Unexpected Resource watch: ${actionId}`);
        return selectWatch(reference);
    });
    serverId = await homes.addHome({ name: 'Services rendered', serverUrl: 'https://services-rendered.test',
        serverIdentityId, accountId, currentAccount: true, active: true });
    await sodium.ready;
    const installationKey = sodium.crypto_sign_seed_keypair(new Uint8Array(32).fill(23));
    const machine = createHydratedPlainMachineFixture({ id: machineId, accountId, machine: { activeAt: Date.now(),
        isShared: false, installationId: 'installation', installationPublicKey: encodeBase64(installationKey.publicKey, 'base64') } });
    const row = createPlainMachineRowFixture({ id: machineId, accountId, machine });
    homes.answer(serverId, 'POST /v1/machines/read-batch', { select: async input => ({ body:
        await createMachineReadBatchResponseFixture(input, () => row).json() }) });
    const { TokenStorage } = await import('@/auth/storage/tokenStorage');
    const { restoreConnectionToActiveServer } = await import('@/sync/runtime/orchestration/connectionManager');
    const credentials = await TokenStorage.getCredentialsForServerUrl('https://services-rendered.test', { serverId });
    if (!credentials) throw new Error('Services Home credentials unavailable');
    await restoreConnectionToActiveServer(credentials);
    await act(async () => { await publishMachineInventoryForTest({ serverId, accountId }, [machine]); });
    vi.mocked(router.push).mockClear();
});
afterEach(async () => {
    standardCleanup();
    resourceSocket?.mockRestore();
    resourceWatches.clear();
    await homes.reset();
});

it('offers only executable current services when setting up a scheduled Environment job', () => withPopoverWebGlobals(async () => {
    const environmentId = 'production';
    const executable = service('Worker', { environmentId });
    const unsupported = service('Database', { environmentId,
        capabilities: { exec: false, start: true, stop: true, restart: true, logs: true, accounting: true } });
    const unresolved = service('Replacing worker', { environmentId, generation: null });
    const resource = answerResource(MachineServicesListResultV1Schema.parse({ kind: 'snapshot',
        services: [executable, unsupported, unresolved] }), 'machines.services.list', (value, reference) => {
        expect(reference.input).toMatchObject({ serverId, machineId, environmentId });
        return value;
    });
    const { ScheduledServiceJobSetup } = await import('@/components/workflows/triggers/ScheduledServiceJobSetup');
    const anchorRef = { current: null };
    const screen = await renderScreen(<ScheduledServiceJobSetup anchorRef={anchorRef} onRequestClose={() => {}}
        serverId={serverId} machineId={machineId} environmentId={environmentId}
        project={{ machineId, directory: '~' }} />);
    try {
        await act(async () => reportPopoverContentLayout(screen.tree, { width: 500, height: 600 }));
        await vi.waitFor(async () => {
            await flushHookEffects();
            expect(screen.findHostByTestId(`scheduled-service-job-service-${executable.serviceId}`)).not.toBeNull();
        });
        expect(screen.findHostByTestId(`scheduled-service-job-service-${unsupported.serviceId}`)).toBeNull();
        expect(screen.findHostByTestId(`scheduled-service-job-service-${unresolved.serviceId}`)).toBeNull();
        expect(resource.reads).toBe(1);
    } finally { await screen.unmount(); }
}));

it('opens a scheduled Environment service job through the subject starter', () => withPopoverWebGlobals(async () => {
    const environmentId = 'production';
    homes.answer(serverId, 'POST /v3/automations/query', { select: input => {
        expect(input).toMatchObject({ subject: { kind: 'environment', serverId, environmentId } });
        return { body: { automations: [], attached: [], nextCursor: null, skippedNotSharedCount: 0 } };
    } });
    const executable = service('Worker', { environmentId });
    answerResource(MachineServicesListResultV1Schema.parse({ kind: 'snapshot', services: [executable] }));
    const { SubjectTriggersSection } = await import('@/components/workflows/triggers/SubjectTriggersSection');
    const { ActionInputFields } = await import('@/components/sessions/actions/ActionInputFields');
    const screen = await renderScreen(<SubjectTriggersSection
        subject={{ kind: 'environment', machineId, environmentId }} subjectName="Production"
        deploymentEnvironment={{ serverId, projectSourceId: 'application', environmentId }} />);
    try {
        await vi.waitFor(async () => {
            await flushHookEffects();
            expect(screen.findHostByTestId('subject-triggers-starter:scheduledJob')).not.toBeNull();
        });
        await screen.pressByTestIdAsync('subject-triggers-starter:scheduledJob');
        await act(async () => reportPopoverContentLayout(screen.tree, { width: 500, height: 600 }));
        await vi.waitFor(async () => {
            await flushHookEffects();
            expect(screen.findHostByTestId(`scheduled-service-job-service-${executable.serviceId}`)).not.toBeNull();
        });
        await screen.pressByTestIdAsync(`scheduled-service-job-service-${executable.serviceId}`);
        await act(async () => reportPopoverContentLayout(screen.tree, { width: 500, height: 600 }));
        await vi.waitFor(() => expect(screen.findAllByType(ActionInputFields)).toHaveLength(1));
        expect(screen.findByType(ActionInputFields).props.input).toMatchObject({ serverId, machineId,
            target: { kind: 'current', serviceId: executable.serviceId, expectedGeneration: executable.generation },
            mode: 'exec', argv: [],
        });
        expect(homes.requests.some(request => request.method === 'POST' && request.path === '/v3/automations')).toBe(false);
    } finally { await screen.unmount(); }
}));

describe('MachineServicesTab rendered production wiring', () => {
    it.each(['deployment', 'adopted'] as const)('investigates an unhealthy %s service using its admitted identity through Triage', async kind => {
        const identity = kind === 'deployment'
            ? { kind, machineId, environmentId: 'production', environmentInstanceId: 'instance-a', composeService: 'api', serviceId: 'instance-a/api' }
            : { kind, machineId, serviceId: 'opaque-watched-service', watchId: 'watch-a', watchRevision: 'watch-revision-a' };
        const row = service('API', { serviceId: identity.serviceId, identity, state: 'unhealthy',
            capabilities: { start: false, stop: false, restart: false, logs: false, accounting: false } });
        answerResource(MachineServicesListResultV1Schema.parse({ kind: 'snapshot', services: [row] }));
        machineTransport.rpc.mockResolvedValue({ kind: 'service', service: row });
        const { answerTriageFailureCatalogForHome } = await import('@/dev/testkit/harness/triageFailureActionBoundary');
        const { answerSourceDeclaredAccountPluginForHome, prepareSourceDeclaredAccountPluginsForTest } = await import('@/dev/testkit/harness/portableAccountPlugin');
        const { captureActiveServerAccountScopeLifetime } = await import('@/sync/domains/scope/activeServerAccountScope');
        const { TRIAGE_PLUGIN } = await import('../../../../../../packages/plugins/triage/src/definition');
        const { createTestkitAccountKv } = await import('../../../../../../packages/plugins/triage/src/settings/testkit/accountKv.test-support');
        const { administerTriageAction } = await import('../../../../../../packages/plugins/triage/src/actions/actionsCatalog');
        const { TRIAGE_ACTIONS_ACCOUNT_KV_KEY_V1 } = await import('../../../../../../packages/plugins/triage/src/settings/actions');
        const { prepareSessionDraftPersistenceStorage } = await import('@/sync/ops/sessionDrafts/sessionDraftPersistenceStorage');
        const { readNewSessionDraftFromRepository } = await import('@/components/sessions/composer/newSessionDraftRepositoryAdapter');
        const catalog = createTestkitAccountKv();
        const label = 'Investigate this service';
        const configured = await administerTriageAction({ v: 1, kind: 'update', actionId: 'investigate',
            expectedRevision: 'absent', label, enabled: true, appliesTo: ['other'], profileId: null,
            workspaceMode: 'reference_only', target: { kind: 'agent', promptInvocationId: null, delivery: 'compose' } },
        { catalog: catalog.catalog(TRIAGE_ACTIONS_ACCOUNT_KV_KEY_V1), mintActionId: () => 'investigate' });
        expect(configured.status).toBe('applied');
        const entry = await catalog.kv.get(TRIAGE_ACTIONS_ACCOUNT_KV_KEY_V1);
        if (!entry) throw new Error('Expected a configured Triage catalog row');
        answerSourceDeclaredAccountPluginForHome(homes, serverId, TRIAGE_PLUGIN.manifest.id);
        const catalogPath = answerTriageFailureCatalogForHome(homes, serverId, entry, Promise.resolve());
        const lifetime = captureActiveServerAccountScopeLifetime();
        if (!lifetime) throw new Error('Expected Services Account');
        const homeId = lifetime.scope.serverId;
        const installTriage = await prepareSourceDeclaredAccountPluginsForTest([{ manifest: TRIAGE_PLUGIN.manifest,
            activate: TRIAGE_PLUGIN.activateAccount, packageName: '@happier-dev/plugins-triage' }]);
        await prepareSessionDraftPersistenceStorage();
        const installed = await installTriage({ accountLifetime: lifetime, publishProjection: true });
        let screen: Awaited<ReturnType<typeof mount>>['screen'] | undefined;
        try {
            ({ screen } = await mount({ serverId: homeId, params: { id: 'services', page: 'service', service: row.serviceId } }));
            const button = await waitForHomeGovernance(() => {
                expect(homes.requestsFor(catalogPath)).toContainEqual(expect.objectContaining({
                    method: 'GET', serverUrl: 'https://services-rendered.test',
                }));
                expect(screen!.findAllByType(AgentActionButton)).toHaveLength(1);
                const action = screen!.findByType(AgentActionButton);
                expect(action.props.title).toBe(label);
                expect(action.props.launchMode).toBe('review');
                return action;
            });
            await act(async () => { button.props.onLaunch(button.props.launchMode); });
            const draftId = await waitForHomeGovernance(() => {
                const route = vi.mocked(router.push).mock.calls.find(([href]) =>
                    typeof href === 'object' && href.pathname === '/new')?.[0];
                const draftId = typeof route === 'object' ? route.params?.draftId : undefined;
                if (typeof draftId !== 'string') throw new Error('Expected investigation to open its New Session draft');
                return draftId;
            });
            const draft = readNewSessionDraftFromRepository({ scope: lifetime.scope, draftId });
            const evidence = readSessionInputForgeEvidenceAttachmentV1(draft?.composerAttachmentSeeds?.[0]?.value.value);
            expect(evidence?.items.map(item => JSON.parse(item.text))).toEqual([{
                subject: { kind: 'service', target: { kind: 'host', page: 'machine_service', machine: { serverId: homeId, machineId }, service: identity } },
                read: { actionId: 'machines.services.detail', input: { serverId: homeId, machineId, serviceId: identity.serviceId } },
            }]);
        } finally {
            await screen?.unmount();
            await installed.dispose();
        }
    });

    it.each(['healthy', 'running', 'missingIdentity', 'expectedStop'] as const)('offers no investigation for %s service data', async scenario => {
        const row = service('API', { state: scenario === 'missingIdentity' || scenario === 'expectedStop' ? 'unhealthy' : scenario,
            ...(scenario === 'missingIdentity' ? {} : { identity: { kind: 'adopted', machineId,
                serviceId: 'api', watchId: 'watch-API', watchRevision: 'revision-a' } }),
            ...(scenario === 'expectedStop' ? { health: { status: 'down', observedAtMs: Date.now(), freshness: 'current', expectedDown: 'stop' } } : {}),
            capabilities: { start: false, stop: false, restart: false, logs: false, accounting: false } });
        answerResource(MachineServicesListResultV1Schema.parse({ kind: 'snapshot', services: [row] }));
        machineTransport.rpc.mockResolvedValue({ kind: 'service', service: row });
        const { screen } = await mount({ params: { id: 'services', page: 'service', service: row.serviceId } });
        await vi.waitFor(() => expect(screen.findHostByTestId('machine-service-facts')).not.toBeNull());
        expect(screen.findAllByType(AgentActionButton)).toHaveLength(0);
    });

    it('retains settled Services detail and the open Automation sentence during credential resolution', () => withPopoverWebGlobals(async () => {
        const row = service('Continuity', { capabilities: { start: true, stop: true, restart: true, logs: false, accounting: false } });
        answerResource(MachineServicesListResultV1Schema.parse({ kind: 'snapshot', services: [row] }));
        machineTransport.rpc.mockResolvedValue({ kind: 'service', service: row });
        const { screen } = await mount({ params: { id: 'services', page: 'service', service: row.serviceId } });
        try {
            await vi.waitFor(() => expect(screen.findHostByTestId('subject-triggers-add')).not.toBeNull());
            await screen.pressByTestIdAsync('subject-triggers-add');
            await act(async () => reportPopoverContentLayout(screen.tree, { width: 500, height: 600 }));
            await vi.waitFor(() => expect(screen.findHostByTestId('workflow-builder-open-editor')).not.toBeNull());
            const loadingPublications: unknown[] = [];
            const stepReplacements: unknown[] = [];
            const unsubscribe = screen.tree.subscribe(() => {
                if (screen.findHostByTestId('machine-service-loading')) loadingPublications.push(true);
                if (!screen.findByTestId('workflow-builder-open-editor')) stepReplacements.push(true);
            });
            try {
                await act(async () => { await homes.switchAccount(serverId, accountId, { currentAccount: true }); });
                await vi.waitFor(async () => { await flushHookEffects(); expect(screen.findHostByTestId('subject-triggers-add')).not.toBeNull(); });
                expect(loadingPublications).toHaveLength(0);
                expect(stepReplacements).toHaveLength(0);
                expect(screen.findByTestId('workflow-builder-open-editor')).not.toBeNull();
            } finally { unsubscribe(); }
        } finally { await screen.unmount(); }
    }));

    it('keeps the exact unavailable Stop refusal typed with a recovery step', async () => {
        const row = service('Web', { generation: 'b1c428a4-7926-46de-b6cd-71a59d6ebc3c', state: 'healthy' });
        answerResource(MachineServicesListResultV1Schema.parse({ kind: 'snapshot', services: [row] }));
        const controls: unknown[] = [];
        let issuedRequestId: string | undefined;
        answerActionExecution('machines.services.control', envelope => {
            controls.push(envelope.input);
            issuedRequestId = envelope.requestId;
            return { ok: false, errorCode: 'native_effect_failed', error: 'native_effect_failed', requestId: envelope.requestId, effectAttempted: false, details: { reason: 'service_operation_unavailable' } };
        });
        machineTransport.rpc.mockImplementation(async ({ method }: { method: string }) => {
            if (method === RPC_METHODS.MACHINES_SERVICE_DETAIL) return { kind: 'service', service: row };
            throw new Error(`Unexpected Machine method: ${method}`);
        });
        const { screen } = await mount({ params: { id: 'services', page: 'service', service: row.serviceId } });
        await vi.waitFor(() => expect(screen.findHostByTestId('machine-service-facts')).not.toBeNull());
        await vi.waitFor(() => expect(screen.findHostByTestId('machine-service-more')).not.toBeNull());
        await screen.pressByTestIdAsync('machine-service-more');
        await vi.waitFor(() => expect(screen.findHostByTestId('machine-service-stop')).not.toBeNull());
        await screen.pressByTestIdAsync('machine-service-stop');
        await vi.waitFor(() => expect(controls).toEqual([{ serverId, machineId,
            serviceId: row.serviceId, expectedGeneration: row.generation, operation: 'stop' }]));
        await vi.waitFor(() => expect(screen.findHostByTestId('machine-service-control-outcome-details-toggle'), screen.getTextContent()).not.toBeNull());
        expect(screen.getTextContent()).toContain(t('errors.machineNativeEffectFailed'));
        expect(screen.getTextContent()).not.toContain(t('machineServices.control.failed', { service: row.name }));
        await screen.pressByTestIdAsync('machine-service-control-outcome-details-toggle');
        expect(screen.getTextContent()).toContain('native_effect_failed');
        expect(issuedRequestId).toBeTruthy();
        expect(screen.getTextContent()).toContain(issuedRequestId!);
        expect(controls).toHaveLength(1);
    });

    async function shareWith(role: 'manage' | 'use') {
        await sodium.ready;
        custodianAccountId = 'owner';
        const machine = createMachineFixture({ id: machineId, activeAt: Date.now(), isShared: true,
            access: { role, resourceMode: 'plain', accessState: 'ready', custodian: { accountId: 'owner', displayName: 'Owner' } } });
        const installationKey = sodium.crypto_sign_seed_keypair(new Uint8Array(32).fill(23));
        const row = { ...createPlainMachineRowFixture({ id: machineId, accountId: 'owner', machine }),
            installationId: 'installation', installationPublicKey: encodeBase64(installationKey.publicKey, 'base64') };
        homes.answer(serverId, 'POST /v1/machines/read-batch', { select: async input => ({ body:
            await createMachineReadBatchResponseFixture(input, () => row).json() }) });
        await act(async () => storage.getState().applyMachines([machine], true, { sourceServerId: serverId }));
        await act(async () => { await publishMachineInventoryForTest({ serverId, accountId }, [machine]); });
    }

    it.each([
        ['manage', 'deployment'], ['use', 'deployment'], ['manage', 'watched'], ['use', 'watched'],
    ] as const)('offers bound Service entries only to Manage (%s, %s)', async (role, target) => {
        await shareWith(role);
        const row = service('Web', target === 'deployment' ? { authority: 'project', lifecyclePurpose: 'deployment',
            environmentId: 'environment-staging', watchId: undefined, watchRevision: undefined } : {});
        answerResource(MachineServicesListResultV1Schema.parse({ kind: 'snapshot', services: [row] }));
        machineTransport.rpc.mockResolvedValue({ kind: 'service', service: row });
        const { screen } = await mount({ params: { id: 'services', page: 'service', service: row.serviceId } });
        await vi.waitFor(() => expect({ text: screen.getTextContent(), page: screen.findHostByTestId('machine-service-state') !== null })
            .toMatchObject({ page: true }));
        await vi.waitFor(() => expect(screen.findHostByTestId('machine-service-more')).not.toBeNull());
        await screen.pressByTestIdAsync('machine-service-more');
        await vi.waitFor(() => expect(screen.findHostByTestId('machine-service-facts')).not.toBeNull());
        await vi.waitFor(() => {
            for (const id of ['machine-service-command', 'machine-service-shell', 'machine-service-unwatch']) {
                // Command and Shell follow the row's admitted exec capability, watched or deployed alike.
                const supportedTarget = id === 'machine-service-unwatch' ? target === 'watched' : true;
                if (role === 'manage' && supportedTarget) expect(screen.findHostByTestId(id), id).not.toBeNull();
                else expect(screen.findHostByTestId(id), id).toBeNull();
            }
        });
        // Merely opening the menu never executes a command or opens a terminal.
        expect(machineTransport.rpc.mock.calls.some(([call]) =>
            call.method === RPC_METHODS.MACHINES_SERVICE_EXEC || call.method === RPC_METHODS.DAEMON_TERMINAL_ENSURE)).toBe(false);
        expect(homes.requests.some(request => request.path === '/v1/actions/machines.services.exec'
            || request.path === '/v1/actions/machines.terminal.open' || request.path === '/v1/actions/machines.services.unwatch')).toBe(false);
    });

    it.each(['offline', 'missing-generation', 'not-watched', 'watched', 'no-exec'] as const)('keeps Service entries bound to the available operands (%s)', async condition => {
        await shareWith('manage');
        const row = service('Web', condition === 'missing-generation' ? { generation: null }
            : condition === 'not-watched' ? { authority: 'project', environmentId: 'environment-staging',
                watchId: undefined, watchRevision: undefined }
            : condition === 'no-exec' ? { capabilities: { start: true, stop: true, restart: true, logs: true, accounting: true } } : {});
        answerResource(MachineServicesListResultV1Schema.parse({ kind: 'snapshot', services: [row] }));
        machineTransport.rpc.mockResolvedValue({ kind: 'service', service: row });
        const { screen } = await mount({ online: condition !== 'offline',
            params: { id: 'services', page: 'service', service: row.serviceId } });
        await vi.waitFor(() => expect(screen.findHostByTestId('machine-service-state')).not.toBeNull());
        if (condition === 'offline') {
            expect(screen.findHostByTestId('machine-service-more')).toBeNull();
            return;
        }
        await screen.pressByTestIdAsync('machine-service-more');
        await vi.waitFor(() => {
            const exec = condition === 'not-watched' || condition === 'watched';
            expect(screen.findHostByTestId('machine-service-command') !== null).toBe(exec);
            expect(screen.findHostByTestId('machine-service-shell') !== null).toBe(exec);
            expect(screen.findHostByTestId('machine-service-unwatch') !== null).toBe(condition !== 'not-watched');
        });
    });

    it('submits literal command arguments once through the real Action', async () => {
        await shareWith('manage');
        const row = service('Web', { authority: 'project', lifecyclePurpose: 'deployment', environmentId: 'environment-staging',
            watchId: undefined, watchRevision: undefined });
        answerResource(MachineServicesListResultV1Schema.parse({ kind: 'snapshot', services: [row] }));
        const commands: unknown[] = [];
        answerAction('machines.services.exec', envelope => {
            commands.push(envelope.input);
            return { kind: 'outcome_unknown' };
        });
        machineTransport.rpc.mockImplementation(async ({ method, payload }) => {
            if (method === RPC_METHODS.MACHINES_SERVICE_EXEC) {
                commands.push(payload);
                return { kind: 'outcome_unknown' };
            }
            return { kind: 'service', service: row };
        });
        const { screen } = await mount({ params: { id: 'services', page: 'service', service: row.serviceId } });
        await vi.waitFor(() => expect(screen.findHostByTestId('machine-service-more')).not.toBeNull());
        await screen.pressByTestIdAsync('machine-service-more');
        await vi.waitFor(() => expect(screen.findHostByTestId('machine-service-command')).not.toBeNull());
        await screen.pressByTestIdAsync('machine-service-command');
        await vi.waitFor(() => expect(vi.mocked(Modal.show).mock.calls.at(-1)?.[0]?.props).toMatchObject({
            serverId, machineId, target: { kind: 'current', serviceId: row.serviceId, expectedGeneration: row.generation },
        }));
        const config = vi.mocked(Modal.show).mock.calls.at(-1)?.[0];
        // The modal is the platform presentation boundary; render its captured real sheet and bound operands.
        const sheetProps = config?.props as ServiceCommandSheetProps;
        expect(sheetProps).toMatchObject({ serverId, machineId,
            target: { kind: 'current', serviceId: row.serviceId, expectedGeneration: row.generation } });
        const { ServiceCommandSheet } = await import('./command/ServiceCommandSheet');
        const commandScreen = await renderScreen(<ServiceCommandSheet {...sheetProps} />);
        try {
            commandScreen.changeTextByTestId('service-command.input', "printf '%s' 'literal; $(not-a-shell)'");
            await vi.waitFor(() => expect(commandScreen.findHostByTestId('service-command.run')?.props.accessibilityState?.disabled).toBe(false));
            await commandScreen.pressByTestIdAsync('service-command.run');
            await vi.waitFor(() => expect(commands).toEqual([{ serverId, machineId,
                target: { kind: 'current', serviceId: row.serviceId, expectedGeneration: row.generation },
                mode: 'exec', argv: ['printf', '%s', 'literal; $(not-a-shell)'] }]));
            await vi.waitFor(() => expect(commandScreen.findHostByTestId('service-command.unknown')).not.toBeNull());
        } finally { await commandScreen.unmount(); }
        // Unknown dispatch remains explicit and closing the sheet never replays it.
        expect(commands).toHaveLength(1);
    });

    it('unwatches the exact revision through the real Action', async () => {
        await shareWith('manage');
        const row = service('Web');
        answerResource(MachineServicesListResultV1Schema.parse({ kind: 'snapshot', services: [row] }));
        const unwatches: unknown[] = [];
        answerAction('machines.services.unwatch', envelope => {
            unwatches.push(envelope.input);
            return { kind: 'applied', revision: 'revision-b' };
        });
        const { screen } = await mount({ params: { id: 'services', page: 'service', service: row.serviceId } });
        await vi.waitFor(() => expect(screen.findHostByTestId('machine-service-more')).not.toBeNull());
        await screen.pressByTestIdAsync('machine-service-more');
        await vi.waitFor(() => expect(screen.findHostByTestId('machine-service-unwatch')).not.toBeNull());
        await screen.pressByTestIdAsync('machine-service-unwatch');
        await vi.waitFor(() => expect(unwatches).toEqual([{ serverId, machineId,
            watchId: row.watchId, expectedRevision: row.watchRevision }]));
    });

    it('opens the existing terminal sheet with the exact typed service-shell launch', async () => {
        await shareWith('manage');
        const row = service('Web', { authority: 'project', lifecyclePurpose: 'deployment', environmentId: 'environment-staging',
            watchId: undefined, watchRevision: undefined });
        answerResource(MachineServicesListResultV1Schema.parse({ kind: 'snapshot', services: [row] }));
        machineTransport.rpc.mockResolvedValue({ kind: 'service', service: row });
        const { screen } = await mount({ params: { id: 'services', page: 'service', service: row.serviceId } });
        await vi.waitFor(() => expect(screen.findHostByTestId('machine-service-more')).not.toBeNull());
        await screen.pressByTestIdAsync('machine-service-more');
        await vi.waitFor(() => expect(screen.findHostByTestId('machine-service-shell')).not.toBeNull());
        await screen.pressByTestIdAsync('machine-service-shell');
        await vi.waitFor(() => expect(vi.mocked(Modal.show).mock.calls.at(-1)?.[0]?.chrome?.testID).toBe('machine-terminal-modal'));
        const config = vi.mocked(Modal.show).mock.calls.at(-1)?.[0];
        expect(config?.chrome?.testID).toBe('machine-terminal-modal');
        expect(config?.props).toMatchObject({ serverId, machineId,
            launch: { kind: 'service_shell', serviceId: row.serviceId, expectedGeneration: row.generation } });
        expect(config?.props).not.toHaveProperty('machineShell');
    });

    it('runs a command and opens a shell in the chosen member of a watched Compose project', async () => {
        await shareWith('manage');
        const row = service('Shop', { native: { phase: 'running', readiness: 'ready', composeServices: ['web', 'worker'] } });
        answerResource(MachineServicesListResultV1Schema.parse({ kind: 'snapshot', services: [row] }));
        const commands: unknown[] = [];
        answerAction('machines.services.exec', envelope => {
            commands.push(envelope.input);
            return { kind: 'outcome_unknown' };
        });
        machineTransport.rpc.mockImplementation(async ({ method, payload }) => {
            if (method === RPC_METHODS.MACHINES_SERVICE_EXEC) {
                commands.push(payload);
                return { kind: 'outcome_unknown' };
            }
            return { kind: 'service', service: row };
        });
        const { screen } = await mount({ params: { id: 'services', page: 'service', service: row.serviceId } });
        await vi.waitFor(() => expect(screen.findHostByTestId('machine-service-more')).not.toBeNull());
        await screen.pressByTestIdAsync('machine-service-more');
        await vi.waitFor(() => expect(screen.findHostByTestId('machine-service-command')).not.toBeNull());
        await screen.pressByTestIdAsync('machine-service-command');
        await vi.waitFor(() => expect(vi.mocked(Modal.show).mock.calls.at(-1)?.[0]?.props).toMatchObject({
            target: { kind: 'current', serviceId: row.serviceId, expectedGeneration: row.generation }, services: ['web', 'worker'],
        }));
        const sheetProps = vi.mocked(Modal.show).mock.calls.at(-1)?.[0]?.props as ServiceCommandSheetProps;
        const { ServiceCommandSheet } = await import('./command/ServiceCommandSheet');
        const commandScreen = await renderScreen(<ServiceCommandSheet {...sheetProps} />);
        try {
            // The picker offers exactly the watch's own members.
            expect(commandScreen.findHostByTestId('service-command.service:web')).not.toBeNull();
            expect(commandScreen.findHostByTestId('service-command.service:worker')).not.toBeNull();
            await commandScreen.pressByTestIdAsync('service-command.service:worker');
            commandScreen.changeTextByTestId('service-command.input', 'ls');
            await vi.waitFor(() => expect(commandScreen.findHostByTestId('service-command.run')?.props.accessibilityState?.disabled).toBe(false));
            await commandScreen.pressByTestIdAsync('service-command.run');
            await vi.waitFor(() => expect(commands).toEqual([{ serverId, machineId,
                target: { kind: 'current', serviceId: row.serviceId, expectedGeneration: row.generation, service: 'worker' },
                mode: 'exec', argv: ['ls'] }]));
        } finally { await commandScreen.unmount(); }

        await screen.pressByTestIdAsync('machine-service-more');
        await vi.waitFor(() => expect(screen.findHostByTestId('machine-service-shell')).not.toBeNull());
        // Several members: the Shell row's submenu (the menu owner's chooser) lists exactly the watch's members.
        // The submenu's measured anchor is a platform boundary, so the menu's own selection contract is driven.
        const menu = screen.tree.find(node => Array.isArray(node.props.items)
            && node.props.items.some((item: { id: string }) => item.id === 'shell') && typeof node.props.onSelect === 'function');
        const shellItem = menu.props.items.find((item: { id: string }) => item.id === 'shell');
        expect(shellItem.submenu.items.map((item: { id: string; title: string }) => [item.id, item.title]))
            .toEqual([['shell:web', 'web'], ['shell:worker', 'worker']]);
        await act(async () => { menu.props.onSelect('shell:worker'); });
        await vi.waitFor(() => expect(vi.mocked(Modal.show).mock.calls.at(-1)?.[0]?.props).toMatchObject({ serverId, machineId,
            launch: { kind: 'service_shell', serviceId: row.serviceId, expectedGeneration: row.generation, service: 'worker' } }));
    });

    it('stops an Environment service through the existing Action and follows its pushed stopped state', async () => {
        const row = service('Web', { authority: 'project', environmentId: 'environment-staging',
            capabilities: { start: true, stop: true, restart: true, logs: false, accounting: false } });
        const list = answerResource(MachineServicesListResultV1Schema.parse({ kind: 'snapshot', services: [row] }));
        const controls: unknown[] = [];
        answerAction('machines.services.control', envelope => {
            controls.push(envelope.input);
            return { kind: 'observed', serviceId: row.serviceId, generation: row.generation,
                state: 'stopped', operation: { operationId: 'stop-operation' } };
        });
        machineTransport.rpc.mockImplementation(async ({ method }) => {
            if (method === RPC_METHODS.MACHINES_SERVICE_DETAIL) return { kind: 'service', service: row };
            throw new Error(`Unexpected Machine method: ${String(method)}`);
        });
        const { screen } = await mount({ params: { id: 'services', page: 'service', service: row.serviceId } });
        await vi.waitFor(() => expect(screen.findHostByTestId('machine-service-facts')).not.toBeNull());
        await vi.waitFor(() => expect(screen.findHostByTestId('machine-service-more')).not.toBeNull());
        await vi.dynamicImportSettled();
        await screen.pressByTestIdAsync('machine-service-more');
        await vi.waitFor(() => expect(screen.findHostByTestId('machine-service-stop')).not.toBeNull());
        await screen.pressByTestIdAsync('machine-service-stop');
        await vi.dynamicImportSettled();
        await vi.waitFor(() => {
            const outcome = screen.findByTestId('machine-service-control-outcome');
            expect({ controls, outcome: outcome ? textOf(outcome) : null }).toEqual({
                controls: [{ serverId, machineId, serviceId: row.serviceId, expectedGeneration: row.generation, operation: 'stop' }],
                outcome: null,
            });
        });
        await list.publish(MachineServicesListResultV1Schema.parse({ kind: 'snapshot', services: [{ ...row, state: 'stopped' }] }));
        await vi.waitFor(() => expect(screen.findHostByTestId('machine-service-start')).not.toBeNull());
        expect(screen.findHostByTestId('machine-service-stop')).toBeNull();
    });

    it('reads the current Services list after remount and still receives a real change', async () => {
        const list = answerResource(MachineServicesListResultV1Schema.parse({ kind: 'snapshot', services: [service('Web')] }));
        let mounted = await mount();
        try {
            await vi.waitFor(() => expect(mounted.screen.findHostByTestId('machine-service-web')).not.toBeNull());
            expect(list.reads).toBe(1);
            await mounted.screen.unmount();
            mounted = await mount();
            await vi.waitFor(() => expect(mounted.screen.findHostByTestId('machine-service-web')).not.toBeNull());
            expect(list.reads, 'the last unmount releases the Resource; remount reads it once').toBe(2);
            await list.publish(MachineServicesListResultV1Schema.parse({ kind: 'snapshot', services: [service('Database')] }));
            await measureMountedCollections(mounted.screen);
            await vi.waitFor(() => expect(mounted.screen.findHostByTestId('machine-service-database')).not.toBeNull());
            expect(list.reads).toBe(3);
        } finally { await mounted.screen.unmount(); }
    });

    it('opens an admitted service row into its facts and redacted logs, then returns to the list', async () => {
        const row = service('Postgres', { port: 5432, nativeInstance: {
            adapter: { pluginId: 'happier.machine.services', localId: 'systemd' }, nativeResourceId: 'postgresql.service',
        }, native: { phase: 'running', readiness: 'ready', displayName: 'PostgreSQL service' } });
        answerResource(MachineServicesListResultV1Schema.parse({ kind: 'snapshot', services: [row] }));
        answerAction('machines.services.detail', () => ({ kind: 'service', service: row,
            accounting: { kind: 'sample', samples: [{ nativeResourceId: 'postgresql.service', cpuPercent: 3, memoryBytes: 64 * 1024 * 1024 }] } }));
        answerResource(ManagedServiceNativeLogResultV1Schema.parse({ kind: 'page', page: {
            sourceRevision: 'native-source', text: 'database ready [REDACTED]\n', nextCursor: null, truncated: false,
        } }), 'machines.services.logs.read');
        const { screen, setParams } = await mount();
        await vi.waitFor(() => expect(screen.findHostByTestId('machine-service-postgres')).not.toBeNull());
        expect(screen.getTextContent()).toContain(row.native!.displayName);
        expect(screen.getTextContent()).not.toContain(row.nativeInstance!.nativeResourceId);
        expect(screen.getTextContent()).toContain('5432');
        await screen.pressByTestIdAsync('machine-service-postgres');
        expect(setParams).toHaveBeenLastCalledWith({ id: 'services', page: 'service', service: 'postgres' });
        await vi.waitFor(() => expect(screen.getTextContent()).toContain('database ready [REDACTED]'));
        await vi.waitFor(() => expect(screen.getTextContent()).toContain('64 MiB'));
        expect(screen.findHostByTestId('machine-service-facts')).not.toBeNull();
        expect(screen.findHostByTestId('machine-service-restart')).not.toBeNull();
        await screen.pressByTestIdAsync('machine-service-back');
        await measureMountedCollections(screen);
        expect(setParams).toHaveBeenLastCalledWith({ id: 'services' });
        expect(screen.findHostByTestId('machine-service-postgres')).not.toBeNull();
    });

    it('says why a Can use person has no way to add a service, on the empty and the listed page', async () => {
        await shareWith('use');
        const list = answerResource(MachineServicesListResultV1Schema.parse({ kind: 'snapshot', services: [] }));
        const { screen } = await mount();
        await vi.waitFor(() => expect(screen.findHostByTestId('machine-services-empty')).not.toBeNull());
        expect(screen.findHostByTestId('machine-services-deploy-here')).toBeNull();
        expect(screen.findHostByTestId('machine-services-watch')).toBeNull();
        expect(screen.findHostByTestId('machine-services-recipient')).not.toBeNull();
        // Said once: where the action would be, not again in the page's lede.
        expect(screen.tree.findAll(node => typeof node.type === 'string' && node.props.testID === 'machine-services-recipient')).toHaveLength(1);
        await list.publish(MachineServicesListResultV1Schema.parse({ kind: 'snapshot', services: [service('Web')] }));
        await measureMountedCollections(screen);
        await vi.waitFor(() => expect(screen.findHostByTestId('machine-service-web')).not.toBeNull());
        expect(screen.findHostByTestId('machine-services-deploy-here')).toBeNull();
        expect(screen.findHostByTestId('machine-services-watch')).toBeNull();
        expect(screen.findHostByTestId('machine-services-recipient')).not.toBeNull();
    });

    it('offers Deploy an app here, opening the one Deploy an app flow with this Machine chosen, on the empty and the listed page', async () => {
        const { Modal } = await import('@/modal');
        // On a computer the flow opens as its dialog over the Machine page, carrying this Machine.
        const expected = expect.objectContaining({ props: expect.objectContaining({ machine: { serverId, machineId } }) });
        const list = answerResource(MachineServicesListResultV1Schema.parse({ kind: 'snapshot', services: [] }));
        const { screen } = await mount();
        await vi.waitFor(() => expect(screen.findHostByTestId('machine-services-empty')).not.toBeNull());
        vi.mocked(Modal.show).mockClear();
        await screen.pressByTestIdAsync('machine-services-deploy-here');
        await vi.waitFor(() => expect(Modal.show).toHaveBeenLastCalledWith(expected));
        vi.mocked(Modal.show).mockClear();
        await list.publish(MachineServicesListResultV1Schema.parse({ kind: 'snapshot', services: [service('Web')] }));
        await measureMountedCollections(screen);
        await vi.waitFor(() => expect(screen.findHostByTestId('machine-service-web')).not.toBeNull());
        await screen.pressByTestIdAsync('machine-services-deploy-here');
        await vi.waitFor(() => expect(Modal.show).toHaveBeenLastCalledWith(expected));
    });

    it('offers Open on a listening service page through the shared port owner, reading Local services only there', async () => {
        const row = service('Web', { port: 3000 });
        answerResource(MachineServicesListResultV1Schema.parse({ kind: 'snapshot', services: [row] }));
        machineTransport.rpc.mockImplementation(async ({ method }: { method: string }) => {
            if (method === RPC_METHODS.MACHINES_SERVICE_DETAIL) return { kind: 'service', service: row };
            throw new Error(`Unexpected Machine method: ${method}`);
        });
        const localServiceReads = () => machineTransport.rpc.mock.calls.filter(([rpc]) => String(rpc.method).startsWith('daemon.localServices.'));
        const { screen } = await mount();
        await vi.waitFor(() => expect(screen.findHostByTestId('machine-service-web')).not.toBeNull());
        expect(localServiceReads()).toHaveLength(0);
        await screen.pressByTestIdAsync('machine-service-web');
        await vi.waitFor(() => expect(screen.findHostByTestId('machine-service-open')).not.toBeNull());
        await vi.waitFor(() => expect(localServiceReads().length).toBeGreaterThan(0));
    });

    it('renders degraded rows without presenting an unknown generation as stopped or controllable', async () => {
        const rows = [service('Broken', { state: 'failed' }), service('Unanswered', { state: 'unknown', generation: null,
            unavailableReason: 'unavailable' })];
        answerResource(MachineServicesListResultV1Schema.parse({ kind: 'snapshot', services: rows }));
        const { screen } = await mount();
        await vi.waitFor(() => expect(screen.findHostByTestId('machine-service-unanswered')).not.toBeNull());
        expect(screen.getTextContent()).toContain(t('machineServices.state.failed'));
        expect(screen.getTextContent()).toContain(t('machineServices.state.unknown'));
        await screen.pressByTestIdAsync('machine-service-unanswered');
        expect(screen.findHostByTestId('machine-service-controls')).toBeNull();
        expect(screen.findHostByTestId('machine-service-logs-none')).not.toBeNull();
        expect(screen.getTextContent()).not.toContain(t('machineServices.state.stopped'));
    });

    it('offers no Environment link while headers load or when the admitted result omits an unreadable Environment', async () => {
        answerResource(MachineServicesListResultV1Schema.parse({ kind: 'snapshot', services: [service('Web', {
            authority: 'project', lifecyclePurpose: 'deployment', environmentId: 'hidden-environment',
        })] }));
        const pending = createDeferred<HomeDomainAnswer>();
        homes.answer(serverId, '/v1/deployments/environments', { select: () => pending.promise });
        const { screen } = await mount();
        await vi.waitFor(() => expect(screen.getTextContent()).toContain(t('machineServices.groups.environmentReading')));
        expect(screen.findHostByTestId('machine-services-environment-hidden-environment:open')).toBeNull();
        await act(async () => { pending.resolve({ body: { ok: true, items: [], nextCursor: null } }); });
        await vi.waitFor(() => expect(screen.getTextContent()).toContain(t('machineServices.groups.environmentUnavailable')));
        expect(screen.findHostByTestId('machine-services-environment-hidden-environment:open')).toBeNull();
        // The row's disclosure says whether its services are shown: open on arrival (lab dMachineSvc), and the person
        // can put them away.
        const disclosure = () => screen.findHostByTestId('machine-services-environment-hidden-environment:disclosure');
        const expanded = () => disclosure()?.props['aria-expanded'] ?? disclosure()?.props.accessibilityState?.expanded;
        expect(expanded()).toBe(true);
        expect(screen.findHostByTestId('machine-service-web')).not.toBeNull();
        await screen.pressByTestIdAsync('machine-services-environment-hidden-environment');
        await vi.waitFor(() => expect(screen.findHostByTestId('machine-service-web')).toBeNull());
        expect(expanded()).toBe(false);
        expect(router.push).not.toHaveBeenCalled();
    });

    it('names readable Environment groups and opens the exact admitted Source and Environment route', async () => {
        // Deployment records carry the Home's advertised identity; the local profile handle only addresses HTTP.
        const environment = createDeploymentEnvironmentHeaderV1({ serverId: serverIdentityId,
            id: 'production-environment', projectSourceId: 'shop-source' });
        const { captureLazyActionAccountContext } = await import('@/sync/ops/actions/actionAccountContext');
        const writer = await captureLazyActionAccountContext(serverId);
        try {
            await writer.createArtifactDocument({ artifactId: environment.contentArtifactId,
                header: { kind: DEPLOYMENT_ENVIRONMENT_ARTIFACT_KIND_V1, title: 'Production' }, body: '{}' });
        } finally { writer.dispose(); }
        homes.answer(serverId, '/v1/deployments/environments', { body: { ok: true, items: [environment], nextCursor: null } });
        homes.answer(serverId, '/v1/projects/sources/shop-source', { body: { ok: true, canManage: true,
            source: { id: 'shop-source', revision: 1, name: 'Storefront', audience: [], createdByAccountId: accountId } } });
        answerResource(MachineServicesListResultV1Schema.parse({ kind: 'snapshot', services: [service('Web', {
            authority: 'project', lifecyclePurpose: 'deployment', environmentId: environment.id,
        })] }));
        const { screen } = await mount();
        // The app is the band (lab dMachineSvc "billing-api · 2 environments · 5 services"); its Environment row says the
        // Environment, with its services under it on arrival.
        await vi.waitFor(() => expect(screen.getTextContent()).toContain('Storefront'));
        expect(screen.getTextContent()).toContain([t('machineServices.groups.environments', { count: 1 }),
            t('machineServices.environmentRow.services', { count: 1 })].join(' · '));
        expect(screen.getTextContent()).not.toContain('Storefront · Production');
        expect(screen.findHostByTestId(`machine-services-environment-${environment.id}`)).not.toBeNull();
        expect(screen.findHostByTestId('machine-service-web')).not.toBeNull();
        // Its disclosure says whether its services are shown.
        const disclosure = () => screen.findHostByTestId(`machine-services-environment-${environment.id}:disclosure`);
        expect(disclosure()?.props['aria-expanded'] ?? disclosure()?.props.accessibilityState?.expanded).toBe(true);
        await screen.pressByTestIdAsync(`machine-services-environment-${environment.id}`);
        await vi.waitFor(() => expect(screen.findHostByTestId('machine-service-web')).toBeNull());
        expect(disclosure()?.props['aria-expanded'] ?? disclosure()?.props.accessibilityState?.expanded).toBe(false);
        const linkId = `machine-services-environment-${environment.id}:open`;
        expect(screen.findHostByTestId(linkId)?.props.accessibilityLabel)
            .toBe(`${t('machineServices.groups.openEnvironment')}, Production`);
        await screen.pressByTestIdAsync(linkId);
        expect(router.push).toHaveBeenCalledWith({ pathname: '/deployments/[projectSourceId]', params: {
            serverId, projectSourceId: 'shop-source', deploymentEnvironment: environment.id,
        } });
        const request = homes.requests.find(item => item.path.split('?')[0] === '/v1/deployments/environments');
        expect(new URLSearchParams(request?.path.split('?')[1]).getAll('environmentIds')).toEqual([environment.id]);
    });

    it('shows the Machine’s exact deployment roles from canonical references with zero services, never from service names', async () => {
        const environment = createDeploymentEnvironmentHeaderV1({ serverId: serverIdentityId,
            id: 'edge-environment', projectSourceId: 'shop-source' });
        const { captureLazyActionAccountContext } = await import('@/sync/ops/actions/actionAccountContext');
        const writer = await captureLazyActionAccountContext(serverId);
        try {
            await writer.createArtifactDocument({ artifactId: environment.contentArtifactId,
                header: { kind: DEPLOYMENT_ENVIRONMENT_ARTIFACT_KIND_V1, title: 'Production' }, body: '{}' });
        } finally { writer.dispose(); }
        homes.answer(serverId, '/v1/deployments/machine-references', { body: { homeId: serverIdentityId, machineId,
            coverage: 'complete', nextCursor: null,
            references: [{ kind: 'deployment_environment', id: environment.id, name: '', deploymentRoles: ['controller', 'edge'] }] } });
        homes.answer(serverId, '/v1/deployments/environments', { body: { ok: true, items: [environment], nextCursor: null } });
        homes.answer(serverId, '/v1/projects/sources/shop-source', { body: { ok: true, canManage: true,
            source: { id: 'shop-source', revision: 1, name: 'Storefront', audience: [], createdByAccountId: accountId } } });
        answerResource(MachineServicesListResultV1Schema.parse({ kind: 'snapshot', services: [] }));
        const { screen } = await mount();
        await vi.waitFor(() => expect(screen.findHostByTestId('machine-services-empty')).not.toBeNull());
        const rowId = `machine-services-role:${environment.id}`;
        await vi.waitFor(() => expect(screen.findHostByTestId(rowId)).not.toBeNull());
        const roles = screen.findHostByTestId('machine-services-roles');
        expect(roles).not.toBeNull();
        const text = screen.getTextContent();
        expect(text).toContain('Production');
        expect(text).toContain(t('machineServices.roles.role.controller'));
        expect(text).toContain(t('machineServices.roles.role.edge'));
        expect(text).not.toContain(t('machineServices.roles.role.build'));
        await screen.pressByTestIdAsync(rowId);
        expect(router.push).toHaveBeenCalledWith({ pathname: '/deployments/[projectSourceId]', params: {
            serverId, projectSourceId: 'shop-source', deploymentEnvironment: environment.id,
        } });
    });

    it('says when the role census can’t be read and reads it again on Retry', async () => {
        let available = false;
        homes.answer(serverId, '/v1/deployments/machine-references', { select: () => available
            ? { body: { homeId: serverIdentityId, machineId, coverage: 'complete', nextCursor: null, references: [] } }
            : { status: 503, body: { error: 'temporarily_unavailable' } } });
        answerResource(MachineServicesListResultV1Schema.parse({ kind: 'snapshot', services: [service('Web')] }));
        const { screen } = await mount();
        await vi.waitFor(() => expect(screen.findHostByTestId('machine-services-roles-unavailable')).not.toBeNull());
        available = true;
        await screen.pressByTestIdAsync('machine-services-roles-unavailable-action');
        await vi.waitFor(() => expect(screen.findHostByTestId('machine-services-roles')).toBeNull());
    });

    it('names no role for a Machine whose services merely carry role-like names', async () => {
        homes.answer(serverId, '/v1/deployments/machine-references', { body: { homeId: serverIdentityId, machineId,
            coverage: 'complete', nextCursor: null, references: [] } });
        answerResource(MachineServicesListResultV1Schema.parse({ kind: 'snapshot', services: [service('Controller'), service('Edge')] }));
        const { screen } = await mount();
        await vi.waitFor(() => expect(screen.findHostByTestId('machine-service-controller')).not.toBeNull());
        await vi.waitFor(() => expect(homes.requests.some(request => request.path.startsWith('/v1/deployments/machine-references'))).toBe(true));
        expect(screen.findHostByTestId('machine-services-roles')).toBeNull();
    });

    it('renders an unsupported list as unavailable without offering a futile retry', async () => {
        answerResource(MachineServicesListResultV1Schema.parse({ kind: 'unavailable', reason: 'unsupported' }));
        const { screen } = await mount();
        await vi.waitFor(() => expect(screen.findHostByTestId('machine-services-unavailable-unsupported')).not.toBeNull());
        expect(screen.findHostByTestId('machine-services-retry')).toBeNull();
        expect(screen.findHostByTestId('machine-services-empty')).toBeNull();
    });

    it('renders a failed offline read as offline rather than an empty service list', async () => {
        const list = answerResource(MachineServicesListResultV1Schema.parse({ kind: 'snapshot', services: [] }));
        list.fail();
        const { screen } = await mount({ online: false });
        await vi.waitFor(() => expect(screen.findHostByTestId('machine-services-offline')).not.toBeNull());
        expect(screen.findHostByTestId('machine-services-empty')).toBeNull();
        expect(screen.findHostByTestId('machine-services-deploy-here')).toBeNull();
        expect(screen.findHostByTestId('machine-services-retry')).toBeNull();
    });

    it.each([false, true])('keeps last-known rows visible with a freshness warning when a pushed refresh fails (empty=%s)', async empty => {
        await shareWith('use');
        const value = MachineServicesListResultV1Schema.parse({ kind: 'snapshot', services: empty ? [] : [service('Retained')] });
        const list = answerResource(value);
        const { screen } = await mount();
        const resultId = empty ? 'machine-services-empty' : 'machine-service-retained';
        await vi.waitFor(() => expect(screen.findHostByTestId(resultId)).not.toBeNull());
        list.fail();
        await list.publish(value);
        await vi.waitFor(() => expect(screen.findHostByTestId('machine-services-stale')).not.toBeNull());
        expect(screen.findHostByTestId(resultId)).not.toBeNull();
        expect(screen.findHostByTestId('machine-services-error')).toBeNull();
        expect(screen.getTextContent()).not.toContain(t('machineServices.stale', { machine: machineName }));
        expect(screen.getTextContent()).toContain(t('machineDetailPage.security.staleFailed'));
        expect(screen.tree.findAll(node => typeof node.type === 'string' && node.props.testID === 'machine-services-recipient')).toHaveLength(1);
        expect(list.reads).toBeGreaterThan(1);
    });

    it('keeps a service history visible with its failed-refresh state and recovers on Retry', async () => {
        const row = service('History');
        answerResource(MachineServicesListResultV1Schema.parse({ kind: 'snapshot', services: [row] }));
        let failed = false;
        machineTransport.rpc.mockImplementation(async ({ method }: { method: string }) => {
            if (method !== RPC_METHODS.MACHINES_VITALS_HISTORY_GET) return { kind: 'service', service: row };
            if (failed) throw new Error('History temporarily unavailable');
            return { range: '1h', bucketMs: 60_000, points: [],
                today: { rxBytes: 0, txBytes: 0 }, service: { serviceId: row.serviceId,
                    points: [{ t: Date.now() - 60_000, cpuPercent: 4, cpuMaxPercent: 9,
                        memoryBytes: 200, memoryMaxBytes: 210 }] } };
        });
        const { machineResourceStore } = await import('@/sync/domains/machines/resources/machineResourceStore');
        const { machineVitalsRangeState, MACHINE_VITALS_RANGE_UI_KEY } = await import('@/sync/domains/state/navigationUiState');
        machineVitalsRangeState.set(MACHINE_VITALS_RANGE_UI_KEY, '1h');
        const range = '1h' as const;
        const { resolveMachineResourceKey } = await import('@/sync/domains/machines/resources/machineRpc');
        const target = await resolveMachineResourceKey({ serverId, machineId });
        if (!target) throw new Error('Expected the history Account target');
        const key = { ...target, serviceId: row.serviceId, range };
        const { screen } = await mount({ params: { id: 'services', page: 'service', service: row.serviceId } });
        await vi.waitFor(() => expect(machineResourceStore.getHistory(key).status).toBe('ready'));
        await vi.waitFor(() => expect(screen.findHostByTestId('machine-service-usage-history')).not.toBeNull());
        failed = true;
        await act(async () => machineResourceStore.retryHistory(key));
        await vi.waitFor(() => expect(machineResourceStore.getHistory(key).status).toBe('error'));
        expect(screen.findHostByTestId('machine-service-usage-history')).not.toBeNull();
        await vi.waitFor(() => expect(screen.findHostByTestId('machine-service-usage-history-error')).not.toBeNull());
        failed = false;
        const failure = screen.findHostByTestId('machine-service-usage-history-error');
        if (!failure) throw new Error('Expected retained history failure');
        const retry = failure.findAll(node => typeof node.props.onPress === 'function')[0];
        if (!retry) throw new Error('Expected history Retry');
        await act(async () => retry.props.onPress());
        await vi.waitFor(() => expect(machineResourceStore.getHistory(key).status).toBe('ready'));
        expect(screen.findHostByTestId('machine-service-usage-history')).not.toBeNull();
        expect(screen.findHostByTestId('machine-service-usage-history-error')).toBeNull();
    });

    it('qualifies a retained service detail when its pushed list refresh fails', async () => {
        await shareWith('use');
        const row = service('Retained');
        const value = MachineServicesListResultV1Schema.parse({ kind: 'snapshot', services: [row] });
        const list = answerResource(value);
        machineTransport.rpc.mockImplementation(async () => ({ kind: 'service', service: row }));
        const { screen } = await mount({ params: { id: 'services', page: 'service', service: row.serviceId } });
        await vi.waitFor(() => expect(screen.findHostByTestId('machine-service-page')).not.toBeNull());
        await vi.waitFor(() => expect(screen.getTextContent()).toContain('Retained'));
        list.fail();
        await list.publish(value);
        await vi.waitFor(() => expect(screen.findHostByTestId('machine-service-stale')).not.toBeNull());
        expect(screen.findHostByTestId('machine-service-page')).not.toBeNull();
        expect(screen.getTextContent()).toContain('Retained');
        expect(screen.getTextContent()).toContain(t('machineDetailPage.security.staleFailed'));
        expect(screen.getTextContent()).not.toContain(t('machineServices.staleService', { machine: machineName }));
    });

    it.each([false, true])('presents a refused online grantee read without a false offline warning (retained=%s)', async retained => {
        await shareWith('use');
        const value = MachineServicesListResultV1Schema.parse({ kind: 'snapshot', services: [service('Retained')] });
        const list = answerResource(value);
        if (!retained) list.fail('access_denied');
        const { screen } = await mount();
        if (retained) {
            await vi.waitFor(() => expect(screen.findHostByTestId('machine-service-retained')).not.toBeNull());
            list.fail('access_denied');
            await list.publish(value);
        }
        await vi.waitFor(() => expect(screen.getTextContent()).toContain(t('errors.permissionDenied')));
        expect(screen.getTextContent()).not.toContain(t('machineServices.stale', { machine: machineName }));
        expect(screen.findHostByTestId('machine-services-offline')).toBeNull();
        expect(screen.findHostByTestId('machine-services-retry')).toBeNull();
        expect(screen.tree.findAll(node => typeof node.type === 'string' && node.props.testID === 'machine-services-recipient')).toHaveLength(1);
    });

    it('preserves a refused Services read when opening a service directly', async () => {
        await shareWith('use');
        const list = answerResource(MachineServicesListResultV1Schema.parse({ kind: 'snapshot', services: [] }));
        list.fail('access_denied');
        const { screen } = await mount({ params: { id: 'services', page: 'service', service: 'retained' } });
        await vi.waitFor(() => expect(screen.getTextContent()).toContain(t('errors.permissionDenied')));
        expect(screen.findHostByTestId('machine-services-offline')).toBeNull();
        expect(screen.getTextContent()).not.toContain(t('common.retry'));
    });

    it('says the last-known list and service are as of when the Machine went offline, and offers no control', async () => {
        // Live 2026-11-02: eadc went offline while its Services page was open; the rows and Restart read as current.
        const row = service('Web', { port: 32771 });
        answerResource(MachineServicesListResultV1Schema.parse({ kind: 'snapshot', services: [row] }));
        machineTransport.rpc.mockImplementation(async () => ({ kind: 'service', service: row }));
        const { screen, goOffline } = await mount();
        await vi.waitFor(() => expect(screen.findHostByTestId('machine-service-web')).not.toBeNull());
        await goOffline();
        await vi.waitFor(() => expect(screen.findHostByTestId('machine-services-stale')).not.toBeNull());
        expect(screen.findHostByTestId('machine-service-web')).not.toBeNull();
        await screen.pressByTestIdAsync('machine-service-web');
        await vi.waitFor(() => expect(screen.findHostByTestId('machine-service-page')).not.toBeNull());
        expect(screen.findHostByTestId('machine-service-stale')).not.toBeNull();
        expect(screen.findHostByTestId('machine-service-restart')).toBeNull();
        expect(screen.findHostByTestId('machine-service-more')).toBeNull();
        expect(screen.findHostByTestId('machine-service-open')).toBeNull();
    });

    it.each(['action', 'census'] as const)('SV-C09 keeps the discovery refusal visible (%s)', async kind => {
        answerResource(MachineServicesListResultV1Schema.parse({ kind: 'snapshot', services: [] }));
        if (kind === 'action') answerActionExecution('machines.services.discovery', () => ({ ok: false,
            errorCode: 'native_check_unavailable', error: 'foreign diagnostic prose' }));
        else answerAction('machines.services.discovery', () => ({ kind: 'snapshot', candidates: [], failures: [
            { adapter: { pluginId: 'happier.machine.services', localId: 'systemd' }, code: 'native_check_unavailable' }] }));
        const { screen } = await mount();
        await vi.waitFor(() => expect(screen.findHostByTestId('machine-services-empty')).not.toBeNull());
        await screen.pressByTestIdAsync('machine-services-watch');
        await vi.waitFor(() => expect(screen.getTextContent()).toContain(t('errors.machineNativeCheckUnavailable')));
        expect(screen.getTextContent()).not.toContain(t('machineServices.watch.none', { machine: machineName }));
        expect(screen.getTextContent()).not.toContain('foreign diagnostic prose');
    });

    it('SV-C10 keeps the first watch failure beside the failed count', async () => {
        answerResource(MachineServicesListResultV1Schema.parse({ kind: 'snapshot', services: [] }));
        answerAction('machines.services.discovery', () => ({ kind: 'snapshot', failures: [], candidates: [{
            candidateId: 'candidate-web', revision: 'revision-web', name: 'web',
            adapter: { pluginId: 'happier.machine.services', localId: 'systemd' }, nativeResourceId: 'web.service',
            observation: { phase: 'running', readiness: 'not_reported', endpoint: null } }] }));
        answerActionExecution('machines.services.watch', () => ({ ok: false,
            errorCode: 'native_effect_failed', error: 'foreign diagnostic prose', requestId: 'watch-request' }));
        const { screen } = await mount();
        await vi.waitFor(() => expect(screen.findHostByTestId('machine-services-empty')).not.toBeNull());
        await screen.pressByTestIdAsync('machine-services-watch');
        await vi.waitFor(() => expect(screen.findHostByTestId('machine-services-watch-candidate:candidate-web')).not.toBeNull());
        await screen.pressByTestIdAsync('machine-services-watch-candidate:candidate-web');
        await screen.pressByTestIdAsync('machine-services-watch-confirm');
        await vi.waitFor(() => expect(screen.getTextContent()).toContain(t('errors.machineNativeEffectFailed')));
        expect(screen.getTextContent()).toContain(t('machineServices.watch.failed', { count: 1 }));
        expect(screen.getTextContent()).not.toContain('foreign diagnostic prose');
    });

    it('SV-C16 explains a typed unwatch failure', async () => {
        const row = service('Web');
        answerResource(MachineServicesListResultV1Schema.parse({ kind: 'snapshot', services: [row] }));
        answerActionExecution('machines.services.unwatch', () => ({ ok: false,
            errorCode: 'native_effect_failed', error: 'foreign diagnostic prose' }));
        machineTransport.rpc.mockImplementation(async () => ({ kind: 'service', service: row }));
        const { screen } = await mount({ params: { id: 'services', page: 'service', service: row.serviceId } });
        await vi.waitFor(() => expect(screen.findHostByTestId('machine-service-more')).not.toBeNull());
        await screen.pressByTestIdAsync('machine-service-more');
        await vi.waitFor(() => expect(screen.findHostByTestId('machine-service-unwatch')).not.toBeNull());
        await screen.pressByTestIdAsync('machine-service-unwatch');
        await vi.waitFor(() => expect(screen.getTextContent()).toContain(t('errors.machineNativeEffectFailed')));
        expect(screen.getTextContent()).not.toContain('foreign diagnostic prose');
    });

    it.each([false, true])('watches the services the person picks from what the Machine discovers, once each (initially empty: %s)', async (initiallyEmpty) => {
        const adapter = { pluginId: 'happier.machine.services', localId: 'systemd' };
        const watched = service('Postgres', { nativeInstance: { adapter, nativeResourceId: 'postgresql.service' } });
        answerResource(MachineServicesListResultV1Schema.parse({ kind: 'snapshot', services: initiallyEmpty ? [] : [watched] }));
        const candidate = (name: string, unit: string) => ({ candidateId: `candidate-${name}`, revision: `revision-${name}`, name,
            adapter, nativeResourceId: unit, observation: { phase: 'running', readiness: 'not_reported', endpoint: null } });
        const watches: unknown[] = [];
        answerAction('machines.services.discovery', () => ({ kind: 'snapshot', failures: initiallyEmpty ? [
            { adapter: { pluginId: 'happier.machine.services', localId: 'compose' }, code: 'compose_docker_tool_unavailable' },
        ] : [],
            candidates: [candidate('fail2ban', 'fail2ban.service'), candidate('redis', 'redis.service'),
                candidate('unpicked', 'unpicked.service'), candidate('postgres', 'postgresql.service')] }));
        answerAction('machines.services.watch', envelope => {
            watches.push(envelope.input);
            return { kind: 'applied', revision: 'next' };
        });
        const discoveryReads = () => homes.requestsFor('/v1/actions/machines.services.discovery');
        const { screen } = await mount();
        await vi.waitFor(() => expect(screen.findHostByTestId(initiallyEmpty ? 'machine-services-empty' : 'machine-service-postgres')).not.toBeNull());
        // Nothing is discovered until the person asks.
        expect(discoveryReads()).toHaveLength(0);
        await screen.pressByTestIdAsync('machine-services-watch');
        await vi.waitFor(() => expect(screen.findHostByTestId('machine-services-watch-candidate:candidate-fail2ban')).not.toBeNull());
        // A missing optional discovery tool leaves the listed systemd services selectable.
        if (initiallyEmpty) expect(screen.getTextContent()).toContain(t('errors.machineComposeDockerToolUnavailable'));
        else expect(screen.getTextContent()).toContain(t('machineServices.watch.alreadyWatched'));
        // Nothing picked yet: the confirm reads "Watch", never a zero count.
        expect(screen.getTextContent()).not.toContain(t('machineServices.watch.confirm', { count: 0 }));
        expect(screen.getTextContent()).toContain(t('machineServices.watch.confirmNone'));
        await screen.pressByTestIdAsync('machine-services-watch-candidate:candidate-fail2ban');
        await vi.waitFor(() => expect(screen.getTextContent()).toContain(t('machineServices.watch.confirm', { count: 1 })));
        await screen.pressByTestIdAsync('machine-services-watch-candidate:candidate-redis');
        await vi.waitFor(() => expect(screen.getTextContent()).toContain(t('machineServices.watch.confirm', { count: 2 })));
        await screen.pressByTestIdAsync('machine-services-watch-confirm');
        await vi.waitFor(() => expect(watches).toHaveLength(2));
        expect(discoveryReads()).toHaveLength(1);
        expect(watches).toEqual(expect.arrayContaining([
            expect.objectContaining({ machineId, candidateId: 'candidate-fail2ban', expectedRevision: 'revision-fail2ban', lifecyclePurpose: 'development' }),
            expect.objectContaining({ machineId, candidateId: 'candidate-redis', expectedRevision: 'revision-redis', lifecyclePurpose: 'development' }),
        ]));
    });

    it('lines Port, Memory and Up up as columns on a wide page and says them in the byline on a phone', async () => {
        const startedAtMs = Date.now() - 4 * 3_600_000;
        const row = service('Web', { state: 'healthy', port: 3000, accounting: { memoryBytes: 98 * 1024 * 1024, startedAtMs } });
        answerResource(MachineServicesListResultV1Schema.parse({ kind: 'snapshot', services: [row, service('Worker')] }));
        const { screen } = await mount();
        await vi.waitFor(() => expect(screen.findHostByTestId('machine-service-web')).not.toBeNull());
        const cell = (key: string) => screen.findHostByTestId(`machine-service-web:column:${key}`);
        await vi.waitFor(() => expect(cell('memory')).not.toBeNull());
        expect(textOf(cell('memory')!)).toContain('98 MiB');
        expect(textOf(cell('up')!)).toBe(t('machineVitals.alerts.durations.hours', { hours: 4 }));
        expect(screen.findHostByTestId('machine-service-web:port')).not.toBeNull();
        // A row with nothing to report keeps the columns' places, so the figures still line up.
        expect(screen.findHostByTestId('machine-service-worker:column:memory')).not.toBeNull();
        expect(screen.findHostByTestId('machine-services-table:sheet-header')).not.toBeNull();
        expect(screen.getTextContent()).not.toContain(t('machineVitals.header.upHours', { hours: 4 }));

        await measureMountedCollections(screen, { width: 390 });
        await vi.waitFor(() => expect(cell('memory')).toBeNull());
        expect(screen.findHostByTestId('machine-services-table:sheet-header')).toBeNull();
        expect(screen.getTextContent()).toContain('98 MiB');
        expect(screen.getTextContent()).toContain(t('machineVitals.header.upHours', { hours: 4 }));
        expect(screen.findHostByTestId('machine-service-web:port')).not.toBeNull();
    });

    it('summarises the deployment roles beside listed services as one row that opens the full list', async () => {
        const environment = createDeploymentEnvironmentHeaderV1({ serverId: serverIdentityId,
            id: 'build-environment', projectSourceId: 'shop-source' });
        const { captureLazyActionAccountContext } = await import('@/sync/ops/actions/actionAccountContext');
        const writer = await captureLazyActionAccountContext(serverId);
        try {
            await writer.createArtifactDocument({ artifactId: environment.contentArtifactId,
                header: { kind: DEPLOYMENT_ENVIRONMENT_ARTIFACT_KIND_V1, title: 'Production' }, body: '{}' });
        } finally { writer.dispose(); }
        homes.answer(serverId, '/v1/deployments/machine-references', { body: { homeId: serverIdentityId, machineId,
            coverage: 'complete', nextCursor: null,
            references: [{ kind: 'deployment_environment', id: environment.id, name: '', deploymentRoles: ['controller', 'build'] }] } });
        homes.answer(serverId, '/v1/deployments/environments', { body: { ok: true, items: [environment], nextCursor: null } });
        answerResource(MachineServicesListResultV1Schema.parse({ kind: 'snapshot', services: [service('Web')] }));
        const { screen, setParams } = await mount();
        await vi.waitFor(() => expect(screen.findHostByTestId('machine-services-roles-summary')).not.toBeNull());
        expect(screen.findHostByTestId(`machine-services-role:${environment.id}`)).toBeNull();
        const summary = textOf(screen.findHostByTestId('machine-services-roles-summary')!);
        expect(summary).toContain(t('machineServices.roles.role.controller'));
        expect(summary).toContain(t('machineServices.roles.forEnvironments', { count: 1 }));
        await screen.pressByTestIdAsync('machine-services-roles-summary');
        expect(setParams).toHaveBeenLastCalledWith({ id: 'services', page: 'roles' });
        await vi.waitFor(() => expect(screen.findHostByTestId(`machine-services-role:${environment.id}`)).not.toBeNull());
        expect(screen.findHostByTestId('machine-services-roles-summary')).toBeNull();
        await screen.pressByTestIdAsync('machine-services-roles-back');
        expect(setParams).toHaveBeenLastCalledWith({ id: 'services' });
    });

    it.each(['running', 'healthy'] as const)('shows running since from native start when a %s service has no health transition clock', async state => {
        const row = service('Web', { state, accounting: { startedAtMs: Date.UTC(2026, 10, 2, 9, 14) } });
        answerResource(MachineServicesListResultV1Schema.parse({ kind: 'snapshot', services: [row] }));
        machineTransport.rpc.mockImplementation(async () => ({ kind: 'service', service: row }));
        const { screen } = await mount();
        await vi.waitFor(() => expect(screen.findHostByTestId('machine-service-web')).not.toBeNull());
        await screen.pressByTestIdAsync('machine-service-web');
        await vi.waitFor(() => expect(screen.findHostByTestId('machine-service-since')).not.toBeNull());
        expect(screen.findHostByTestId('machine-service-since')?.props.children).toContain(t('machineServices.state.running'));
    });

    it('shows memory and uptime on the row, health since on the page, and the masking notice outside the log', async () => {
        const startedAtMs = Date.now() - 4 * 3_600_000;
        const row = service('Web', { state: 'healthy', accounting: { memoryBytes: 98 * 1024 * 1024, startedAtMs },
            health: { status: 'up', since: Date.UTC(2026, 10, 2, 9, 14), observedAtMs: Date.now(), freshness: 'current' } });
        answerResource(MachineServicesListResultV1Schema.parse({ kind: 'snapshot', services: [row] }));
        machineTransport.rpc.mockImplementation(async () => ({ kind: 'service', service: row }));
        answerResource(ManagedServiceNativeLogResultV1Schema.parse({ kind: 'page', page: {
            sourceRevision: 'native-source', text: 'listening on :80\n', nextCursor: null, truncated: false, secretMasking: 'incomplete',
        } }), 'machines.services.logs.read');
        const { screen } = await mount();
        await vi.waitFor(() => expect(screen.findHostByTestId('machine-service-web')).not.toBeNull());
        await measureMountedCollections(screen, { width: 390 });
        await vi.waitFor(() => expect(screen.getTextContent()).toContain(t('machineVitals.header.upHours', { hours: 4 })));
        expect(screen.getTextContent()).toContain('98 MiB');
        await screen.pressByTestIdAsync('machine-service-web');
        await vi.waitFor(() => expect(screen.findHostByTestId('machine-service-since')).not.toBeNull());
        await vi.waitFor(() => expect(screen.getTextContent()).toContain('listening on :80'));
        expect(screen.findHostByTestId('machine-service-logs-masking')).not.toBeNull();
    });

    it('measures each replica on open and again on Measure again, keeping the last figures while it reads', async () => {
        const row = service('Web', { state: 'healthy' });
        answerResource(MachineServicesListResultV1Schema.parse({ kind: 'snapshot', services: [row] }));
        const reads: Array<(value: unknown) => void> = [];
        answerAction('machines.services.detail', () => new Promise(resolve => { reads.push(resolve); }));
        const sample = (cpuPercent: number, memoryMb: number) => ({ kind: 'service', service: row, accounting: { kind: 'sample', samples: [
            { nativeResourceId: 'shop-web-1', cpuPercent, memoryBytes: memoryMb * 1024 * 1024,
                networkReceivedBytes: 2 * 1024 * 1024, networkSentBytes: 0, restartCount: 3 },
            { nativeResourceId: 'shop-web-2', cpuPercent: null, memoryBytes: null }] } });
        const { screen } = await mount({ params: { id: 'services', page: 'service', service: row.serviceId } });
        await vi.waitFor(() => expect(reads).toHaveLength(1));
        await act(async () => { reads[0]!(sample(12, 48)); });
        await vi.waitFor(() => expect(screen.findHostByTestId('machine-service-usage')).not.toBeNull());
        const usage = () => textOf(screen.findHostByTestId('machine-service-usage')!);
        expect(usage()).toContain('12%');
        expect(usage()).toContain('48 MiB');
        expect(usage()).toContain('2 MiB');
        expect(usage()).toContain('0 B');
        expect(usage()).toContain(`3 · ${t('machineServices.facts.notReported')}`);
        // A replica whose sample omits its figures says so instead of reading as zero.
        expect(usage()).toContain(t('machineServices.facts.notReported'));
        await screen.pressByTestIdAsync('machine-service-measure');
        await vi.waitFor(() => expect(reads).toHaveLength(2));
        expect(usage()).toContain('48 MiB');
        await act(async () => { reads[1]!(sample(30, 64)); });
        await vi.waitFor(() => expect(usage()).toContain('64 MiB'));
        expect(usage()).toContain('30%');
    });
});

it('withdrawn secret notice stops the admitted generation and offers Start only after the service push confirms stopped', async () => {
    const { DeploymentSecretBindingsNotice } = await import('@/components/projects/deployments/DeploymentSecretBindingsNotice');
    const environmentId = 'production';
    const row = service('Web', { serviceId: 'instance/web', authority: 'project', environmentId,
        deployment: { deploymentId: 'serving', installationId: 'installation', service: {
            kind: 'deployment', machineId, environmentId, environmentInstanceId: 'instance', composeService: 'web', serviceId: 'instance/web' } } });
    const resource = answerResource(MachineServicesListResultV1Schema.parse({ kind: 'snapshot', services: [row] }));
    const operations: unknown[] = [];
    const firstControl = createDeferred<ActionExecuteResult>();
    answerActionExecution('machines.services.control', envelope => {
        operations.push(envelope.input);
        return operations.length === 1 ? firstControl.promise
            : { ok: true, result: { kind: 'accepted', operation: { operationId: 'control' } } };
    });
    const target = { serverId, environmentId, machineIds: [machineId], active: true };
    const { useServerCredentialAccountScopeBinding } = await import('@/sync/domains/scope/useServerCredentialAccountScopes');
    let credentialScope: ReturnType<typeof useServerCredentialAccountScopeBinding> | undefined;
    function Notice() {
        credentialScope = useServerCredentialAccountScopeBinding(serverId);
        return <DeploymentSecretBindingsNotice secretScope={{
            status: 'actionNeeded', reason: 'secret_scope_resource_unavailable',
            requiredGrantCount: 1, missingGrantCount: 1,
        }} canManageBindings={true} controlTarget={target} />;
    }
    const screen = await renderScreen(<Notice />);
    await vi.waitFor(() => expect(credentialScope?.binding?.isCurrent()).toBe(true));
    const { areServerProfileIdentifiersEquivalent } = await import('@/sync/domains/server/serverProfiles');
    expect(areServerProfileIdentifiersEquivalent(credentialScope!.binding!.scope.serverId, serverId)).toBe(true);
    expect(credentialScope?.binding?.scope.accountId).toBe(accountId);
    expect(row.generation).toBe('generation-a');
    const id = 'project-deployments.environment.secret-control.machine.instance/web';
    await vi.waitFor(() => expect(screen.findHostByTestId(id + '.stop')).not.toBeNull());
    expect(screen.findHostByTestId(id + '.stop')!.props.accessibilityLabel).toBe(t('machineServices.control.stop'));
    await vi.dynamicImportSettled();
    await screen.pressByTestIdAsync(id + '.stop');
    await vi.dynamicImportSettled();
    await vi.waitFor(() => expect({ operations, pending: screen.findHostByTestId(id + '.stop')?.props.accessibilityState, requests: homes.requests.map(request => request.path), outcome: screen.findByTestId(id + '.outcome') ? textOf(screen.findByTestId(id + '.outcome')!) : null }).toMatchObject({ operations: [expect.anything()], outcome: null }));
    expect(operations[0]).toMatchObject({ serverId, machineId, serviceId: row.serviceId,
        expectedGeneration: row.generation, operation: 'stop' });
    expect(screen.findHostByTestId(id + '.start')).toBeNull();
    expect(screen.findHostByTestId(id + '.stop')!.props.accessibilityState).toMatchObject({ disabled: true });
    await screen.pressByTestIdAsync(id + '.stop');
    expect(operations).toHaveLength(1);
    await act(async () => { firstControl.resolve({ ok: false, errorCode: 'service_operation_unavailable',
        error: 'Native control is unavailable' }); });
    await vi.waitFor(() => expect(screen.findHostByTestId(id + '.outcome')).not.toBeNull());
    expect(textOf(screen.findHostByTestId(id + '.outcome')!)).toContain(t('machineServices.control.unavailableRemedy'));
    await screen.pressByTestIdAsync(id + '.outcome-details-toggle');
    expect(textOf(screen.findHostByTestId(id + '.outcome')!)).toContain('service_operation_unavailable');
    expect(screen.findHostByTestId(id + '.start')).toBeNull();
    await screen.pressByTestIdAsync(id + '.stop');
    await vi.waitFor(() => expect(operations).toHaveLength(2));
    await resource.publish(MachineServicesListResultV1Schema.parse({ kind: 'snapshot', services: [{ ...row, state: 'stopped' }] }));
    await vi.waitFor(() => expect(screen.findHostByTestId(id + '.start')).not.toBeNull());
    await screen.pressByTestIdAsync(id + '.start');
    await vi.waitFor(() => expect(operations).toHaveLength(3));
    expect(operations[2]).toMatchObject({ serviceId: row.serviceId, expectedGeneration: row.generation, operation: 'start' });
    await screen.unmount();
});

describe('Add a machine → done step (#5; UI refinements ruling 2026-11-13 08:07Z)', () => {
    async function renderDone(next: 'picker' | 'machine') {
        answerResource(MachineServicesListResultV1Schema.parse({ kind: 'snapshot',
            services: [service('Web'), service('Worker'), service('Postgres')] }));
        const { MachineArrivedCard } = await import('@/components/machines/add/MachineAddPanes');
        const onStartSession = vi.fn();
        const screen = await renderScreen(<MachineArrivedCard testID="arrived" machineId={machineId} serverId={serverId}
            name={machineName} facts="" next={next} onStartSession={onStartSession} onAddAnother={() => {}} />);
        return { screen, onStartSession };
    }

    it('says once what the first read of the new Machine found, and opens that Machine when the flow began on Machines', async () => {
        const { screen, onStartSession } = await renderDone('machine');
        try {
            await vi.waitFor(async () => { await flushHookEffects();
                expect(screen.getTextContent()).toContain(t('addFlows.machineFoundServices', { count: 3 })); });
            await screen.pressByTestIdAsync('arrived.continue');
            const { machinePageHref } = await import('@/components/machines/page/machinePageHref');
            expect(router.push).toHaveBeenCalledWith(machinePageHref({ door: 'settings', target: { machineId, serverId } }));
            expect(onStartSession).not.toHaveBeenCalled();
        } finally { await screen.unmount(); }
    });

    it('hands the new Machine back to the picker that started the flow', async () => {
        const { screen, onStartSession } = await renderDone('picker');
        try {
            await vi.waitFor(async () => { await flushHookEffects();
                expect(screen.getTextContent()).toContain(t('addFlows.machineFoundServices', { count: 3 })); });
            await screen.pressByTestIdAsync('arrived.continue');
            expect(onStartSession).toHaveBeenCalledOnce();
            expect(router.push).not.toHaveBeenCalled();
        } finally { await screen.unmount(); }
    });
});

describe('Add review → declared ports (#4)', () => {
    it('lists what each service declares, names a managed service already on a declared port, and leaves the rest to first start', async () => {
        const selections: unknown[] = [];
        answerResource(MachineServicesListResultV1Schema.parse({ kind: 'snapshot', services: [service('meili-old', { port: 7700 })] }),
            'machines.services.list', (value, reference) => { selections.push(reference.input); return value; });
        const { DeploymentAddPortsFacts } = await import('@/components/approvals/DeploymentAddPortsFacts');
        const document = [
            'services:',
            '  search:',
            '    image: getmeili/meilisearch:v1.11',
            '    container_name: search-1',
            '    ports:',
            '      - "7701:7700"',
            '      - target: 7700',
            '        published: 7700',
        ].join('\n');
        const screen = await renderScreen(<DeploymentAddPortsFacts document={document} services={['search']}
            serverId={serverId} machineId={machineId} testID="ports" />);
        try {
            await vi.waitFor(async () => { await flushHookEffects(); expect(screen.findByTestId('ports.clash')).not.toBeNull(); });
            const text = screen.getTextContent();
            expect(text).toContain('search-1');
            expect(text).toContain('7701:7700');
            expect(text).toContain('7700:7700');
            expect(text).toContain('meili-old');
            expect(text).toContain(t('projects.deployments.addPortsUnresolved'));
            // Only the literal long-form publication is asked about; the short form is not evaluated.
            expect(selections).toContainEqual(expect.objectContaining({ preflight: { ports: [7700], nativeNames: [], displayNames: ['search-1'] } }));
        } finally { await screen.unmount(); }
    });

    it('warns about a matching visible service name without a published port', async () => {
        const selections: unknown[] = [];
        answerResource(MachineServicesListResultV1Schema.parse({ kind: 'snapshot', services: [service('search-1')] }),
            'machines.services.list', (value, reference) => { selections.push(reference.input); return value; });
        const { DeploymentAddPortsFacts } = await import('@/components/approvals/DeploymentAddPortsFacts');
        const screen = await renderScreen(<DeploymentAddPortsFacts document="services: { search: { container_name: search-1 } }"
            services={['search']} serverId={serverId} machineId={machineId} testID="ports" />);
        try {
            await vi.waitFor(async () => { await flushHookEffects(); expect(screen.findByTestId('ports.clash')).not.toBeNull(); });
            expect(selections).toContainEqual(expect.objectContaining({ preflight: { ports: [], nativeNames: [], displayNames: ['search-1'] } }));
        } finally { await screen.unmount(); }
    });
});
