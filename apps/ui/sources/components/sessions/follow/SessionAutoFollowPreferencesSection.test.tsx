import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterAll, afterEach, expect, it, vi } from 'vitest';
import { resolveSessionFollowActionRequest } from '@happier-dev/protocol/sessions/follow/actionTransport';
import { SessionAutoFollowPreferencesV1Schema, type SessionAutoFollowPreferencesV1 } from '@happier-dev/protocol/sessions/follow/accountFollow';
import { renderSettingsView } from '@/dev/testkit/harness/settingsViewHarness';
import { buildServerFeaturesResponse } from '@/hooks/server/serverFeaturesTestUtils';
import { getServerFeaturesSnapshot, resetServerFeaturesClientForTests } from '@/sync/api/capabilities/serverFeaturesClient';
import type { RuntimeFetch } from '@/utils/system/runtimeFetch';
import { installSessionOpsNetworkBoundary } from '@/dev/testkit/harness/sessionOpsNetworkBoundary';
import { createEmptyAccountBootstrapHttpResponse } from '@/dev/testkit/fixtures/accountBootstrapHttpBoundary';
import { createDeferred } from '@/dev/testkit/hooks/createDeferred';
import { publishHomeAccountChange } from '@/sync/runtime/orchestration/homeAccountChange';
import { renderHook } from '@/dev/testkit';
import { readPresentationNotice, retirePresentationNotice } from '@/components/sessions/presentation/presentationNotices';
vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock({
    pathname: '/settings/coordination',
}).module);
const network = await installSessionOpsNetworkBoundary();
const { loadSyncSingletonForTests } = await import('@/dev/testkit/harness/syncSingletonLoader');
await loadSyncSingletonForTests();
const { restoreServerAccountForTest } = await import('@/dev/testkit/harness/serverAccountConnectionHarness');
const { getStorage } = await import('@/sync/domains/state/storage');
const { SessionAutoFollowPreferencesSection: PreferencesSection } = await import('./SessionAutoFollowPreferencesSection');
const { useSessionAutoFollowPreferences } = await import('./useSessionAutoFollowPreferences');
function SessionAutoFollowPreferencesSection({ serverId }: Readonly<{ serverId: string }>) {
    const preferences = useSessionAutoFollowPreferences(serverId);
    return <PreferencesSection preferences={preferences} />;
}
const { CoordinationSettingsView } = await import('@/components/settings/coordination/CoordinationSettingsView');
const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
let connection: Awaited<ReturnType<typeof restoreServerAccountForTest>> | undefined;
afterEach(async () => {
    retirePresentationNotice();
    await connection?.dispose();
    connection = undefined;
    vi.restoreAllMocks(); vi.unstubAllGlobals(); resetServerFeaturesClientForTests();
    network.resetRequests();
});
afterAll(() => network.dispose());

type Screen = Awaited<ReturnType<typeof renderSettingsView>>;
/** Follow automatically is a level per rule (lab P5): Important follows, Off does not. */
function isOn(screen: Screen, field: string): boolean | undefined {
    return screen.findByTestId(`session-auto-follow-${field}:important`)?.props.accessibilityState?.checked;
}
function choose(screen: Screen, field: string, on: boolean) {
    screen.findByTestId(`session-auto-follow-${field}:${on ? 'important' : 'off'}`)?.props.onPress();
}

const preferencesPath = resolveSessionFollowActionRequest('follow.preferences.get', {}).path;

function setPreferencesFetch(handler: RuntimeFetch) {
    network.setHttpResponder(async (url, init) => {
        const pathname = new URL(String(url)).pathname;
        if (pathname === '/v1/auth/ping') return new Response('{}', { status: 200 });
        if (pathname === '/v1/features') return globalThis.fetch(url, init);
        // Preserve the canonical Account bootstrap and Settings transport underneath.
        if (pathname !== preferencesPath) return createEmptyAccountBootstrapHttpResponse(pathname, init);
        return handler(url, init);
    });
}

async function flushAsyncWork() {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}

async function publishFollowFeature(serverId: string, following: boolean) {
    const features = buildServerFeaturesResponse();
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ...features, features: { ...features.features, sessions: { ...features.features.sessions, enabled: true, following: { enabled: following } } } }), { status: 200, headers: { 'content-type': 'application/json' } })));
    await getServerFeaturesSnapshot({ serverId, force: true });
}

async function renderEnabledPreferencesSection(serverUrl: string) {
    const home = await network.addHome(serverUrl, 'account-a');
    await publishFollowFeature(home.id, true);
    setPreferencesFetch(async () => new Response('{}', { status: 404 }));
    connection = await restoreServerAccountForTest({ serverUrl, accountId: 'account-a', request: network.request });
    await publishFollowFeature(home.id, true);
    expect(getStorage().getState().profileScope).toEqual({ serverId: home.id, accountId: 'account-a' });
    // Settle the real bootstrap/reconnect publication before counting page-owned reads.
    await flushAsyncWork();
    return home;
}

it.each(['managerPolicy', 'runReportPolicy', 'discussionReceivePolicy'] as const)('reads and writes the declared %s through the real Settings and Follow Actions', async field => {
    const home = await renderEnabledPreferencesSection(`https://preferences-setting-${field}.example`);
    let preferences: SessionAutoFollowPreferencesV1 = { assigned: true, direct: true, team: false, group: false,
        managerPolicy: { preset: 'important' }, runReportPolicy: { preset: 'everything' },
        discussionReceivePolicy: { preset: 'quiet' } };
    const original = structuredClone(preferences);
    setPreferencesFetch(async (_url, init) => {
        if (init?.method === 'PUT') preferences = SessionAutoFollowPreferencesV1Schema.parse(JSON.parse(String(init.body)));
        return Response.json(preferences);
    });
    const executor = createDefaultActionExecutor();
    const anchor = `coordination.${field}`;
    const context = { surface: 'ui' as const, serverId: home.id, authority: 'present_user' as const,
        actionCaller: { kind: 'host' as const } };
    const target = { kind: 'home' as const, serverId: home.id };
    expect(await executor.execute('settings.list', { pageId: 'coordination' }, context)).toMatchObject({ ok: true,
        result: { items: expect.arrayContaining([expect.objectContaining({ anchor, readable: true, writable: true })]) } });
    expect(await executor.execute('settings.get', { anchor, target }, context)).toMatchObject({ ok: true,
        result: { anchor, value: preferences[field] } });
    const next = { preset: 'custom', events: { finished: { delivery: 'quiet' } } } as const;
    // Presets use the same strict Follow-policy parser as Custom; malformed policies never mutate.
    expect(await executor.execute('settings.set', { anchor, target, value: { preset: 'unknown' } }, context))
        .toMatchObject({ ok: false, errorCode: 'invalid_setting_value' });
    expect(preferences).toEqual(original);
    expect(await executor.execute('settings.set', { anchor, target, value: next }, context))
        .toMatchObject({ ok: true, result: { anchor, value: next } });
    expect(preferences).toEqual({ ...original, [field]: next });
    expect(await executor.execute('settings.get', { anchor, target }, context)).toMatchObject({ ok: true,
        result: { anchor, value: next } });
});

it('returns confirmed save and retry outcomes and restores only changed fields through the same owner', async () => {
    const home = await renderEnabledPreferencesSection('https://preferences-outcomes.example');
    let preferences = SessionAutoFollowPreferencesV1Schema.parse({ assigned: true, direct: false, team: false, group: false });
    let fail = false;
    let writes = 0;
    setPreferencesFetch(async (_url, init) => {
        if (init?.method === 'PUT') {
            writes++;
            if (fail) return Response.json({}, { status: 503 });
            preferences = SessionAutoFollowPreferencesV1Schema.parse(JSON.parse(String(init.body)));
        }
        return Response.json(preferences);
    });
    const hook = await renderHook(() => useSessionAutoFollowPreferences(home.id));
    await vi.waitFor(() => expect(hook.getCurrent().displayed).not.toBeNull());
    let outcome: unknown;
    await act(async () => { outcome = await hook.getCurrent().save({ patch: { direct: true } }); });
    expect(outcome).toMatchObject({ kind: 'saved', previous: { patch: { direct: false } }, value: { direct: true } });
    expect(writes).toBe(1);
    await act(async () => { outcome = await hook.getCurrent().save({ patch: { direct: true } }); });
    expect(outcome).toEqual({ kind: 'unchanged' });
    expect(writes).toBe(1);
    fail = true;
    await act(async () => { outcome = await hook.getCurrent().save({ patch: { group: true } }); });
    expect(outcome).toMatchObject({ kind: 'failed', cause: { kind: 'failed', error: expect.any(String) } });
    preferences = { ...preferences, team: true };
    await act(async () => publishHomeAccountChange(home.id));
    await vi.waitFor(() => expect(hook.getCurrent().displayed?.team).toBe(true));
    fail = false;
    await act(async () => { outcome = await hook.getCurrent().retry(); });
    expect(outcome).toMatchObject({ kind: 'saved', previous: { patch: { group: false } } });
    await act(async () => { outcome = await hook.getCurrent().save({ patch: { direct: false } }); });
    expect(outcome).toMatchObject({ kind: 'saved' });
    expect(preferences).toMatchObject({ direct: false, group: true, team: true });
    const undo = readPresentationNotice()?.undo;
    expect(undo).toBeDefined();
    preferences = { ...preferences, assigned: false };
    await act(async () => publishHomeAccountChange(home.id));
    await vi.waitFor(() => expect(hook.getCurrent().displayed?.assigned).toBe(false));
    fail = true;
    await act(async () => { undo?.run(); });
    await vi.waitFor(() => expect(readPresentationNotice()?.severity).toBe('error'));
    expect(preferences.direct).toBe(false);
    fail = false;
    await act(async () => { outcome = await hook.getCurrent().retry(); });
    expect(outcome).toMatchObject({ kind: 'saved' });
    expect(preferences).toMatchObject({ direct: true, group: true, team: true, assigned: false });
    expect(readPresentationNotice()?.severity).toBe('info');
    await hook.unmount();
});

it.each([false, true])('retains the latest same-field choice and retries a failed followup (latest %s)', async latest => {
    const home = await renderEnabledPreferencesSection(`https://preferences-latest-${latest}.example`);
    let preferences = SessionAutoFollowPreferencesV1Schema.parse({ assigned: true, direct: false, team: true, group: false });
    const held = createDeferred<void>();
    let writes = 0;
    let rejectFollowup = true;
    setPreferencesFetch(async (_url, init) => {
        if (init?.method === 'PUT') {
            writes++;
            if (writes === 1) await held.promise;
            else if (rejectFollowup) return Response.json({}, { status: 503 });
            preferences = SessionAutoFollowPreferencesV1Schema.parse(JSON.parse(String(init.body)));
        }
        return Response.json(preferences);
    });
    const hook = await renderHook(() => useSessionAutoFollowPreferences(home.id));
    await vi.waitFor(() => expect(hook.getCurrent().displayed).not.toBeNull());
    let settled: ReturnType<ReturnType<typeof useSessionAutoFollowPreferences>['save']> | undefined;
    act(() => { settled = hook.getCurrent().save({ patch: { direct: true } }); });
    await vi.waitFor(() => expect(writes).toBe(1));
    act(() => {
        for (const direct of [false, true, false, latest]) void hook.getCurrent().save({ patch: { direct } });
    });
    expect(hook.getCurrent().displayed?.direct).toBe(latest);
    expect(writes).toBe(1);
    await act(async () => { held.resolve(); await settled; });
    expect(writes).toBe(latest ? 1 : 2);
    expect(preferences).toMatchObject({ direct: true, team: true });
    expect(hook.getCurrent().displayed?.direct).toBe(true);
    expect(hook.getCurrent().error).toBe(!latest);
    if (!latest) {
        expect(hook.getCurrent().failed?.patch.direct).toBe(false);
        rejectFollowup = false;
        await act(async () => { await hook.getCurrent().retry(); });
        expect(preferences).toMatchObject({ direct: false, team: true });
        expect(hook.getCurrent().error).toBe(false);
    }
    await hook.unmount();
});

it('offers Retry when Undo restores a previously implicit default level', async () => {
    await renderEnabledPreferencesSection('https://preferences-implicit-default.example');
    let preferences = SessionAutoFollowPreferencesV1Schema.parse({ assigned: true, direct: false, team: false, group: false });
    let fail = false;
    setPreferencesFetch(async (_url, init) => {
        if (init?.method === 'PUT') {
            if (fail) return Response.json({}, { status: 503 });
            preferences = SessionAutoFollowPreferencesV1Schema.parse(JSON.parse(String(init.body)));
        }
        return Response.json(preferences);
    });
    const screen = await renderSettingsView(<CoordinationSettingsView />);
    await vi.waitFor(() => expect(isOn(screen, 'assigned')).toBe(true));
    const level = () => screen.findAll(node => node.props.testID === 'settings-coordination-level-managerPolicy'
        && typeof node.props.onSelect === 'function')[0]!;
    act(() => level().props.onSelect('quiet'));
    await vi.waitFor(() => expect(preferences.managerPolicy?.preset).toBe('quiet'));
    await vi.waitFor(() => expect(readPresentationNotice()?.undo).toBeDefined());
    fail = true;
    await act(async () => { readPresentationNotice()?.undo?.run(); });
    await vi.waitFor(() => expect(readPresentationNotice()?.severity).toBe('error'));
    expect(screen.findByTestId('settings-coordination-levels-retry')).not.toBeNull();
    fail = false;
    await screen.pressByTestIdAsync('settings-coordination-levels-retry');
    await vi.waitFor(() => expect(preferences.managerPolicy).toBeUndefined());
    expect(level().props.selectedId).toBe('important');
    expect(readPresentationNotice()?.severity).toBe('info');
    await screen.unmount();
});

it('coalesces rapid choices across both Follow sections while preserving neighbouring preferences', async () => {
    await renderEnabledPreferencesSection('https://preferences-whole-page.example');
    let preferences: SessionAutoFollowPreferencesV1 = { assigned: true, direct: false, team: false, group: false,
        managerPolicy: { preset: 'important' }, runReportPolicy: { preset: 'important' },
        discussionReceivePolicy: { preset: 'important' } };
    let reads = 0;
    const held = createDeferred<void>();
    const writes: unknown[] = [];
    setPreferencesFetch(async (_url, init) => {
        if (init?.method === 'PUT') {
            const next = SessionAutoFollowPreferencesV1Schema.parse(JSON.parse(String(init.body)));
            writes.push(next);
            if (writes.length === 1) await held.promise;
            preferences = next;
        } else reads++;
        return Response.json(preferences);
    });
    const screen = await renderSettingsView(<CoordinationSettingsView />);
    await vi.waitFor(() => expect(isOn(screen, 'assigned')).toBe(true));
    expect(reads).toBe(1);
    for (const field of ['managerPolicy', 'runReportPolicy', 'discussionReceivePolicy']) {
        expect(screen.findAll(node => node.props.nativeID === `setting-coordination.${field}`).length).toBeGreaterThan(0);
    }
    const level = () => screen.findAll(node => node.props.testID === 'settings-coordination-level-managerPolicy'
        && typeof node.props.onSelect === 'function')[0]!;
    act(() => level().props.onSelect('quiet'));
    await vi.waitFor(() => expect(writes).toHaveLength(1));
    expect(readPresentationNotice()).toBeNull();
    expect(screen.findByTestId('session-auto-follow-direct:important')?.props.disabled).toBe(false);
    expect(level().props.itemTrigger.itemProps.disabled).toBe(false);
    act(() => {
        level().props.onSelect('important');
        level().props.onSelect('everything');
        choose(screen, 'direct', true);
        choose(screen, 'direct', false);
        choose(screen, 'direct', true);
    });
    expect(isOn(screen, 'direct')).toBe(true);
    expect(level().props.selectedId).toBe('everything');
    expect(writes).toHaveLength(1);
    await act(async () => { held.resolve(); });
    await vi.waitFor(() => expect(preferences).toMatchObject({ direct: true, managerPolicy: { preset: 'everything' },
        runReportPolicy: { preset: 'important' }, discussionReceivePolicy: { preset: 'important' } }));
    expect(writes).toHaveLength(2);
    expect(readPresentationNotice()?.undo).toBeDefined();
    await act(async () => { readPresentationNotice()?.undo?.run(); });
    await vi.waitFor(() => expect(preferences.managerPolicy?.preset).toBe('important'));
    expect(preferences.direct).toBe(false);
    await act(async () => { choose(screen, 'direct', true); });
    await vi.waitFor(() => expect(preferences).toMatchObject({ managerPolicy: { preset: 'important' }, direct: true }));
    expect(readPresentationNotice()?.undo).toBeDefined();
    await screen.unmount();
});

it('retries failed edits across both sections on the latest confirmed Home preferences', async () => {
    const home = await renderEnabledPreferencesSection('https://preferences-page-retry.example');
    let preferences: SessionAutoFollowPreferencesV1 = { assigned: true, direct: false, team: false, group: false,
        managerPolicy: { preset: 'important' } };
    let fail = true;
    setPreferencesFetch(async (_url, init) => {
        if (init?.method === 'PUT') {
            if (fail) return Response.json({}, { status: 503 });
            preferences = SessionAutoFollowPreferencesV1Schema.parse(JSON.parse(String(init.body)));
        }
        return Response.json(preferences);
    });
    const screen = await renderSettingsView(<CoordinationSettingsView />);
    await vi.waitFor(() => expect(isOn(screen, 'assigned')).toBe(true));
    const level = () => screen.findAll(node => node.props.testID === 'settings-coordination-level-managerPolicy'
        && typeof node.props.onSelect === 'function')[0]!;
    await act(async () => { level().props.onSelect('quiet'); });
    expect(level().props.selectedId).toBe('important');
    await act(async () => { choose(screen, 'direct', true); });
    expect(isOn(screen, 'direct')).toBe(false);
    expect(level().props.selectedId).toBe('important');
    preferences = { ...preferences, team: true };
    await act(async () => { publishHomeAccountChange(home.id); });
    await vi.waitFor(() => expect(isOn(screen, 'team')).toBe(true));
    fail = false;
    await act(async () => { screen.findByTestId('settings-coordination-levels-retry')?.props.onPress(); });
    expect(preferences).toMatchObject({ managerPolicy: { preset: 'quiet' }, direct: true, team: true });
    await screen.unmount();
});

it('loads Account preferences on first render and preserves a failed toggle for retry', async () => {
    const home = await renderEnabledPreferencesSection('https://preferences-follow.example');
    let preferences: SessionAutoFollowPreferencesV1 = { assigned: true, direct: false, team: false, group: false };
    let failWrite = true;
    setPreferencesFetch(async (url, init) => {
        if (new URL(String(url)).pathname === '/v1/auth/ping') return new Response('{}', { status: 200 });
        if (init?.method === 'PUT') {
            if (failWrite) return new Response('{}', { status: 503 });
            preferences = SessionAutoFollowPreferencesV1Schema.parse(JSON.parse(String(init.body)));
        }
        return new Response(JSON.stringify(preferences), { status: 200 });
    });
    const screen = await renderSettingsView(<SessionAutoFollowPreferencesSection serverId={home.id} />);
    await vi.waitFor(() => expect(isOn(screen, 'assigned'), JSON.stringify({
        content: screen.getTextContent(), scope: getStorage().getState().profileScope,
        paths: network.httpRequests.map(request => new URL(request.url).pathname),
    })).toBe(true));
    for (const field of ['assigned', 'direct', 'team', 'group']) {
        const anchor = `coordination.autoFollow${field[0]!.toUpperCase()}${field.slice(1)}`;
        expect(screen.findAll((node) => node.props.nativeID === `setting-${anchor}`).length).toBeGreaterThan(0);
    }
    await act(async () => { choose(screen, 'direct', true); });
    expect(isOn(screen, 'direct')).toBe(false);
    expect(preferences.direct).toBe(false);
    expect(screen.findByTestId('session-auto-follow-retry')).not.toBeNull();
    failWrite = false;
    await act(async () => { screen.findByTestId('session-auto-follow-retry')?.props.onPress(); });
    expect(preferences.direct).toBe(true);
    expect(screen.findByTestId('session-auto-follow-retry')).toBeNull();
    await screen.unmount();
});

it('does not read preferences for 1,000 unrelated detailed Account changes but refreshes Follow configuration', async () => {
    const home = await renderEnabledPreferencesSection('https://preferences-relevance.example');
    let reads = 0;
    let assigned = true;
    setPreferencesFetch(async () => {
        reads++;
        return Response.json({ assigned, direct: false, team: false, group: false });
    });
    const screen = await renderSettingsView(<SessionAutoFollowPreferencesSection serverId={home.id} />);
    await vi.waitFor(() => expect(isOn(screen, 'assigned')).toBe(true));
    const baseline = reads;
    const unrelatedKinds = ['kv', 'session', 'artifact', 'machine', 'account'] as const;
    await act(async () => {
        for (let index = 0; index < 1_000; index++) publishHomeAccountChange(home.id, [`unrelated-${index}`],
            { changeKinds: [unrelatedKinds[index % unrelatedKinds.length]!], sessionListQueryAffects: true });
    });
    await flushAsyncWork();
    expect(reads).toBe(baseline);
    assigned = false;
    const { ACCOUNT_SESSION_FOLLOW_CHANGE_ENTITY_ID } = await import('@happier-dev/protocol/sessions/follow/changes');
    await act(async () => publishHomeAccountChange(home.id, [ACCOUNT_SESSION_FOLLOW_CHANGE_ENTITY_ID], { changeKinds: ['account'] }));
    await vi.waitFor(() => expect(isOn(screen, 'assigned')).toBe(false));
    expect(reads).toBe(baseline + 1);
    for (const event of [
        { entityIds: ['self'], changeKinds: ['account'] as const },
        { entityIds: ['shared-session'], changeKinds: ['share'] as const },
        { source: 'connected' as const },
        { entityIds: ['future-entity'], changeKinds: ['future-kind'] },
        {},
    ]) {
        const before = reads;
        assigned = !assigned;
        await act(async () => publishHomeAccountChange(home.id, 'entityIds' in event ? event.entityIds : undefined, event));
        await vi.waitFor(() => expect(isOn(screen, 'assigned')).toBe(assigned));
        expect(reads).toBe(before + 1);
    }
    await screen.unmount();
});

it('re-reads on the primary reconnect wake only while its own last read is not current', async () => {
    const home = await renderEnabledPreferencesSection('https://preferences-reconnect-class.example');
    let reads = 0;
    let failing = false;
    setPreferencesFetch(async () => {
        reads += 1;
        return failing ? new Response('{}', { status: 503 })
            : new Response(JSON.stringify({ assigned: true, direct: false, team: false, group: false }), { status: 200 });
    });
    const screen = await renderSettingsView(<SessionAutoFollowPreferencesSection serverId={home.id} />);
    await flushAsyncWork();
    expect(reads).toBe(1);
    const reconnect = async () => {
        await act(async () => publishHomeAccountChange(home.id, undefined, { source: 'connected', changesCatchUp: true }));
        await flushAsyncWork();
    };

    // Current read: the changes catch-up owns what changed while away.
    await reconnect();
    expect(reads).toBe(1);

    failing = true;
    await act(async () => publishHomeAccountChange(home.id));
    await flushAsyncWork();
    expect(reads).toBe(2);
    expect(screen.findByTestId('session-auto-follow-error')).not.toBeNull();

    // Failed read: the reconnect is its retry, and a successful retry is current again.
    failing = false;
    await reconnect();
    expect(reads).toBe(3);
    await reconnect();
    expect(reads).toBe(3);
    await screen.unmount();
});

it('coalesces Account-change wakes during a save and reconciles to the Home after success or failure', async () => {
    const home = await renderEnabledPreferencesSection('https://preferences-follow-race.example');
    const initial = { assigned: true, direct: false, team: false, group: false };
    let authoritative = initial;
    let reads = 0;
    const firstWrite = createDeferred<Response>();
    const secondWrite = createDeferred<Response>();
    let writes = 0;
    setPreferencesFetch(async (url, init) => {
        if (new URL(String(url)).pathname === '/v1/auth/ping') return new Response('{}', { status: 200 });
        if (init?.method === 'PUT') return ++writes === 1 ? firstWrite.promise : secondWrite.promise;
        reads += 1;
        return new Response(JSON.stringify(authoritative), { status: 200 });
    });

    const screen = await renderSettingsView(<SessionAutoFollowPreferencesSection serverId={home.id} />);
    await flushAsyncWork();
    expect(reads).toBe(1);

    act(() => { choose(screen, 'direct', true); });
    authoritative = { ...initial, team: true };
    act(() => {
        publishHomeAccountChange(home.id);
        publishHomeAccountChange(home.id);
    });
    expect(reads).toBe(1);
    firstWrite.resolve(new Response(JSON.stringify({ ...initial, direct: true }), { status: 200 }));
    await flushAsyncWork();
    expect(reads).toBe(2);
    expect(isOn(screen, 'direct')).toBe(false);
    expect(isOn(screen, 'team')).toBe(true);

    act(() => { choose(screen, 'group', true); });
    authoritative = { ...initial, assigned: false };
    act(() => { publishHomeAccountChange(home.id); });
    secondWrite.resolve(new Response('{}', { status: 503 }));
    await flushAsyncWork();
    expect(reads).toBe(3);
    // The confirmed Home value is refreshed beneath the failed change…
    expect(isOn(screen, 'assigned')).toBe(false);
    // The failed intent survives for Retry, while the control shows the confirmed value.
    expect(isOn(screen, 'group')).toBe(false);
    expect(screen.findByTestId('session-auto-follow-error')).not.toBeNull();
    expect(screen.findByTestId('session-auto-follow-retry')).not.toBeNull();

    // A later reconnect wake is still only a refresh: it may not abandon the failed change.
    act(() => { publishHomeAccountChange(home.id); });
    await flushAsyncWork();
    expect(reads).toBe(4);
    expect(isOn(screen, 'group')).toBe(false);
    expect(screen.findByTestId('session-auto-follow-retry')).not.toBeNull();

    // Retry re-executes that exact intent against the current confirmed value, not a stale
    // snapshot: the refreshed `assigned: false` survives and only `group` changes.
    let retried: unknown = null;
    setPreferencesFetch(async (url, init) => {
        if (new URL(String(url)).pathname === '/v1/auth/ping') return new Response('{}', { status: 200 });
        if (init?.method === 'PUT') {
            retried = SessionAutoFollowPreferencesV1Schema.parse(JSON.parse(String(init.body)));
            return new Response(String(init.body), { status: 200 });
        }
        reads += 1;
        return new Response(JSON.stringify(authoritative), { status: 200 });
    });
    await act(async () => { screen.findByTestId('session-auto-follow-retry')?.props.onPress(); });
    await flushAsyncWork();
    expect(retried).toEqual({ ...initial, assigned: false, group: true });
    expect(screen.findByTestId('session-auto-follow-error')).toBeNull();
    expect(isOn(screen, 'group')).toBe(true);
    await screen.unmount();
});

it('reloads the Home after the Follow feature decision disappears during an outstanding save', async () => {
    const home = await renderEnabledPreferencesSection('https://preferences-follow-feature-flip.example');
    const write = createDeferred<Response>();
    let reads = 0;
    const DIAG: string[] = [];
    setPreferencesFetch(async (url, init) => {
        const pathname = new URL(String(url)).pathname;
        if (pathname === '/v1/auth/ping') return new Response('{}', { status: 200 });
        // The Home feature decision is the thing this test flips, and the features
        // client reads it through the same runtime fetch. Delegate that path to the
        // decision `publishFollowFeature` installs instead of answering it with this
        // section's preference payload, which would pin the feature off forever.
        if (pathname === '/v1/features') return await globalThis.fetch(url, init);
        if (init?.method === 'PUT') return write.promise;
        reads += 1;
        DIAG.push(`read:${pathname}`);
        return new Response(JSON.stringify({ assigned: true, direct: false, team: false, group: false }), { status: 200 });
    });

    const screen = await renderSettingsView(<SessionAutoFollowPreferencesSection serverId={home.id} />);
    await flushAsyncWork();
    DIAG.push('mounted');
    act(() => { choose(screen, 'direct', true); });
    DIAG.push('toggled');

    await act(async () => { await publishFollowFeature(home.id, false); });
    DIAG.push('feature-off');
    expect(screen.findByTestId('session-auto-follow-direct:important')).toBeNull();
    write.resolve(new Response(JSON.stringify({ assigned: true, direct: true, team: false, group: false }), { status: 200 }));
    await flushAsyncWork();
    DIAG.push('write-settled');

    await act(async () => { await publishFollowFeature(home.id, true); });
    DIAG.push('feature-on');
    await flushAsyncWork();
    expect(reads, DIAG.join(' > ')).toBe(2);
    expect(isOn(screen, 'direct')).toBe(false);
    expect(screen.findByTestId('session-auto-follow-direct:important')?.props.accessibilityState?.disabled).toBe(false);
    await screen.unmount();
});

it('does not start a deferred refresh after the settings lifetime is retired', async () => {
    const home = await renderEnabledPreferencesSection('https://preferences-follow-retire.example');
    const write = createDeferred<Response>();
    let reads = 0;
    setPreferencesFetch(async (url, init) => {
        if (new URL(String(url)).pathname === '/v1/auth/ping') return new Response('{}', { status: 200 });
        if (init?.method === 'PUT') return write.promise;
        reads += 1;
        return new Response(JSON.stringify({ assigned: true, direct: false, team: false, group: false }), { status: 200 });
    });

    const screen = await renderSettingsView(<SessionAutoFollowPreferencesSection serverId={home.id} />);
    await flushAsyncWork();
    act(() => { choose(screen, 'direct', true); });
    act(() => { publishHomeAccountChange(home.id); });
    await screen.unmount();
    write.resolve(new Response(JSON.stringify({ assigned: true, direct: true, team: false, group: false }), { status: 200 }));
    await flushAsyncWork();
    expect(reads).toBe(1);
});
