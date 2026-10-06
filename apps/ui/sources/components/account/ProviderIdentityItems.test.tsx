import React from 'react';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderScreen as renderTestkitScreen, standardCleanup } from '@/dev/testkit';
import { Item } from '@/components/ui/lists/Item';
import { profileDefaults } from '@/sync/domains/profiles/profile';
import { installAccountCommonModuleMocks } from './accountTestHelpers';
import { storage } from '@/sync/domains/state/storageStore';
import { getActiveServerSnapshot, setActiveServer, upsertAndActivateServer } from '@/sync/domains/server/serverRuntime';
import { resetRuntimeFetch, setRuntimeFetch } from '@/utils/system/runtimeFetch';
import { resetServerFeaturesClientForTests } from '@/sync/api/capabilities/serverFeaturesClient';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { FeaturesResponseSchema } from '@happier-dev/protocol';
import { TokenStorage } from '@/auth/storage/tokenStorage';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const shared = vi.hoisted(() => ({
    canOpenURL: vi.fn(async () => true),
    openURL: vi.fn(async () => true),
    pendingConnectAtRequest: null as Awaited<ReturnType<typeof TokenStorage.getPendingExternalConnect>>,
    authEntryResult: { current: { kind: 'unsupported' } as any },
    fetchHomeAuthEntry: vi.fn(async (_request?: Readonly<{ signal?: AbortSignal | null }>) => shared.authEntryResult.current),
    featuresSnapshot: {
        current: {
            status: 'ready' as const,
            features: { capabilities: { auth: { providers: {} } } },
        } as any,
    },
    routerPush: vi.fn(),
    connectFailure: false,
}));

installAccountCommonModuleMocks({
    icons: () => ({
        Ionicons: 'Ionicons',
    }),
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            Linking: {
                canOpenURL: shared.canOpenURL,
                openURL: shared.openURL,
            },
        });
    },
    modal: async () => {
        const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        return createModalModuleMock({ confirmResult: true }).module;
    },
    router: () => ({
        useRouter: () => ({ push: shared.routerPush }),
    }),
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock();
    },
});

vi.mock('expo-image', () => ({
    Image: 'Image',
}));

let mountedScreen: Awaited<ReturnType<typeof renderTestkitScreen>> | undefined;

async function renderScreen(...args: Parameters<typeof renderTestkitScreen>) {
    mountedScreen = await renderTestkitScreen(...args);
    return mountedScreen;
}

function itemProps() {
    return mountedScreen?.root.findAllByType(Item).map((item) => item.props) ?? [];
}

function inlineActionProps(node: React.ReactNode) {
    if (!React.isValidElement(node)) return undefined;
    const props = node.props;
    if (typeof props !== 'object' || props === null || !('onPress' in props) || typeof props.onPress !== 'function') {
        return undefined;
    }
    return props;
}

describe('ProviderIdentityItems', () => {
    const initialStorageState = storage.getState();

    beforeEach(async () => {
        mountedScreen = undefined;
        shared.canOpenURL.mockClear();
        shared.openURL.mockClear();
        shared.routerPush.mockClear();
        shared.fetchHomeAuthEntry.mockReset();
        shared.fetchHomeAuthEntry.mockImplementation(async () => shared.authEntryResult.current);
        shared.authEntryResult.current = { kind: 'unsupported' };
        shared.featuresSnapshot.current = { status: 'ready', features: createRootLayoutFeaturesResponse() };
        shared.connectFailure = false;
        shared.pendingConnectAtRequest = null;
        setRuntimeFetch(async (input, init) => {
            const path = new URL(String(input)).pathname;
            if (path === '/v1/auth/entry') {
                const result = await shared.fetchHomeAuthEntry({ signal: init?.signal });
                return result.kind === 'ready'
                    ? Response.json(result.projection)
                    : Response.json({}, { status: result.kind === 'unsupported' ? 404 : 503 });
            }
            if (path === '/v1/features') return Response.json(FeaturesResponseSchema.parse(shared.featuresSnapshot.current.features));
            if (path.startsWith('/v1/connect/external/')) {
                shared.pendingConnectAtRequest = await TokenStorage.getPendingExternalConnect();
                // Current connect route failures use the global server error projection,
                // not a provider-specific code manufactured by an internal catalog mock.
                if (shared.connectFailure) return Response.json({
                    error: 'Internal Server Error',
                    message: 'An unexpected error occurred',
                    statusCode: 500,
                }, { status: 500 });
                return Response.json({ url: path.includes('/github/') ? 'javascript:alert(1)' : 'https://auth.example.test/connect' });
            }
            throw new Error(`Unexpected identity test request: ${path}`);
        });
        await upsertAndActivateServer({ serverUrl: 'https://home-a.example.test', scope: 'tab' });
        resetServerFeaturesClientForTests();
        storage.setState({ profile: profileDefaults });
    });

    afterEach(() => {
        vi.useRealTimers();
        standardCleanup();
        resetRuntimeFetch();
        resetServerFeaturesClientForTests();
        storage.setState(initialStorageState, true);
    });
    it('fails closed when linked-identity management metadata is absent', async () => {
        shared.authEntryResult.current = { kind: 'ready', projection: { v: 1, state: 'ready', scope: { kind: 'home' }, actions: [], autoRedirect: null } };

        const { ProviderIdentityItems } = await import('./ProviderIdentityItems');
        await renderScreen(
            <ProviderIdentityItems
                profile={{
                    ...profileDefaults,
                    linkedProviders: [{
                        id: 'github', login: 'alice', displayName: 'Alice', avatarUrl: null,
                        profileUrl: null, showOnProfile: true,
                    }],
                }}
                credentials={{ token: 't', secret: 's' }}
                applyProfile={() => {}}
                returnTo="/settings/account"
            />,
        );

        await vi.waitFor(() => expect(itemProps().some((item) => item.detail === '@alice')).toBe(true));
        const linkedRow = itemProps().find((item) => item.detail === '@alice');
        expect(linkedRow?.onPress).toBeUndefined();
        expect(linkedRow?.rightElement).toBeUndefined();
        expect(itemProps().some((item) => String(item.title).includes('showProviderOnProfile'))).toBe(false);
    });

    it('keeps the released identity controls on a supported Home without managed integrations', async () => {
        // An exact supported older Home: it cannot host a managed identity, so
        // absent management metadata is its normal answer rather than a fact the
        // client failed to classify.
        shared.authEntryResult.current = { kind: 'unsupported' };

        const { ProviderIdentityItems } = await import('./ProviderIdentityItems');
        await renderScreen(
            <ProviderIdentityItems
                profile={{
                    ...profileDefaults,
                    linkedProviders: [{
                        id: 'github', login: 'alice', displayName: 'Alice', avatarUrl: null,
                        profileUrl: null, showOnProfile: true,
                    }],
                }}
                credentials={{ token: 't', secret: 's' }}
                applyProfile={() => {}}
                returnTo="/settings/account"
            />,
        );

        // The catalog answer settles after the first render, so the row as the
        // user finally sees it is the last one rendered.
        const latestLinkedRow = () => itemProps().find((item) => item.detail === '@alice');
        await vi.waitFor(() => expect(typeof inlineActionProps(latestLinkedRow()?.rightElement)?.onPress).toBe('function'));
        expect(itemProps().some((item) => String(item.title).includes('showProviderOnProfile'))).toBe(true);
    });

    it('renders disconnect and profile publication from independent server permissions', async () => {
        shared.routerPush.mockClear();
        shared.authEntryResult.current = { kind: 'ready', projection: { v: 1, state: 'ready', scope: { kind: 'home' }, actions: [], autoRedirect: null } };

        const { ProviderIdentityItems } = await import('./ProviderIdentityItems');
        await renderScreen(
            <ProviderIdentityItems
                profile={{
                    ...profileDefaults,
                    linkedProviders: [{
                        id: 'workforce', login: 'alice', displayName: 'Alice', avatarUrl: null,
                        profileUrl: null, showOnProfile: false,
                    }],
                    linkedIdentityManagementV1: [{
                        v: 1,
                        providerId: 'workforce',
                        descriptor: { displayName: 'Acme Workforce', iconHint: 'shield-outline', source: 'managed' },
                        managedBy: { kind: 'team', team: { id: 'team-1', name: 'Acme' } },
                        requiredByTeams: [{ id: 'team-1', name: 'Acme' }],
                        canDisconnect: false,
                        disconnectReason: 'required_by_team',
                        canPublishProfile: true,
                        publishProfileReason: null,
                    }],
                }}
                credentials={{ token: 't', secret: 's' }}
                applyProfile={() => {}}
                returnTo="/settings/account"
            />,
        );

        await vi.waitFor(() => expect(itemProps().some((item) => item.title === 'Acme Workforce')).toBe(true));
        const linkedRow = itemProps().find((item) => item.title === 'Acme Workforce' && item.detail === '@alice');
        expect(linkedRow?.onPress).toEqual(expect.any(Function));
        expect(linkedRow?.showChevron).toBe(true);
        await act(async () => linkedRow?.onPress?.());
        expect(shared.routerPush).toHaveBeenCalledWith(`/settings/teams/${getActiveServerSnapshot().serverId}/team-1/authentication`);
        expect(linkedRow?.subtitle).toContain('Acme');
        expect(itemProps().some((item) => String(item.title).includes('showProviderOnProfile'))).toBe(true);
    });

    it('discards a stale provider projection after the selected Home changes', async () => {
        let resolveHomeA: ((value: any) => void) | undefined;
        const homeA = new Promise((resolve) => { resolveHomeA = resolve; });
        const ready = (id: string, displayName: string) => ({
            kind: 'ready',
            projection: {
                v: 1,
                state: 'ready',
                scope: { kind: 'home' },
                actions: [{
                    kind: 'authenticate', methodId: id, action: 'connect', mode: 'either', origin: 'home',
                    presentation: { displayName },
                }],
                autoRedirect: null,
            },
        });
        shared.fetchHomeAuthEntry.mockReset();
        shared.fetchHomeAuthEntry.mockImplementationOnce(async () => await homeA);
        shared.fetchHomeAuthEntry.mockResolvedValueOnce(ready('provider-b', 'Provider B'));

        const { ProviderIdentityItems } = await import('./ProviderIdentityItems');
        const element = (
            <ProviderIdentityItems
                profile={profileDefaults}
                credentials={{ token: 't', secret: 's' }}
                applyProfile={() => {}}
                returnTo="/settings/account"
            />
        );
        const screen = await renderScreen(element);
        await act(async () => {
            await upsertAndActivateServer({ serverUrl: 'https://home-b.example.test', scope: 'tab' });
            await screen.update(
            <ProviderIdentityItems
                profile={profileDefaults}
                credentials={{ token: 't', secret: 's' }}
                applyProfile={() => {}}
                returnTo="/settings/account"
            />,
            );
        });
        await vi.waitFor(() => expect(itemProps().some((p) => p.title === 'Provider B')).toBe(true));

        await act(async () => resolveHomeA?.(ready('provider-a', 'Provider A')));
        expect(itemProps().some((p) => p.title === 'Provider A')).toBe(false);
    });

    it('refreshes provider discovery when the current Home runtime generation changes', async () => {
        const ready = (id: string, displayName: string) => ({
            kind: 'ready',
            projection: {
                v: 1,
                state: 'ready',
                scope: { kind: 'home' },
                actions: [{
                    kind: 'authenticate', methodId: id, action: 'connect', mode: 'either', origin: 'home',
                    presentation: { displayName },
                }],
                autoRedirect: null,
            },
        });
        shared.fetchHomeAuthEntry.mockReset();
        shared.fetchHomeAuthEntry
            .mockResolvedValueOnce(ready('provider-old', 'Provider Old'))
            .mockResolvedValueOnce(ready('provider-current', 'Provider Current'));

        const { ProviderIdentityItems } = await import('./ProviderIdentityItems');
        const props = {
            profile: profileDefaults,
            credentials: { token: 't', secret: 's' },
            applyProfile: () => {},
            returnTo: '/settings/account',
        } as const;
        const screen = await renderScreen(<ProviderIdentityItems {...props} />);
        await vi.waitFor(() => expect(itemProps().some((p) => p.title === 'Provider Old')).toBe(true));

        const previousGeneration = getActiveServerSnapshot().generation;
        await act(async () => {
            await setActiveServer({ serverId: getActiveServerSnapshot().serverId, scope: 'tab' });
            await screen.update(
            <ProviderIdentityItems {...props} returnTo="/settings/account?generation=11" />,
            );
        });
        expect(getActiveServerSnapshot().generation).toBeGreaterThan(previousGeneration);

        await vi.waitFor(() => expect(itemProps().some((p) => p.title === 'Provider Current')).toBe(true));
        expect(shared.fetchHomeAuthEntry).toHaveBeenCalledTimes(2);
    });

    it('retains the last successful dynamic descriptors while refreshing the same Home', async () => {
        let resolveRefresh: ((value: any) => void) | undefined;
        const refresh = new Promise((resolve) => { resolveRefresh = resolve; });
        const ready = (id: string, displayName: string) => ({
            kind: 'ready',
            projection: {
                v: 1,
                state: 'ready',
                scope: { kind: 'home' },
                actions: [{
                    kind: 'authenticate', methodId: id, action: 'connect', mode: 'either', origin: 'home',
                    presentation: { displayName },
                }],
                autoRedirect: null,
            },
        });
        shared.fetchHomeAuthEntry.mockReset();
        shared.fetchHomeAuthEntry
            .mockResolvedValueOnce(ready('provider-old', 'Provider Old'))
            .mockImplementationOnce(async () => await refresh);

        const { ProviderIdentityItems } = await import('./ProviderIdentityItems');
        const props = {
            profile: profileDefaults,
            credentials: { token: 't', secret: 's' },
            applyProfile: () => {},
            returnTo: '/settings/account',
        } as const;
        const screen = await renderScreen(<ProviderIdentityItems {...props} />);
        await vi.waitFor(() => expect(itemProps().some((p) => p.title === 'Provider Old')).toBe(true));

        const previousGeneration = getActiveServerSnapshot().generation;
        await act(async () => {
            await setActiveServer({ serverId: getActiveServerSnapshot().serverId, scope: 'tab' });
            await screen.update(
            <ProviderIdentityItems {...props} returnTo="/settings/account?generation=21" />,
            );
        });
        expect(getActiveServerSnapshot().generation).toBeGreaterThan(previousGeneration);

        expect(itemProps().some((p) => p.title === 'Provider Old')).toBe(true);
        await act(async () => resolveRefresh?.(ready('provider-new', 'Provider New')));
        await vi.waitFor(() => expect(itemProps().some((p) => p.title === 'Provider New')).toBe(true));
    });

    it('discovers an unlinked deployment OIDC provider from the supported-old-server feature payload', async () => {
        shared.fetchHomeAuthEntry.mockImplementation(async () => shared.authEntryResult.current);
        shared.authEntryResult.current = { kind: 'unsupported' };
        shared.featuresSnapshot.current = {
            status: 'ready',
            features: {
                capabilities: {
                    auth: {
                        providers: {
                            'corporate-oidc': {
                                enabled: true,
                                configured: true,
                                ui: { displayName: 'Corporate SSO', iconHint: 'shield-outline' },
                                restrictions: { usersAllowlist: false, orgsAllowlist: false, orgMatch: 'any' },
                                offboarding: { enabled: false, intervalSeconds: 60, mode: 'per-request-cache', source: 'oidc' },
                            },
                        },
                    },
                },
            },
        } as any;

        const { ProviderIdentityItems } = await import('./ProviderIdentityItems');
        await renderScreen(
            <ProviderIdentityItems
                profile={profileDefaults}
                credentials={{ token: 't', secret: 's' }}
                applyProfile={() => {}}
                returnTo="/settings/account"
            />,
        );

        await vi.waitFor(() => {
            const row = itemProps().find((p) => p.title === 'Corporate SSO');
            expect(row).toMatchObject({ showChevron: false });
            // Connecting is the row's inline action, not a press on the row.
            expect(inlineActionProps(row?.rightElement)).toMatchObject({ disabled: false });
        });
    });

    it('renders a current dynamic provider that is absent from the static UI registry', async () => {
        shared.fetchHomeAuthEntry.mockImplementation(async () => shared.authEntryResult.current);
        shared.authEntryResult.current = {
            kind: 'ready',
            projection: {
                v: 1,
                state: 'ready',
                scope: { kind: 'home' },
                actions: [{
                    kind: 'authenticate',
                    methodId: 'acme',
                    action: 'connect',
                    mode: 'either',
                    origin: 'home',
                    presentation: { displayName: 'Acme Workforce', iconHint: 'shield-outline' },
                }],
                autoRedirect: null,
            },
        };

        const { ProviderIdentityItems } = await import('./ProviderIdentityItems');
        await renderScreen(
            <ProviderIdentityItems
                profile={profileDefaults}
                credentials={{ token: 't', secret: 's' }}
                applyProfile={() => {}}
                returnTo="/settings/account"
            />,
        );

        await vi.waitFor(() => {
            const row = itemProps().find((p) => p.title === 'Acme Workforce');
            expect(row).toMatchObject({ showChevron: false });
            // Connecting is the row's inline action, not a press on the row.
            expect(inlineActionProps(row?.rightElement)).toMatchObject({ disabled: false });
        });
    });

    it('keeps the canonical first presentation and connect action when later rows share a method', async () => {
        shared.fetchHomeAuthEntry.mockImplementation(async () => shared.authEntryResult.current);
        shared.authEntryResult.current = {
            kind: 'ready',
            projection: {
                v: 1,
                state: 'ready',
                scope: { kind: 'home' },
                actions: [
                    {
                        kind: 'authenticate',
                        methodId: 'acme',
                        action: 'connect',
                        mode: 'either',
                        origin: 'home',
                        presentation: { displayName: 'Acme Workforce' },
                    },
                    {
                        kind: 'authenticate',
                        methodId: 'acme',
                        action: 'login',
                        mode: 'keyless',
                        origin: 'home',
                        presentation: { displayName: 'Conflicting later presentation' },
                    },
                ],
                autoRedirect: null,
            },
        };

        const { ProviderIdentityItems } = await import('./ProviderIdentityItems');
        await renderScreen(
            <ProviderIdentityItems
                profile={profileDefaults}
                credentials={{ token: 't', secret: 's' }}
                applyProfile={() => {}}
                returnTo="/settings/account"
            />,
        );

        await vi.waitFor(() => {
            const row = itemProps().find((p) => p.title === 'Acme Workforce');
            expect(row).toMatchObject({ showChevron: false });
            // Connecting is the row's inline action, not a press on the row.
            expect(inlineActionProps(row?.rightElement)).toMatchObject({ disabled: false });
        });
        expect(itemProps().some((p) => p.title === 'Conflicting later presentation')).toBe(false);
    });

    it('keeps a linked provider visible when it is absent from the current catalog', async () => {
        shared.authEntryResult.current = {
            kind: 'ready',
            projection: {
                v: 1,
                state: 'ready',
                scope: { kind: 'home' },
                actions: [],
                autoRedirect: null,
            },
        };

        const { ProviderIdentityItems } = await import('./ProviderIdentityItems');
        await renderScreen(
            <ProviderIdentityItems
                profile={{
                    ...profileDefaults,
                    linkedProviders: [{
                        id: 'retired-sso',
                        login: 'alice',
                        displayName: 'Alice',
                        avatarUrl: null,
                        profileUrl: null,
                        showOnProfile: false,
                    }],
                }}
                credentials={{ token: 't', secret: 's' }}
                applyProfile={() => {}}
                returnTo="/settings/account"
            />,
        );

        await vi.waitFor(() => {
            expect(itemProps().find((p) => p.title === 'Retired-sso')).toMatchObject({ detail: '@alice' });
        });
    });

    it('presents provider failures through localized identity copy without exposing raw text', async () => {
        shared.authEntryResult.current = {
            kind: 'ready',
            projection: {
                v: 1,
                state: 'ready',
                scope: { kind: 'home' },
                actions: [{
                    kind: 'authenticate',
                    methodId: 'workforce',
                    action: 'connect',
                    mode: 'either',
                    origin: 'home',
                    presentation: { displayName: 'Acme Workforce' },
                }],
                autoRedirect: null,
            },
        };

        const { Modal } = await import('@/modal');
        const { ProviderIdentityItems } = await import('./ProviderIdentityItems');
        vi.mocked(Modal.alert).mockReset();

        await renderScreen(
            <ProviderIdentityItems
                profile={profileDefaults}
                credentials={{ token: 't', secret: 's' }}
                applyProfile={() => {}}
                returnTo="/settings/account"
            />,
        );

        await vi.waitFor(() => {
            expect(inlineActionProps(itemProps().find((item) => item.title === 'Acme Workforce')?.rightElement)?.onPress)
                .toEqual(expect.any(Function));
        });
        const connect = () => {
            const action = inlineActionProps(itemProps()
                .find((item) => item.title === 'Acme Workforce' && typeof inlineActionProps(item.rightElement)?.onPress === 'function')
                ?.rightElement);
            if (!action || typeof action.onPress !== 'function') throw new Error('Acme Workforce connect action was not rendered');
            return action.onPress();
        };

        shared.connectFailure = true;
        // Drive the genuine clock boundary while the real HTTP/OAuth owners
        // exhaust their existing retry policies; do not shorten those policies.
        vi.useFakeTimers();
        const connecting = act(async () => { await connect(); });
        await vi.runAllTimersAsync();
        await connecting;
        expect(Modal.alert).toHaveBeenLastCalledWith(
            'common.error',
            'identityAdministration.error',
        );
        const presented = vi.mocked(Modal.alert).mock.calls.flat().join('\n');
        expect(presented).not.toContain('Internal Server Error');
        expect(presented).not.toContain('An unexpected error occurred');
        expect(presented).not.toContain('Failed to get Acme Workforce OAuth params');
        expect(await TokenStorage.getPendingExternalConnect()).toBeNull();
        expect(shared.openURL).not.toHaveBeenCalled();
    });

    it('clears pending connect state and blocks unsafe connect URLs', async () => {
        shared.authEntryResult.current = { kind: 'unsupported' };
        shared.canOpenURL.mockClear();
        shared.openURL.mockClear();

        const { Modal } = await import('@/modal');
        const { ProviderIdentityItems } = await import('./ProviderIdentityItems');
        vi.mocked(Modal.alert).mockReset();
        vi.mocked(Modal.confirm).mockReset();
        vi.mocked(Modal.confirm).mockResolvedValue(true);

        await renderScreen(
            <ProviderIdentityItems
                profile={profileDefaults}
                credentials={{ token: 't', secret: 's' }}
                applyProfile={() => {}}
                returnTo="/settings/account"
            />,
        );

        await vi.waitFor(() => {
            expect(itemProps().find((p) => p.title === 'GitHub' && typeof inlineActionProps(p.rightElement)?.onPress === 'function')).toBeTruthy();
        });
        const connectItem = itemProps().find((p) => p.title === 'GitHub' && typeof inlineActionProps(p.rightElement)?.onPress === 'function');
        if (!connectItem) throw new Error('GitHub connect action was not rendered');
        const connectAction = inlineActionProps(connectItem.rightElement);
        if (!connectAction || typeof connectAction.onPress !== 'function') throw new Error('GitHub connect action has no press handler');
        const onPress = connectAction.onPress;

        await act(async () => {
            await onPress();
        });

        expect(shared.pendingConnectAtRequest).toMatchObject({ provider: 'github', returnTo: '/settings/account' });
        expect(await TokenStorage.getPendingExternalConnect()).toBeNull();
        expect(shared.canOpenURL).not.toHaveBeenCalled();
        expect(shared.openURL).not.toHaveBeenCalled();
        expect(Modal.alert).toHaveBeenCalled();
    });
});
