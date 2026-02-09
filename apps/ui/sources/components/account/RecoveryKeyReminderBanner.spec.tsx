import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';

(
    globalThis as typeof globalThis & {
        IS_REACT_ACT_ENVIRONMENT?: boolean;
    }
).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native-reanimated', () => ({}));

vi.mock('react-native', () => ({
    View: 'View',
    Text: 'Text',
    Pressable: 'Pressable',
    Platform: {
        OS: 'ios',
        select: (options: { ios?: unknown; default?: unknown }) => options.ios ?? options.default,
    },
}));

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
}));

vi.mock('react-native-typography', () => ({ iOSUIKit: { title3: {} } }));

const show = vi.fn();
vi.mock('@/modal', () => ({
    Modal: {
        show,
        alert: vi.fn(),
        prompt: vi.fn(),
        confirm: vi.fn(),
    },
}));

const push = vi.fn();
vi.mock('expo-router', () => ({
    useRouter: () => ({ push }),
}));

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
vi.mock('@/sync/api/capabilities/apiFeatures', () => ({
    getServerFeatures: () => getServerFeatures(),
}));

const getRecoveryKeyReminderDismissed = vi.fn(async () => false);
const setRecoveryKeyReminderDismissed = vi.fn(async () => true);
vi.mock('@/auth/storage/tokenStorage', () => ({
    TokenStorage: {
        getRecoveryKeyReminderDismissed,
        setRecoveryKeyReminderDismissed,
    },
}));

vi.mock('@/components/ui/lists/ItemGroup', () => ({
    ItemGroup: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock('@/components/ui/lists/Item', () => ({
    Item: (props: {
        onPress?: () => void;
        rightElement?: React.ReactNode;
    }) => {
        const dismissElement =
            React.isValidElement<{ accessibilityLabel?: string }>(props.rightElement)
                ? React.cloneElement(props.rightElement, {
                      accessibilityLabel: 'recovery-key-dismiss',
                  })
                : props.rightElement;
        return (
            <>
                {React.createElement('Pressable', {
                    accessibilityLabel: 'recovery-key-item',
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
    let tree: renderer.ReactTestRenderer | undefined;
    await act(async () => {
        tree = renderer.create(<RecoveryKeyReminderBanner />);
    });
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

        const tree = await renderBanner();
        const openItem = tree.root.findByProps({ accessibilityLabel: 'recovery-key-item' });

        await act(async () => {
            openItem.props.onPress();
        });

        expect(show).toHaveBeenCalledWith(
            expect.objectContaining({
                component: expect.any(Function),
                props: expect.objectContaining({ secret: 's' }),
            }),
        );

        const dismissButton = tree.root.findByProps({ accessibilityLabel: 'recovery-key-dismiss' });
        await act(async () => {
            dismissButton.props.onPress({ stopPropagation: vi.fn() });
        });

        expect(setRecoveryKeyReminderDismissed).toHaveBeenCalledWith(true);
    });

    it('does not render when server features cannot be fetched', async () => {
        vi.resetModules();
        show.mockClear();
        push.mockClear();
        getServerFeatures.mockRejectedValueOnce(new Error('network'));
        getRecoveryKeyReminderDismissed.mockResolvedValue(false);

        const tree = await renderBanner();
        const itemNodes = tree.root.findAllByProps({ accessibilityLabel: 'recovery-key-item' });

        expect(itemNodes).toHaveLength(0);
        expect(show).not.toHaveBeenCalled();
    });
});
