import * as React from 'react';
import { createHash } from 'node:crypto';
import sodium from 'libsodium-wrappers';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { router } from 'expo-router';
import { MachineServiceRowV1Schema, MachineServicesListResultV1Schema, ManagedServiceNativeLogResultV1Schema, type MachineServiceRowV1 } from '@happier-dev/protocol';
import { ExternalActionExecutionAuthorizationRequestV1Schema, ExternalActionRequestEnvelopeV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { computeExternalActionRequestEnvelopeDigestV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import type { PluginUiHostReadReferenceV1 } from '@happier-dev/protocol/plugins/ui/client';
import { encodeBase64 } from '@happier-dev/protocol/crypto/base64';
import { createDeploymentEnvironmentHeaderV1 } from '@happier-dev/deployment-protocol/testing/v1';
import { DEPLOYMENT_ENVIRONMENT_ARTIFACT_KIND_V1 } from '@happier-dev/deployment-protocol/v1';

import { createDeferred, createMachineFixture, flushHookEffects, renderHook, renderScreen, standardCleanup, reportPopoverContentLayout, withPopoverWebGlobals } from '@/dev/testkit';
import { Modal } from '@/modal';
import type { ServiceCommandSheetProps } from './command/ServiceCommandSheet';
import { createMachineReadBatchResponseFixture, createPlainMachineRowFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries, type HomeDomainAnswer } from '@/dev/testkit/harness/homeGovernanceHarness';
import { initializeRealAppRuntimeForTests } from '@/dev/testkit/harness/realAppRuntimeHarness';
import { publishMachineInventoryForTest } from '@/dev/testkit/harness/machinePresence';
import { measureMountedCollections } from '@/dev/testkit/render/renderInCollectionLayout';
import type { MachinePageTabParams } from '@/components/machines/page/machinePageTabQuery';
import { ListPresentationProvider } from '@/components/ui/lists/listPresentation';
import { t } from '@/text';
import { AccountNoticeInvestigationBoundary } from '@/hooks/inbox/AccountNoticeInvestigationProvider';
import { registerCurrentUiContextActionPort } from '@/components/appShell/currentUiContext/currentUiContextActionRuntime';
import { TriageReadSessionHandoffChoicesInputV1Schema, TriageSessionHandoffChoicesV1Schema } from '@happier-dev/triage-protocol/v1';
import { TriageRunConfiguredActionInputV1Schema, TriageRunConfiguredActionResultV1Schema } from '../../../../../../packages/plugins/triage/src/actions/configuredActionRunProtocol';
import { AgentActionButton } from '@happier-dev/plugin-ui/components';

// Only Home HTTP, Machine RPC and Socket boundaries are substituted. The tab, Actions,
// credential admission, Resource lifecycle, collection and detail hooks stay real.
const machineTransport = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock().module);
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', async () => {
    const { createServerScopedMachineRpcBoundaryMock } = await import('@/dev/testkit/mocks/serverScopedRpc');
    return createServerScopedMachineRpcBoundaryMock(machineTransport.rpc);
});
const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
const { storage } = await import('@/sync/domains/state/storageStore');
const { MachineServicesTab } = await import('./MachineServicesTab');

let serverId: string;
const accountId = 'account';
const machineId = 'machine';
const machineName = 'Development machine';
const serverIdentityId = 'srv_services_rendered';
let custodianAccountId = accountId;
type Envelope = ReturnType<typeof ExternalActionRequestEnvelopeV1Schema.parse>;
type Request = Parameters<NonNullable<HomeDomainAnswer['select']>>[1];

function service(name: string, overrides: Partial<MachineServiceRowV1> = {}) {
    return MachineServiceRowV1Schema.parse({
        serviceId: name.toLowerCase(), name, authority: 'machine', lifecyclePurpose: 'development',
        generation: 'generation-a', state: 'running', watchId: `watch-${name}`, watchRevision: 'revision-a',
        capabilities: { exec: true, start: true, stop: true, restart: true, logs: true, accounting: true },
        ...overrides,
    });
}

function answerAction(actionId: string, read: (envelope: Envelope, request: Request) => unknown | Promise<unknown>) {
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
            execution: { ok: true, result: await read(envelope, request) } } };
    } });
}

/** Emulate the daemon's Resource wire; the production Resource store owns demand and refresh. */
function answerResource<T>(initial: T, actionId: 'machines.services.list' | 'machines.services.logs.read' = 'machines.services.list',
    select: (value: T, reference: PluginUiHostReadReferenceV1) => T = value => value) {
    let value = initial;
    let failureCode: string | null = null;
    let deliver: (() => void) | undefined;
    let reads = 0;
    const readValues: T[] = [];
    const content = (reference: PluginUiHostReadReferenceV1) => {
        const bytes = Buffer.from(JSON.stringify(select(value, reference)));
        return { contentType: 'application/json', bytesBase64: bytes.toString('base64'),
            digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}` };
    };
    answerAction(actionId, (envelope, request) => {
        const continuation = envelope.resourceContinuation;
        if (!continuation) return value;
        const reference = continuation.params.resource;
        if (continuation.method === RPC_METHODS.DAEMON_PLUGIN_UI_RESOURCE_READ) {
            reads++;
            readValues.push(select(value, reference));
            return failureCode ? { ok: false, code: failureCode, reason: 'unavailable' }
                : { ok: true, resource: reference, ...content(reference) };
        }
        if (continuation.method === RPC_METHODS.DAEMON_PLUGIN_UI_RESOURCE_WATCH_OPEN)
            return { ok: true, subscriptionId: continuation.params.subscriptionId, digest: content(reference).digest };
        if (continuation.method === RPC_METHODS.DAEMON_PLUGIN_UI_RESOURCE_WATCH_CLOSE)
            return { ok: true, closed: true };
        return new Promise(resolve => {
            const finish = (result: unknown) => {
                request.signal?.removeEventListener('abort', abort);
                deliver = undefined;
                resolve(result);
            };
            const abort = () => finish({ ok: true, status: 'idle' });
            deliver = () => finish({ ok: true, status: 'event', event: { version: 1, kind: 'invalidated',
                subscriptionId: continuation.params.subscriptionId, digest: failureCode ? `sha256:${'0'.repeat(64)}` : content(reference).digest } });
            request.signal?.addEventListener('abort', abort, { once: true });
            if (request.signal?.aborted) abort();
        });
    });
    return {
        fail(code = 'service_transport_unavailable') { failureCode = code; },
        async publish(next: typeof value) {
            value = next;
            await vi.waitFor(() => expect(deliver).toBeTypeOf('function'));
            await act(async () => { deliver?.(); });
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
    const resource = answerResource(initial, 'machines.services.list', (value, reference) => {
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
        await vi.waitFor(async () => { await flushHookEffects(); expect(hook.getCurrent().pending).toBe(false); });
        expect(resource.reads).toBe(1);
        expect(resource.readValues.flatMap(value => value.kind === 'snapshot' ? value.services : [])).toHaveLength(shown);
        expect(hook.getCurrent().rows).toHaveLength(shown);
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
        expect(resource.readValues.flatMap(value => value.kind === 'snapshot' ? value.services : [])).toHaveLength(shown * 3 + 1);
    } finally { await hook.unmount(); }
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
        const settled = hook.getCurrent().rows;
        publications.length = 0;
        await act(async () => { await homes.switchAccount(serverId, accountId, { currentAccount: true }); });
        await vi.waitFor(async () => { await flushHookEffects(); expect(hook.getCurrent().pending).toBe(false); });
        expect(publications).toHaveLength(0);
        expect(hook.getCurrent().rows).toBe(settled);
        await resource.publish(MachineServicesListResultV1Schema.parse({ kind: 'snapshot',
            services: [{ ...row, name: 'Changed continuity' }, stableRow] }));
        await vi.waitFor(async () => { await flushHookEffects(); expect(hook.getCurrent().rows?.[0]?.name).toBe('Changed continuity'); });
        expect(publications).toHaveLength(1);
        expect(hook.getCurrent().rows?.[1]).toBe(settled?.[1]);
        await act(async () => { await homes.switchAccount(serverId, 'another-account', { currentAccount: true }); });
        expect(hook.getCurrent().rows).toBeNull();
    } finally { await hook.unmount(); }
});

/** The words a rendered node draws, joined. */
function textOf(node: { children: readonly unknown[] }): string {
    return node.children.map(child => typeof child === 'string' ? child : textOf(child as { children: readonly unknown[] })).join('');
}

async function mount(options: Readonly<{ online?: boolean; params?: MachinePageTabParams }> = {}) {
    const setParams = vi.fn();
    // The Machine page shell's presence fact, which the tab consumes as `online`.
    let setPresence: (online: boolean) => void = () => {};
    function Route() {
        const [params, update] = React.useState<MachinePageTabParams>(options.params ?? { id: 'services' });
        const [online, setOnline] = React.useState(options.online ?? true);
        setPresence = setOnline;
        return <MachineServicesTab serverId={serverId} machineId={machineId} machineName={machineName}
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
    serverId = await homes.addHome({ name: 'Services rendered', serverUrl: 'https://services-rendered.test',
        serverIdentityId, accountId, currentAccount: true, active: true });
    const machine = createMachineFixture({ id: machineId, activeAt: Date.now(), isShared: false });
    const row = { ...createPlainMachineRowFixture({ id: machineId, accountId, machine }), installationId: 'installation' };
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
afterEach(async () => { standardCleanup(); await homes.reset(); });

describe('MachineServicesTab rendered production wiring', () => {
    it.each(['deployment', 'adopted'] as const)('investigates an unhealthy %s service using its admitted identity through Triage', async kind => {
        const identity = kind === 'deployment'
            ? { kind, machineId, environmentId: 'production', environmentInstanceId: 'instance-a', composeService: 'api', serviceId: 'instance-a/api' }
            : { kind, machineId, serviceId: 'opaque-watched-service', watchId: 'watch-a', watchRevision: 'watch-revision-a' };
        const row = service('API', { serviceId: identity.serviceId, identity, state: 'unhealthy',
            capabilities: { start: false, stop: false, restart: false, logs: false, accounting: false } });
        answerResource(MachineServicesListResultV1Schema.parse({ kind: 'snapshot', services: [row] }));
        machineTransport.rpc.mockResolvedValue({ kind: 'service', service: row });
        const handoffs: unknown[] = [];
        // The contributed plugin realm is the execution boundary. Account custody, the Action
        // front door and investigation domain stay real; Triage's published schemas admit both sides.
        const unregister = registerCurrentUiContextActionPort(() => ({
            readCurrentUiContext: () => null, resolveCurrentUiCommand: () => null, subscribe: () => () => {},
            invokeAction: async request => {
                expect(request.action.pluginId).toBe('happier.triage');
                if (request.action.localId === 'actions/read-v1') {
                    TriageReadSessionHandoffChoicesInputV1Schema.parse(request.input);
                    return { ok: true, result: TriageSessionHandoffChoicesV1Schema.parse({ v: 1, kind: 'choices', defaultActionId: 'investigate',
                        actions: [{ label: 'Investigate', launchMode: 'start', startable: true,
                            selection: { configuredActionId: 'investigate', sessionChoice: { kind: 'configured' },
                                agentChoice: { kind: 'configured' }, delivery: 'configured' } }] }) };
                }
                expect(request.action.localId).toBe('sessions/run-configured-v1');
                handoffs.push(TriageRunConfiguredActionInputV1Schema.parse(request.input));
                return { ok: true, result: TriageRunConfiguredActionResultV1Schema.parse({ v: 1,
                    handoff: { kind: 'unavailable', reason: 'catalogUnavailable' } }) };
            },
        }));
        try {
            const { screen } = await mount({ params: { id: 'services', page: 'service', service: row.serviceId } });
            await vi.waitFor(() => expect(screen.findAllByType(AgentActionButton)).toHaveLength(1));
            await vi.waitFor(() => expect(screen.findAllByType(AgentActionButton)[0]?.props.launchMode).toBe('start'));
            const button = screen.findAllByType(AgentActionButton)[0]!;
            await act(async () => { button.props.onLaunch(button.props.launchMode); });
            await vi.waitFor(() => expect(handoffs).toHaveLength(1));
            const subject = { kind: 'service', target: { kind: 'host', page: 'machine_service', machine: { serverId, machineId }, service: identity } };
            expect(handoffs).toEqual([expect.objectContaining({ handoff: expect.objectContaining({
                task: 'investigate', configuredActionId: 'investigate', delivery: 'send',
                context: { kind: 'failure', subject }, evidence: [{ kind: 'failure', subject }],
            }) })]);
            await vi.waitFor(() => expect(screen.findByTestId('machine-service-investigate.unavailable')).not.toBeNull());
        } finally { unregister(); }
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

    it('retains settled Services detail and its guided automation step during credential resolution', () => withPopoverWebGlobals(async () => {
        const row = service('Continuity', { capabilities: { start: true, stop: true, restart: true, logs: false, accounting: false } });
        answerResource(MachineServicesListResultV1Schema.parse({ kind: 'snapshot', services: [row] }));
        machineTransport.rpc.mockResolvedValue({ kind: 'service', service: row });
        const { screen } = await mount({ params: { id: 'services', page: 'service', service: row.serviceId } });
        try {
            await vi.waitFor(() => expect(screen.findHostByTestId('subject-triggers-set-up')).not.toBeNull());
            await screen.pressByTestIdAsync('subject-triggers-set-up');
            await act(async () => reportPopoverContentLayout(screen.tree, { width: 500, height: 600 }));
            await vi.waitFor(() => expect(screen.findHostByTestId('guided-automation-next')).not.toBeNull());
            await screen.pressByTestIdAsync('guided-automation-next');
            expect(screen.findByTestId('guided-automation-lookAt')).not.toBeNull();
            const loadingPublications: unknown[] = [];
            const stepReplacements: unknown[] = [];
            const unsubscribe = screen.tree.subscribe(() => {
                if (screen.findHostByTestId('machine-service-loading')) loadingPublications.push(true);
                if (!screen.findByTestId('guided-automation-lookAt')) stepReplacements.push(true);
            });
            try {
                await act(async () => { await homes.switchAccount(serverId, accountId, { currentAccount: true }); });
                await vi.waitFor(async () => { await flushHookEffects(); expect(screen.findHostByTestId('subject-triggers-set-up')).not.toBeNull(); });
                expect(loadingPublications).toHaveLength(0);
                expect(stepReplacements).toHaveLength(0);
                expect(screen.findByTestId('guided-automation-lookAt')).not.toBeNull();
            } finally { unsubscribe(); }
        } finally { await screen.unmount(); }
    }));

    it('keeps the exact unavailable Stop refusal typed with a recovery step', async () => {
        const row = service('Web', { generation: 'b1c428a4-7926-46de-b6cd-71a59d6ebc3c', state: 'healthy' });
        answerResource(MachineServicesListResultV1Schema.parse({ kind: 'snapshot', services: [row] }));
        machineTransport.rpc.mockImplementation(async ({ method }: { method: string }) => {
            if (method === RPC_METHODS.MACHINES_SERVICE_DETAIL) return { kind: 'service', service: row };
            if (method === RPC_METHODS.MACHINES_SERVICE_CONTROL) return {
                ok: false, errorCode: 'service_operation_unavailable', error: 'service_operation_unavailable',
            };
            throw new Error(`Unexpected Machine method: ${method}`);
        });
        const { screen } = await mount({ params: { id: 'services', page: 'service', service: row.serviceId } });
        await vi.waitFor(() => expect(machineTransport.rpc.mock.calls.some(([call]) => call.method === RPC_METHODS.MACHINES_SERVICE_DETAIL)).toBe(true));
        await vi.waitFor(() => expect(screen.findHostByTestId('machine-service-more')).not.toBeNull());
        await screen.pressByTestIdAsync('machine-service-more');
        await vi.waitFor(() => expect(screen.findHostByTestId('machine-service-stop')).not.toBeNull());
        await screen.pressByTestIdAsync('machine-service-stop');
        await vi.waitFor(() => expect(machineTransport.rpc.mock.calls.filter(([call]) => call.method === RPC_METHODS.MACHINES_SERVICE_CONTROL)).toHaveLength(1));
        await vi.waitFor(() => expect(screen.findHostByTestId('machine-service-control-outcome-details-toggle'), screen.getTextContent()).not.toBeNull());
        expect(screen.getTextContent()).toContain(t('machineServices.control.unavailableRemedy'));
        expect(screen.getTextContent()).not.toContain(t('machineServices.control.failed', { service: row.name }));
        await screen.pressByTestIdAsync('machine-service-control-outcome-details-toggle');
        expect(screen.getTextContent()).toContain('service_operation_unavailable');
        expect(machineTransport.rpc.mock.calls.filter(([call]) => call.method === RPC_METHODS.MACHINES_SERVICE_CONTROL)).toHaveLength(1);
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
        await vi.waitFor(() => expect(machineTransport.rpc.mock.calls.some(([call]) => call.method === RPC_METHODS.MACHINES_SERVICE_DETAIL)).toBe(true));
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
        machineTransport.rpc.mockImplementation(async ({ method, payload }) => {
            if (method === RPC_METHODS.MACHINES_SERVICE_UNWATCH) {
                unwatches.push(payload);
                return { kind: 'applied', revision: 'revision-b' };
            }
            return { kind: 'service', service: row };
        });
        const { screen } = await mount({ params: { id: 'services', page: 'service', service: row.serviceId } });
        await vi.waitFor(() => expect(screen.findHostByTestId('machine-service-more')).not.toBeNull());
        await screen.pressByTestIdAsync('machine-service-more');
        await vi.waitFor(() => expect(screen.findHostByTestId('machine-service-unwatch')).not.toBeNull());
        await screen.pressByTestIdAsync('machine-service-unwatch');
        await vi.waitFor(() => expect(unwatches).toEqual([{ serverId: serverIdentityId, machineId,
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
        machineTransport.rpc.mockImplementation(async ({ method, payload: input }) => {
            if (method === RPC_METHODS.MACHINES_SERVICE_DETAIL) return { kind: 'service', service: row };
            if (method !== RPC_METHODS.MACHINES_SERVICE_CONTROL) throw new Error(`Unexpected Machine method: ${String(method)}`);
            controls.push(input);
            return { kind: 'observed', serviceId: row.serviceId, generation: row.generation,
                state: 'stopped', operation: { operationId: 'stop-operation' } };
        });
        const { screen } = await mount({ params: { id: 'services', page: 'service', service: row.serviceId } });
        await vi.waitFor(() => expect(machineTransport.rpc.mock.calls.some(([call]) => call.method === RPC_METHODS.MACHINES_SERVICE_DETAIL)).toBe(true));
        await vi.waitFor(() => expect(screen.findHostByTestId('machine-service-more')).not.toBeNull());
        await vi.dynamicImportSettled();
        await screen.pressByTestIdAsync('machine-service-more');
        await vi.waitFor(() => expect(screen.findHostByTestId('machine-service-stop')).not.toBeNull());
        await screen.pressByTestIdAsync('machine-service-stop');
        await vi.dynamicImportSettled();
        await vi.waitFor(() => {
            const outcome = screen.findByTestId('machine-service-control-outcome');
            expect({ controls, outcome: outcome ? textOf(outcome) : null }).toEqual({
                controls: [{ serverId: serverIdentityId, machineId, serviceId: row.serviceId, expectedGeneration: row.generation, operation: 'stop' }],
                outcome: null,
            });
        });
        await list.publish(MachineServicesListResultV1Schema.parse({ kind: 'snapshot', services: [{ ...row, state: 'stopped' }] }));
        await vi.waitFor(() => expect(screen.findHostByTestId('machine-service-start')).not.toBeNull());
        expect(screen.findHostByTestId('machine-service-stop')).toBeNull();
    });

    it('retains the current Services list across remounts and still receives a real change', async () => {
        const list = answerResource(MachineServicesListResultV1Schema.parse({ kind: 'snapshot', services: [service('Web')] }));
        let mounted = await mount();
        try {
            await vi.waitFor(() => expect(mounted.screen.findHostByTestId('machine-service-web')).not.toBeNull());
            expect(list.reads).toBe(1);
            await mounted.screen.unmount();
            mounted = await mount();
            await vi.waitFor(() => expect(mounted.screen.findHostByTestId('machine-service-web')).not.toBeNull());
            expect(list.reads, 'current list remount performs zero additional Resource reads').toBe(1);
            await list.publish(MachineServicesListResultV1Schema.parse({ kind: 'snapshot', services: [service('Database')] }));
            await measureMountedCollections(mounted.screen);
            await vi.waitFor(() => expect(mounted.screen.findHostByTestId('machine-service-database')).not.toBeNull());
            expect(list.reads).toBe(2);
        } finally { await mounted.screen.unmount(); }
    });

    it('opens an admitted service row into its facts and redacted logs, then returns to the list', async () => {
        const row = service('Postgres', { port: 5432, nativeInstance: {
            adapter: { pluginId: 'happier.machine.services', localId: 'systemd' }, nativeResourceId: 'postgresql.service',
        }, native: { phase: 'running', readiness: 'ready', displayName: 'PostgreSQL service' } });
        answerResource(MachineServicesListResultV1Schema.parse({ kind: 'snapshot', services: [row] }));
        machineTransport.rpc.mockImplementation(async ({ method }: { method: string }) => {
            if (method !== RPC_METHODS.MACHINES_SERVICE_DETAIL) throw new Error(`Unexpected Machine method: ${method}`);
            return { kind: 'service', service: row,
                accounting: { kind: 'sample', samples: [{ nativeResourceId: 'postgresql.service', cpuPercent: 3, memoryBytes: 64 * 1024 * 1024 }] } };
        });
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
        await vi.waitFor(() => expect(screen.getTextContent()).toContain('64 MB'));
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

    it('offers Deploy an app here, opening New app with this Machine chosen, on the empty and the listed page', async () => {
        const { buildPluginsHomeRoute } = await import('@/components/settings/plugins/model/pluginsSurfaceRoutes');
        const expected = buildPluginsHomeRoute('app', { view: 'kind', kind: 'app', machine: { serverId, machineId } });
        const list = answerResource(MachineServicesListResultV1Schema.parse({ kind: 'snapshot', services: [] }));
        const { screen } = await mount();
        await vi.waitFor(() => expect(screen.findHostByTestId('machine-services-empty')).not.toBeNull());
        await screen.pressByTestIdAsync('machine-services-deploy-here');
        await vi.waitFor(() => expect(router.push).toHaveBeenLastCalledWith(expected));
        vi.mocked(router.push).mockClear();
        await list.publish(MachineServicesListResultV1Schema.parse({ kind: 'snapshot', services: [service('Web')] }));
        await measureMountedCollections(screen);
        await vi.waitFor(() => expect(screen.findHostByTestId('machine-service-web')).not.toBeNull());
        await screen.pressByTestIdAsync('machine-services-deploy-here');
        await vi.waitFor(() => expect(router.push).toHaveBeenLastCalledWith(expected));
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
        // The row's disclosure says whether its services are shown, before and after the person opens it.
        const disclosure = () => screen.findHostByTestId('machine-services-environment-hidden-environment:disclosure');
        const expanded = () => disclosure()?.props['aria-expanded'] ?? disclosure()?.props.accessibilityState?.expanded;
        expect(expanded()).toBe(false);
        expect(screen.findHostByTestId('machine-service-web')).toBeNull();
        await screen.pressByTestIdAsync('machine-services-environment-hidden-environment');
        await vi.waitFor(() => expect(screen.findHostByTestId('machine-service-web')).not.toBeNull());
        expect(expanded()).toBe(true);
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
        await vi.waitFor(() => expect(screen.getTextContent()).toContain('Storefront · Production'));
        // One row per Environment (lab `services/list`): its services stay under it until the person opens the row.
        expect(screen.findHostByTestId(`machine-services-environment-${environment.id}`)).not.toBeNull();
        expect(screen.findHostByTestId('machine-service-web')).toBeNull();
        expect(screen.getTextContent()).toContain(t('machineServices.environmentRow.services', { count: 1 }));
        // Its disclosure says whether its services are shown.
        const disclosure = () => screen.findHostByTestId(`machine-services-environment-${environment.id}:disclosure`);
        expect(disclosure()?.props['aria-expanded'] ?? disclosure()?.props.accessibilityState?.expanded).toBe(false);
        await screen.pressByTestIdAsync(`machine-services-environment-${environment.id}`);
        await vi.waitFor(() => expect(screen.findHostByTestId('machine-service-web')).not.toBeNull());
        expect(disclosure()?.props['aria-expanded'] ?? disclosure()?.props.accessibilityState?.expanded).toBe(true);
        const linkId = `machine-services-environment-${environment.id}:open`;
        expect(screen.findHostByTestId(linkId)?.props.accessibilityLabel)
            .toBe(`${t('machineServices.groups.openEnvironment')}, Storefront · Production`);
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

    it.each([false, true])('watches the services the person picks from what the Machine discovers, once each (initially empty: %s)', async (initiallyEmpty) => {
        const adapter = { pluginId: 'happier.machine.services', localId: 'systemd' };
        const watched = service('Postgres', { nativeInstance: { adapter, nativeResourceId: 'postgresql.service' } });
        answerResource(MachineServicesListResultV1Schema.parse({ kind: 'snapshot', services: initiallyEmpty ? [] : [watched] }));
        const candidate = (name: string, unit: string) => ({ candidateId: `candidate-${name}`, revision: `revision-${name}`, name,
            adapter, nativeResourceId: unit, observation: { phase: 'running', readiness: 'not_reported', endpoint: null } });
        const watches: unknown[] = [];
        machineTransport.rpc.mockImplementation(async ({ method, payload }: { method: string; payload: unknown }) => {
            if (method === RPC_METHODS.MACHINES_SERVICE_DISCOVERY) return { kind: 'snapshot', failures: [],
                candidates: [candidate('fail2ban', 'fail2ban.service'), candidate('postgres', 'postgresql.service')] };
            if (method === RPC_METHODS.MACHINES_SERVICE_WATCH) { watches.push(payload); return { kind: 'applied', revision: 'next' }; }
            throw new Error(`Unexpected Machine method: ${method}`);
        });
        const { screen } = await mount();
        await vi.waitFor(() => expect(screen.findHostByTestId(initiallyEmpty ? 'machine-services-empty' : 'machine-service-postgres')).not.toBeNull());
        // Nothing is discovered until the person asks.
        expect(machineTransport.rpc.mock.calls.some(([call]) => call.method === RPC_METHODS.MACHINES_SERVICE_DISCOVERY)).toBe(false);
        await screen.pressByTestIdAsync('machine-services-watch');
        await vi.waitFor(() => expect(screen.findHostByTestId('machine-services-watch-candidate:candidate-fail2ban')).not.toBeNull());
        // What is already watched stays visible but can't be picked again.
        if (!initiallyEmpty) expect(screen.getTextContent()).toContain(t('machineServices.watch.alreadyWatched'));
        // Nothing picked yet: the confirm reads "Watch", never a zero count.
        expect(screen.getTextContent()).not.toContain(t('machineServices.watch.confirm', { count: 0 }));
        expect(screen.getTextContent()).toContain(t('machineServices.watch.confirmNone'));
        await screen.pressByTestIdAsync('machine-services-watch-candidate:candidate-fail2ban');
        await vi.waitFor(() => expect(screen.getTextContent()).toContain(t('machineServices.watch.confirm', { count: 1 })));
        await screen.pressByTestIdAsync('machine-services-watch-confirm');
        await vi.waitFor(() => expect(watches).toHaveLength(1));
        expect(machineTransport.rpc.mock.calls.filter(([call]) => call.method === RPC_METHODS.MACHINES_SERVICE_DISCOVERY)).toHaveLength(1);
        expect(watches[0]).toMatchObject({ machineId, candidateId: 'candidate-fail2ban', expectedRevision: 'revision-fail2ban',
            lifecyclePurpose: 'development' });
    });

    it('lines Port, Memory and Up up as columns on a wide page and says them in the byline on a phone', async () => {
        const startedAtMs = Date.now() - 4 * 3_600_000;
        const row = service('Web', { state: 'healthy', port: 3000, accounting: { memoryBytes: 98 * 1024 * 1024, startedAtMs } });
        answerResource(MachineServicesListResultV1Schema.parse({ kind: 'snapshot', services: [row, service('Worker')] }));
        const { screen } = await mount();
        await vi.waitFor(() => expect(screen.findHostByTestId('machine-service-web')).not.toBeNull());
        const cell = (key: string) => screen.findHostByTestId(`machine-service-web:column:${key}`);
        await vi.waitFor(() => expect(cell('memory')).not.toBeNull());
        expect(textOf(cell('memory')!)).toContain('98 MB');
        expect(textOf(cell('up')!)).toBe(t('machineVitals.alerts.durations.hours', { hours: 4 }));
        expect(screen.findHostByTestId('machine-service-web:port')).not.toBeNull();
        // A row with nothing to report keeps the columns' places, so the figures still line up.
        expect(screen.findHostByTestId('machine-service-worker:column:memory')).not.toBeNull();
        expect(screen.findHostByTestId('machine-services-table:sheet-header')).not.toBeNull();
        expect(screen.getTextContent()).not.toContain(t('machineVitals.header.upHours', { hours: 4 }));

        await measureMountedCollections(screen, { width: 390 });
        await vi.waitFor(() => expect(cell('memory')).toBeNull());
        expect(screen.findHostByTestId('machine-services-table:sheet-header')).toBeNull();
        expect(screen.getTextContent()).toContain('98 MB');
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
        expect(screen.getTextContent()).toContain('98 MB');
        await screen.pressByTestIdAsync('machine-service-web');
        await vi.waitFor(() => expect(screen.findHostByTestId('machine-service-since')).not.toBeNull());
        await vi.waitFor(() => expect(screen.getTextContent()).toContain('listening on :80'));
        expect(screen.findHostByTestId('machine-service-logs-masking')).not.toBeNull();
    });

    it('measures each replica on open and again on Measure again, keeping the last figures while it reads', async () => {
        const row = service('Web', { state: 'healthy' });
        answerResource(MachineServicesListResultV1Schema.parse({ kind: 'snapshot', services: [row] }));
        const reads: Array<(value: unknown) => void> = [];
        machineTransport.rpc.mockImplementation(({ method }: { method: string }) => method === RPC_METHODS.MACHINES_SERVICE_DETAIL
            ? new Promise(resolve => { reads.push(resolve); }) : Promise.resolve({ kind: 'unavailable', reason: 'unavailable' }));
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
        expect(usage()).toContain('48 MB');
        expect(usage()).toContain('2 MB');
        expect(usage()).toContain('0 B');
        expect(usage()).toContain(`3 · ${t('machineServices.facts.notReported')}`);
        // A replica whose sample omits its figures says so instead of reading as zero.
        expect(usage()).toContain(t('machineServices.facts.notReported'));
        await screen.pressByTestIdAsync('machine-service-measure');
        await vi.waitFor(() => expect(reads).toHaveLength(2));
        expect(usage()).toContain('48 MB');
        await act(async () => { reads[1]!(sample(30, 64)); });
        await vi.waitFor(() => expect(usage()).toContain('64 MB'));
        expect(usage()).toContain('30%');
    });
});
