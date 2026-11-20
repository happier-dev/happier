import 'fake-indexeddb/auto';
import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';

import { createDeferred, renderHook, renderScreen, standardCleanup } from '@/dev/testkit';
import { PluginAutomationSubjectPicker } from '@/components/plugins/surfaces/PluginAutomationSubjectPicker';
import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { serveActionHomes } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { initializeRealAppRuntimeForTests } from '@/dev/testkit/harness/realAppRuntimeHarness';
import { captureLazyActionAccountContext } from '@/sync/ops/actions/actionAccountContext';
import { useAutomationSubjectPicker } from './useAutomationSubjectPicker';
import { PluginProjectedActionV2Schema, DaemonContributionRegistryProjectionDescribeResponseSchema } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import { projectPluginSubjectKindDeclarationV1 } from '@happier-dev/protocol/plugins/contributions/subjectKinds';
import { ExternalActionExecutionAuthorizationRequestV1Schema, ExternalActionRequestEnvelopeV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { computeExternalActionRequestEnvelopeDigestV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { createPlainMachineRowFixture, createMachineReadBatchResponseFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { EMPTY_PLUGIN_UI_PROJECTION } from '@/sync/domains/plugins/ui/projection';
import { unionPluginUiProjections } from '@/sync/domains/plugins/ui/projectionUnion';
import { publishCommittedAppShellPluginUiProjection } from '@/components/appShell/plugins/committedPluginUiProjection';
import { encodeBase64 } from '@happier-dev/protocol/crypto/base64';
import tweetnacl from 'tweetnacl';

// The selected daemon's schema RPC is an external boundary; Action admission and dispatch stay real.
const daemonRpc = vi.hoisted(() => vi.fn());
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({ machineRpcWithServerScope: daemonRpc }));

await initializeRealAppRuntimeForTests();
afterEach(standardCleanup);

it('demands one addressed App page at a time, preserves partial coverage and retries a failed continuation', async () => {
    let failContinuation = true;
    const reads: URL[] = [];
    const home = await serveActionHomes({ homes: [
        { key: 'addressed', serverUrl: 'https://subject-picker-addressed.test', accountId: 'author' },
        { key: 'focused', serverUrl: 'https://subject-picker-focused.test', accountId: 'other' },
    ], route: request => {
        if (request.path !== '/v1/projects/sources') return undefined;
        expect(request.home).toBe('addressed');
        expect(request.accountId).toBe('author');
        reads.push(request.url);
        if (request.url.searchParams.has('cursor') && failContinuation) return Response.json({ error: 'offline' }, { status: 503 });
        const second = request.url.searchParams.has('cursor');
        return Response.json({ ok: true, sources: [{ id: second ? 'source-b' : 'source-a', revision: 1,
            name: second ? 'Second App' : 'First App', audience: [], createdByAccountId: 'author' }],
        coverage: { complete: false, nextCursor: second ? null : 'page-two' } });
    } });
    const account = await captureLazyActionAccountContext(home.homes.addressed!.id);
    try {
        const hook = await renderHook((props: { demanded: boolean }) => useAutomationSubjectPicker({
            kind: { kind: 'app' }, lifetime: account.accountLifetime, demanded: props.demanded,
            query: 'store', limit: 7,
        }), { initialProps: { demanded: false } });
        expect(hook.getCurrent().status).toBe('idle');
        expect(reads).toHaveLength(0);
        await hook.rerender({ demanded: true });
        await vi.waitFor(() => expect(hook.getCurrent().status).toBe('ready'));
        expect(hook.getCurrent()).toMatchObject({ coverage: 'partial', hasMore: true,
            items: [{ label: 'First App', subject: { kind: 'app', serverId: home.homes.addressed!.id, projectSourceId: 'source-a' } }] });
        expect(reads).toHaveLength(1);
        expect(reads[0]!.searchParams.get('query')).toBe('store');
        expect(reads[0]!.searchParams.get('limit')).toBe('7');
        await act(async () => { await hook.getCurrent().loadMore(); });
        expect(hook.getCurrent().status).toBe('error');
        expect(hook.getCurrent().error).toBeInstanceOf(Error);
        expect(hook.getCurrent().items).toHaveLength(1);
        failContinuation = false;
        await act(async () => { await hook.getCurrent().loadMore(); });
        expect(hook.getCurrent()).toMatchObject({ status: 'ready', coverage: 'partial', hasMore: false });
        expect(hook.getCurrent().items.map(item => item.label)).toEqual(['First App', 'Second App']);
        expect(reads.map(url => url.searchParams.get('cursor'))).toEqual([null, 'page-two', 'page-two']);
        await hook.unmount();
    } finally { account.dispose(); await home.dispose(); }
});

it('withdraws a retired borrowed Account and ignores its in-flight answer without acquiring the focused Account', async () => {
    const pending = createDeferred<Response>();
    const reads: string[] = [];
    const home = await serveActionHomes({ homes: [
        { key: 'addressed', serverUrl: 'https://subject-picker-retired.test', accountId: 'author' },
        { key: 'focused', serverUrl: 'https://subject-picker-other.test', accountId: 'other' },
    ], route: request => {
        if (request.path !== '/v1/projects/sources') return undefined;
        reads.push(request.home);
        return pending.promise;
    } });
    const account = await captureLazyActionAccountContext(home.homes.addressed!.id);
    try {
        const hook = await renderHook(() => useAutomationSubjectPicker({ kind: { kind: 'app' },
            lifetime: account.accountLifetime, demanded: true }));
        await vi.waitFor(() => expect(reads).toEqual(['addressed']));
        await act(async () => { await home.switchAccount('addressed', 'replacement'); });
        expect(hook.getCurrent()).toMatchObject({ status: 'idle', items: [], hasMore: false });
        await act(async () => { pending.resolve(Response.json({ ok: true,
            sources: [{ id: 'stale', revision: 1, name: 'Stale App', audience: [], createdByAccountId: 'author' }],
            coverage: { complete: true, nextCursor: null } })); });
        expect(hook.getCurrent()).toMatchObject({ status: 'idle', items: [] });
        await act(async () => { await hook.getCurrent().reload(); });
        expect(reads).toEqual(['addressed']);
        await hook.unmount();
    } finally { account.dispose(); await home.dispose(); }
});

it.each([{ query: 'fix' }, { query: 'fix', limit: 3 }])('uses contributed page demand %j and the physical Action target while retaining plugin qualification', async (page) => {
    const pluginId = 'acme.tickets';
    const action = { pluginId, localId: 'list-tickets' };
    const machineId = 'picker-machine';
    const serverIdentityId = 'srv_picker';
    const pages: unknown[] = [];
    const installation = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(3));
    const machine = { ...createPlainMachineRowFixture({ id: machineId, accountId: 'author' }),
        active: true, installationId: 'picker-installation', installationPublicKey: encodeBase64(installation.publicKey) };
    const home = await serveActionHomes({ homes: [
        { key: 'addressed', serverUrl: 'https://plugin-picker-contribution.test', accountId: 'author', serverIdentityId, currentAccount: true },
        { key: 'focused', serverUrl: 'https://plugin-picker-contribution-other.test', accountId: 'other' },
    ], route: async request => {
        if (request.path === '/v1/machines') return Response.json([machine]);
        if (request.path === `/v1/machines/${machineId}`) return Response.json({ machine });
        if (request.path === '/v1/machines/read-batch') {
            return createMachineReadBatchResponseFixture(request.body, id => id === machineId ? machine : null);
        }
        if (request.path === '/v1/actions/action.invoke/execution-authorization') {
            const { envelope } = ExternalActionExecutionAuthorizationRequestV1Schema.parse(request.body);
            return Response.json({ v: 1, token: 'picker-action-proof', binding: { serverIdentityId, accountId: 'author',
                authentication: { kind: 'account', tokenEpoch: 0 }, actionId: 'action.invoke', requestId: envelope.requestId,
                target: envelope.target, machineId, installationId: machine.installationId, custodianAccountId: 'author',
                accountEncryptionMode: 'plain', machineRuntimeDemand: 'required',
                requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope) } });
        }
        if (request.path !== '/v1/actions/action.invoke') return undefined;
        expect(request.home).toBe('addressed');
        expect(request.accountId).toBe('author');
        const forwarded = ExternalActionRequestEnvelopeV1Schema.safeParse(request.body);
        const envelope = forwarded.success ? forwarded.data : ExternalActionExecutionAuthorizationRequestV1Schema.parse(request.body).envelope;
        expect(envelope.target).toEqual({ kind: 'machine', machineId });
        expect(envelope.input).toMatchObject({ action });
        const input = Reflect.get(envelope.input as object, 'input');
        pages.push(input);
        const second = Reflect.get(input, 'cursor') !== undefined;
        return Response.json({ v: 1, actionId: 'action.invoke', requestId: envelope.requestId, execution: { ok: true,
            result: { items: [{ identity: { ticketId: second ? 'ticket-b' : 'ticket-a' }, label: second ? 'Second ticket' : 'First ticket' }],
                nextCursor: second ? null : 'next-ticket' } } });
    } });
    const account = await captureLazyActionAccountContext(home.homes.addressed!.id);
    const executionOrigin = { serverIdentityId, materializationRef: {
        pluginId, machineId, materializationId: 'tickets-current' } };
    const projected = PluginProjectedActionV2Schema.parse({ id: action.localId, pluginId, title: 'List tickets',
        scopes: ['global', 'machine'], surfaces: ['ui'], execution: { target: 'daemon' },
        dangerLevel: 'safe', readOnly: true, occurrenceId: 'tickets:current', available: true, executionOrigin });
    const declaration = { pluginId, definition: { id: 'ticket', label: 'Ticket', listAction: action.localId,
        identitySchema: { type: 'object' as const, additionalProperties: false, required: ['ticketId'],
            properties: { ticketId: { type: 'string' as const } } } } };
    const entry = projectPluginSubjectKindDeclarationV1({ ...declaration, pluginVersion: '1.0.0' });
    const projection = DaemonContributionRegistryProjectionDescribeResponseSchema.parse({ protocolVersion: 1, projection: {
        v: 2, generation: 1, installedPackagesById: {}, agentsById: {},
        actionsById: { [`${pluginId}/${action.localId}`]: projected }, resourcesById: {}, settingsById: {},
        familiesById: { subjectKinds: { family: 'subjectKinds', entriesById: { [entry.id]: entry } } }, diagnostics: [],
    } });
    daemonRpc.mockImplementation(async (request: { method: string }) => {
        if (request.method === RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE) return projection;
        if (request.method === RPC_METHODS.DAEMON_PLUGIN_ACTION_SCHEMAS_READ) return { ok: true,
            inputSchema: { type: 'object' }, outputSchema: { type: 'object' } };
        throw new Error(`Unanswered picker RPC: ${request.method}`);
    });
    const union = unionPluginUiProjections([{ machineId, serverId: home.homes.addressed!.id, serverIdentityId,
        selectableExecutionOrigins: [executionOrigin],
        phase: 'current', interactionEnabled: true, projection: { ...EMPTY_PLUGIN_UI_PROJECTION, generation: 1,
            actionsById: { [`${pluginId}/${action.localId}`]: projected } } }], new Map([[pluginId, executionOrigin]]));
    const withdraw = publishCommittedAppShellPluginUiProjection(() => union.pluginUiProjection);
    try {
        const context = { externalActionTarget: { kind: 'machine' as const, machineId } };
        const subjectKinds = [entry];
        const hook = await renderHook((props: { demanded: boolean; subjectKinds: typeof subjectKinds }) => useAutomationSubjectPicker({
            kind: { kind: 'plugin', pluginId, subjectKindId: 'ticket' }, page, subjectKinds: props.subjectKinds,
            lifetime: account.accountLifetime, demanded: props.demanded, context,
        }), { initialProps: { demanded: false, subjectKinds } });
        expect(hook.getCurrent().status).toBe('idle');
        expect(pages).toHaveLength(0);
        await hook.rerender({ demanded: true, subjectKinds });
        await vi.waitFor(() => expect(hook.getCurrent()).toMatchObject({ status: 'ready', error: null }));
        expect(hook.getCurrent()).toMatchObject({ hasMore: true, items: [
            { label: 'First ticket', subject: { kind: 'plugin', serverId: home.homes.addressed!.id,
                pluginId, subjectKindId: 'ticket', identity: { ticketId: 'ticket-a' } } },
        ] });
        await act(async () => { await hook.getCurrent().loadMore(); });
        expect(hook.getCurrent()).toMatchObject({ status: 'ready', hasMore: false, items: [
            { label: 'First ticket', subject: { kind: 'plugin', serverId: home.homes.addressed!.id,
                pluginId, subjectKindId: 'ticket', identity: { ticketId: 'ticket-a' } } },
            { label: 'Second ticket', subject: { kind: 'plugin', serverId: home.homes.addressed!.id,
                pluginId, subjectKindId: 'ticket', identity: { ticketId: 'ticket-b' } } },
        ] });
        expect(pages).toEqual([page, { ...page, cursor: 'next-ticket' }]);
        // A refreshed projection can allocate equal declarations. It must not discard
        // the second page or issue another list read for an unchanged picker demand.
        const loaded = hook.getCurrent().items;
        await hook.rerender({ demanded: true, subjectKinds: structuredClone(subjectKinds) });
        expect(hook.getCurrent()).toMatchObject({ status: 'ready', hasMore: false });
        expect(hook.getCurrent().items).toBe(loaded);
        expect(pages).toEqual([page, { ...page, cursor: 'next-ticket' }]);
        await hook.unmount();

        // App pages have no addressed resource Machine. Their host's selected
        // execution target still owns the contributed list Action and its catalog.
        const onChange = vi.fn();
        const screen = await renderScreen(<PluginAutomationSubjectPicker
            kind={{ kind: 'plugin', pluginId, subjectKindId: 'ticket' }} page={page}
            value={null} onChange={onChange} target={{ kind: 'app' }} context={context}
            accountLifetime={account.accountLifetime} isCurrent={account.accountLifetime.isCurrent} />);
        expect(pages).toHaveLength(2);
        const menu = () => screen.findByType(DropdownMenu);
        await act(async () => { menu().props.onOpenChange(true); });
        await vi.waitFor(() => expect(menu().props.items).toEqual(expect.arrayContaining([
            expect.objectContaining({ title: 'First ticket' }),
        ])));
        const first = menu().props.items.find((item: { title: string }) => item.title === 'First ticket');
        await act(async () => { menu().props.onSelect(first.id); });
        expect(onChange).toHaveBeenCalledWith({ kind: 'plugin', serverId: home.homes.addressed!.id,
            pluginId, subjectKindId: 'ticket', identity: { ticketId: 'ticket-a' } });
        expect(pages).toEqual([page, { ...page, cursor: 'next-ticket' }, page]);
        await screen.unmount();
    } finally { withdraw(); account.dispose(); await home.dispose(); }
});
