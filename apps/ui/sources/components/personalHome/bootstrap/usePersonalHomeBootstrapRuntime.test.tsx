import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SystemTaskJsonObject, SystemTaskJsonValue, SystemTaskSpec } from '@happier-dev/protocol/system/tasks/spec';
import type { SystemTaskBridgeListenerSet } from '@/components/systemTasks/types';
import { installPersonalHomeBootstrapNetworkBoundary } from '@/dev/testkit/harness/personalHomeBootstrapNetworkBoundary';

import { flushHookEffects } from '@/dev/testkit/hooks/flushHookEffects';
import { renderHook } from '@/dev/testkit/hooks/renderHook';
import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { PersonalHomeBootstrapContent } from './PersonalHomeBootstrapGate';
import type { PersonalHomeFacts } from './personalHomeBootstrapTypes';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});

// The real `useThisComputerSetupTask` resolves its runner through the shared system-tasks
// runtime. The dev runner still crosses the explicit native-process bridge below.
process.env.EXPO_PUBLIC_SYSTEM_TASKS_RUNNER_MODE = 'dev';

const harness = vi.hoisted(() => {
    const canonicalServerUrl = 'http://127.0.0.1:43123';
    const runtime = {
        installed: false,
        healthy: false,
        dataPresent: false,
        signupEnabled: true,
        purpose: null as null | { kind: 'personal-home'; canonicalServerUrl: string } | { kind: 'generic' },
    };
    const endpoint = {
        storagePolicy: 'plaintext_only' as 'required_e2ee' | 'optional' | 'plaintext_only',
        reachable: true,
        homeConnectionDescriptor: {
            v: 1 as const,
            homeServerIdentityId: 'srv_home_b_identity',
            canonicalServerUrl,
            revision: 1,
            endpoints: [{
                kind: 'iroh' as const,
                endpointId: 'b'.repeat(64),
            }],
        },
    };
    let credentials: Readonly<{ token: string }> | null = null;
    let segments: readonly string[] = ['(app)', 'index'];
    const taskCalls: Array<{ kind: string; options: Record<string, unknown> }> = [];
    let failNextRelayTask: string | null = null;
    let failRelayTaskOnOccurrence: Readonly<{ kind: string; occurrence: number }> | null = null;
    const relayTaskOccurrences = new Map<string, number>();
    let statusAvailable = true;
    const routerPush = vi.fn();
    const token = `eyJhbGciOiJub25lIn0.${btoa(JSON.stringify({ sub: 'acct_home_b' }))}.fixture`;
    const isTaskObject = (value: SystemTaskJsonValue): value is SystemTaskJsonObject =>
        value !== null && typeof value === 'object' && !Array.isArray(value);
    const runRelayTask = async (kind: string, params: SystemTaskJsonValue = {}) => {
            if (!isTaskObject(params)) throw new Error('Relay task fixture requires object params');
            const options = params;
            taskCalls.push({ kind, options });
            const occurrence = (relayTaskOccurrences.get(kind) ?? 0) + 1;
            relayTaskOccurrences.set(kind, occurrence);
            if (
                failNextRelayTask === kind
                || (failRelayTaskOnOccurrence?.kind === kind && failRelayTaskOnOccurrence.occurrence === occurrence)
            ) {
                failNextRelayTask = null;
                failRelayTaskOnOccurrence = null;
                return {
                    protocolVersion: 1,
                    taskId: `task-${taskCalls.length}`,
                    ok: false,
                    error: { code: 'relay_task_injected_failure', message: 'transient relay task failure' },
                };
            }
            if (kind === 'relay.runtime.installOrUpdate.v1') {
                runtime.installed = true;
                runtime.healthy = true;
                runtime.dataPresent = true;
                runtime.purpose = options.purpose as typeof runtime.purpose;
                runtime.signupEnabled = (options.env as Record<string, string> | undefined)?.AUTH_ANONYMOUS_SIGNUP_ENABLED !== '0';
            } else if (kind === 'relay.runtime.start.v1' || kind === 'relay.runtime.restart.v1') {
                runtime.healthy = true;
            }
            return {
                protocolVersion: 1,
                taskId: `task-${taskCalls.length}`,
                ok: true,
                data: statusAvailable ? statusData() : {},
            };
    };
    const taskSpecs = new Map<string, SystemTaskSpec>();
    const taskResults: Array<{ kind: string; ok: boolean; error?: { code: string; message: string } }> = [];
    let nextTaskId = 0;
    const bridge = {
        start: async (spec: SystemTaskSpec) => {
            const taskId = `runtime-task-${++nextTaskId}`;
            taskSpecs.set(taskId, spec);
            return taskId;
        },
        subscribe: async (taskId: string, listener: SystemTaskBridgeListenerSet) => {
            const spec = taskSpecs.get(taskId)!;
            queueMicrotask(async () => {
                const result = spec.kind.startsWith('relay.runtime.')
                    ? await runRelayTask(spec.kind, spec.params)
                    : { protocolVersion: 1, ok: true, data: {} };
                taskResults.push({ kind: spec.kind, ...result });
                listener.onResult({ ...result, taskId });
            });
            return () => {};
        },
        cancel: async () => {},
        respond: async () => {},
    };
    const currentWindowLabel = vi.fn(() => 'main');

    const authCallSecrets: Uint8Array[] = [];

    const redeemHomeChallenge = vi.fn(async (params: { secret?: Uint8Array } = {}) => {
        if (!runtime.signupEnabled) {
            throw Object.assign(new Error('signup disabled'), { code: 'signup-disabled' });
        }
        if (params.secret) {
            authCallSecrets.push(new Uint8Array(params.secret));
        }
        return { token };
    });

    // Status identity is stable while the underlying runtime state is unchanged (mirroring the
    // real hook's memoized state), so consumers depending on status identity do not churn.
    let cachedStatusData: Record<string, unknown> | null = null;
    let cachedStatusKey = '';
    function statusData(): Record<string, unknown> {
        const purposeKey = runtime.purpose?.kind === 'personal-home'
            ? `personal-home:${runtime.purpose.canonicalServerUrl}`
            : (runtime.purpose?.kind ?? 'none');
        const key = `${runtime.installed}|${runtime.healthy}|${runtime.dataPresent}|${runtime.signupEnabled}|${purposeKey}`;
        if (key !== cachedStatusKey || cachedStatusData == null) {
            cachedStatusKey = key;
            cachedStatusData = {
                installed: runtime.installed,
                version: runtime.installed ? '0.3.0-test' : null,
                relayUrl: canonicalServerUrl,
                healthy: runtime.healthy,
                dataPresent: runtime.dataPresent,
                service: {
                    active: runtime.installed ? runtime.healthy : null,
                    enabled: runtime.installed ? true : null,
                },
                purpose: runtime.purpose,
                anonymousSignupEnabled: runtime.purpose?.kind === 'personal-home' ? runtime.signupEnabled : null,
            };
        }
        return cachedStatusData!;
    }

    return {
        canonicalServerUrl,
        token,
        bridge,
        taskSpecs,
        taskResults,
        mutations: () => [...taskSpecs.values()].filter(spec => spec.kind !== 'relay.runtime.status.v1' && spec.kind !== 'daemon.service.status.v1'),
        clearTaskObservations() {
            taskCalls.length = 0;
            relayTaskOccurrences.clear();
        },
        runtime,
        endpoint,
        taskCalls,
        setFailNextRelayTask(next: string | null) {
            failNextRelayTask = next;
        },
        failRelayTaskOnOccurrence(kind: string, occurrence: number) {
            failRelayTaskOnOccurrence = { kind, occurrence };
        },
        setStatusAvailable(next: boolean) {
            statusAvailable = next;
        },
        routerPush,
        currentWindowLabel,
        redeemHomeChallenge,
        getCredentials: () => credentials,
        setCredentials(value: Readonly<{ token: string }> | null) {
            credentials = value;
        },
        segments: () => segments,
        setSegments(value: readonly string[]) {
            segments = value;
        },
        authCallSecrets: () => authCallSecrets.map((seed) => new Uint8Array(seed)),
        statusData,
        reset() {
            runtime.installed = false;
            runtime.healthy = false;
            runtime.dataPresent = false;
            runtime.signupEnabled = true;
            runtime.purpose = null;
            endpoint.storagePolicy = 'plaintext_only';
            endpoint.reachable = true;
            credentials = null;
            segments = ['(app)', 'index'];
            taskCalls.length = 0;
            taskSpecs.clear();
            taskResults.length = 0;
            failNextRelayTask = null;
            failRelayTaskOnOccurrence = null;
            relayTaskOccurrences.clear();
            statusAvailable = true;
            authCallSecrets.length = 0;
            routerPush.mockClear();
            redeemHomeChallenge.mockClear();
            currentWindowLabel.mockReturnValue('main');
        },
    };
});

// The shell reveal keeps the departing setup frame mounted for ONE settle after the gate releases
// (`PersonalHomeSetupReveal`), so this suite — which asserts the state the user is left in, not the
// transition — opts the canonical reanimated mock into settling `withTiming` completion callbacks.
vi.mock('react-native-reanimated', async () => {
    const { createReanimatedModuleMock } = await import('@/dev/testkit/mocks/reanimated');
    return createReanimatedModuleMock({ settleTimingCallbacks: true });
});

vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await vi.importActual<typeof import('@/dev/testkit/mocks/router')>(
        '@/dev/testkit/mocks/router',
    );
    const routerMock = createExpoRouterMock({
        router: { push: harness.routerPush },
        segments: ['(app)', 'index'],
    }).module;
    return {
        ...routerMock,
        useSegments: () => harness.segments(),
    };
});

vi.mock('@tauri-apps/api/window', () => ({
    getCurrentWindow: () => ({ label: harness.currentWindowLabel() }),
}));

vi.mock('@/components/systemTasks/createSystemTaskBridge', () => ({
    createSystemTaskBridge: () => harness.bridge,
}));

vi.mock('@/platform/cryptoRandom', () => ({
    getRandomBytes: vi.fn(() => new Uint8Array(32).fill(7)),
    getRandomBytesAsync: vi.fn(async () => new Uint8Array(32).fill(7)),
}));

let network: Awaited<ReturnType<typeof installPersonalHomeBootstrapNetworkBoundary>>;
async function seedExistingCredentials() {
    const credentials = { token: harness.token };
    expect(await network.seedCredentials({ serverId: 'srv_home_b_identity' }, credentials)).toBe(true);
    harness.setCredentials(credentials);
}

const initialFacts: PersonalHomeFacts = {
    hostIsDesktop: true,
    isDesktopMainWindow: true,
    explicitlySelectedOtherHome: false,
    completedPersonalHomeProfile: null,
    candidateLocalProfile: null,
    relayRuntime: null,
    localHomeReachability: 'unknown',
    localHomeIdentity: null,
    localHomeAuth: 'missing',
    anonymousSignup: 'unknown',
    daemon: null,
    activeTask: null,
};

describe('usePersonalHomeBootstrapRuntime production composition', () => {
    beforeEach(async () => {
        vi.stubEnv('EXPO_PUBLIC_HAPPIER_BUILD_DEFAULT_PROFILE_JSON', JSON.stringify({ personalHome: { value: 'auto' } }));
        harness.reset();
        network = await installPersonalHomeBootstrapNetworkBoundary({
            serverUrl: harness.canonicalServerUrl,
            serverIdentityId: 'srv_home_b_identity',
            readFeatures: async () => !harness.endpoint.reachable || !harness.runtime.installed || !harness.runtime.healthy
                ? { status: 'error', reason: 'network' }
                : {
                    status: 'ready', serverIdentityId: 'srv_home_b_identity',
                    features: {
                        homeConnectionDescriptor: harness.endpoint.homeConnectionDescriptor,
                        capabilities: {
                            auth: { signup: { methods: [{ id: 'anonymous', enabled: harness.runtime.signupEnabled }] } },
                            encryption: { storagePolicy: harness.endpoint.storagePolicy },
                        },
                    },
                },
            authenticate: harness.redeemHomeChallenge,
            authPing: async ({ token }) => ({ status: harness.endpoint.reachable && token === harness.token && harness.runtime.healthy ? 'ready' : 'auth_failed' }),
            credentialPersisted: async (_url, _scope, credentials) => harness.setCredentials(credentials),
            request: async ({ path }) => path === '/v1/account/profile'
                ? Response.json({ id: 'acct_home_b' }) : new Response(null, { status: 404 }),
        });
        const profiles = await import('@/sync/domains/server/serverProfiles');
        profiles.resetServerProfilesRuntimeForTests();
    });
    afterEach(async () => {
        standardCleanup();
        await harness.reset();
        const profiles = await import('@/sync/domains/server/serverProfiles');
        profiles.clearTabActiveServerId();
        for (const profile of profiles.listServerProfiles()) await profiles.removeServerProfile(profile.id);
        network.dispose();
        vi.restoreAllMocks();
        vi.unstubAllEnvs();
    });

    it('offers without starting tasks, then runs the full bootstrap from the Add Home local action', async () => {
        vi.stubEnv('EXPO_PUBLIC_HAPPIER_BUILD_DEFAULT_PROFILE_JSON', JSON.stringify({ personalHome: { value: 'offer' } }));
        const { PersonalHomeBootstrapRuntimeMount } = await import('./usePersonalHomeBootstrapRuntime');
        const { RelayHostLocalChecklistStep } = await import('@/components/onboarding/checklists/relayHostLocal/RelayHostLocalChecklistStep');
        const action: { primary: Readonly<{ disabled: boolean; onPress: () => void | Promise<void> }> | null } = { primary: null };
        await renderScreen(
            <PersonalHomeBootstrapRuntimeMount>
                <PersonalHomeBootstrapContent>
                    <RelayHostLocalChecklistStep onWizardPrimaryChange={(value) => { action.primary = value; }} />
                </PersonalHomeBootstrapContent>
            </PersonalHomeBootstrapRuntimeMount>,
        );
        await flushHookEffects({ cycles: 2, turns: 2 });
        expect(harness.taskSpecs.size).toBe(0);
        expect(action.primary).toMatchObject({ disabled: false });
        await action.primary!.onPress();
        await flushHookEffects({ cycles: 10, turns: 6 });
        expect(harness.runtime.purpose).toEqual({ kind: 'personal-home', canonicalServerUrl: harness.canonicalServerUrl });
        expect(harness.runtime.signupEnabled).toBe(false);
        expect(harness.getCredentials()).toEqual({ token: harness.token });
        const profiles = await import('@/sync/domains/server/serverProfiles');
        expect(profiles.listServerProfiles()).toContainEqual(expect.objectContaining({ personalHomeBootstrapCompleted: true }));
    });

    it('off leaves the existing runtime untouched and constructs no bootstrap tasks', async () => {
        vi.stubEnv('EXPO_PUBLIC_HAPPIER_BUILD_DEFAULT_PROFILE_JSON', JSON.stringify({ personalHome: { value: 'off' } }));
        harness.runtime.installed = true;
        harness.runtime.healthy = true;
        const { PersonalHomeBootstrapRuntimeMount } = await import('./usePersonalHomeBootstrapRuntime');
        await renderScreen(<PersonalHomeBootstrapRuntimeMount><div data-testid="normal-shell" /></PersonalHomeBootstrapRuntimeMount>);
        await flushHookEffects({ cycles: 2, turns: 2 });
        expect(harness.taskSpecs.size).toBe(0);
        expect(harness.runtime.installed).toBe(true);
        expect(harness.runtime.healthy).toBe(true);
    });

    it('runs the canonical bootstrap through system tasks, persists token-only credentials, adopts only after verification, and preserves focus', async () => {
        const profiles = await import('@/sync/domains/server/serverProfiles');
        for (const profile of profiles.listServerProfiles()) await profiles.removeServerProfile(profile.id);
        const focusedHome = await profiles.upsertServerProfile({
            serverUrl: 'https://home-a.example',
            name: 'Focused Home A',
            source: 'manual',
        });
        await profiles.setActiveServerId(focusedHome.id);

        const { usePersonalHomeBootstrapRuntime } = await import('./usePersonalHomeBootstrapRuntime');
        const hook = await renderHook(() => usePersonalHomeBootstrapRuntime());
        await flushHookEffects();
        harness.clearTaskObservations();

        await hook.getCurrent().operations['ensure-home-ready']?.(initialFacts);

        // Readback refreshes may repeat; retain the exact mutation order and every transition.
        expect(harness.taskCalls.map((call) => call.kind).filter((kind, index, kinds) => (
            kind !== 'relay.runtime.status.v1' || kinds[index - 1] !== kind
        ))).toEqual([
            'relay.runtime.status.v1',
            'relay.runtime.installOrUpdate.v1',
            'relay.runtime.status.v1',
            'relay.runtime.installOrUpdate.v1',
            'relay.runtime.status.v1',
        ]);
        expect(harness.runtime.signupEnabled).toBe(false);
        expect(harness.getCredentials()).toEqual({ token: harness.token });
        // The account-creating call carried the deterministic 32-byte seed, taken from verified
        // pending custody, and the custody was released after the verified credential persisted.
        expect(harness.authCallSecrets()).toHaveLength(1);
        expect([...harness.authCallSecrets()[0]!]).toEqual(new Array(32).fill(7));
        expect(network.pendingSeeds()).toEqual([]);
        // Both account creation and the live signup-refusal check used real v2 proofs.
        expect(network.requests.filter(request => request.path === '/v1/auth/challenge')).toHaveLength(2);
        expect(network.requests.filter(request => request.path === '/v1/auth')).toHaveLength(2);
        expect(profiles.listServerProfiles()).toContainEqual(expect.objectContaining({
            source: 'desktop-personal-home',
            serverUrl: harness.canonicalServerUrl,
            canonicalServerUrl: harness.canonicalServerUrl,
            serverIdentityId: 'srv_home_b_identity',
            personalHomeBootstrapCompleted: true,
        }));
        expect(profiles.getActiveServerSnapshot().serverId).toBe(focusedHome.id);
        expect(network.requests.every(request => new URL(request.url).origin === harness.canonicalServerUrl)).toBe(true);
    });

    it('resumes with the URL-scoped seed when the first post-install readback fails after creating Home data', async () => {
        const { usePersonalHomeBootstrapRuntime } = await import('./usePersonalHomeBootstrapRuntime');
        let hook = await renderHook(() => usePersonalHomeBootstrapRuntime());
        await flushHookEffects();
        harness.clearTaskObservations();
        // After the real hooks' read-only mount work, the first operation read is preflight.
        // Fail the post-install readback, after the one
        // runtime mutation has created meaningful Home data, to prove that seed custody was
        // established before the mutation without relying on the retired start task.
        harness.failRelayTaskOnOccurrence('relay.runtime.status.v1', 2);

        await expect(hook.getCurrent().operations['ensure-home-ready']?.(initialFacts)).rejects.toThrow(
            'transient relay task failure',
        );

        expect(harness.taskCalls.map((call) => call.kind)).toEqual([
            'relay.runtime.status.v1',
            'relay.runtime.installOrUpdate.v1',
            'relay.runtime.status.v1',
        ]);
        expect(network.pendingSeeds()).toHaveLength(1);
        expect(network.pendingSeeds()[0]?.seed).toHaveLength(32);
        const seedAfterFailure = network.pendingSeeds()[0]!.seed;
        expect(harness.runtime.installed).toBe(true);
        expect(harness.runtime.dataPresent).toBe(true);
        expect(harness.authCallSecrets()).toEqual([]);

        await hook.unmount();
        hook = await renderHook(() => usePersonalHomeBootstrapRuntime());
        await hook.getCurrent().operations['ensure-home-ready']?.(initialFacts);
        expect(harness.authCallSecrets()).toHaveLength(1);
        expect([...harness.authCallSecrets()[0]!]).toEqual([...seedAfterFailure]);
        expect(network.pendingSeeds()).toEqual([]);
        await hook.unmount();
    });

    it('activates the adopted first local Home only when the existing selection remains implicit', async () => {
        const previousScope = process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE;
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = `personal-home-implicit-${Date.now()}`;
        try {
            const profiles = await import('@/sync/domains/server/serverProfiles');
            const initialSelection = profiles.getActiveServerSnapshot();
            expect(initialSelection.isSelectionExplicit).toBe(false);

            const { usePersonalHomeBootstrapRuntime } = await import('./usePersonalHomeBootstrapRuntime');
            const hook = await renderHook(() => usePersonalHomeBootstrapRuntime());
            await hook.getCurrent().operations['ensure-home-ready']?.(initialFacts);

            const selected = profiles.getActiveServerSnapshot();
            expect(selected).toMatchObject({ isSelectionExplicit: false });
            expect(profiles.getServerProfileById(selected.serverId)).toMatchObject({
                source: 'desktop-personal-home',
                serverIdentityId: 'srv_home_b_identity',
            });
            await hook.unmount();
        } finally {
            if (previousScope === undefined) delete process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE;
            else process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = previousScope;
        }
    });

    it('surfaces retained data as existing-Home recovery before installing or creating an account', async () => {
        harness.runtime.dataPresent = true;

        const { PersonalHomeBootstrapRuntimeMount } = await import('./usePersonalHomeBootstrapRuntime');
        const screen = await renderScreen(
            <PersonalHomeBootstrapRuntimeMount>
                <div data-testid="normal-shell">
                    <PersonalHomeBootstrapContent><div data-testid="home-content" /></PersonalHomeBootstrapContent>
                </div>
            </PersonalHomeBootstrapRuntimeMount>,
        );
        await flushHookEffects({ cycles: 6, turns: 4 });

        expect(screen.findByTestId('personal-home-use-existing')).not.toBeNull();
        expect(screen.findByTestId('personal-home-use-another')).not.toBeNull();
        // The canonical status projection carries retained-data state into the gate, so the
        // recovery decision appears without invoking the bootstrap runner at all.
        expect(harness.mutations()).toEqual([]);
        expect(harness.runtime.installed).toBe(false);
        expect(harness.redeemHomeChallenge).not.toHaveBeenCalled();
        expect(harness.getCredentials()).toBeNull();
        const profiles = await import('@/sync/domains/server/serverProfiles');
        expect(profiles.listServerProfiles().filter((profile) => profile.source === 'desktop-personal-home')).toEqual([]);

        await screen.pressByTestIdAsync('personal-home-use-existing');
        await flushHookEffects({ cycles: 4, turns: 4 });
        expect(harness.routerPush).toHaveBeenCalledWith(`/?step=home&server=${encodeURIComponent(harness.canonicalServerUrl)}`);
        expect(harness.mutations()).toEqual([]);
        expect(harness.taskCalls.some(call => call.kind === 'relay.runtime.status.v1')).toBe(true);
        expect(harness.runtime.installed).toBe(false);
        expect(harness.getCredentials()).toBeNull();
    });

    it('does not start Personal Home checks for an explicitly selected existing Home', async () => {
        const profiles = await import('@/sync/domains/server/serverProfiles');
        const home = await profiles.upsertServerProfile({
            serverUrl: 'https://existing-home.example',
            source: 'manual',
        });
        await profiles.setActiveServerId(home.id, { scope: 'device' });
        const { PersonalHomeBootstrapRuntimeMount } = await import('./usePersonalHomeBootstrapRuntime');
        const screen = await renderScreen(
            <PersonalHomeBootstrapRuntimeMount>
                <PersonalHomeBootstrapContent><div data-testid="existing-home-content" /></PersonalHomeBootstrapContent>
            </PersonalHomeBootstrapRuntimeMount>,
        );
        await flushHookEffects({ cycles: 4, turns: 4 });
        expect(screen.findByTestId('existing-home-content')).not.toBeNull();
        expect(screen.findByTestId('personal-home-use-another')).toBeNull();
        expect(harness.taskCalls).toEqual([]);
        expect(profiles.getActiveServerSnapshot().serverId).toBe(home.id);
    });

    it('keeps explicit recovery/callback routes reachable without bypassing the ordinary shell route', async () => {
        const { shouldBypassPersonalHomeBootstrapForSegments } = await import('./usePersonalHomeBootstrapRuntime');

        expect(shouldBypassPersonalHomeBootstrapForSegments(['(app)', 'server'])).toBe(true);
        expect(shouldBypassPersonalHomeBootstrapForSegments(['(app)', 'settings', 'server'])).toBe(true);
        expect(shouldBypassPersonalHomeBootstrapForSegments(['(app)', 'settings', 'server', 'add'])).toBe(true);
        expect(shouldBypassPersonalHomeBootstrapForSegments(['(app)', 'settings', 'server', '[homeId]'])).toBe(true);
        expect(shouldBypassPersonalHomeBootstrapForSegments(['(app)', 'settings', 'home'])).toBe(false);
        expect(shouldBypassPersonalHomeBootstrapForSegments(['(app)', 'setup', 'wizard'])).toBe(true);
        expect(shouldBypassPersonalHomeBootstrapForSegments(['(app)', 'oauth', 'github'])).toBe(true);
        expect(shouldBypassPersonalHomeBootstrapForSegments(['(app)', 'restore', 'lost-access'])).toBe(true);
        expect(shouldBypassPersonalHomeBootstrapForSegments(['(app)', 'index'])).toBe(false);
        expect(shouldBypassPersonalHomeBootstrapForSegments(['(app)', 'settings'])).toBe(false);
    });

    it("recovers a valid plaintext generic Home in place through 'Use this local Home' without routing", async () => {
        const profiles = await import('@/sync/domains/server/serverProfiles');
        harness.runtime.installed = true;
        harness.runtime.healthy = true;
        harness.runtime.purpose = { kind: 'generic' };
        await seedExistingCredentials();

        const { PersonalHomeBootstrapRuntimeMount } = await import('./usePersonalHomeBootstrapRuntime');
        const screen = await renderScreen(
            <PersonalHomeBootstrapRuntimeMount>
                <div data-testid="normal-shell">
                    <PersonalHomeBootstrapContent><div data-testid="home-content" /></PersonalHomeBootstrapContent>
                </div>
            </PersonalHomeBootstrapRuntimeMount>,
        );
        await flushHookEffects({ cycles: 6, turns: 4 });

        harness.clearTaskObservations();
        await screen.pressByTestIdAsync('personal-home-use-existing');
        await flushHookEffects({ cycles: 8, turns: 6 });

        // The existing runtime was recovered through the canonical system-task caller in place.
        expect(harness.taskCalls.map((call) => call.kind).filter((kind, index, kinds) => (
            kind !== 'relay.runtime.status.v1' || kinds[index - 1] !== kind
        ))).toEqual([
            'relay.runtime.status.v1',
            'relay.runtime.installOrUpdate.v1',
            'relay.runtime.status.v1',
            'relay.runtime.installOrUpdate.v1',
            'relay.runtime.status.v1',
        ]);
        expect(harness.runtime.purpose).toEqual({ kind: 'personal-home', canonicalServerUrl: harness.canonicalServerUrl });
        expect(harness.runtime.signupEnabled).toBe(false);
        // Token-only recovery: the existing verified credential is kept, no account is created
        // (no call passes the signup-open gate), and no pending bootstrap seed is ever
        // generated or consumed by recovery.
        expect(harness.getCredentials()).toEqual({ token: harness.token });
        expect(harness.authCallSecrets()).toEqual([]);
        expect(network.pendingSeeds()).toEqual([]);
        expect(profiles.listServerProfiles()).toContainEqual(expect.objectContaining({
            source: 'desktop-personal-home',
            canonicalServerUrl: harness.canonicalServerUrl,
            serverIdentityId: 'srv_home_b_identity',
        }));
        // In-place recovery: no route is pushed.
        expect(harness.routerPush).not.toHaveBeenCalled();
        expect(screen.findByTestId('normal-shell')).not.toBeNull();
        expect(screen.findByTestId('personal-home-setup-surface')).toBeNull();
    });

    it('keeps a required_e2ee existing Home generic and routes to the generic login path without mutation', async () => {
        harness.runtime.installed = true;
        harness.runtime.healthy = true;
        harness.runtime.purpose = { kind: 'generic' };
        harness.endpoint.storagePolicy = 'required_e2ee';
        await seedExistingCredentials();

        const { PersonalHomeBootstrapRuntimeMount } = await import('./usePersonalHomeBootstrapRuntime');
        const screen = await renderScreen(
            <PersonalHomeBootstrapRuntimeMount>
                <div data-testid="normal-shell">
                    <PersonalHomeBootstrapContent><div data-testid="home-content" /></PersonalHomeBootstrapContent>
                </div>
            </PersonalHomeBootstrapRuntimeMount>,
        );
        await flushHookEffects({ cycles: 6, turns: 4 });

        await screen.pressByTestIdAsync('personal-home-use-existing');
        await flushHookEffects({ cycles: 8, turns: 6 });

        // The decision is routed to the established generic login path for this local Home.
        expect(harness.routerPush).toHaveBeenCalledWith(`/?step=home&server=${encodeURIComponent(harness.canonicalServerUrl)}`);
        // The canonical caller preflighted through the read-only status task and mutated nothing.
        expect(harness.mutations()).toEqual([]);
        expect(harness.taskCalls.some(call => call.kind === 'relay.runtime.status.v1')).toBe(true);
        expect(harness.runtime.purpose).toEqual({ kind: 'generic' });
        const profiles = await import('@/sync/domains/server/serverProfiles');
        expect(profiles.listServerProfiles().filter((profile) => profile.source === 'desktop-personal-home')).toEqual([]);
    });

    it('keeps a generic Home without verified credentials generic and routes to the generic login path without mutation', async () => {
        harness.runtime.installed = true;
        harness.runtime.healthy = true;
        harness.runtime.purpose = { kind: 'generic' };

        const { PersonalHomeBootstrapRuntimeMount } = await import('./usePersonalHomeBootstrapRuntime');
        const screen = await renderScreen(
            <PersonalHomeBootstrapRuntimeMount>
                <div data-testid="normal-shell">
                    <PersonalHomeBootstrapContent><div data-testid="home-content" /></PersonalHomeBootstrapContent>
                </div>
            </PersonalHomeBootstrapRuntimeMount>,
        );
        await flushHookEffects({ cycles: 6, turns: 4 });

        await screen.pressByTestIdAsync('personal-home-use-existing');
        await flushHookEffects({ cycles: 8, turns: 6 });

        expect(harness.routerPush).toHaveBeenCalledWith(`/?step=home&server=${encodeURIComponent(harness.canonicalServerUrl)}`);
        expect(harness.mutations()).toEqual([]);
        expect(harness.taskCalls.some(call => call.kind === 'relay.runtime.status.v1')).toBe(true);
        expect(harness.runtime.purpose).toEqual({ kind: 'generic' });
        expect(harness.getCredentials()).toBeNull();
        const profiles = await import('@/sync/domains/server/serverProfiles');
        expect(profiles.listServerProfiles().filter((profile) => profile.source === 'desktop-personal-home')).toEqual([]);
    });

    it("routes with 'Use another Home' without mutating the runtime, credentials, or profiles", async () => {
        harness.runtime.installed = true;
        harness.runtime.healthy = true;
        harness.runtime.purpose = { kind: 'generic' };
        const profiles = await import('@/sync/domains/server/serverProfiles');
        const profilesBefore = profiles.listServerProfiles().map(({ id, serverUrl, source }) => ({ id, serverUrl, source }));

        const {
            PersonalHomeBootstrapRuntimeMount,
            usePersonalHomeBootstrapRuntime,
        } = await import('./usePersonalHomeBootstrapRuntime');
        const screen = await renderScreen(
            <PersonalHomeBootstrapRuntimeMount>
                <div data-testid="normal-shell">
                    <PersonalHomeBootstrapContent><div data-testid="home-content" /></PersonalHomeBootstrapContent>
                </div>
            </PersonalHomeBootstrapRuntimeMount>,
        );
        await flushHookEffects({ cycles: 6, turns: 4 });

        await screen.pressByTestIdAsync('personal-home-use-another');
        await flushHookEffects({ cycles: 4, turns: 4 });

        expect(harness.routerPush).toHaveBeenCalledTimes(1);
        expect(harness.routerPush).toHaveBeenCalledWith('/?step=home');
        expect(harness.mutations()).toEqual([]);
        expect(harness.getCredentials()).toBeNull();
        expect(harness.runtime.purpose).toEqual({ kind: 'generic' });
        expect(profiles.listServerProfiles().map(({ id, serverUrl, source }) => ({ id, serverUrl, source }))).toEqual(profilesBefore);

        // The server picker owns the actual decision. Once it records an explicit unrelated
        // Home, the same durable selection releases this first-run gate on a later read/remount.
        const otherHome = await profiles.upsertServerProfile({
            serverUrl: 'https://chosen-home.example',
            source: 'manual',
        });
        await profiles.setActiveServerId(otherHome.id);
        const runtimeHook = await renderHook(() => usePersonalHomeBootstrapRuntime());
        const facts = await runtimeHook.getCurrent().readFacts();
        expect(facts.explicitlySelectedOtherHome).toBe(true);
    });

    it('keeps a transient recovery failure retryable at the decision surface', async () => {
        harness.runtime.installed = true;
        harness.runtime.healthy = true;
        harness.runtime.purpose = { kind: 'generic' };
        await seedExistingCredentials();
        harness.setFailNextRelayTask('relay.runtime.installOrUpdate.v1');

        const { PersonalHomeBootstrapRuntimeMount } = await import('./usePersonalHomeBootstrapRuntime');
        const screen = await renderScreen(
            <PersonalHomeBootstrapRuntimeMount>
                <div data-testid="normal-shell">
                    <PersonalHomeBootstrapContent><div data-testid="home-content" /></PersonalHomeBootstrapContent>
                </div>
            </PersonalHomeBootstrapRuntimeMount>,
        );
        await flushHookEffects({ cycles: 6, turns: 4 });

        await screen.pressByTestIdAsync('personal-home-use-existing');
        await flushHookEffects({ cycles: 8, turns: 6 });

        // Transient failure: no route, the runtime stays generic and untouched.
        expect(harness.taskResults.filter(result => result.kind === 'relay.runtime.installOrUpdate.v1').at(-1)).toMatchObject({
            ok: false, error: { code: 'relay_task_injected_failure' },
        });
        expect(harness.routerPush).not.toHaveBeenCalled();
        expect(harness.runtime.purpose).toEqual({ kind: 'generic' });
        // The decision surface remains available and the failure is observable as retryable.
        expect(screen.findByTestId('personal-home-use-existing')).not.toBeNull();
        expect(screen.findByTestId('personal-home-bootstrap-failure')).not.toBeNull();

        harness.setFailNextRelayTask(null);
        await screen.pressByTestIdAsync('personal-home-use-existing');
        await flushHookEffects({ cycles: 8, turns: 6 });

        expect(harness.runtime.purpose).toEqual({ kind: 'personal-home', canonicalServerUrl: harness.canonicalServerUrl });
        expect(harness.runtime.signupEnabled).toBe(false);
        const profiles = await import('@/sync/domains/server/serverProfiles');
        expect(profiles.listServerProfiles()).toContainEqual(expect.objectContaining({ source: 'desktop-personal-home' }));
        expect(harness.routerPush).not.toHaveBeenCalled();
    });

    it('completes a verified-but-unadopted Personal Home automatically mutation-free after Home readiness', async () => {
        harness.runtime.installed = true;
        harness.runtime.healthy = true;
        harness.runtime.signupEnabled = false;
        harness.runtime.purpose = { kind: 'personal-home', canonicalServerUrl: harness.canonicalServerUrl };
        await seedExistingCredentials();

        const { PersonalHomeBootstrapRuntimeMount } = await import('./usePersonalHomeBootstrapRuntime');
        const screen = await renderScreen(
            <PersonalHomeBootstrapRuntimeMount>
                <div data-testid="normal-shell">
                    <PersonalHomeBootstrapContent><div data-testid="home-content" /></PersonalHomeBootstrapContent>
                </div>
            </PersonalHomeBootstrapRuntimeMount>,
        );
        await flushHookEffects({ cycles: 8, turns: 6 });

        // Shell is usable and never gated for profile completion.
        expect(screen.findByTestId('normal-shell')).not.toBeNull();
        expect(screen.findByTestId('personal-home-setup-surface')).toBeNull();
        expect(harness.routerPush).not.toHaveBeenCalled();
        // Completion reuses the canonical caller mutation-free: read-only verification only.
        expect(harness.mutations()).toEqual([]);
        expect(harness.taskCalls.some(call => call.kind === 'relay.runtime.status.v1')).toBe(true);
        expect(harness.getCredentials()).toEqual({ token: harness.token });
        const profiles = await import('@/sync/domains/server/serverProfiles');
        expect(profiles.listServerProfiles()).toContainEqual(expect.objectContaining({
            source: 'desktop-personal-home',
            serverIdentityId: 'srv_home_b_identity',
        }));
    });

    it('renders off-Desktop and overlay windows without constructing the bootstrap runtime hooks', async () => {
        const { PersonalHomeBootstrapRuntimeMount } = await import('./usePersonalHomeBootstrapRuntime');

        network.setDesktopHostKind(null);
        const offDesktopScreen = await renderScreen(
            <PersonalHomeBootstrapRuntimeMount>
                <div data-testid="normal-shell">
                    <PersonalHomeBootstrapContent><div data-testid="home-content" /></PersonalHomeBootstrapContent>
                </div>
            </PersonalHomeBootstrapRuntimeMount>,
        );
        await flushHookEffects({ cycles: 2, turns: 2 });
        expect(offDesktopScreen.findByTestId('normal-shell')).not.toBeNull();
        expect(harness.taskSpecs.size).toBe(0);

        standardCleanup();
        await harness.reset();

        network.setDesktopHostKind('tauri');
        harness.currentWindowLabel.mockReturnValue('activity_overlay');
        const overlayScreen = await renderScreen(
            <PersonalHomeBootstrapRuntimeMount>
                <div data-testid="normal-shell">
                    <PersonalHomeBootstrapContent><div data-testid="home-content" /></PersonalHomeBootstrapContent>
                </div>
            </PersonalHomeBootstrapRuntimeMount>,
        );
        await flushHookEffects({ cycles: 2, turns: 2 });
        expect(overlayScreen.findByTestId('normal-shell')).not.toBeNull();
        expect(harness.taskSpecs.size).toBe(0);
    });

    it('renders Electron without constructing the Tauri-only Personal Home runtime hooks', async () => {
        network.setDesktopHostKind('electron');
        const { PersonalHomeBootstrapRuntimeMount } = await import('./usePersonalHomeBootstrapRuntime');
        const screen = await renderScreen(
            <PersonalHomeBootstrapRuntimeMount>
                <div data-testid="electron-shell" />
            </PersonalHomeBootstrapRuntimeMount>,
        );
        await flushHookEffects({ cycles: 2, turns: 2 });

        expect(screen.findByTestId('electron-shell')).not.toBeNull();
        expect(harness.taskSpecs.size).toBe(0);
    });

    it.each([
        ['oauth-callback'],
        ['future-secondary-window'],
    ])('renders Tauri window %s without constructing the bootstrap runtime hooks', async (windowLabel) => {
        harness.currentWindowLabel.mockReturnValue(windowLabel);
        const { PersonalHomeBootstrapRuntimeMount } = await import('./usePersonalHomeBootstrapRuntime');
        const screen = await renderScreen(
            <PersonalHomeBootstrapRuntimeMount>
                <div data-testid="secondary-window-shell" />
            </PersonalHomeBootstrapRuntimeMount>,
        );
        await flushHookEffects({ cycles: 2, turns: 2 });

        expect(screen.findByTestId('secondary-window-shell')).not.toBeNull();
        expect(harness.taskSpecs.size).toBe(0);
    });

    it('renders Desktop callback routes without constructing the bootstrap runtime hooks', async () => {
        harness.setSegments(['(app)', 'oauth', 'github']);
        const { PersonalHomeBootstrapRuntimeMount } = await import('./usePersonalHomeBootstrapRuntime');
        const screen = await renderScreen(
            <PersonalHomeBootstrapRuntimeMount>
                <div data-testid="callback-route" />
            </PersonalHomeBootstrapRuntimeMount>,
        );
        await flushHookEffects({ cycles: 2, turns: 2 });

        expect(screen.findByTestId('callback-route')).not.toBeNull();
        expect(harness.taskSpecs.size).toBe(0);
    });

    it('off retains durable returning Home recovery without misclassifying an unverified Home as computer recovery', async () => {
        vi.stubEnv('EXPO_PUBLIC_HAPPIER_BUILD_DEFAULT_PROFILE_JSON', JSON.stringify({ personalHome: { value: 'off' } }));
        const profiles = await import('@/sync/domains/server/serverProfiles');
        await profiles.adoptPersonalHomeProfileAndComplete({
            source: 'desktop-personal-home',
            suggestedName: 'Personal Home',
            descriptor: {
                serverUrl: harness.canonicalServerUrl,
                canonicalServerUrl: harness.canonicalServerUrl,
                homeServerIdentityId: 'srv_home_b_identity',
            },
        });

        const { PersonalHomeBootstrapRuntimeMount } = await import('./usePersonalHomeBootstrapRuntime');
        const screen = await renderScreen(
            <PersonalHomeBootstrapRuntimeMount>
                <div data-testid="normal-shell">
                    <PersonalHomeBootstrapContent><div data-testid="home-content" /></PersonalHomeBootstrapContent>
                </div>
            </PersonalHomeBootstrapRuntimeMount>,
        );

        expect(screen.findByTestId('normal-shell')).not.toBeNull();
        expect(screen.findByTestId('personal-home-setup-surface')).toBeNull();
        expect(screen.findByTestId('home-content')).not.toBeNull();

        await flushHookEffects({ cycles: 6, turns: 4 });

        // The completed receipt releases the shell, but missing authenticated Home readback must
        // not start daemon setup or mislabel the Home outage as computer recovery.
        expect(screen.findByTestId('normal-shell')).not.toBeNull();
        expect(screen.findByTestId('home-content')).not.toBeNull();
        expect(screen.findByTestId('personal-home-setup-surface')).toBeNull();
        expect(screen.findByTestId('personal-home-recovery-strip')).toBeNull();
        expect(harness.mutations()).toEqual([]);
    });

    it('uses durable completion only to release the shell while runtime status has no canonical origin', async () => {
        harness.runtime.installed = true;
        harness.runtime.healthy = true;
        harness.setStatusAvailable(false);
        const profiles = await import('@/sync/domains/server/serverProfiles');
        await profiles.adoptPersonalHomeProfileAndComplete({
            source: 'desktop-personal-home',
            suggestedName: 'Personal Home',
            descriptor: {
                serverUrl: harness.canonicalServerUrl,
                canonicalServerUrl: harness.canonicalServerUrl,
                homeServerIdentityId: 'srv_home_b_identity',
            },
        });
        const features = await import('@/sync/api/capabilities/serverFeaturesClient');
        const tokenStorage = await import('@/auth/storage/tokenStorage');
        const featureProbe = vi.spyOn(features, 'probeServerFeaturesAtUrl');
        const credentialRead = vi.spyOn(tokenStorage.TokenStorage, 'getCredentialsForServerUrl');

        const { PersonalHomeBootstrapRuntimeMount } = await import('./usePersonalHomeBootstrapRuntime');
        const screen = await renderScreen(
            <PersonalHomeBootstrapRuntimeMount>
                <div data-testid="normal-shell">
                    <PersonalHomeBootstrapContent><div data-testid="home-content" /></PersonalHomeBootstrapContent>
                </div>
            </PersonalHomeBootstrapRuntimeMount>,
        );

        expect(screen.findByTestId('normal-shell')).not.toBeNull();
        expect(screen.findByTestId('personal-home-setup-surface')).toBeNull();

        await flushHookEffects({ cycles: 6, turns: 4 });

        expect(featureProbe).not.toHaveBeenCalled();
        // Mounted Action admission still checks its captured Home's credentials. The
        // bootstrap owner must not attempt its own Home-auth classification without an origin.
        expect(credentialRead.mock.calls.filter(([, options]) => options?.storageReadFailure !== 'surface')).toEqual([]);
        expect(network.requests).toEqual([]);
        expect(harness.mutations()).toEqual([]);
    });
});
