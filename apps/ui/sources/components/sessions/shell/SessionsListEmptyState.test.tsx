import * as React from 'react';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import type { Machine } from '@/sync/domains/state/storageTypes';
import { DestinationInstanceHost } from '@/components/appShell/workspace/DestinationInstanceHost';
import { act } from 'react-test-renderer';
import { buildMachineAddHref } from '@/components/settings/machines/collection/machineCollectionModel';
import { resolveCliInvokerNameForCurrentApp } from '@/sync/runtime/resolvePublicReleaseRing';
import { readNewSessionDraftProjectionFromRepository } from '@/components/sessions/composer/newSessionDraftRepositoryAdapter';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const routerPushSpy = vi.hoisted(() => vi.fn());

let machinesMock: Machine[] = [];

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        View: React.forwardRef((props: any, ref: any) => React.createElement('View', { ...props, ref }, props.children)),
        Pressable: (props: any) => React.createElement('Pressable', props, props.children),
    });
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock({
        theme: {
            text: '#111',
            textSecondary: '#777',
            divider: '#ddd',
            surfaceHigh: '#f5f5f5',
            groupped: { background: '#fff' },
        },
    });
});

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({
        translate: (key, params) => typeof params?.machine === 'string' ? `${key}:${params.machine}` : key,
    });
});

vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock({
        router: {
            push: routerPushSpy,
        },
    }).module;
});

vi.mock('@/hooks/server/useActiveServerSnapshot', () => ({
    useActiveServerSnapshot: () => ({ serverId: 'server-1' }),
}));

// Device persistence is the boundary; Machine selection and the draft repository stay real.
vi.mock('@/sync/ops/sessionDrafts/sessionDraftPersistenceStorage', () => {
    const values = new Map<string, string>();
    return { getSessionDraftPersistenceStorage: () => ({
        getString: (key: string) => values.get(key),
        set: (key: string, value: string) => { values.set(key, value); },
        delete: (key: string) => { values.delete(key); },
    }) };
});

vi.mock('@expo/vector-icons', async () => {
    const { createExpoVectorIconsMock } = await import('@/dev/testkit/mocks/icons');
    return createExpoVectorIconsMock();
});

vi.mock('@/components/ui/text/Text', () => ({
    Text: (props: any) => React.createElement('Text', props, props.children),
}));

function createMachine(params: Readonly<{
    id: string;
    host: string;
    active?: boolean;
    activeAt?: number;
}>): Machine {
    return {
        id: params.id,
        seq: 1,
        createdAt: 1,
        updatedAt: 1,
        active: params.active ?? true,
        activeAt: params.activeAt ?? Date.now(),
        metadata: {
            host: params.host,
            platform: 'darwin',
            happyCliVersion: '0',
            happyHomeDir: '/tmp/.happy',
            homeDir: '/Users/tester',
        },
        metadataVersion: 1,
        daemonState: null,
        daemonStateVersion: 1,
    };
}

function flattenTextValue(value: unknown): string {
    if (Array.isArray(value)) {
        return value.map(flattenTextValue).join('');
    }
    if (value == null || typeof value === 'boolean') {
        return '';
    }
    if (typeof value === 'object' && 'props' in (value as Record<string, unknown>)) {
        return flattenTextValue((value as { props?: { children?: unknown } }).props?.children);
    }
    return String(value);
}

async function renderSessions(element: React.ReactElement) {
    const { storage } = await import('@/sync/domains/state/storage');
    storage.setState({ profileScope: { serverId: 'server-1', accountId: 'account-1' },
        machines: Object.fromEntries(machinesMock.map(machine => [machine.id, machine])),
        machineListByServerId: { 'server-1': machinesMock } });
    const { publishAppliedActiveServerSnapshot } = await import('@/sync/runtime/orchestration/appliedActiveServerRuntime');
    publishAppliedActiveServerSnapshot({ serverId: 'server-1', serverUrl: 'https://home.test', generation: 0 });
    const { captureActiveServerAccountScopeLifetime } = await import('@/sync/domains/scope/activeServerAccountScope');
    expect(captureActiveServerAccountScopeLifetime()?.isCurrent()).toBe(true);
    return renderScreen(element);
}

function selectedDraft() {
    const route = routerPushSpy.mock.lastCall?.[0] as { params: { draftId: string } };
    return readNewSessionDraftProjectionFromRepository({
        scope: { serverId: 'server-1', accountId: 'account-1' }, draftId: route.params.draftId,
    })?.draft;
}

describe('SessionsListEmptyState', () => {
    beforeEach(async () => {
        standardCleanup();
        routerPushSpy.mockReset();
        machinesMock = [];
        const { configureSessionDraftRepository, resetSessionDraftRepositoryForTests } =
            await import('@/sync/ops/sessionDrafts/sessionDraftRepository');
        const { createSessionDraftCipher } = await import('@/sync/encryption/sessionDraftEncryption');
        resetSessionDraftRepositoryForTests();
        configureSessionDraftRepository({ scope: { serverId: 'server-1', accountId: 'account-1' }, syncEnabled: false,
            cipher: createSessionDraftCipher({ accountMode: 'plain', accountCryptoMaterial: null,
                getSessionContext: () => { throw new Error('A new-session draft has no Session'); }, randomBytes: size => new Uint8Array(size) }) });
    });

    it('opens machine setup through the Home tab that owns the pressed empty state', async () => {
        const { SessionsListEmptyState } = await import('./SessionsListEmptyState');
        const pushes = [vi.fn(), vi.fn()];
        const screen = await renderSessions(<>
            {pushes.map((push, index) => <DestinationInstanceHost key={index}
                tabId={`home-${index}`} ref={{ kind: 'sessions', params: {} }} pathname="/"
                focused={index === 0} visible navigation={{ push, replace: () => {}, back: () => {} }}>
                <SessionsListEmptyState kind="start_daemon" targetLabel="Computer" />
            </DestinationInstanceHost>)}
        </>);
        const actions = screen.root.findAll((node) => typeof node.type === 'string'
            && node.props.testID === 'sessions-empty-state-open-setup'
            && typeof node.props.onPress === 'function');
        expect(actions).toHaveLength(2);
        await act(async () => { actions.forEach((node) => node.props.onPress()); });
        expect(pushes[0]).toHaveBeenCalledWith(buildMachineAddHref({ path: 'thisComputer' }));
        expect(pushes[1]).toHaveBeenCalledWith(buildMachineAddHref({ path: 'thisComputer' }));
        expect(routerPushSpy).not.toHaveBeenCalled();
    });

    it('renders one start-session action per online machine and keeps the CLI guidance inline', async () => {
        const nowMs = Date.now();
        machinesMock = [
            createMachine({ id: 'm-online', host: 'leeroy-mbp', active: true, activeAt: nowMs }),
            createMachine({ id: 'm-offline', host: 'studio-mac', active: true, activeAt: nowMs - (2 * 60_000) }),
        ];

        const { SessionsListEmptyState } = await import('./SessionsListEmptyState');
        const screen = await renderSessions(<SessionsListEmptyState kind="create_session" targetLabel="leeroy-mbp" />);

        expect(
            screen.findAllByType('Text' as never)
                .some((node) => flattenTextValue(node.props.children) === 'sessionsList.emptyState.startSessionOnMachine:leeroy-mbp'),
        ).toBe(true);
        expect(
            screen.findAllByType('Text' as never)
                .some((node) => flattenTextValue(node.props.children) === 'sessionsList.emptyState.startSessionOnMachineSubtitle'),
        ).toBe(true);
        expect(() => screen.findByProps({ testID: 'sessions-empty-state-machine:m-offline' })).toThrow();
        expect(
            screen.findAllByType('Text' as never)
                .some((node) => flattenTextValue(node.props.children).includes(resolveCliInvokerNameForCurrentApp())),
        ).toBe(true);
    });

    it('routes the machine action into the new-session flow with machine and server context', async () => {
        machinesMock = [
            createMachine({ id: 'm-online', host: 'leeroy-mbp' }),
        ];

        const { SessionsListEmptyState } = await import('./SessionsListEmptyState');
        const screen = await renderSessions(<SessionsListEmptyState kind="create_session" targetLabel="leeroy-mbp" />);

        await screen.pressByTestIdAsync('sessions-empty-state-machine:m-online');

        expect(routerPushSpy).toHaveBeenCalledWith({
            pathname: '/new',
            params: {
                draftId: expect.any(String),
            },
        });
        expect(selectedDraft()).toMatchObject({ selectedMachineId: 'm-online', targetServerId: 'server-1' });
    });

    it('offers every online same-name Machine with a distinguishable label', async () => {
        machinesMock = [createMachine({ id: 'd4ac-machine', host: 'same-host' }),
            createMachine({ id: 'f874-machine', host: 'same-host' })];
        const { SessionsListEmptyState } = await import('./SessionsListEmptyState');
        const { Item } = await import('@/components/ui/lists/Item');
        const screen = await renderSessions(<SessionsListEmptyState kind="create_session" targetLabel="same-host" />);
        expect(screen.findAllByType(Item).filter(node => node.props.testID?.startsWith('sessions-empty-state-machine:'))
            .map(node => ({ id: node.props.testID, title: node.props.title })))
            .toEqual([
                { id: 'sessions-empty-state-machine:d4ac-machine', title: 'sessionsList.emptyState.startSessionOnMachine:same-host · d4ac' },
                { id: 'sessions-empty-state-machine:f874-machine', title: 'sessionsList.emptyState.startSessionOnMachine:same-host · f874' },
            ]);
        await screen.pressByTestIdAsync('sessions-empty-state-machine:f874-machine');
        expect(selectedDraft()).toMatchObject({ selectedMachineId: 'f874-machine', targetServerId: 'server-1' });
    });

    // No machine yet (58d AF1): the setup page is desktop-only, so neither the phone's Sessions tab nor the
    // sidebar offers it. One quiet line; New Session ("Run on…") is the way to start.
    it.each(['default', 'sidebar'] as const)('keeps the %s surface to one quiet line with no machine yet', async (surface) => {
        const { SessionsListEmptyState } = await import('./SessionsListEmptyState');
        const screen = await renderSessions(<SessionsListEmptyState kind="connect_machine" targetLabel="leeroy-mbp" surface={surface} />);

        expect(screen.findByProps({ testID: 'session-getting-started-kind-connect_machine' })).toBeTruthy();
        expect(screen.findByProps({ testID: 'sessions-empty-state-first-run' })).toBeTruthy();
        expect(() => screen.findByProps({ testID: 'sessions-empty-state-summary' })).toThrow();
        expect(() => screen.findByProps({ testID: 'sessions-empty-state-open-setup' })).toThrow();
    });

    it('renders the reconnect action below the tile when a machine exists but is offline', async () => {
        machinesMock = [
            createMachine({ id: 'm-offline', host: 'leeroy-mbp', active: false, activeAt: Date.now() - (10 * 60_000) }),
        ];

        const { SessionsListEmptyState } = await import('./SessionsListEmptyState');
        const screen = await renderSessions(<SessionsListEmptyState kind="start_daemon" targetLabel="leeroy-mbp" />);

        expect(screen.findByProps({ testID: 'session-getting-started-kind-start_daemon' })).toBeTruthy();
        expect(
            screen.findAllByType('Text' as never)
                .some((node) => flattenTextValue(node.props.children) === 'sessionsList.emptyState.reconnectMachineActionSubtitle'),
        ).toBe(true);

        await screen.pressByTestIdAsync('sessions-empty-state-open-setup');

        expect(routerPushSpy).toHaveBeenCalledWith(buildMachineAddHref({ path: 'thisComputer' }));
    });

    it('renders select-session as the browse-style summary without setup actions', async () => {
        const { SessionsListEmptyState } = await import('./SessionsListEmptyState');
        const screen = await renderSessions(<SessionsListEmptyState kind="select_session" targetLabel="leeroy-mbp" />);

        expect(screen.findByProps({ testID: 'session-getting-started-kind-select_session' })).toBeTruthy();
        expect(screen.findByTestId('sessions-empty-state-summary')).not.toBeNull();
        expect(screen.findByTestId('sessions-empty-state-title')).not.toBeNull();
        expect(screen.findByTestId('sessions-empty-state-description')).not.toBeNull();
        expect(screen.findByTestId('sessions-empty-state-open-setup')).toBeNull();
        expect(() => screen.findByProps({ testID: 'sessions-empty-state-machine:m-online' })).toThrow();
    });
});
