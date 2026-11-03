import 'fake-indexeddb/auto';
import * as React from 'react';
import { Text, View } from 'react-native';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installApprovalCommonModuleMocks } from '@/components/approvals/approvalsTestHelpers';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries, waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { createSessionReadBatchFetchBoundary } from '@/dev/testkit/harness/sessionReadBatchHttpBoundary';
import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { flushHookEffects } from '@/dev/testkit/hooks/flushHookEffects';
import { getServerProfileById, resolveServerProfileScopeIdForIdentifier } from '@/sync/domains/server/serverProfiles';
import { installRealActionExecutorModuleLoader } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { createMachineFixture, createPlainMachineRowFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { storage } from '@/sync/domains/state/storage';
import type { InputFieldOptionsState } from './inputFieldOptionsStore';
import { recordMachineRequestFailed } from '@/sync/domains/machines/reachability/machineReachability';
import { createExternalActionAccountHttpBoundary } from '@/dev/testkit/harness/externalActionAccountHttpBoundary';
import { readBuiltinWidgetDescriptorV1 } from '@happier-dev/protocol/widgets/builtinWidgetDescriptorV1';
import { V2SessionRecordSchema } from '@happier-dev/protocol/sessions/control/contract';
import { SessionListQueryResponseV1Schema } from '@happier-dev/protocol/sessions/listing/response';
import { createSessionAccessFixture } from '@/dev/testkit/fixtures/sessionFixtures';

// Hoist the physical transport before cross-package imports can capture Socket.IO.
vi.mock('socket.io-client', async importOriginal => (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));
installApprovalCommonModuleMocks({ text: async () => vi.importActual<typeof import('@/text')>('@/text') });
const harness = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(harness);
const rpc = vi.hoisted(() => ({ read: vi.fn() }));
const optionsBoundaries = new Map<string, Awaited<ReturnType<typeof createExternalActionAccountHttpBoundary>>>();
async function requestOptions(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const url = new URL(String(input));
    return await optionsBoundaries.get(url.origin)?.handle(url, init) ?? harness.request(input, init);
}
installDisconnectedServerSocketBoundary(socket => {
    vi.mocked(socket.connect).mockImplementation(() => {
        socket.connected = true;
        for (const listener of socket.listeners('connect')) listener();
        return socket;
    });
    vi.spyOn(socket, 'emitWithAck').mockImplementation(async (event) => {
        if (event !== 'rpc-call') throw new Error(`Unexpected options transport event: ${event}`);
        throw new Error('Native contributed options must use the private Account HTTP carrier');
    });
});
const { useServerCredentialAccountScopeBinding } = await import('@/sync/domains/scope/useServerCredentialAccountScopes');
const { useInputFieldOptions } = await import('./useInputFieldOptions');
const { scopedHomeActionExecutor, resetScopedHomeActionExecutorsForTests } = await import('@/sync/ops/actions/scopedHomeActionExecutor');
const { repositoryInputTypeRef } = await import('../../../../../../packages/plugin-sdk/examples/public-authoring/inputTypes');
let disposeModuleLoader: (() => void) | undefined;
beforeEach(async () => { await harness.reset(); rpc.read.mockReset(); optionsBoundaries.clear(); resetScopedHomeActionExecutorsForTests();
    const { setRuntimeFetch } = await import('@/utils/system/runtimeFetch');
    // The scoped socket's authenticated readiness probe uses the raw network boundary,
    // distinct from the Home harness's scoped Action/row request adapters.
    setRuntimeFetch(async (input, init) => {
        const url = new URL(String(input));
        const home = harness.findByServerUrl(url.origin);
        if (url.pathname !== '/v1/auth/ping' || !home) return requestOptions(input, init);
        return Response.json(new Headers(init?.headers).get('Authorization') === `Bearer ${home.token}` ? { ok: true } : { error: 'unauthorized' },
            { status: new Headers(init?.headers).get('Authorization') === `Bearer ${home.token}` ? 200 : 401 });
    });
    disposeModuleLoader = await installRealActionExecutorModuleLoader();
});
afterEach(async () => {
    standardCleanup(); disposeModuleLoader?.(); disposeModuleLoader = undefined;
    const { resetRuntimeFetch } = await import('@/utils/system/runtimeFetch');
    resetRuntimeFetch();
});
const field = { path: 'repository', inputType: repositoryInputTypeRef };
const periodField = { path: 'period', inputType: { hostType: 'usageQuery', field: 'period' } } as const;

function MixedOptionsProbe(props: Readonly<{ serverId: string; workflow: string; observePeriod(state: InputFieldOptionsState): void }>) {
    const { binding } = useServerCredentialAccountScopeBinding(props.serverId);
    const consumer = { kind: 'workflow' as const, workflow: props.workflow };
    const options = useInputFieldOptions({ serverId: props.serverId, enabled: !!binding, accountLifetime: binding,
        requests: [field, periodField].map(field => ({ field, consumer, draftInput: { period: {} } })) });
    const period = options.state(periodField);
    props.observePeriod(period);
    return <View testID="mixed.options" accessibilityLabel={options.state(field).status} accessibilityHint={options.resolveOptions.pickerContext?.machineId ?? undefined}>
        {period.options.map(option => <Text key={option.label}>{option.label}</Text>)}
        {options.state(field).options.map(option => <Text key={option.label}>{option.label}</Text>)}
    </View>;
}

function OptionsProbe(props: Readonly<{ serverId: string; workflow: string; restricted?: boolean }>) {
    const { binding } = useServerCredentialAccountScopeBinding(props.serverId);
    const selectedField = props.restricted ? { ...field, options: [
        { value: { repositoryId: 'example/review-assistant' }, label: 'Authored repository' },
        { value: { repositoryId: 'outside-resource' }, label: 'Outside Resource' },
    ] } : field;
    const options = useInputFieldOptions({ serverId: props.serverId, machineId: 'controller-a', enabled: !!binding, accountLifetime: binding,
        requests: [{ field: selectedField, consumer: { kind: 'workflow', workflow: props.workflow }, draftInput: {} }] });
    const state = options.state(selectedField);
    return <View testID="native-field.options" accessibilityLabel={state.status} accessibilityHint={state.errorCode}>
        {state.options.map(option => <Text key={option.label}>{option.label}</Text>)}
    </View>;
}

const platformActionId = 'happier.deploy.vercel/actions/targets-inspect-v1';
const platformField = { path: 'providerIdentity.providerAccountId',
    inputType: { pluginId: 'happier.deploy.vercel', localId: 'provider-account' } };
function PlatformOptionsProbe(props: Readonly<{ serverId: string; draftInput: Record<string, unknown>; cursor?: string }>) {
    const { binding } = useServerCredentialAccountScopeBinding(props.serverId);
    const options = useInputFieldOptions({ serverId: props.serverId, machineId: 'controller-a', enabled: !!binding, accountLifetime: binding,
        requests: [{ actionId: platformActionId, field: platformField, draftInput: props.draftInput,
            ...(props.cursor ? { query: 'selected', cursor: props.cursor } : {}) }] });
    return <View testID="platform.options" accessibilityLabel={options.state(platformField).status}
        accessibilityHint={options.state(platformField).errorCode}>
        {options.state(platformField).options.map(option => <Text key={option.label}>{option.label}</Text>)}
    </View>;
}

function NativeSessionOptionsProbe(props: Readonly<{ serverId: string }>) {
    const { binding } = useServerCredentialAccountScopeBinding(props.serverId);
    const definition = { kind: 'builtin' as const, id: 'local_services' };
    const field = readBuiltinWidgetDescriptorV1(definition)!.inputs!.fields[0]!;
    const consumer = { kind: 'widget' as const, surface: { serverId: props.serverId, accountId: 'viewer',
        owner: { kind: 'project' as const, projectId: 'project' } }, definition };
    const options = useInputFieldOptions({ serverId: props.serverId, enabled: !!binding, accountLifetime: binding,
        requests: [{ field, consumer, draftInput: {} }] });
    const state = options.state(field);
    return <View testID="native-session.options" accessibilityLabel={state.status} accessibilityHint={state.errorCode}>
        {state.options.map(option => <Text key={option.label}>{option.label}</Text>)}
    </View>;
}

function SavedSessionOptionsProbe(props: Readonly<{ serverId: string; sessionId: string; asksOnlyForSaved: boolean }>) {
    const { binding } = useServerCredentialAccountScopeBinding(props.serverId);
    const definition = { kind: 'builtin' as const, id: 'session_summary' };
    const field = readBuiltinWidgetDescriptorV1(definition)!.inputs!.fields[0]!;
    const saved = { serverId: props.serverId, sessionId: props.sessionId };
    const consumer = { kind: 'widget' as const, surface: { serverId: props.serverId, accountId: 'viewer', owner: { kind: 'home' as const } }, definition };
    const options = useInputFieldOptions({ serverId: props.serverId, enabled: !!binding, accountLifetime: binding,
        requests: [{ field, consumer, draftInput: { session: saved }, ...(props.asksOnlyForSaved ? { values: [saved] } : {}) }] });
    const state = options.state(field, props.asksOnlyForSaved ? { consumer, draftInput: { session: saved }, values: [saved] } : undefined);
    return <View testID="saved-session.options" accessibilityLabel={state.status} accessibilityHint={state.errorCode}>
        {state.options.map(option => <Text key={option.label}>{option.label}</Text>)}
    </View>;
}

function NativePeriodOptionsProbe(props: Readonly<{ serverId: string; observe(state: InputFieldOptionsState): void }>) {
    const definition = { kind: 'builtin' as const, id: 'usage_flow' };
    const options = useInputFieldOptions({ serverId: props.serverId, enabled: true,
        requests: [{ field: periodField, consumer: { kind: 'widget', surface: { serverId: props.serverId,
            accountId: 'viewer', owner: { kind: 'home' } }, definition }, draftInput: { period: { relative: '30days' } } }] });
    const state = options.state(periodField);
    props.observe(state);
    return null;
}

async function createTypedWorkflow(serverId: string, accountId: string, definitionId = '00000000-0000-4000-8000-000000000051', mixed = false) {
    const home = getServerProfileById(serverId);
    if (!home?.serverIdentityId) throw new Error('Expected the options Home identity');
    // Exercise the current private Account HTTP carrier, including its real crypto.
    optionsBoundaries.set(new URL(home.serverUrl).origin, await createExternalActionAccountHttpBoundary({
        serverUrl: home.serverUrl, serverIdentityId: home.serverIdentityId, accountId,
        machineId: 'controller-a', actionId: 'action.options.resolve', tokenEpoch: 0,
        execute: (input, context) => {
            expect(context.invocation).toEqual({ caller: { kind: 'host' }, surface: 'ui', authority: 'present_user' });
            return rpc.read({ serverUrl: home.serverUrl, accountId, input, ...context });
        },
    }));
    const machine = createPlainMachineRowFixture({ id: 'controller-a', accountId });
    harness.answer(serverId, 'GET /v1/machines/controller-a', { body: { machine } });
    harness.answer(serverId, 'GET /v1/machines', { body: [machine] });
    const result = await scopedHomeActionExecutor({ serverId: resolveServerProfileScopeIdForIdentifier(serverId), accountId })('workflow.definition.create', {
        definitionId, definition: { version: 1, inputs: [{ name: 'repository', valueType: 'json', required: true, inputType: repositoryInputTypeRef },
            ...(mixed ? [{ name: 'period', valueType: 'json' as const, required: true, inputType: periodField.inputType }] : [])],
            defaults: {}, blocks: [{ kind: 'wait', id: 'review', document: { text: 'Review', references: [], attachments: [] }, result: { kind: 'text' } }] },
        metadata: { title: 'Input fixture' },
    }, { surface: 'ui', authority: 'present_user', serverId, runtimeAccountId: accountId });
    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect(harness.artifacts(serverId).list()).toHaveLength(1);
    return definitionId;
}
function reply(label: string) {
    return { actionId: 'workflow.run.start', fieldPath: field.path,
        optionsSourceId: `plugin-input:${repositoryInputTypeRef.pluginId}/${repositoryInputTypeRef.localId}`,
        options: [{ value: { repositoryId: 'example/review-assistant' }, label }] };
}

describe('qualified input field options scope', () => {
    it('carries the partial platform draft and paging through the UI Account HTTP executor', async () => {
        const origin = 'https://platform-options.example';
        const serverIdentityId = 'srv_platform_options';
        const serverId = await harness.addHome({ name: 'Platform choices', serverUrl: origin,
            serverIdentityId, accountId: 'viewer', currentAccount: true });
        optionsBoundaries.set(origin, await createExternalActionAccountHttpBoundary({ serverUrl: origin, serverIdentityId,
            accountId: 'viewer', machineId: 'controller-a', actionId: 'action.options.resolve', tokenEpoch: 0,
            execute: input => rpc.read(input) }));
        const machine = createPlainMachineRowFixture({ id: 'controller-a', accountId: 'viewer' });
        harness.answer(serverId, 'GET /v1/machines/controller-a', { body: { machine } });
        harness.answer(serverId, 'GET /v1/machines', { body: [machine] });
        const credentialRef = { service: { pluginId: 'happier.machine.vercel', localId: 'vercel-account' }, accountId: 'selected' };
        const draftInput = { v: 1, serverId, environmentId: 'environment-options', expectedRevision: 1, credentialRef,
            credentialPrincipal: { kind: 'account', accountId: 'viewer', purpose: { consumer: {
                pluginId: 'happier.deploy.vercel', localId: 'targets-inspect-v1' }, purpose: 'deploy.manage' },
                target: { kind: 'account', account: credentialRef } } };
        rpc.read.mockImplementation(async input => ({ actionId: platformActionId, fieldPath: platformField.path,
            optionsSourceId: 'plugin-input:happier.deploy.vercel/provider-account',
            options: [{ value: input.cursor ? 'team-selected' : 'user-selected', label: input.cursor ? 'Selected team' : 'Selected user' }] }));
        const screen = await renderScreen(<PlatformOptionsProbe serverId={serverId} draftInput={draftInput} />);
        try {
            await waitForHomeGovernance(() => expect(screen.findByTestId('platform.options')?.props.accessibilityLabel).not.toBe('loading'));
            expect({ status: screen.findByTestId('platform.options')?.props.accessibilityLabel,
                error: screen.findByTestId('platform.options')?.props.accessibilityHint, requests: rpc.read.mock.calls.length })
                .toEqual({ status: 'ready', error: undefined, requests: 1 });
            expect(screen.getTextContent()).toContain('Selected user');
            expect(rpc.read).toHaveBeenLastCalledWith({ actionId: platformActionId, fieldPath: platformField.path,
                draftInput: { ...draftInput, machineId: 'controller-a' } });
            await screen.update(<PlatformOptionsProbe serverId={serverId} draftInput={draftInput} cursor="from:next-team" />);
            await waitForHomeGovernance(() => expect(screen.getTextContent()).toContain('Selected team'));
            expect(rpc.read).toHaveBeenLastCalledWith({ actionId: platformActionId, fieldPath: platformField.path,
                draftInput: { ...draftInput, machineId: 'controller-a' }, query: 'selected', cursor: 'from:next-team' });
        } finally { await screen.unmount(); }
    });
    it('keeps admitted native choices ready when responsive composition replaces the last reader, and withdraws them on Account retirement', async () => {
        const serverId = await harness.addHome({ name: 'Responsive Home', serverUrl: 'https://responsive-options.example',
            accountId: 'viewer', currentAccount: true });
        const connection = await restoreServerAccountForTest({ serverUrl: 'https://responsive-options.example', accountId: 'viewer', request: harness.request });
        installHomeGovernanceBoundaries(harness);
        const { setRuntimeFetch } = await import('@/utils/system/runtimeFetch');
        setRuntimeFetch(harness.request);
        const states: InputFieldOptionsState[] = [];
        const body = (key: string) => <NativePeriodOptionsProbe key={key} serverId={serverId} observe={state => states.push(state)} />;
        const screen = await renderScreen(body('desktop'));
        try {
            await waitForHomeGovernance(() => expect(states.at(-1)?.status).toBe('ready'));
            const ready = states.at(-1)!;
            for (const size of ['phone', 'desktop']) {
                const before = states.length;
                await screen.update(body(size));
                await flushHookEffects({ cycles: 10 });
                expect(states.slice(before).map(state => state.status)).not.toContain('loading');
                expect(states.at(-1)?.options).toBe(ready.options);
            }
            await screen.update(<></>);
            await flushHookEffects({ cycles: 2 });
            const beforeRemount = states.length;
            await screen.update(body('later-navigation'));
            await waitForHomeGovernance(() => expect(states.at(-1)?.status).toBe('ready'));
            expect(states.slice(beforeRemount).map(state => state.status)).toContain('loading');
            const remounted = states.at(-1)!;
            await act(async () => { await connection.dispose(); });
            await screen.update(body('retired'));
            expect(states.at(-1)?.options).not.toBe(remounted.options);
        } finally { await screen.unmount(); await connection.dispose(); }
    });
    it('retains host choices while a refused plugin sibling changes fallback relay', async () => {
        const serverId = await harness.addHome({ name: 'Mixed inputs', serverUrl: 'https://mixed-options.example', serverIdentityId: 'srv_mixed_options', accountId: 'viewer', currentAccount: true });
        const { setRuntimeFetch } = await import('@/utils/system/runtimeFetch');
        setRuntimeFetch(harness.request);
        const workflow = await createTypedWorkflow(serverId, 'viewer', undefined, true);
        const connection = await restoreServerAccountForTest({ serverUrl: 'https://mixed-options.example', accountId: 'viewer', request: harness.request });
        installHomeGovernanceBoundaries(harness);
        setRuntimeFetch(harness.request);
        const observations: InputFieldOptionsState[] = [];
        const body = () => <MixedOptionsProbe serverId={serverId} workflow={workflow} observePeriod={state => observations.push(state)} />;
        rpc.read.mockResolvedValue(reply('Serving repository'));
        await act(async () => { storage.getState().applyMachines([createMachineFixture({ id: 'controller-a', activeAt: Date.now() })]); });
        const screen = await renderScreen(body());
        try {
            await vi.waitFor(() => {
                expect(screen.getTextContent()).toContain('Last 30 days');
                expect(screen.findByTestId('mixed.options')?.props.accessibilityLabel).toBe('failed');
            });
            const settled = observations.at(-1)!;
            const mark = observations.length;
            const replacement = createPlainMachineRowFixture({ id: 'controller-b', accountId: 'viewer' });
            harness.answer(serverId, 'GET /v1/machines/controller-b', { body: { machine: replacement } });
            await act(async () => {
                const machine = createMachineFixture({ id: 'controller-b', activeAt: Date.now() });
                storage.getState().applyMachines([machine]);
                storage.setState(state => ({ machineListByServerId: { ...state.machineListByServerId,
                    [resolveServerProfileScopeIdForIdentifier(serverId)]: [machine] } }));
                recordMachineRequestFailed({ serverId: resolveServerProfileScopeIdForIdentifier(serverId), accountId: 'viewer', machineId: 'controller-a' });
            });
            await screen.update(body());
            await vi.waitFor(() => expect(screen.findByTestId('mixed.options')?.props.accessibilityHint, JSON.stringify({
                machines: Object.values(storage.getState().machines).map(machine => machine.id),
                byHome: Object.fromEntries(Object.entries(storage.getState().machineListByServerId).map(([home, machines]) => [home, machines?.map(machine => machine.id)])),
            })).toBe('controller-b'));
            expect(observations.slice(mark).every(state => state.status === 'ready' && state.options === settled.options)).toBe(true);
            expect(screen.getTextContent()).toContain('Last 30 days');
        } finally { await screen.unmount(); await connection.dispose(); }
    });
    it('offers an unopened Project session for Local services through the shared resolver and current Home HTTP reader', async () => {
        const serverId = await harness.addHome({ name: 'Project Home', serverUrl: 'https://native-session-options.example',
            accountId: 'viewer', currentAccount: true });
        const session = V2SessionRecordSchema.parse({ id: 'unopened', seq: 1, createdAt: 1, updatedAt: 1,
            active: true, activeAt: 1, encryptionMode: 'plain', metadataLayoutVersion: 0,
            metadata: JSON.stringify({ path: '/repo', host: 'machine', summary: { text: 'Project session', updatedAt: 1 }, machineId: 'machine', projectId: 'project' }),
            metadataVersion: 1, agentState: null, agentStateVersion: 0, dataEncryptionKey: null, share: null,
            effectiveAccess: { v: 1, level: 'owner', sources: [{ kind: 'owner' }], capabilities: createSessionAccessFixture().capabilities },
            responsibleAccountId: null, responsibleAccount: null,
            viewer: { latestFailureSeq: null, readState: { state: 'not_started' }, relevance: { relevant: true, reasons: ['owned_by_me'] },
                attention: { needsAttention: false, reasons: [], primary: null, presentation: 'full' },
                follow: { follows: false, notificationLevel: null }, notification: { level: 'none', source: 'none' } },
        });
        harness.answer(serverId, 'POST /v2/sessions/query', { body: SessionListQueryResponseV1Schema.parse({
            sessions: [session], nextCursor: null, hasNext: false, attentionNextCursor: null, attentionHasNext: false,
        }) });
        const connection = await restoreServerAccountForTest({ serverUrl: 'https://native-session-options.example', accountId: 'viewer',
            request: (url, init) => harness.request(url, init) });
        installHomeGovernanceBoundaries(harness);
        const { setRuntimeFetch } = await import('@/utils/system/runtimeFetch');
        setRuntimeFetch(harness.request);
        const screen = await renderScreen(<NativeSessionOptionsProbe serverId={serverId} />);
        await waitForHomeGovernance(() => expect(screen.findByTestId('native-session.options')?.props.accessibilityLabel).not.toBe('loading'));
        expect({ status: screen.findByTestId('native-session.options')?.props.accessibilityLabel,
            code: screen.findByTestId('native-session.options')?.props.accessibilityHint }).toEqual({ status: 'ready', code: undefined });
        expect(screen.getTextContent()).toContain('Project session');
        expect(rpc.read).not.toHaveBeenCalled();
        await screen.unmount();
        await connection.dispose();
    });
    it('checks a saved Session through its own read instead of paging the Session list', async () => {
        const serverId = await harness.addHome({ name: 'Saved Home', serverUrl: 'https://saved-session-options.example',
            accountId: 'viewer', currentAccount: true });
        const viewer = { latestFailureSeq: null, readState: { state: 'not_started' }, relevance: { relevant: true, reasons: ['owned_by_me'] },
            attention: { needsAttention: false, reasons: [], primary: null, presentation: 'full' },
            follow: { follows: false, notificationLevel: null }, notification: { level: 'none', source: 'none' } };
        const record = (id: string, title: string) => V2SessionRecordSchema.parse({ id, seq: 1, createdAt: 1, updatedAt: 1,
            active: true, activeAt: 1, encryptionMode: 'plain', metadataLayoutVersion: 0,
            metadata: JSON.stringify({ path: '/repo', host: 'machine', summary: { text: title, updatedAt: 1 }, machineId: 'machine' }),
            metadataVersion: 1, agentState: null, agentStateVersion: 0, dataEncryptionKey: null, share: null,
            effectiveAccess: { v: 1, level: 'owner', sources: [{ kind: 'owner' }], capabilities: createSessionAccessFixture().capabilities },
            responsibleAccountId: null, responsibleAccount: null, viewer });
        harness.answer(serverId, 'POST /v2/sessions/query', { body: SessionListQueryResponseV1Schema.parse({
            sessions: [record('listed', 'Listed session')], nextCursor: null, hasNext: false, attentionNextCursor: null, attentionHasNext: false,
        }) });
        harness.answer(serverId, 'GET /v2/sessions/saved', { body: { session: record('saved', 'Saved session') } });
        const readBatchRequest = createSessionReadBatchFetchBoundary(harness.request);
        const connection = await restoreServerAccountForTest({ serverUrl: 'https://saved-session-options.example', accountId: 'viewer',
            request: readBatchRequest });
        installHomeGovernanceBoundaries(harness);
        const { setRuntimeFetch } = await import('@/utils/system/runtimeFetch');
        setRuntimeFetch(readBatchRequest);
        const listPages = () => harness.requests.filter(request => request.path.endsWith('/v2/sessions/query')).length;
        const screen = await renderScreen(<SavedSessionOptionsProbe serverId={serverId} sessionId="saved" asksOnlyForSaved />);
        try {
            await waitForHomeGovernance(() => expect(screen.findByTestId('saved-session.options')?.props.accessibilityLabel).not.toBe('loading'));
            expect(screen.findByTestId('saved-session.options')?.props.accessibilityLabel).toBe('ready');
            expect(screen.getTextContent()).toContain('Saved session');
            expect(listPages()).toBe(0);
        } finally { await screen.unmount(); await connection.dispose(); }
    });
    it('does not bypass serving type choices with authored static choices', async () => {
        const target = await harness.addHome({ name: 'Compute', serverUrl: 'https://restricted-options.example',
            serverIdentityId: 'srv_restricted_options', accountId: 'compute-owner', currentAccount: true });
        const workflow = await createTypedWorkflow(target, 'compute-owner');
        rpc.read.mockResolvedValue(reply('Serving repository'));
        const screen = await renderScreen(<OptionsProbe serverId={target} workflow={workflow} restricted />);
        await waitForHomeGovernance(() => expect(screen.findByTestId('native-field.options')?.props.accessibilityLabel).not.toBe('loading'));
        expect(screen.getTextContent()).not.toContain('Outside Resource');
        expect(screen.getTextContent()).toContain('Serving repository');
        await screen.unmount();
    });
    it('withdraws a retired target Account response and resolves only the replacement binding', async () => {
        const target = await harness.addHome({ name: 'Compute', serverUrl: 'https://retired-options.example', serverIdentityId: 'srv_retired_options', accountId: 'original-owner', currentAccount: true });
        await harness.addHome({ name: 'Focused', serverUrl: 'https://other-options.example', serverIdentityId: 'srv_other_options', accountId: 'focused-owner', currentAccount: true });
        const workflow = await createTypedWorkflow(target, 'original-owner');
        let releaseOriginal: (() => void) | undefined;
        let first = true;
        rpc.read.mockImplementation(async () => {
            const original = first; first = false;
            if (original) await new Promise<void>(resolve => { releaseOriginal = resolve; });
            return reply(original ? 'Retired repository' : 'Replacement repository');
        });
        const screen = await renderScreen(<OptionsProbe serverId={target} workflow={workflow} />);
        await waitForHomeGovernance(() => expect(rpc.read.mock.calls.length > 0
            || screen.findByTestId('native-field.options')?.props.accessibilityLabel === 'failed').toBe(true));
        expect(rpc.read).toHaveBeenCalledTimes(1);
        await act(async () => harness.switchAccount(target, 'replacement-owner', { currentAccount: true }));
        // The replacement Account has its own authored definition, not the retired Account's content.
        harness.artifacts(target).clear();
        const replacement = await createTypedWorkflow(target, 'replacement-owner', '00000000-0000-4000-8000-000000000052');
        await screen.update(<OptionsProbe serverId={target} workflow={replacement} />);
        await waitForHomeGovernance(() => expect(screen.getTextContent()).toContain('Replacement repository'));
        await act(async () => { releaseOriginal?.(); await flushHookEffects(); });
        expect(screen.getTextContent()).not.toContain('Retired repository');
        expect(screen.getTextContent()).toContain('Replacement repository');
        await screen.unmount();
    });
    it('resolves a declared native input type in the captured target Home instead of borrowing the focused Account', async () => {
        const target = await harness.addHome({ name: 'Compute', serverUrl: 'https://compute-options.example', serverIdentityId: 'srv_compute_options', accountId: 'compute-owner', currentAccount: true });
        await harness.addHome({ name: 'Focused', serverUrl: 'https://focused-options.example', serverIdentityId: 'srv_focused_options', accountId: 'focused-owner', currentAccount: true });
        const workflow = await createTypedWorkflow(target, 'compute-owner');
        rpc.read.mockResolvedValue(reply('Target repository'));
        const screen = await renderScreen(<OptionsProbe serverId={target} workflow={workflow} />);
        await waitForHomeGovernance(() => expect(screen.findByTestId('native-field.options')?.props.accessibilityLabel).not.toBe('loading'));
        expect({ status: screen.findByTestId('native-field.options')?.props.accessibilityLabel,
            code: screen.findByTestId('native-field.options')?.props.accessibilityHint }).toEqual({ status: 'ready', code: undefined });
        expect(screen.getTextContent()).toContain('Target repository');
        expect(rpc.read).toHaveBeenCalledWith(expect.objectContaining({ serverUrl: expect.stringContaining('compute-options.example'),
            accountId: 'compute-owner', target: { kind: 'machine', machineId: 'controller-a' },
                input: { consumer: { kind: 'workflow', workflow }, fieldPath: field.path, draftInput: { machineId: 'controller-a' } },
        }));
        await screen.unmount();
    });
});
