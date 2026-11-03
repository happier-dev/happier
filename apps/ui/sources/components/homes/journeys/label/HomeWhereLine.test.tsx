import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { flushHookEffects } from '@/dev/testkit/hooks/flushHookEffects';
import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { HomeWhereLine } from './HomeWhereLine';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const state = vi.hoisted(() => ({
    profile: null as null | Record<string, unknown>,
    hostsHere: false,
    pushed: [] as unknown[],
}));

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock());
vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    const router = createExpoRouterMock();
    router.spies.push.mockImplementation((href: unknown) => { state.pushed.push(href); });
    return router.module;
});
// The focused Home (runtime) and this device's saved record of it (device storage).
vi.mock('@/hooks/server/useActiveServerSnapshot', () => ({ useActiveServerSnapshot: () => ({ serverId: 'srv_a' }) }));
vi.mock('@/hooks/server/useServerProfilesGeneration', () => ({ useServerProfilesGeneration: () => 1 }));
vi.mock('@/sync/domains/server/serverProfiles', async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    getServerProfileById: () => state.profile,
}));
// No Home's published presentation is cached (network client).
vi.mock('@/sync/api/capabilities/serverFeaturesClient', async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    getCachedServerFeaturesSnapshot: () => null,
}));
// Whether this computer can host a Personal Home (desktop host kind) and its boot state (runtime).
vi.mock('@/utils/platform/personalHomeBootstrapHost', () => ({
    isPersonalHomeBootstrapRuntimeHost: () => state.hostsHere,
}));
vi.mock('@/components/personalHome/bootstrap/PersonalHomeBootstrapGate', () => ({
    usePersonalHomeBootReadiness: () => ({ kind: 'ready' }),
}));

afterEach(() => {
    standardCleanup();
    vi.unstubAllEnvs();
    state.profile = null;
    state.hostsHere = false;
    state.pushed = [];
});

function profile(overrides: Record<string, unknown>) {
    return {
        id: 'srv_a',
        name: '',
        serverUrl: 'http://localhost:53288',
        canonicalServerUrl: 'http://localhost:53288',
        serverIdentityId: 'srv_a',
        ...overrides,
    };
}

async function renderLine() {
    const screen = await renderScreen(<HomeWhereLine />);
    await flushHookEffects({ cycles: 2 });
    return screen;
}

describe('HomeWhereLine', () => {
    it('never names a Home by its raw address: an unnamed Home says nothing here', async () => {
        state.profile = profile({ name: 'localhost:53288' });
        const screen = await renderLine();
        expect(screen.getTextContent()).not.toContain('localhost');
        expect(screen.getTextContent()).not.toContain('server.homeOnHost');
        expect(screen.findByTestId('home-where-line')).toBeNull();
    });

    it('keeps the installed Personal Home location when new installs are off, and its name opens About your Home', async () => {
        vi.stubEnv('EXPO_PUBLIC_HAPPIER_BUILD_DEFAULT_PROFILE_JSON', JSON.stringify({ personalHome: { value: 'off' } }));
        state.profile = profile({ personalHomeBootstrapCompleted: true });
        state.hostsHere = true;
        const screen = await renderLine();
        const text = screen.getTextContent();
        expect(text).toContain('personalHome.settings.defaultHomeLabel');
        expect(text).toContain('homesJourneys.livesOnThisComputer');
        // No letter tile: no one-letter monogram is drawn on the line.
        expect(screen.findAll((node) => typeof node.props?.children === 'string' && node.props.children.trim().length === 1)).toEqual([]);

        screen.pressByTestId('home-where-line.about');
        expect(state.pushed).toHaveLength(1);
    });
});
