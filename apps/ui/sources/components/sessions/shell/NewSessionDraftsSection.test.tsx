import React from 'react';
import { View } from 'react-native';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createThemeFixture, renderScreen, standardCleanup } from '@/dev/testkit';
import { FocusReturnProvider, useFocusReturnFallbackRef } from '@/keyboard/focusReturn';
import type { NewSessionDraftProjection } from '@/sync/ops/sessionDrafts/sessionDraftRepository';

type CataloguedNewSessionDraftDocument = Extract<
    NewSessionDraftProjection['document'],
    { target: { kind: 'newSession' } }
>;

function assertCataloguedNewSessionDocument(
    document: NewSessionDraftProjection['document'],
): asserts document is CataloguedNewSessionDraftDocument {
    if (document.v !== 2 || document.target.kind !== 'newSession') {
        throw new Error('expected a catalogued new-session draft');
    }
}
import type { RunnerActivationClient } from '@/sync/api/ephemeralRunner/runnerActivationClient';
import {
    resolveNewSessionDraftAgentId,
    resolveNewSessionDraftMachineId,
} from '@/components/sessions/drafts/newSessionDraftPresentation';

import {
    NewSessionDraftsSection,
    NewSessionDraftsSectionView,
    buildNewSessionDraftContinueRoute,
    buildNewSessionDraftRowPresentation,
    deleteNewSessionDraftAfterConfirmation,
    isNewSessionDraftDeletionBlocked,
    resolveNewSessionDraftSectionTitle,
    resolveNewSessionDraftWaitingSectionTitle,
    resolveNewSessionDraftMachineUnavailable,
} from './NewSessionDraftsSection';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const HOME_A_SCOPE = { serverId: 'home-a', accountId: 'account-a' } as const;
const HOME_B_SCOPE = { serverId: 'home-b', accountId: 'account-b' } as const;

const focusedScopeState = vi.hoisted(() => ({
    scope: null as { serverId: string; accountId: string } | null,
    listeners: new Set<() => void>(),
}));
const draftRepositoryState = vi.hoisted(() => ({
    draftsByScopeKey: new Map<string, readonly unknown[]>(),
    remoteDraftsByScopeKey: new Map<string, readonly unknown[]>(),
    listenersByScopeKey: new Map<string, Set<() => void>>(),
    scopedDeleteResultsByScopeKey: new Map<string, boolean>(),
    hydrationGatesByScopeKey: new Map<string, Promise<void>>(),
    deleteGatesByScopeKey: new Map<string, Promise<void>>(),
    scopedHydrationKeys: [] as string[],
    scopedDeleteKeys: [] as string[],
    ambientDeleteKeys: [] as string[],
    liveSubscriptionKeys: [] as string[],
    subscribedKeys: [] as string[],
}));
const serverProfilesState = vi.hoisted(() => ({
    profiles: [] as Array<{ id: string; serverIdentityId?: string | null; serverUrl: string; name: string }>,
    bindings: new Map<string, { scope: { serverId: string; accountId: string }; isCurrent: () => boolean }>(),
    unavailableProfileIds: new Set<string>(),
}));

// The draft repository is the persisted draft-store boundary consumed through
// `useSyncExternalStore`. Everything below it — row presentation, availability,
// deletion policy, focus return — stays real.
vi.mock('@/sync/ops/sessionDrafts/sessionDraftRepository', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/sync/ops/sessionDrafts/sessionDraftRepository')>();
    const keyOf = (scope: { serverId: string; accountId: string }) => `${scope.serverId}|${scope.accountId}`;
    // The canonical repository caches one projection array per scope, so a scope
    // with no drafts keeps returning the same reference. A fresh `[]` here would
    // make `useSyncExternalStore` see a new snapshot on every render and spin —
    // a defect in this harness, not in the owner it stands in for.
    const NO_DRAFTS: readonly unknown[] = Object.freeze([]);
    return {
        ...actual,
        subscribeSessionDraftList: (scope: { serverId: string; accountId: string }, listener: () => void) => {
            const key = keyOf(scope);
            draftRepositoryState.subscribedKeys.push(key);
            draftRepositoryState.liveSubscriptionKeys.push(key);
            const listeners = draftRepositoryState.listenersByScopeKey.get(key) ?? new Set();
            listeners.add(listener);
            draftRepositoryState.listenersByScopeKey.set(key, listeners);
            return () => {
                const index = draftRepositoryState.liveSubscriptionKeys.indexOf(key);
                if (index >= 0) draftRepositoryState.liveSubscriptionKeys.splice(index, 1);
                listeners.delete(listener);
            };
        },
        listNewSessionDraftProjections: (scope: { serverId: string; accountId: string }) =>
            draftRepositoryState.draftsByScopeKey.get(keyOf(scope)) ?? NO_DRAFTS,
        deleteSessionDraft: async ({ scope, address }: {
            scope: { serverId: string; accountId: string };
            address: { kind: 'newSession'; draftId: string };
        }) => {
            draftRepositoryState.ambientDeleteKeys.push(`${keyOf(scope)}|${address.draftId}`);
        },
        ensureSessionDraftRepositoryHydratedWithScopedRuntime: async ({ scope, isCurrent }: {
            scope: { serverId: string; accountId: string };
            isCurrent: () => boolean;
        }) => {
            const key = keyOf(scope);
            draftRepositoryState.scopedHydrationKeys.push(key);
            await (draftRepositoryState.hydrationGatesByScopeKey.get(key) ?? Promise.resolve());
            if (!isCurrent()) return;
            draftRepositoryState.draftsByScopeKey.set(
                key,
                draftRepositoryState.remoteDraftsByScopeKey.get(key) ?? NO_DRAFTS,
            );
            draftRepositoryState.listenersByScopeKey.get(key)?.forEach((listener) => listener());
        },
        deleteSessionDraftWithScopedRuntime: async ({ scope, address, isCurrent }: {
            scope: { serverId: string; accountId: string };
            address: { kind: 'newSession'; draftId: string };
            isCurrent: () => boolean;
        }) => {
            const key = keyOf(scope);
            draftRepositoryState.scopedDeleteKeys.push(`${key}|${address.draftId}`);
            await (draftRepositoryState.deleteGatesByScopeKey.get(key) ?? Promise.resolve());
            if (!isCurrent() || draftRepositoryState.scopedDeleteResultsByScopeKey.get(key) !== true) return false;
            const current = draftRepositoryState.draftsByScopeKey.get(key) ?? NO_DRAFTS;
            draftRepositoryState.draftsByScopeKey.set(
                key,
                current.filter((candidate: any) => candidate.draftId !== address.draftId),
            );
            draftRepositoryState.listenersByScopeKey.get(key)?.forEach((listener) => listener());
            return true;
        },
    };
});
vi.mock('@/sync/ops/sessionDrafts/runWithSessionDraftRepositoryScopedRuntime', () => ({
    runWithSessionDraftRepositoryScopedRuntime: async ({ binding, operation }: {
        binding: { scope: { serverId: string; accountId: string }; isCurrent: () => boolean };
        operation: (input: unknown) => Promise<unknown>;
    }) => {
        if (!binding.isCurrent()) return null;
        return await operation({
            scope: binding.scope,
            runtime: { transport: {}, cipher: {} },
            isCurrent: binding.isCurrent,
        });
    },
}));
vi.mock('@/sync/domains/state/storage', async (importOriginal) => {
    const { createStorageModuleMock } = await import('@/dev/testkit/mocks/storage');
    const ReactModule = await import('react');
    return createStorageModuleMock({
        importOriginal,
        overrides: {
            // Production reads this value from the live zustand store. Preserve
            // that reactive boundary here so a scope transition reaches a
            // memoized consumer without relying on an unrelated parent render.
            useActiveServerAccountScope: () => ReactModule.useSyncExternalStore(
                (listener) => {
                    focusedScopeState.listeners.add(listener);
                    return () => focusedScopeState.listeners.delete(listener);
                },
                () => focusedScopeState.scope,
                () => focusedScopeState.scope,
            ),
            useLaunchSelectionMachines: () => [],
            useMachineListStatusByServerId: () => ({}),
        },
    });
});
vi.mock('@/sync/domains/server/serverProfiles', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/sync/domains/server/serverProfiles')>();
    return {
        ...actual,
        listServerProfiles: () => serverProfilesState.profiles,
        getServerProfileById: (serverId: string) => (
            serverProfilesState.unavailableProfileIds.has(serverId)
                ? null
                : serverProfilesState.profiles.find((profile) => profile.id === serverId) ?? null
        ),
    };
});
vi.mock('@/hooks/server/useServerProfilesGeneration', () => ({ useServerProfilesGeneration: () => 1 }));
vi.mock('@/sync/domains/scope/useServerCredentialAccountScopes', () => ({
    useServerCredentialAccountScopeBindings: () => serverProfilesState.bindings,
}));
const routerMockState = vi.hoisted(() => ({
    spies: null as Awaited<ReturnType<typeof import('@/dev/testkit/mocks/router').createExpoRouterMock>>['spies'] | null,
}));
const modalMockState = vi.hoisted(() => ({ confirmResult: false }));
vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    const mock = createExpoRouterMock();
    routerMockState.spies = mock.spies;
    return mock.module;
});
vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock({
        spies: { confirm: async () => modalMockState.confirmResult },
    }).module;
});

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    const base = await createReactNativeWebMock({ Pressable: 'Pressable' });
    const MockView = React.forwardRef((props: Record<string, unknown> & { children?: React.ReactNode }, ref) => {
        React.useImperativeHandle(ref, () => ({
            isConnected: true,
            focus: () => focusState.calls.push(String(props.testID)),
        }), [props.testID]);
        return React.createElement('View', props, props.children);
    });
    return { ...base, View: MockView };
});
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});
vi.mock('@/text', () => ({
    t: (key: string, params?: Readonly<Record<string, unknown>>) => (
        key === 'sessionDrafts.sectionTitleForHome' || key === 'sessionDrafts.waitingSectionTitleForHome'
            ? `${key}:${String(params?.home ?? '')}`
            : key
    ),
}));
const focusState = vi.hoisted(() => ({ calls: [] as string[] }));
vi.mock('@/components/ui/lists/Item', async () => {
    const ReactModule = await import('react');
    return {
        Item: (props: any) => {
            ReactModule.useEffect(() => {
                const assign = (value: unknown) => {
                    if (typeof props.pressableRef === 'function') props.pressableRef(value);
                    else if (props.pressableRef) props.pressableRef.current = value;
                };
                assign({ focus: () => focusState.calls.push(props.testID) });
                return () => assign(null);
            }, [props.pressableRef, props.testID]);
            return ReactModule.createElement('Item', props, props.rightElement);
        },
    };
});
vi.mock('@/components/appShell/plugins/AppShellPluginUiProjection', () => ({
    useAppShellPluginUiProjection: () => ({ phase: 'unavailable', pluginUiProjection: null }),
}));
vi.mock('@/components/ui/lists/ItemGroup', () => ({ ItemGroup: (props: any) => React.createElement('ItemGroup', props, props.children) }));
vi.mock('@/components/ui/icons/Icon', () => ({
    Icon: (props: any) => React.createElement('Icon', props),
    ICON_SIZE: { xs: 14, sm: 16, md: 20, lg: 24, xl: 29 },
}));
vi.mock('@/components/sessions/presentation/SessionAgentCatalogIdentityIcon', () => ({
    SessionAgentCatalogIdentityIcon: (props: any) => React.createElement('SessionAgentCatalogIdentityIcon', props),
}));
// The catalog is internal logic and the testkit's own fixtures read it, so this
// keeps the real module and overrides only the presentation leaves in play.
vi.mock('@/agents/catalog/catalog', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/agents/catalog/catalog')>()),
    getAgentPickerIconScale: () => 1,
}));

function draft(
    overrides: Partial<NewSessionDraftProjection> = {},
    prompt = 'Fix login\nwith tests',
): NewSessionDraftProjection {
    return {
        draftId: '00000000-0000-4000-8000-000000000001',
        document: {
            v: 1,
            composer: {
                text: { mutationId: 'm-text', value: prompt },
                mentions: { mutationId: 'm-mentions', value: [] },
                attachments: { mutationId: 'm-attachments', value: [] },
            },
            target: {
                kind: 'newSession',
                authoring: {
                    directory: { mutationId: 'm-dir', value: '/Users/alice/private-project' },
                    serverId: { mutationId: 'm-server', value: 'server-a' },
                    machineId: { mutationId: 'm-machine', value: 'machine-a' },
                    agentId: { mutationId: 'm-agent', value: 'codex' },
                },
            },
            extensions: {},
        },
        status: 'pending',
        conflict: null,
        createdAt: 10,
        updatedAt: 20,
        localSupplement: {},
        ...overrides,
    };
}

/**
 * Temporary-computer authoring is catalogued only in the current document, so
 * every Runner draft fixture is a V2 document rather than the released V1
 * vocabulary the ordinary `draft()` fixture keeps.
 */
function temporaryComputerDraft(input: Readonly<{
    base?: NewSessionDraftProjection;
    serverId: string;
    activationRef?: Readonly<{ v: 1; activationId: string; createdOnDeviceLabel: string }>;
}>): NewSessionDraftProjection {
    const base = input.base ?? draft();
    return {
        ...base,
        document: {
            v: 2,
            composer: base.document.composer,
            target: {
                kind: 'newSession',
                authoring: {
                    directory: { mutationId: 'm-dir', value: '/Users/alice/private-project' },
                    executionTarget: {
                        mutationId: 'm-target',
                        value: {
                            kind: 'temporary_computer',
                            serverId: input.serverId,
                            artifactTarget: 'linux-x64',
                            workspace: { kind: 'choose_on_endpoint' },
                        },
                    },
                    ...(input.activationRef
                        ? { temporaryComputerActivationRef: { mutationId: 'm-activation', value: input.activationRef } }
                        : {}),
                },
            },
            extensions: {},
        },
    };
}

/** A draft whose package is already out: an activation reference exists for it. */
function waitingRunnerDraft(draftId: string, serverId: string): NewSessionDraftProjection {
    return {
        ...temporaryComputerDraft({
            serverId,
            activationRef: {
                v: 1,
                activationId: '00000000-0000-4000-8000-000000000099',
                createdOnDeviceLabel: 'Alice’s Mac',
            },
        }),
        draftId,
        status: 'clean',
    };
}

describe('NewSessionDraftsSection', () => {
    afterEach(() => {
        focusState.calls = [];
        focusedScopeState.scope = null;
        focusedScopeState.listeners.clear();
        draftRepositoryState.draftsByScopeKey.clear();
        draftRepositoryState.remoteDraftsByScopeKey.clear();
        draftRepositoryState.listenersByScopeKey.clear();
        draftRepositoryState.scopedDeleteResultsByScopeKey.clear();
        draftRepositoryState.hydrationGatesByScopeKey.clear();
        draftRepositoryState.deleteGatesByScopeKey.clear();
        draftRepositoryState.scopedHydrationKeys = [];
        draftRepositoryState.scopedDeleteKeys = [];
        draftRepositoryState.ambientDeleteKeys = [];
        draftRepositoryState.liveSubscriptionKeys = [];
        draftRepositoryState.subscribedKeys = [];
        serverProfilesState.profiles = [];
        serverProfilesState.bindings = new Map();
        serverProfilesState.unavailableProfileIds.clear();
        modalMockState.confirmResult = false;
        standardCleanup();
    });

    it('derives a prompt-first title without routine machine, folder, agent, or model metadata', () => {
        const presentation = buildNewSessionDraftRowPresentation(draft());
        expect(presentation).toEqual({ title: 'Fix login', statusKey: 'sessionDrafts.status.syncing' });
        expect(JSON.stringify(presentation)).not.toContain('machine-a');
        expect(JSON.stringify(presentation)).not.toContain('private-project');
        expect(JSON.stringify(presentation)).not.toContain('codex');
        expect(JSON.stringify(presentation)).not.toContain('/Users/alice');
    });

    it('labels the draft owner Home instead of implying Team-filtered draft ownership', () => {
        expect(resolveNewSessionDraftSectionTitle({
            serverId: 'home-a',
            homeName: 'Alice’s Home',
            viewContext: { kind: 'team', team: { serverId: 'home-b', teamId: 'team-b' }, teamDisplayName: 'Design' },
        })).toBe('sessionDrafts.sectionTitleForHome:Alice’s Home');
        expect(resolveNewSessionDraftSectionTitle({
            serverId: 'home-a',
            homeName: 'Alice’s Home',
            viewContext: { kind: 'team', team: { serverId: 'home-a', teamId: 'team-a' }, teamDisplayName: 'Design' },
        })).toBe('sessionDrafts.sectionTitle');
        expect(resolveNewSessionDraftSectionTitle({
            serverId: 'home-a',
            homeName: null,
            viewContext: { kind: 'global' },
        })).toBe('sessionDrafts.sectionTitle');
        expect(resolveNewSessionDraftSectionTitle({
            serverId: null,
            homeName: null,
            viewContext: { kind: 'global' },
        })).toBe('sessionDrafts.sectionTitle');
    });

    it('binds Continue to the exact draft Home and Account scope', () => {
        expect(buildNewSessionDraftContinueRoute('draft-b', HOME_B_SCOPE)).toEqual({
            pathname: '/new',
            params: {
                draftId: 'draft-b',
                spawnServerId: 'home-b',
                draftServerId: 'home-b',
                draftAccountId: 'account-b',
            },
        });
    });

    it('subscribes only to the focused Home and replaces its rows when focus moves', async () => {
        const draftA = { ...draft(), draftId: '00000000-0000-4000-8000-00000000000a' };
        const draftB = { ...draft(), draftId: '00000000-0000-4000-8000-00000000000b' };
        draftRepositoryState.draftsByScopeKey.set('home-a|account-a', Object.freeze([draftA]));
        draftRepositoryState.draftsByScopeKey.set('home-b|account-b', Object.freeze([draftB]));
        focusedScopeState.scope = HOME_A_SCOPE;

        const screen = await renderScreen(<NewSessionDraftsSection />);

        expect(screen.findByTestId(`session-draft-row:new-session:${draftA.draftId}`)).not.toBeNull();
        expect(screen.findByTestId(`session-draft-row:new-session:${draftB.draftId}`)).toBeNull();
        expect(draftRepositoryState.subscribedKeys).toEqual(['home-a|account-a']);
        expect(draftRepositoryState.liveSubscriptionKeys).toEqual(['home-a|account-a']);

        await act(async () => {
            focusedScopeState.scope = HOME_B_SCOPE;
            focusedScopeState.listeners.forEach((listener) => listener());
        });

        expect(screen.findByTestId(`session-draft-row:new-session:${draftB.draftId}`)).not.toBeNull();
        expect(screen.findByTestId(`session-draft-row:new-session:${draftA.draftId}`)).toBeNull();
        expect(draftRepositoryState.liveSubscriptionKeys).toEqual(['home-b|account-b']);

        await screen.unmount();
        expect(draftRepositoryState.liveSubscriptionKeys).toEqual([]);
    });

    it('keeps another Home’s waiting Temporary-computer request discoverable and exactly scoped', async () => {
        const ordinaryOnB = { ...draft(), draftId: '00000000-0000-4000-8000-00000000000b' };
        const unlaunchedTemporaryComputerOnB = {
            ...temporaryComputerDraft({ serverId: 'home-b' }),
            draftId: '00000000-0000-4000-8000-0000000000db',
        };
        const waitingOnB = waitingRunnerDraft('00000000-0000-4000-8000-0000000000cb', 'home-b');
        draftRepositoryState.draftsByScopeKey.set('home-a|account-a', Object.freeze([draft()]));
        // Nothing from B exists in the local repository before mount. The exact
        // inactive-Home hydration is what makes the remote waiting row visible.
        draftRepositoryState.remoteDraftsByScopeKey.set('home-b|account-b', Object.freeze([
            ordinaryOnB,
            unlaunchedTemporaryComputerOnB,
            waitingOnB,
        ]));
        focusedScopeState.scope = HOME_A_SCOPE;
        serverProfilesState.profiles = [
            { id: 'home-a', serverUrl: 'https://home-a.test', name: 'Home A' },
            { id: 'home-b', serverUrl: 'https://home-b.test', name: 'Home B' },
        ];
        serverProfilesState.bindings = new Map([['home-b', { scope: HOME_B_SCOPE, isCurrent: () => true }]]);

        const screen = await renderScreen(<NewSessionDraftsSection />);

        // The live package on home-b stays reachable from home-a...
        await vi.waitFor(() => expect(
            screen.findByTestId(`session-draft-row:new-session:${waitingOnB.draftId}`),
        ).not.toBeNull());
        // ...while home-b's ordinary drafts remain its own Home's business.
        expect(screen.findByTestId(`session-draft-row:new-session:${ordinaryOnB.draftId}`)).toBeNull();
        // Selecting Temporary computer is still ordinary authoring until the
        // package activation reference exists. It must not leak cross-Home.
        expect(screen.findByTestId(
            `session-draft-row:new-session:${unlaunchedTemporaryComputerOnB.draftId}`,
        )).toBeNull();
        expect(screen.findByTestId('session-drafts-waiting-section:home-b:account-b')).not.toBeNull();
        expect(draftRepositoryState.scopedHydrationKeys).toContain('home-b|account-b');
        expect(draftRepositoryState.scopedHydrationKeys).not.toContain('home-a|account-a');
        await screen.unmount();
    });

    it('names the Home that owns a cross-Home waiting request', () => {
        expect(resolveNewSessionDraftWaitingSectionTitle({ serverId: 'home-b', homeName: 'Bob’s Home' }))
            .toBe('sessionDrafts.waitingSectionTitleForHome:Bob’s Home');
        expect(resolveNewSessionDraftWaitingSectionTitle({ serverId: 'home-b', homeName: '  ' }))
            .toBe('sessionDrafts.waitingSectionTitleForHome:home-b');
    });

    it('binds a cross-Home waiting row’s continue and delete to that row’s exact scope', async () => {
        const waitingOnB = waitingRunnerDraft('00000000-0000-4000-8000-0000000000cc', 'home-b');
        draftRepositoryState.remoteDraftsByScopeKey.set('home-b|account-b', Object.freeze([waitingOnB]));
        focusedScopeState.scope = HOME_A_SCOPE;
        serverProfilesState.profiles = [
            { id: 'home-a', serverUrl: 'https://home-a.test', name: 'Home A' },
            { id: 'home-b', serverUrl: 'https://home-b.test', name: 'Home B' },
        ];
        serverProfilesState.bindings = new Map([['home-b', { scope: HOME_B_SCOPE, isCurrent: () => true }]]);

        const screen = await renderScreen(<NewSessionDraftsSection />);

        await vi.waitFor(() => expect(
            screen.findByTestId(`session-draft-row:new-session:${waitingOnB.draftId}`),
        ).not.toBeNull());
        const row = screen.findByTestId(`session-draft-row:new-session:${waitingOnB.draftId}`);
        routerMockState.spies?.push.mockClear();
        await act(async () => row?.props.onPress());
        expect(routerMockState.spies?.push).toHaveBeenCalledWith(
            buildNewSessionDraftContinueRoute(waitingOnB.draftId, HOME_B_SCOPE),
        );
        await screen.unmount();
    });

    it('removes only the acknowledged inactive-Home draft through that row scope', async () => {
        const activeA = { ...draft(), draftId: '00000000-0000-4000-8000-0000000000aa' };
        const waitingB = waitingRunnerDraft('00000000-0000-4000-8000-0000000000bb', 'home-b');
        draftRepositoryState.draftsByScopeKey.set('home-a|account-a', Object.freeze([activeA]));
        draftRepositoryState.remoteDraftsByScopeKey.set('home-b|account-b', Object.freeze([waitingB]));
        draftRepositoryState.scopedDeleteResultsByScopeKey.set('home-b|account-b', true);
        focusedScopeState.scope = HOME_A_SCOPE;
        modalMockState.confirmResult = true;
        serverProfilesState.profiles = [
            { id: 'home-a', serverUrl: 'https://home-a.test', name: 'Home A' },
            { id: 'home-b', serverUrl: 'https://home-b.test', name: 'Home B' },
        ];
        serverProfilesState.bindings = new Map([['home-b', { scope: HOME_B_SCOPE, isCurrent: () => true }]]);
        const screen = await renderScreen(<NewSessionDraftsSection />);
        await vi.waitFor(() => expect(
            screen.findByTestId(`session-draft-row:new-session:${waitingB.draftId}`),
        ).not.toBeNull());

        await act(async () => screen.findByTestId(
            `session-draft-delete:new-session:${waitingB.draftId}`,
        )?.props.onPress({ stopPropagation: vi.fn() }));

        await vi.waitFor(() => expect(
            screen.findByTestId(`session-draft-row:new-session:${waitingB.draftId}`),
        ).toBeNull());
        expect(screen.findByTestId(`session-draft-row:new-session:${activeA.draftId}`)).not.toBeNull();
        expect(draftRepositoryState.scopedDeleteKeys).toEqual([
            `home-b|account-b|${waitingB.draftId}`,
        ]);
        await screen.unmount();
    });

    it('keeps the inactive-Home waiting row when its authoritative delete is rejected', async () => {
        const waitingB = waitingRunnerDraft('00000000-0000-4000-8000-0000000000bc', 'home-b');
        draftRepositoryState.remoteDraftsByScopeKey.set('home-b|account-b', Object.freeze([waitingB]));
        draftRepositoryState.scopedDeleteResultsByScopeKey.set('home-b|account-b', false);
        focusedScopeState.scope = HOME_A_SCOPE;
        modalMockState.confirmResult = true;
        serverProfilesState.profiles = [
            { id: 'home-a', serverUrl: 'https://home-a.test', name: 'Home A' },
            { id: 'home-b', serverUrl: 'https://home-b.test', name: 'Home B' },
        ];
        serverProfilesState.bindings = new Map([['home-b', { scope: HOME_B_SCOPE, isCurrent: () => true }]]);
        const screen = await renderScreen(<NewSessionDraftsSection />);
        await vi.waitFor(() => expect(
            screen.findByTestId(`session-draft-row:new-session:${waitingB.draftId}`),
        ).not.toBeNull());

        await act(async () => screen.findByTestId(
            `session-draft-delete:new-session:${waitingB.draftId}`,
        )?.props.onPress({ stopPropagation: vi.fn() }));

        expect(screen.findByTestId(`session-draft-row:new-session:${waitingB.draftId}`)).not.toBeNull();
        expect(draftRepositoryState.scopedDeleteKeys).toEqual([
            `home-b|account-b|${waitingB.draftId}`,
        ]);
        await screen.unmount();
    });

    it('never falls back to the active repository when an inactive Home endpoint is unavailable', async () => {
        const waitingB = waitingRunnerDraft('00000000-0000-4000-8000-0000000000bf', 'home-b');
        draftRepositoryState.draftsByScopeKey.set('home-b|account-b', Object.freeze([waitingB]));
        focusedScopeState.scope = HOME_A_SCOPE;
        modalMockState.confirmResult = true;
        serverProfilesState.profiles = [
            { id: 'home-a', serverUrl: 'https://home-a.test', name: 'Home A' },
            { id: 'home-b', serverUrl: 'https://home-b.test', name: 'Home B' },
        ];
        serverProfilesState.unavailableProfileIds.add('home-b');
        serverProfilesState.bindings = new Map([['home-b', { scope: HOME_B_SCOPE, isCurrent: () => true }]]);
        const screen = await renderScreen(<NewSessionDraftsSection />);

        await act(async () => screen.findByTestId(
            `session-draft-delete:new-session:${waitingB.draftId}`,
        )?.props.onPress({ stopPropagation: vi.fn() }));

        expect(screen.findByTestId(`session-draft-row:new-session:${waitingB.draftId}`)).not.toBeNull();
        expect(draftRepositoryState.scopedDeleteKeys).toEqual([]);
        expect(draftRepositoryState.ambientDeleteKeys).toEqual([]);
        await screen.unmount();
    });

    it('publishes and removes nothing after the inactive-Home section retires', async () => {
        const waitingB = waitingRunnerDraft('00000000-0000-4000-8000-0000000000bd', 'home-b');
        let releaseHydration!: () => void;
        draftRepositoryState.remoteDraftsByScopeKey.set('home-b|account-b', Object.freeze([waitingB]));
        draftRepositoryState.hydrationGatesByScopeKey.set(
            'home-b|account-b',
            new Promise<void>((resolve) => { releaseHydration = resolve; }),
        );
        focusedScopeState.scope = HOME_A_SCOPE;
        serverProfilesState.profiles = [
            { id: 'home-a', serverUrl: 'https://home-a.test', name: 'Home A' },
            { id: 'home-b', serverUrl: 'https://home-b.test', name: 'Home B' },
        ];
        serverProfilesState.bindings = new Map([['home-b', { scope: HOME_B_SCOPE, isCurrent: () => true }]]);
        const screen = await renderScreen(<NewSessionDraftsSection />);
        await vi.waitFor(() => expect(draftRepositoryState.scopedHydrationKeys).toContain('home-b|account-b'));

        await screen.unmount();
        releaseHydration();
        await Promise.resolve();

        expect(draftRepositoryState.draftsByScopeKey.has('home-b|account-b')).toBe(false);
    });

    it('does not remove a waiting row when the section retires before delete responds', async () => {
        const waitingB = waitingRunnerDraft('00000000-0000-4000-8000-0000000000be', 'home-b');
        let releaseDelete!: () => void;
        draftRepositoryState.remoteDraftsByScopeKey.set('home-b|account-b', Object.freeze([waitingB]));
        draftRepositoryState.scopedDeleteResultsByScopeKey.set('home-b|account-b', true);
        draftRepositoryState.deleteGatesByScopeKey.set(
            'home-b|account-b',
            new Promise<void>((resolve) => { releaseDelete = resolve; }),
        );
        focusedScopeState.scope = HOME_A_SCOPE;
        modalMockState.confirmResult = true;
        serverProfilesState.profiles = [
            { id: 'home-a', serverUrl: 'https://home-a.test', name: 'Home A' },
            { id: 'home-b', serverUrl: 'https://home-b.test', name: 'Home B' },
        ];
        serverProfilesState.bindings = new Map([['home-b', { scope: HOME_B_SCOPE, isCurrent: () => true }]]);
        const screen = await renderScreen(<NewSessionDraftsSection />);
        await vi.waitFor(() => expect(
            screen.findByTestId(`session-draft-row:new-session:${waitingB.draftId}`),
        ).not.toBeNull());

        screen.findByTestId(`session-draft-delete:new-session:${waitingB.draftId}`)?.props.onPress({
            stopPropagation: vi.fn(),
        });
        await vi.waitFor(() => expect(draftRepositoryState.scopedDeleteKeys).toHaveLength(1));
        await screen.unmount();
        releaseDelete();
        await Promise.resolve();

        expect(draftRepositoryState.draftsByScopeKey.get('home-b|account-b')).toEqual([waitingB]);
    });

    it('renders nothing until a focused Home Account scope exists', async () => {
        draftRepositoryState.draftsByScopeKey.set('home-a|account-a', Object.freeze([draft()]));
        focusedScopeState.scope = null;

        const screen = await renderScreen(<NewSessionDraftsSection />);

        expect(screen.findByTestId('session-drafts-section')).toBeNull();
        expect(draftRepositoryState.subscribedKeys).toEqual([]);
        await screen.unmount();
    });

    it('projects canonical Runner activation status without creating a draft-local lifecycle', async () => {
        const projection = draft();
        const runnerDraft: NewSessionDraftProjection = {
            ...temporaryComputerDraft({
                base: projection,
                serverId: 'home-a',
                activationRef: {
                    v: 1,
                    activationId: '00000000-0000-4000-8000-000000000099',
                    createdOnDeviceLabel: 'Alice’s Mac',
                },
            }),
            status: 'clean',
        };
        const read = vi.fn(async () => ({
            activationId: '00000000-0000-4000-8000-000000000099',
            state: 'claimed',
            review: {
                sealedLaunchManifest: 'sealed',
                authoringCommitment: 'A'.repeat(43),
                launchManifestCommitment: 'a'.repeat(64),
                credentialSelectionBinding: { v: 1, resourceId: 'resource-1', brokerMachineId: 'broker-1', revision: 1,
                    application: { agentTargetKey: 'agent:happier.agent.codex/codex', implementationIdentity: { pluginId: 'happier.provider.openai', localId: 'openai' }, endpointTemplateId: 'responses', protocol: 'openai-responses' },
                    sourceRevision: 'source-1' },
            },
            materialization: null,
        }) as never);
        const cancel = vi.fn();
        const client = { read, cancel } as unknown as RunnerActivationClient;
        const onDelete = vi.fn(async () => true);
        const screen = await renderScreen(
            <NewSessionDraftsSectionView
                drafts={[runnerDraft]}
                runnerActivationClient={client}
                onContinue={vi.fn()}
                onDelete={onDelete}
            />,
        );

        await vi.waitFor(() => expect(
            screen.findByTestId(`session-draft-row:new-session:${runnerDraft.draftId}`)?.props.subtitle,
        ).toBe('newSession.temporaryComputer.status.waiting_for_approval'));
        expect(read).toHaveBeenCalledWith(
            '00000000-0000-4000-8000-000000000099',
            expect.any(AbortSignal),
        );
        await act(async () => screen.findByTestId(
            `session-draft-delete:new-session:${runnerDraft.draftId}`,
        )?.props.onPress({ stopPropagation: vi.fn() }));
        await vi.waitFor(() => expect(onDelete).toHaveBeenCalledWith(runnerDraft.draftId));
        expect(cancel).not.toHaveBeenCalled();
        await screen.unmount();
    });

    it('uses the first nonblank prompt line instead of treating leading whitespace as an empty prompt', () => {
        const withLeadingBlankLine = draft({}, '\n  Keep the second line  \nthird');
        expect(buildNewSessionDraftRowPresentation(withLeadingBlankLine).title).toBe('Keep the second line');
    });

    it('projects installed Agent identities from the canonical authoring target', () => {
        const projection = temporaryComputerDraft({ serverId: 'server-a' });
        const document = projection.document;
        assertCataloguedNewSessionDocument(document);
        const installedProjection: NewSessionDraftProjection = {
            ...projection,
            document: {
                v: 2,
                composer: projection.document.composer,
                extensions: {},
                target: {
                    kind: 'newSession',
                    authoring: {
                        directory: projection.document.target.authoring.directory,
                        agentTarget: {
                            mutationId: 'm-agent',
                            value: {
                                kind: 'agent',
                                identity: { pluginId: 'acme.agent.review', localId: 'review' },
                            },
                        },
                    },
                },
            },
        };

        expect(resolveNewSessionDraftAgentId(installedProjection)).toBe('acme.agent.review/review');
    });

    it('does not infer a user-facing interrupted state from local launch-attempt metadata', () => {
        const projection = draft({
            status: 'clean',
            localSupplement: { launchUserAttemptId: 'attempt-a' },
        });

        expect(buildNewSessionDraftRowPresentation(projection).statusKey).toBeNull();
    });

    it('presents exactly one prioritized safe problem label supplied by current owners', () => {
        const presentation = buildNewSessionDraftRowPresentation(draft(), {
            machineUnavailable: true,
            pluginUnavailable: true,
            attachmentNeedsAttention: true,
        });
        expect(presentation.statusKey).toBe('sessionDrafts.availability.machineUnavailable');
        expect(JSON.stringify(presentation)).not.toContain('sessionDrafts.availability.pluginUnavailable');
        expect(JSON.stringify(presentation)).not.toContain('sessionDrafts.availability.attachmentNeedsAttention');
        expect(JSON.stringify(presentation)).not.toContain('/private/daemon/socket');
    });

    it('resolves the selected Machine from the released and the catalogued draft document alike', () => {
        const released = draft();
        expect(resolveNewSessionDraftMachineId(released)).toBe('machine-a');

        const catalogued: NewSessionDraftProjection = {
            ...released,
            document: {
                v: 2,
                composer: released.document.composer,
                target: {
                    kind: 'newSession',
                    authoring: {
                        executionTarget: {
                            mutationId: 'm-target',
                            value: { kind: 'machine', target: { serverId: 'home-a', machineId: 'machine-b' } },
                        },
                    },
                },
                extensions: {},
            },
        };
        expect(resolveNewSessionDraftMachineId(catalogued)).toBe('machine-b');

        // A Temporary computer names no Machine, so it must never be reported
        // as a selected Machine that is offline.
        expect(resolveNewSessionDraftMachineId(temporaryComputerDraft({ serverId: 'home-a' }))).toBeNull();
    });

    it('marks a selected visible-but-offline machine unavailable only from a current inventory', () => {
        expect(resolveNewSessionDraftMachineUnavailable({
            machineId: 'machine-a',
            inventoryCurrent: true,
            onlineMachineIds: new Set(),
        })).toBe(true);
        expect(resolveNewSessionDraftMachineUnavailable({
            machineId: '  machine-a  ',
            inventoryCurrent: true,
            onlineMachineIds: new Set(['machine-a']),
        })).toBe(false);
        expect(resolveNewSessionDraftMachineUnavailable({
            machineId: 'machine-a',
            inventoryCurrent: false,
            onlineMachineIds: new Set(),
        })).toBe(false);
    });

    it('does not delete or restore focus when launch custody begins while confirmation is open', async () => {
        let confirmDeletion!: (confirmed: boolean) => void;
        let deletionDisposition: 'deletable' | 'launch-custody' = 'deletable';
        const deleteDraft = vi.fn(async () => true);
        const attempt = deleteNewSessionDraftAfterConfirmation({
            confirm: () => new Promise<boolean>((resolve) => {
                confirmDeletion = resolve;
            }),
            readCurrentDraftDeletionDisposition: () => deletionDisposition,
            deleteDraft,
        });

        deletionDisposition = 'launch-custody';
        confirmDeletion(true);

        await expect(attempt).resolves.toBe(false);
        expect(deleteDraft).not.toHaveBeenCalled();
        expect(focusState.calls).toEqual([]);
    });

    it('does not report deletion when the authoritative tombstone is unavailable', async () => {
        const offline = new Error('offline');
        await expect(deleteNewSessionDraftAfterConfirmation({
            confirm: async () => true,
            readCurrentDraftDeletionDisposition: () => 'deletable',
            deleteDraft: async () => { throw offline; },
        })).rejects.toBe(offline);
    });

    it('does not report deletion when the canonical draft owner rejects the tombstone', async () => {
        await expect(deleteNewSessionDraftAfterConfirmation({
            confirm: async () => true,
            readCurrentDraftDeletionDisposition: () => 'deletable',
            deleteDraft: async () => false,
        })).resolves.toBe(false);
    });

    it('allows a Runner waiting draft to use the canonical canceling tombstone while preserving ordinary launch custody', () => {
        const ordinary = draft();
        const launchUserAttemptId = 'attempt-1';
        const operation = {
            snapshot: {
                requestId: launchUserAttemptId,
                scope: { accountId: 'account-a' },
                actionId: 'session.spawn_new',
                state: 'running',
            },
        } as never;
        const withAttempt = { ...ordinary, localSupplement: { launchUserAttemptId } };
        expect(isNewSessionDraftDeletionBlocked({
            draft: withAttempt,
            accountId: 'account-a',
            operations: [operation],
        })).toBe(true);

        const runner = {
            ...temporaryComputerDraft({ base: ordinary, serverId: 'home-a' }),
            localSupplement: { launchUserAttemptId },
        } satisfies NewSessionDraftProjection;
        expect(isNewSessionDraftDeletionBlocked({
            draft: runner,
            accountId: 'account-a',
            operations: [operation],
        })).toBe(false);
    });

    it('renders saved drafts with a direct delete action outside row activation', async () => {
        const projection = draft();
        const onContinue = vi.fn();
        const onDelete = vi.fn(async () => true);
        const screen = await renderScreen(
            <NewSessionDraftsSectionView
                drafts={[projection]}
                onContinue={onContinue}
                onDelete={onDelete}
            />,
        );
        const row = screen.findByTestId(`session-draft-row:new-session:${projection.draftId}`);
        row?.props.onPress();
        const deleteButton = screen.findByTestId(`session-draft-delete:new-session:${projection.draftId}`);
        const stopPropagation = vi.fn();
        await act(async () => deleteButton?.props.onPress({ stopPropagation }));
        expect(onContinue).toHaveBeenCalledWith(projection.draftId);
        expect(onDelete).toHaveBeenCalledWith(projection.draftId);
        expect(stopPropagation).toHaveBeenCalledOnce();
        expect(screen.findByTestId('session-draft-new')).toBeNull();
        expect(row?.props).toMatchObject({
            subtitle: 'sessionDrafts.status.syncing',
            subtitleTestID: `session-draft-status:new-session:${projection.draftId}`,
            rightElementOutsidePressable: true,
        });
        expect(String(row?.props.accessibilityLabel)).not.toContain('sessionDrafts.badge');
        expect(Object.assign({}, ...([] as any[]).concat(deleteButton?.props.style ?? []))).toMatchObject({
            width: 24,
            height: 24,
        });
        expect(deleteButton?.props.hitSlop).toEqual({ top: 10, bottom: 10, left: 10, right: 10 });
        expect(deleteButton?.props.accessibilityLabel).toBe('sessionDrafts.delete.action');
        expect(screen.findByTestId(`session-draft-menu:new-session:${projection.draftId}`)).toBeNull();
        await screen.unmount();
    });

    it('labels the drafts group like a project group, with a quiet count instead of a grouped sheet title', async () => {
        const first = draft();
        const second = draft({ draftId: '00000000-0000-4000-8000-000000000002' }, 'Second');
        const screen = await renderScreen(
            <NewSessionDraftsSectionView
                drafts={[first, second]}
                onContinue={vi.fn()}
                onDelete={vi.fn(async () => false)}
            />,
        );
        const header = screen.findByTestId('session-drafts-header');
        expect(header).toBeTruthy();
        expect(screen.getTextContent()).toContain('sessionDrafts.sectionTitle');
        expect(screen.findByTestId('session-drafts-header-count')?.props.children).toBe(2);
        // The grouped sheet title is the uppercase eyebrow the rail no longer uses.
        expect(screen.findByType('ItemGroup' as any)?.props.title).toBeUndefined();
        await screen.unmount();
    });

    it('keeps the inline delete quiet at rest and tints it only while hovered or pressed', async () => {
        const theme = createThemeFixture();
        const projection = draft();
        const screen = await renderScreen(
            <NewSessionDraftsSectionView
                drafts={[projection]}
                onContinue={vi.fn()}
                onDelete={vi.fn(async () => false)}
            />,
        );
        const deleteId = `session-draft-delete:new-session:${projection.draftId}`;
        const glyphColor = () => screen.findByTestId(deleteId)?.findByType('Icon' as any).props.color;
        expect(screen.findByTestId(deleteId)?.props.accessibilityLabel).toBe('sessionDrafts.delete.action');
        expect(glyphColor()).toBe(theme.colors.text.secondary);
        await act(async () => screen.findByTestId(deleteId)?.props.onHoverIn?.());
        expect(glyphColor()).toBe(theme.colors.state.danger.foreground);
        await act(async () => screen.findByTestId(deleteId)?.props.onHoverOut?.());
        expect(glyphColor()).toBe(theme.colors.text.secondary);
        await act(async () => screen.findByTestId(deleteId)?.props.onPressIn?.());
        expect(glyphColor()).toBe(theme.colors.state.danger.foreground);
        await screen.unmount();
    });

    it('shows the web delete only while its row is hovered or the button has keyboard focus', async () => {
        const projection = draft();
        const screen = await renderScreen(
            <NewSessionDraftsSectionView
                drafts={[projection]}
                onContinue={vi.fn()}
                onDelete={vi.fn(async () => false)}
            />,
        );
        const slotId = `session-draft-action-slot:new-session:${projection.draftId}`;
        const deleteId = `session-draft-delete:new-session:${projection.draftId}`;
        const slotOpacity = () => Object.assign({}, ...([] as any[]).concat(screen.findByTestId(slotId)?.props.style ?? [])).opacity;
        expect(slotOpacity()).toBe(0);
        // Hidden visually only: it stays in the tab order and keeps its accessible name.
        expect(screen.findByTestId(deleteId)?.props.disabled).toBeFalsy();
        await act(async () => screen.findByTestId(`session-draft-row:new-session:${projection.draftId}`)?.props.onHoverIn?.());
        expect(slotOpacity()).toBe(1);
        await act(async () => screen.findByTestId(`session-draft-row:new-session:${projection.draftId}`)?.props.onHoverOut?.());
        expect(slotOpacity()).toBe(0);
        await act(async () => screen.findByTestId(deleteId)?.props.onFocus?.());
        expect(slotOpacity()).toBe(1);
        await screen.unmount();
    });

    it('binds Continue and Delete to the row\'s exact Home and Account scope', async () => {
        const projection = draft();
        const scope = { serverId: 'home-b', accountId: 'account-b' } as const;
        const onContinue = vi.fn();
        const onDelete = vi.fn(async () => true);
        const screen = await renderScreen(
            <NewSessionDraftsSectionView
                drafts={[projection]}
                rowScope={scope}
                serverId={scope.serverId}
                onContinue={onContinue}
                onDelete={onDelete}
            />,
        );

        screen.findByTestId(`session-draft-row:new-session:${projection.draftId}`)?.props.onPress();
        await act(async () => screen.findByTestId(
            `session-draft-delete:new-session:${projection.draftId}`,
        )?.props.onPress({ stopPropagation: vi.fn() }));

        expect(onContinue).toHaveBeenCalledWith(projection.draftId, scope);
        expect(onDelete).toHaveBeenCalledWith(projection.draftId, scope);
        await screen.unmount();
    });

    it('matches Session-list density while preserving an edge-aligned direct action target', async () => {
        const projection = draft();
        const screen = await renderScreen(
            <NewSessionDraftsSectionView
                drafts={[projection]}
                density="minimal"
                onContinue={vi.fn()}
                onDelete={vi.fn(async () => false)}
            />,
        );
        const row = screen.findByTestId(`session-draft-row:new-session:${projection.draftId}`);
        expect(row?.props).toMatchObject({
            density: 'tight',
            titleLines: 1,
            subtitle: undefined,
            rightElementOutsidePressable: true,
            style: { height: 34, minHeight: 34, paddingVertical: 0 },
            titleStyle: { fontSize: 12, lineHeight: 16 },
        });
        expect(row?.props.leftElement?.props).toMatchObject({
            agentId: 'codex',
            machineId: 'machine-a',
            serverId: null,
            size: 14,
            testID: `session-draft-agent-logo:new-session:${projection.draftId}`,
        });
        expect(String(row?.props.accessibilityLabel)).toContain('sessionDrafts.status.syncing');
        expect(Object.assign({}, ...([] as any[]).concat(
            screen.findByTestId(`session-draft-action-slot:new-session:${projection.draftId}`)?.props.style ?? [],
        ))).toMatchObject({
            alignItems: 'flex-end',
            width: 24,
        });
        expect(Object.assign({}, ...([] as any[]).concat(
            screen.findByTestId(`session-draft-delete:new-session:${projection.draftId}`)?.props.style ?? [],
        ))).toMatchObject({
            width: 24,
            height: 24,
        });
        await screen.unmount();

        const detailed = await renderScreen(
            <NewSessionDraftsSectionView
                drafts={[projection]}
                density="default"
                onContinue={vi.fn()}
                onDelete={vi.fn(async () => false)}
            />,
        );
        expect(detailed.findByTestId(`session-draft-row:new-session:${projection.draftId}`)?.props).toMatchObject({
            density: 'comfortable',
            titleLines: 2,
            subtitle: 'sessionDrafts.status.syncing',
            style: { height: 84, minHeight: 84, paddingVertical: 0 },
            titleStyle: { fontSize: 14, lineHeight: 18 },
            subtitleStyle: { fontSize: 12, lineHeight: 16 },
        });
        expect(detailed.findByTestId(`session-draft-row:new-session:${projection.draftId}`)?.props.leftElement).toBeUndefined();
        await detailed.unmount();
    });

    it('renders an external draft through its exact machine-qualified Agent identity', async () => {
        const projection = draft();
        const document = projection.document;
        if (document.v !== 1 || document.target.kind !== 'newSession') {
            throw new Error('expected a released new-session draft');
        }
        const externalProjection: NewSessionDraftProjection = {
            ...projection,
            document: {
                ...document,
                target: {
                    ...document.target,
                    authoring: {
                        ...document.target.authoring,
                        agentId: { mutationId: 'm-agent-external', value: 'plugin:acme.review' },
                    },
                },
            },
        };
        const screen = await renderScreen(
            <NewSessionDraftsSectionView
                drafts={[externalProjection]}
                serverId="server-a"
                density="minimal"
                onContinue={vi.fn()}
                onDelete={vi.fn(async () => false)}
            />,
        );

        expect(screen.findByTestId(`session-draft-row:new-session:${projection.draftId}`)?.props.leftElement?.props)
            .toMatchObject({
                agentId: 'plugin:acme.review',
                machineId: 'machine-a',
                serverId: 'server-a',
            });
    });

    it('reads the Agent badge identity from the catalogued V2 authoring target', () => {
        const projection = temporaryComputerDraft({ serverId: 'server-a' });
        const document = projection.document;
        assertCataloguedNewSessionDocument(document);
        const v2Projection = {
            ...projection,
            document: {
                ...document,
                target: {
                    ...document.target,
                    authoring: {
                        ...document.target.authoring,
                        agentTarget: {
                            mutationId: 'm-agent-target',
                            value: {
                                kind: 'agent',
                                identity: { pluginId: 'happier.agent.codex', localId: 'codex' },
                            },
                        },
                    },
                },
            },
        } satisfies NewSessionDraftProjection;

        expect(resolveNewSessionDraftAgentId(v2Projection)).toBe('codex');

        const installedProjection = {
            ...v2Projection,
            document: {
                ...v2Projection.document,
                target: {
                    ...v2Projection.document.target,
                    authoring: {
                        ...v2Projection.document.target.authoring,
                        agentTarget: {
                            mutationId: 'm-installed-agent-target',
                            value: {
                                kind: 'agent',
                                identity: { pluginId: 'acme.review', localId: 'reviewer' },
                            },
                        },
                    },
                },
            },
        } satisfies NewSessionDraftProjection;
        expect(resolveNewSessionDraftAgentId(installedProjection)).toBe('acme.review/reviewer');
    });

    it('keeps an installed Agent’s draft on its own identity instead of the default mark', async () => {
        const projection = draft({
            document: {
                ...draft().document,
                target: {
                    kind: 'newSession',
                    authoring: {
                        directory: { mutationId: 'm-dir', value: '/Users/alice/private-project' },
                        machineId: { mutationId: 'm-machine', value: 'machine-a' },
                        agentId: { mutationId: 'm-agent', value: 'acme.plugin/ultracode' },
                    },
                },
            },
        } as Partial<NewSessionDraftProjection>);
        const screen = await renderScreen(
            <NewSessionDraftsSectionView
                drafts={[projection]}
                density="minimal"
                onContinue={vi.fn()}
                onDelete={vi.fn(async () => false)}
            />,
        );

        const row = screen.findByTestId(`session-draft-row:new-session:${projection.draftId}`);
        expect(row?.props.leftElement?.props.agentId).not.toBe('claude');
    });

    it('renders nothing when the repository has no saved new-session drafts', async () => {
        const screen = await renderScreen(
            <NewSessionDraftsSectionView drafts={[]} onContinue={vi.fn()} onDelete={vi.fn(async () => false)} />,
        );
        expect(screen.findByTestId('session-drafts-section')).toBeNull();
        await screen.unmount();
    });

    it('disables deletion while launch custody is retained', async () => {
        const projection = draft();
        const screen = await renderScreen(
            <NewSessionDraftsSectionView
                drafts={[projection]}
                onContinue={vi.fn()}
                onDelete={vi.fn(async () => false)}
                deleteDisabledDraftIds={new Set([projection.draftId])}
            />,
        );
        expect(screen.findByTestId(`session-draft-delete:new-session:${projection.draftId}`)?.props).toMatchObject({
            disabled: true,
            accessibilityState: { disabled: true },
        });
        await screen.unmount();
    });

    it('restores focus to the nearest surviving row, then the canonical list fallback', async () => {
        const first = draft();
        const second = { ...draft(), draftId: '00000000-0000-4000-8000-000000000002', updatedAt: 19 };

        function Harness() {
            const [drafts, setDrafts] = React.useState<readonly NewSessionDraftProjection[]>([first, second]);
            const fallbackRef = useFocusReturnFallbackRef<React.ElementRef<typeof View> | null>();
            return (
                <View ref={fallbackRef} testID="session-list-focus-fallback">
                    <NewSessionDraftsSectionView
                        drafts={drafts}
                        onContinue={vi.fn()}
                        onDelete={async (draftId) => {
                            setDrafts((current) => current.filter((candidate) => candidate.draftId !== draftId));
                            return true;
                        }}
                    />
                </View>
            );
        }

        const screen = await renderScreen(<FocusReturnProvider><Harness /></FocusReturnProvider>);
        await act(async () => screen.findByTestId(`session-draft-delete:new-session:${first.draftId}`)?.props.onPress({
            stopPropagation: vi.fn(),
        }));
        await vi.waitFor(() => expect(focusState.calls).toContain(
            `session-draft-row:new-session:${second.draftId}`,
        ));

        await act(async () => screen.findByTestId(`session-draft-delete:new-session:${second.draftId}`)?.props.onPress({
            stopPropagation: vi.fn(),
        }));
        await vi.waitFor(() => expect(focusState.calls).toContain('session-list-focus-fallback'));
        await screen.unmount();
    });
});
