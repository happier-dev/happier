import * as React from 'react';
import { createHash } from 'node:crypto';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { router } from 'expo-router';
import { MachineServiceRowV1Schema, MachineServicesListResultV1Schema, ManagedServiceNativeLogResultV1Schema, type MachineServiceRowV1 } from '@happier-dev/protocol';
import { ExternalActionExecutionAuthorizationRequestV1Schema, ExternalActionRequestEnvelopeV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { computeExternalActionRequestEnvelopeDigestV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { createDeploymentEnvironmentHeaderV1 } from '@happier-dev/deployment-protocol/testing/v1';
import { DEPLOYMENT_ENVIRONMENT_ARTIFACT_KIND_V1 } from '@happier-dev/deployment-protocol/v1';

import { createDeferred, renderScreen, standardCleanup } from '@/dev/testkit';
import { createMachineReadBatchResponseFixture, createPlainMachineRowFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries, type HomeDomainAnswer } from '@/dev/testkit/harness/homeGovernanceHarness';
import { initializeRealAppRuntimeForTests } from '@/dev/testkit/harness/realAppRuntimeHarness';
import { measureMountedCollections } from '@/dev/testkit/render/renderInCollectionLayout';
import type { MachinePageTabParams } from '@/components/machines/page/machinePageTabQuery';
import { ListPresentationProvider } from '@/components/ui/lists/listPresentation';
import { t } from '@/text';

// Only Home HTTP, Machine RPC and Socket boundaries are substituted. The tab, Actions,
// credential admission, Resource lifecycle, collection and detail hooks stay real.
const machineTransport = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', async () => {
    const { createServerScopedMachineRpcBoundaryMock } = await import('@/dev/testkit/mocks/serverScopedRpc');
    return createServerScopedMachineRpcBoundaryMock(machineTransport.rpc);
});
const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
const { MachineServicesTab } = await import('./MachineServicesTab');

let serverId: string;
const accountId = 'account';
const machineId = 'machine';
const machineName = 'Development machine';
const serverIdentityId = 'srv_services_rendered';
type Envelope = ReturnType<typeof ExternalActionRequestEnvelopeV1Schema.parse>;
type Request = Parameters<NonNullable<HomeDomainAnswer['select']>>[1];

function service(name: string, overrides: Partial<MachineServiceRowV1> = {}) {
    return MachineServiceRowV1Schema.parse({
        serviceId: name.toLowerCase(), name, authority: 'machine', lifecyclePurpose: 'development',
        generation: 'generation-a', state: 'running', watchId: `watch-${name}`, watchRevision: 'revision-a',
        capabilities: { start: true, stop: true, restart: true, logs: true, accounting: true },
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
            installationId: 'installation', custodianAccountId: accountId, accountEncryptionMode: 'plain',
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
function answerResource<T>(initial: T, actionId: 'machines.services.list' | 'machines.services.logs.read' = 'machines.services.list') {
    let value = initial;
    let failed = false;
    let deliver: (() => void) | undefined;
    let reads = 0;
    const content = () => {
        const bytes = Buffer.from(JSON.stringify(value));
        return { contentType: 'application/json', bytesBase64: bytes.toString('base64'),
            digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}` };
    };
    answerAction(actionId, (envelope, request) => {
        const continuation = envelope.resourceContinuation;
        if (!continuation) return value;
        if (continuation.method === RPC_METHODS.DAEMON_PLUGIN_UI_RESOURCE_READ) {
            reads++;
            return failed ? { ok: false, code: 'service_transport_unavailable', reason: 'unavailable' }
                : { ok: true, resource: continuation.params.resource, ...content() };
        }
        if (continuation.method === RPC_METHODS.DAEMON_PLUGIN_UI_RESOURCE_WATCH_OPEN)
            return { ok: true, subscriptionId: continuation.params.subscriptionId, digest: content().digest };
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
                subscriptionId: continuation.params.subscriptionId, digest: failed ? `sha256:${'0'.repeat(64)}` : content().digest } });
            request.signal?.addEventListener('abort', abort, { once: true });
            if (request.signal?.aborted) abort();
        });
    });
    return {
        fail() { failed = true; },
        async publish(next: typeof value) {
            value = next;
            await vi.waitFor(() => expect(deliver).toBeTypeOf('function'));
            await act(async () => { deliver?.(); });
        },
        get reads() { return reads; },
    };
}

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
    const screen = await renderScreen(<ListPresentationProvider value="page"><Route /></ListPresentationProvider>);
    await measureMountedCollections(screen);
    return { screen, setParams, goOffline: async () => { await act(async () => { setPresence(false); }); } };
}

beforeEach(async () => {
    await homes.reset();
    machineTransport.rpc.mockReset();
    await initializeRealAppRuntimeForTests();
    installHomeGovernanceBoundaries(homes);
    serverId = await homes.addHome({ name: 'Services rendered', serverUrl: 'https://services-rendered.test',
        serverIdentityId, accountId, currentAccount: true, active: true });
    const row = { ...createPlainMachineRowFixture({ id: machineId, accountId }), installationId: 'installation' };
    homes.answer(serverId, 'POST /v1/machines/read-batch', { select: async input => ({ body:
        await createMachineReadBatchResponseFixture(input, () => row).json() }) });
    const { TokenStorage } = await import('@/auth/storage/tokenStorage');
    const { restoreConnectionToActiveServer } = await import('@/sync/runtime/orchestration/connectionManager');
    const credentials = await TokenStorage.getCredentialsForServerUrl('https://services-rendered.test', { serverId });
    if (!credentials) throw new Error('Services Home credentials unavailable');
    await restoreConnectionToActiveServer(credentials);
    vi.mocked(router.push).mockClear();
});
afterEach(async () => { standardCleanup(); await homes.reset(); });

describe('MachineServicesTab rendered production wiring', () => {
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
        expect(screen.findHostByTestId('machine-services-table:group:environment:hidden-environment:action')).toBeNull();
        await act(async () => { pending.resolve({ body: { ok: true, items: [], nextCursor: null } }); });
        await vi.waitFor(() => expect(screen.getTextContent()).toContain(t('machineServices.groups.environmentUnavailable')));
        expect(screen.findHostByTestId('machine-services-table:group:environment:hidden-environment:action')).toBeNull();
        expect(router.push).not.toHaveBeenCalled();
    });

    it('names readable Environment groups using the exact admitted Source and Environment', async () => {
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

    it('keeps last-known rows visible with a freshness warning when a pushed refresh fails', async () => {
        const value = MachineServicesListResultV1Schema.parse({ kind: 'snapshot', services: [service('Retained')] });
        const list = answerResource(value);
        const { screen } = await mount();
        await vi.waitFor(() => expect(screen.findHostByTestId('machine-service-retained')).not.toBeNull());
        list.fail();
        await list.publish(value);
        await vi.waitFor(() => expect(screen.findHostByTestId('machine-services-stale')).not.toBeNull());
        expect(screen.findHostByTestId('machine-service-retained')).not.toBeNull();
        expect(screen.findHostByTestId('machine-services-error')).toBeNull();
        expect(list.reads).toBeGreaterThan(1);
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
});
