import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';

(
    globalThis as typeof globalThis & {
        IS_REACT_ACT_ENVIRONMENT?: boolean;
    }
).IS_REACT_ACT_ENVIRONMENT = true;

type PopoverCaptureProps = {
    open?: boolean;
    portal?: {
        web?: boolean;
        native?: boolean;
        matchAnchorWidth?: boolean;
    };
    children?: ((params: { maxHeight: number }) => React.ReactNode) | React.ReactNode;
};

type ActionLike = { label?: unknown };
type ActionListSectionProps = {
    actions?: ActionLike[];
};

const capture = vi.hoisted(() => ({
    popoverProps: null as PopoverCaptureProps | null,
    actionSections: [] as ActionListSectionProps[],
    reset() {
        this.popoverProps = null;
        this.actionSections = [];
    },
}));

vi.mock('react-native', () => ({
    Platform: { OS: 'ios' },
    View: 'View',
    Text: 'Text',
    Pressable: 'Pressable',
}));

vi.mock('react-native-unistyles', () => ({
    useUnistyles: () => ({
        theme: {
            colors: {
                status: {
                    connected: '#00ff00',
                    connecting: '#ffcc00',
                    disconnected: '#ff0000',
                    error: '#ff0000',
                    default: '#999999',
                },
                text: '#111111',
                textSecondary: '#666666',
            },
        },
    }),
    StyleSheet: {
        create: (
            factory: (
                theme: {
                    colors: {
                        status: {
                            connected: string;
                            connecting: string;
                            disconnected: string;
                            error: string;
                            default: string;
                        };
                        text: string;
                        textSecondary: string;
                    };
                },
                runtime: Record<string, unknown>,
            ) => unknown,
        ) =>
            factory(
                {
                    colors: {
                        status: {
                            connected: '#00ff00',
                            connecting: '#ffcc00',
                            disconnected: '#ff0000',
                            error: '#ff0000',
                            default: '#999999',
                        },
                        text: '#111111',
                        textSecondary: '#666666',
                    },
                },
                {},
            ),
    },
}));

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
}));

vi.mock('@/text', () => ({
    t: (key: string) => key,
}));

vi.mock('@/constants/Typography', () => ({
    Typography: {
        default: () => ({}),
    },
}));

vi.mock('@/components/StatusDot', () => ({
    StatusDot: 'StatusDot',
}));

vi.mock('@/components/ui/lists/ActionListSection', () => ({
    ActionListSection: (props: ActionListSectionProps) => {
        capture.actionSections.push(props);
        return null;
    },
}));

vi.mock('@/components/FloatingOverlay', () => ({
    FloatingOverlay: (props: { children?: React.ReactNode }) =>
        React.createElement(React.Fragment, null, props.children),
}));

vi.mock('@/components/ui/popover', () => ({
    Popover: (props: PopoverCaptureProps) => {
        capture.popoverProps = props;
        if (!props.open) return null;
        return React.createElement(
            React.Fragment,
            null,
            typeof props.children === 'function' ? props.children({ maxHeight: 520 }) : props.children,
        );
    },
}));

vi.mock('@/sync/storage', () => ({
    useSocketStatus: () => ({ status: 'connected' }),
    useSyncError: () => null,
    useLastSyncAt: () => null,
}));

vi.mock('@/auth/AuthContext', () => ({
    useAuth: () => ({ isAuthenticated: true }),
}));

vi.mock('expo-router', () => ({
    useRouter: () => ({ push: vi.fn() }),
}));

vi.mock('@/sync/sync', () => ({
    sync: { retryNow: vi.fn() },
}));

function getActionLabels(): string[] {
    return capture.actionSections.flatMap((section) =>
        (section.actions ?? []).flatMap((action) => {
            if (!action || typeof action !== 'object') return [];
            const label = action.label;
            return typeof label === 'string' ? [label] : [];
        }),
    );
}

async function importConnectionStatusControl() {
    const module = await import('./ConnectionStatusControl');
    return module.ConnectionStatusControl;
}

afterEach(() => {
    capture.reset();
});

describe('ConnectionStatusControl (native popover config)', () => {
    it('enables a native portal so the menu is not width-constrained to the trigger', async () => {
        const ConnectionStatusControl = await importConnectionStatusControl();
        let tree: renderer.ReactTestRenderer | undefined;
        await act(async () => {
            tree = renderer.create(React.createElement(ConnectionStatusControl, { variant: 'sidebar' }));
        });

        expect(capture.popoverProps).toBeTruthy();
        expect(capture.popoverProps?.portal?.web).toBe(true);
        expect(capture.popoverProps?.portal?.native).toBe(true);
        expect(capture.popoverProps?.portal?.matchAnchorWidth).toBe(false);

        await act(async () => {
            tree?.unmount();
        });
    });

    it('includes server switch actions when multiple servers are configured', async () => {
        const previousScope = process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE;
        const scope = `test_${Date.now()}_${Math.random().toString(16).slice(2)}`;
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = scope;

        try {
            vi.resetModules();
            const profiles = await import('@/sync/serverProfiles');
            profiles.upsertServerProfile({ serverUrl: 'https://company.example.test', name: 'Company' });
            const ConnectionStatusControl = await importConnectionStatusControl();

            let tree: renderer.ReactTestRenderer | undefined;
            await act(async () => {
                tree = renderer.create(React.createElement(ConnectionStatusControl, { variant: 'sidebar' }));
            });

            const trigger = tree!.root.findByType('Pressable');
            await act(async () => {
                trigger.props.onPress();
            });

            const actionLabels = getActionLabels();
            expect(actionLabels.some((label) => label.toLowerCase().includes('company'))).toBe(true);

            await act(async () => {
                tree?.unmount();
            });
        } finally {
            if (previousScope === undefined) {
                delete process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE;
            } else {
                process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = previousScope;
            }
        }
    });
});
