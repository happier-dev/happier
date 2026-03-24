import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import { renderScreen } from '@/dev/testkit';
import { installAccountCommonModuleMocks } from './accountTestHelpers';


(
    globalThis as typeof globalThis & {
        IS_REACT_ACT_ENVIRONMENT?: boolean;
    }
).IS_REACT_ACT_ENVIRONMENT = true;

const show = vi.fn();

const push = vi.fn();

vi.mock('react-native-reanimated', () => ({}));

installAccountCommonModuleMocks({
    icons: () => ({
        Ionicons: 'Ionicons',
    }),
    modal: async () => {
        const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        return createModalModuleMock({
            spies: {
                show: show,
                alert: vi.fn(),
                prompt: vi.fn(),
                confirm: vi.fn(),
            },
        }).module;
    },
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            View: 'View',
            Text: 'Text',
            Pressable: 'Pressable',
            Platform: {
                OS: 'ios',
                select: (options: { ios?: unknown; default?: unknown }) => options.ios ?? options.default,
            },
            AppState: {
                addEventListener: () => ({ remove: () => {} }),
            },
        });
    },
    router: async () => {
        const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
        const expoRouterMock = createExpoRouterMock({
            router: { push },
        });
        return expoRouterMock.module;
    },
});

vi.mock('react-native-typography', () => ({ iOSUIKit: { title3: {} } }));

vi.mock('@/auth/context/AuthContext', () => ({
    useAuth: () => ({
        isAuthenticated: true,
        credentials: { token: 't', secret: 's' },
    }),
}));

const getServerFeatures = vi.fn(async () => ({
    features: {
        sharing: {
            session: { enabled: true },
            public: { enabled: true },
            contentKeys: { enabled: true },
            pendingQueueV2: { enabled: true },
        },
        voice: { enabled: false, configured: false, provider: null },
        social: { friends: { enabled: false, allowUsername: false, requiredIdentityProviderId: null } },
        oauth: { providers: {} },
        auth: {
            signup: { methods: [{ id: 'anonymous', enabled: true }] },
            login: { requiredProviders: [] },
            recovery: { providerReset: { enabled: false, providers: [] } },
            ui: { autoRedirect: { enabled: false, providerId: null }, recoveryKeyReminder: { enabled: true } },
            providers: {},
            misconfig: [],
        },
    },
}));
const getCachedServerFeatures = vi.fn<
    () => {
        features: {
            auth: {
                ui: {
                    recoveryKeyReminder: {
                        enabled: boolean;
                    };
                };
            };
        };
    } | null
>(() => null);
vi.mock('@/sync/api/capabilities/getReadyServerFeatures', () => ({
    getReadyServerFeatures: () => getServerFeatures(),
    getCachedReadyServerFeatures: () => getCachedServerFeatures(),
}));

const getRecoveryKeyReminderDismissed = vi.fn(async () => false);
const setRecoveryKeyReminderDismissed = vi.fn(async () => true);
const getCachedRecoveryKeyReminderDismissed = vi.fn<() => boolean | null>(() => null);
vi.mock('@/auth/storage/tokenStorage', () => ({
    TokenStorage: {
        getRecoveryKeyReminderDismissed,
        setRecoveryKeyReminderDismissed,
        getCachedRecoveryKeyReminderDismissed,
    },
    // RecoveryKeyReminderBanner gates on legacy credentials; include this export to
    // keep the mock aligned with the real module surface.
    isLegacyAuthCredentials: (credentials: unknown) => Boolean(credentials),
}));

vi.mock('@/components/ui/lists/ItemGroup', () => ({
    ItemGroup: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock('@/components/ui/lists/Item', () => ({
    Item: (props: {
        onPress?: () => void;
        rightElement?: React.ReactNode;
        testID?: string;
    }) => {
        const dismissElement = React.isValidElement<{
            accessibilityLabel?: string;
            testID?: string;
            onPress?: (event?: { stopPropagation?: () => void }) => void | Promise<void>;
        }>(props.rightElement)
            ? (() => {
                  const rightElement = props.rightElement;
                  return React.cloneElement(rightElement, {
                      accessibilityLabel: 'recovery-key-dismiss',
                      testID: 'recovery-key-dismiss',
                      onPress: async () => {
                          await rightElement.props.onPress?.({
                              stopPropagation: vi.fn(),
                          } as never);
                      },
                  });
              })()
            : props.rightElement;
        return (
            <>
                {React.createElement('Pressable', {
                    accessibilityLabel: 'recovery-key-item',
                    testID: 'recovery-key-item',
                    onPress: props.onPress,
                })}
                {dismissElement}
            </>
        );
    },
}));

async function flushEffects(turns = 4): Promise<void> {
    for (let turn = 0; turn < turns; turn += 1) {
        await act(async () => {});
    }
}

async function renderBanner() {
    const { RecoveryKeyReminderBanner } = await import('./RecoveryKeyReminderBanner');
    let tree: Awaited<ReturnType<typeof renderScreen>> | undefined;
    tree = await renderScreen(<RecoveryKeyReminderBanner />);
    await flushEffects();
    return tree!;
}

describe('RecoveryKeyReminderBanner', () => {
    it('renders, opens the backup modal, and can be dismissed', async () => {
        vi.resetModules();
        show.mockClear();
        push.mockClear();
        getServerFeatures.mockResolvedValue({
            features: {
                sharing: {
                    session: { enabled: true },
                    public: { enabled: true },
                    contentKeys: { enabled: true },
                    pendingQueueV2: { enabled: true },
                },
                voice: { enabled: false, configured: false, provider: null },
                social: { friends: { enabled: false, allowUsername: false, requiredIdentityProviderId: null } },
                oauth: { providers: {} },
                auth: {
                    signup: { methods: [{ id: 'anonymous', enabled: true }] },
                    login: { requiredProviders: [] },
                    recovery: { providerReset: { enabled: false, providers: [] } },
                    ui: { autoRedirect: { enabled: false, providerId: null }, recoveryKeyReminder: { enabled: true } },
                    providers: {},
                    misconfig: [],
                },
            },
        });
        getRecoveryKeyReminderDismissed.mockResolvedValue(false);
        setRecoveryKeyReminderDismissed.mockResolvedValue(true);

        const screen = await renderBanner();
        await screen.pressByTestIdAsync('recovery-key-item');

        expect(show).toHaveBeenCalledWith(
            expect.objectContaining({
                component: expect.any(Function),
                props: expect.objectContaining({ secret: 's' }),
            }),
        );

        await screen.pressByTestIdAsync('recovery-key-dismiss');

        expect(setRecoveryKeyReminderDismissed).toHaveBeenCalledWith(true);
    });

    it('does not render when server features cannot be fetched', async () => {
        vi.resetModules();
        show.mockClear();
        push.mockClear();
        getServerFeatures.mockRejectedValueOnce(new Error('network'));
        getCachedServerFeatures.mockReturnValue(null);
        getRecoveryKeyReminderDismissed.mockResolvedValue(false);
        getCachedRecoveryKeyReminderDismissed.mockReturnValue(null);

        const tree = await renderBanner();
        const itemNodes = tree.findAllByTestId('recovery-key-item');

        expect(itemNodes).toHaveLength(0);
        expect(show).not.toHaveBeenCalled();
    });

    it('renders immediately when cached banner visibility state is already available', async () => {
        vi.resetModules();
        show.mockClear();
        push.mockClear();
        getCachedServerFeatures.mockReturnValue({
            features: {
                auth: {
                    ui: { recoveryKeyReminder: { enabled: true } },
                },
            },
        });
        getCachedRecoveryKeyReminderDismissed.mockReturnValue(false);
        getServerFeatures.mockImplementation(() => new Promise(() => {}));
        getRecoveryKeyReminderDismissed.mockImplementation(() => new Promise(() => {}));

        const { RecoveryKeyReminderBanner } = await import('./RecoveryKeyReminderBanner');
        const screen = await renderScreen(<RecoveryKeyReminderBanner />, { flushOptions: { cycles: 0 } });

        expect(screen.findAllByTestId('recovery-key-item')).toHaveLength(1);
    });
});
