import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';

const received = vi.hoisted(() => ({ style: undefined as unknown }));

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
// expo-image is the third-party boundary: record what it is handed.
vi.mock('expo-image', () => ({
    Image: (props: { style?: unknown }) => {
        received.style = props.style;
        return React.createElement('ExpoImage', props);
    },
}));

/**
 * A `StyleSheet.create` entry as Unistyles builds it on web: the values are non-enumerable and only
 * a hidden `unistyles_<id>` marker is enumerable (`removeInlineStyles` + `assignSecrets`).
 */
function unistylesWebEntry(values: Record<string, unknown>): Record<string, unknown> {
    const entry: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(values)) {
        Object.defineProperty(entry, key, { value, enumerable: false, configurable: true });
    }
    entry.unistyles_k3j2 = {};
    return entry;
}

/** What expo-image's `StyleSheet.flatten` keeps: enumerable own properties, later entries winning. */
function appliedByExpoImage(style: unknown): Record<string, unknown> {
    return Object.assign({}, ...[style].flat(Infinity).filter(Boolean));
}

describe('SafeExpoImage', () => {
    it.each([undefined, 'Project mark'])('provides an image alternative for %s', async accessibilityLabel => {
        const { SafeExpoImage } = await import('./SafeExpoImage');
        const screen = await renderScreen(<SafeExpoImage testID="mark" accessibilityLabel={accessibilityLabel} source={{ uri: 'https://example.test/mark.png' }} />);
        expect(screen.findByTestId('mark')?.props.alt).toBe(accessibilityLabel ?? '');
        // expo-image's loaded web image reads accessibilityLabel, unlike its placeholder's alt fallback.
        expect(screen.findByTestId('mark')?.props.accessibilityLabel).toBe(accessibilityLabel ?? '');
    });
    it('hands expo-image a style whose sizes survive its flatten, when the caller passes a Unistyles stylesheet entry', async () => {
        const { SafeExpoImage } = await import('./SafeExpoImage');
        const fill = unistylesWebEntry({ width: '100%', height: '100%' });
        await renderScreen(<SafeExpoImage source={{ uri: 'data:image/png;base64,cG5n' }} style={fill as never} />);
        expect(appliedByExpoImage(received.style)).toMatchObject({ width: '100%', height: '100%' });
    });

    it('keeps array order, so an inline override still wins over a stylesheet entry', async () => {
        const { SafeExpoImage } = await import('./SafeExpoImage');
        const base = unistylesWebEntry({ width: 20, height: 20, borderRadius: 4 });
        await renderScreen(<SafeExpoImage source={{ uri: 'data:image/png;base64,cG5n' }} style={[base, { width: 32 }] as never} />);
        expect(appliedByExpoImage(received.style)).toMatchObject({ width: 32, height: 20, borderRadius: 4 });
        expect(Object.keys(appliedByExpoImage(received.style)).some(key => key.startsWith('unistyles_'))).toBe(false);
    });
});
