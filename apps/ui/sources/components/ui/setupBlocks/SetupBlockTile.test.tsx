import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { HappierUiPlatformProvider } from '@happier-dev/plugin-ui/environment';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

const buttonRenders = vi.hoisted(() => ({ count: 0 }));
vi.mock('@/components/ui/buttons/RoundButton', async () => {
    const actual = await vi.importActual<typeof import('@/components/ui/buttons/RoundButton')>('@/components/ui/buttons/RoundButton');
    const Real = actual.RoundButton as React.ComponentType<Record<string, unknown>>;
    // Counts real renders of the tile's buttons; rendering itself is untouched.
    return { ...actual, RoundButton: (props: Record<string, unknown>) => { buttonRenders.count += 1; return <Real {...props} />; } };
});

import { SetupBlockTile } from './SetupBlockTile';

const PLATFORM = { platform: 'ios', colorScheme: 'light' } as const;

describe('SetupBlockTile', () => {
    // A host re-renders with equal tile data and fresh action/dismiss objects (its hooks settle one by
    // one); the tile and its buttons must not re-render for that, and a changed label must.
    it('re-renders only when what it draws or its handlers change, not for fresh equal action objects', async () => {
        const onPress = () => {};
        const onDismiss = () => {};
                const scene = (label: string) => (
            <HappierUiPlatformProvider platform={PLATFORM}>
                <>
                    <SetupBlockTile
                        testID="tile" layout="card" icon="key" title="Title" subtitle="Subtitle"
                        action={{ label, testID: 'tile.action', onPress }}
                        dismiss={{ label: 'Hide', tooltip: 'Hide tip', onPress: onDismiss }}
                    />
                </>
            </HappierUiPlatformProvider>
        );
        const screen = await renderScreen(scene('Open'));
        const mounted = buttonRenders.count;
        expect(mounted).toBeGreaterThan(0);
        await screen.update(scene('Open'));
        await screen.update(scene('Open'));
        expect(buttonRenders.count).toBe(mounted);
        await screen.update(scene('Go'));
        expect(buttonRenders.count).toBe(mounted + 1);
    });
});
