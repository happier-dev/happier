import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { installServerSettingsHooksCommonModuleMocks } from '@/components/settings/server/hooks/serverSettingsHooksTestHelpers';
import type { HomeConnectionSummary } from '@/components/navigation/connectionStatus/resolveHomeConnectionSummary';
import type { ServerProfile } from '@/sync/domains/server/serverProfiles';

const viewport = vi.hoisted(() => ({ width: 1440 }));

installServerSettingsHooksCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            Platform: { OS: 'ios' },
            useWindowDimensions: () => ({ width: viewport.width, height: 844, scale: 1, fontScale: 1 }),
        });
    },
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});
function home(id: string, overrides: Partial<ServerProfile> = {}): ServerProfile {
    return { id, name: id, serverUrl: `https://${id}.example.test`, createdAt: 0, updatedAt: 0, lastUsedAt: 0, ...overrides };
}

function summary(kind: HomeConnectionSummary['kind'], action: HomeConnectionSummary['action'] = 'none'): HomeConnectionSummary {
    const statusLabelKey = ({
        connected: 'connectionStatus.summary.connected',
        reconnecting: 'connectionStatus.summary.reconnecting',
        unavailable: 'connectionStatus.summary.unavailable',
        sign_in: 'connectionStatus.summary.signInAgain',
        unknown: 'status.unknown',
    } as const)[kind];
    return { kind, statusLabelKey, statusKey: 'unknown', action };
}

async function render(params: Readonly<{ currentSummary?: HomeConnectionSummary; activeServerId?: string }> = {}) {
    const handlers = { onSwitch: vi.fn(), onRename: vi.fn(), onRemove: vi.fn(), onSignIn: vi.fn(), onRetry: vi.fn() };
    const servers = [
        home('personal', { name: 'Personal', personalHomeBootstrapCompleted: true }),
        home('work', { name: 'Work' }),
        home('lab', { name: 'Lab' }),
        home('devbox', { name: 'devbox.internal', serverUrl: 'https://devbox.internal' }),
    ];
    const { SavedServersSection } = await import('./SavedServersSection');
    const screen = await renderScreen(React.createElement(SavedServersSection, {
        servers,
        activeServerId: params.activeServerId ?? 'personal',
        deviceDefaultServerId: params.activeServerId ?? 'personal',
        authStatusByServerId: {},
        homeConnectionSummaryByServerId: {
            personal: params.currentSummary ?? summary('connected'),
            work: summary('connected'),
            lab: summary('sign_in', 'restore'),
            devbox: summary('unavailable'),
        },
        ...handlers,
    }));
    return { screen, servers, handlers };
}

// The real list owner renders the sections; this suite checks which Homes each one holds. The list
// primitives are memoized, so they are found by their props (outermost first), not by type.
async function groupTitled(screen: Awaited<ReturnType<typeof renderScreen>>, title: string) {
    return screen.root.findAll((node) => typeof node.type !== 'string' && node.props.title === title && 'children' in node.props)[0];
}

function homeRow(screen: Awaited<ReturnType<typeof renderScreen>>, id: string) {
    return screen.findAllByTestId(`saved-server-row-${id}`).find((node) => node.props.title !== undefined);
}

describe('SavedServersSection: the Home this device uses', () => {
    it('shows the current Home first, on its own, and the other Homes under Saved Homes', async () => {
        viewport.width = 1440;
        const { screen } = await render();
        const current = await groupTitled(screen, 'server.homes.currentTitle');
        const saved = await groupTitled(screen, 'server.savedServersTitle');
        expect(current).toBeDefined();
        expect(current!.findAll((node) => node.props?.testID === 'saved-server-row-personal').length).toBeGreaterThan(0);
        expect(saved!.findAll((node) => node.props?.testID === 'saved-server-row-personal')).toHaveLength(0);
        expect(screen.findByTestId('current-home-pill')).not.toBeNull();
        // The current Home offers no state action of its own.
        for (const id of ['saved-server-switch-personal', 'saved-server-sign-in-personal', 'saved-server-retry-personal']) {
            expect(screen.findByTestId(id)).toBeNull();
        }
    });

    it('offers each saved Home the one action its real state needs', async () => {
        viewport.width = 1440;
        const { screen, servers, handlers } = await render();

        expect(screen.getTextContent()).toContain('server.homes.switch');
        await screen.pressByTestIdAsync('saved-server-switch-work');
        expect(handlers.onSwitch).toHaveBeenCalledWith(servers[1]);

        await screen.pressByTestIdAsync('saved-server-sign-in-lab');
        expect(handlers.onSignIn).toHaveBeenCalledWith(servers[2]);

        await screen.pressByTestIdAsync('saved-server-retry-devbox');
        expect(handlers.onRetry).toHaveBeenCalledWith(servers[3]);
    });

    it('gives an unnamed Home a human title rather than its raw address', async () => {
        const { screen } = await render();
        const row = homeRow(screen, 'devbox');
        // This suite's text mock returns bare keys; the label owner's own test covers the fallback.
        expect(row?.props.title).toBe('settingsAccount.thisHomeTitle');
    });

    it('keeps only the ⋯ menu beside each Home on a phone', async () => {
        viewport.width = 390;
        const { screen } = await render();
        expect(screen.findByTestId('saved-server-switch-work')).toBeNull();
    });

    it('asks for sign-in once, in a banner, when the current Home is signed out', async () => {
        viewport.width = 1440;
        const { screen, servers, handlers } = await render({ currentSummary: summary('sign_in', 'restore') });
        expect(screen.findAllHostsByTestId('current-home-attention').length).toBeGreaterThan(0);
        expect(screen.findByTestId('saved-server-sign-in-personal')).toBeNull();
        await screen.pressByTestIdAsync('current-home-attention.action');
        expect(handlers.onSignIn).toHaveBeenCalledWith(servers[0]);
    });

    it('offers a retry in the banner when the current Home cannot be reached', async () => {
        viewport.width = 1440;
        const { screen, servers, handlers } = await render({ currentSummary: summary('unavailable', 'retry') });
        await screen.pressByTestIdAsync('current-home-attention.action');
        expect(handlers.onRetry).toHaveBeenCalledWith(servers[0]);
    });

    it('says "default" once: the current Home’s line carries only its state', async () => {
        viewport.width = 1440;
        const { screen } = await render();
        expect(homeRow(screen, 'personal')?.props.subtitle).toBe('connectionStatus.summary.connected');
    });

    it('offers naming an unnamed Home first in its ⋯ menu, through the rename flow, not inline', async () => {
        viewport.width = 1440;
        const { screen, servers, handlers } = await render({ activeServerId: 'devbox', currentSummary: summary('connected') });
        const menuActions = (profileId: string) => screen.findByTestId(`saved-server-row-${profileId}`)!
            .findAll((node) => Array.isArray(node.props?.actions))[0]!.props.actions as Array<{ id: string; title: string; onPress: () => void }>;

        // The row keeps one inline action; naming never squeezes the Home's name.
        expect(screen.root.findAll((node) => String(node.props?.testID ?? '').startsWith('saved-server-name-'))).toHaveLength(0);
        const first = menuActions('devbox')[0]!;
        expect(first).toMatchObject({ id: 'rename', title: 'server.homes.nameThisHome' });
        await act(async () => { first.onPress(); });
        expect(handlers.onRename).toHaveBeenCalledWith(servers[3]);
        // A named Home keeps its plain Rename among the rarer actions.
        expect(menuActions('personal').find((action) => action.id === 'rename')?.title).toBe('common.rename');
    });

    it('shows no banner while the current Home is connected', async () => {
        const { screen } = await render();
        expect(screen.findByTestId('current-home-attention')).toBeNull();
    });
});
