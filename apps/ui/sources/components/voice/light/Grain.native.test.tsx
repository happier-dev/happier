import * as React from 'react';
import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';

type ReactActEnvironmentGlobal = typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
};

// React's test renderer reads this test-runner boundary flag from the global object.
(globalThis as ReactActEnvironmentGlobal).IS_REACT_ACT_ENVIRONMENT = true;

// `vi.mock` is hoisted above the module body, so the shared handle must be too.
const platformState = vi.hoisted(() => ({ OS: 'ios' as string }));
vi.mock('react-native', async () => {
    const actual = await import('@/dev/reactNativeStub');
    // Only `OS` is dynamic. Replacing the whole Platform object breaks
    // `Platform.select`, which the theme profiles call at module scope.
    return {
        ...actual,
        Platform: new Proxy(actual.Platform as object, {
            get: (target, key) => (key === 'OS'
                ? platformState.OS
                : (target as Record<string | symbol, unknown>)[key]),
        }),
    };
});

vi.mock('@/hooks/ui/useReducedMotionPreference', () => ({
    useReducedMotionPreference: () => false,
}));

import { Grain } from './VoiceLight';
import { Image, StyleSheet, View } from 'react-native';

/**
 * Grain must render on native, not only on web.
 *
 * The film grain is not decoration: without it, soft light on a flat canvas
 * reads as a cheap blur rather than a material, which is the whole reason the
 * onboarding horizon uses the same recipe. Rendering it on web and skipping it
 * on iOS/Android is a platform fidelity divergence — and this spec's own rule
 * (§M8) is that a divergence is a defect to fix, not an outcome to document.
 *
 * `backgroundImage` is a web-only style, so the original implementation
 * early-returned `null` off web. The native path uses a static repeating
 * `Image` carrying the *same* 16×16 tile: no JS animation, no per-frame work,
 * one texture the platform tiles for free.
 */
function renderGrain(
    os: 'ios' | 'android' | 'web',
    props: Readonly<{ radius?: number; opacity?: number }> = {},
): renderer.ReactTestRenderer {
    platformState.OS = os;
    let tree: renderer.ReactTestRenderer | null = null;
    act(() => {
        tree = renderer.create(<Grain {...props} />);
    });
    if (tree === null) {
        throw new Error(`Grain did not render on ${os}`);
    }
    return tree;
}

function flattenStyle(style: unknown): Record<string, unknown> {
    return (StyleSheet.flatten(style as never) ?? {}) as Record<string, unknown>;
}

function readNativeTileUri(tree: renderer.ReactTestRenderer): string {
    const image = tree.root.findByType(Image);
    const source = image.props.source as Readonly<{ uri?: unknown }>;
    if (typeof source.uri !== 'string') {
        throw new Error('Native Grain image did not render a URI source');
    }
    return source.uri;
}

function readWebTileUri(tree: renderer.ReactTestRenderer): string {
    const backgroundImage = flattenStyle(tree.root.findByType(View).props.style).backgroundImage;
    if (typeof backgroundImage !== 'string' || !backgroundImage.startsWith('url(') || !backgroundImage.endsWith(')')) {
        throw new Error('Web Grain did not render a CSS background-image URI');
    }
    return backgroundImage.slice(4, -1);
}

function decodePngDataUri(uri: string): Buffer {
    const prefix = 'data:image/png;base64,';
    if (!uri.startsWith(prefix)) {
        throw new Error('Grain tile is not a PNG data URI');
    }
    return Buffer.from(uri.slice(prefix.length), 'base64');
}

describe('Grain renders on every platform', () => {
    it.each(['ios', 'android'] as const)('renders the complete native texture contract on %s', (os) => {
        const tree = renderGrain(os, { radius: 18, opacity: 0.037 });
        const wrapper = tree.root.findByType(View);
        const image = tree.root.findByType(Image);

        expect(wrapper.props.pointerEvents).toBe('none');
        expect(flattenStyle(wrapper.props.style)).toMatchObject({
            position: 'absolute',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            borderRadius: 18,
            opacity: 0.037,
            overflow: 'hidden',
        });
        expect(image.props.resizeMode).toBe('repeat');
        expect(flattenStyle(image.props.style)).toEqual({ width: '100%', height: '100%' });
        expect(image.props.accessibilityElementsHidden).toBe(true);
        expect(image.props.importantForAccessibility).toBe('no-hide-descendants');
    });

    it('renders the same exact tile URI on web, iOS, and Android', () => {
        const webUri = readWebTileUri(renderGrain('web'));
        expect(readNativeTileUri(renderGrain('ios'))).toBe(webUri);
        expect(readNativeTileUri(renderGrain('android'))).toBe(webUri);
    });

    it('pins the rendered PNG tile bytes and intrinsic dimensions', () => {
        const bytes = decodePngDataUri(readWebTileUri(renderGrain('web')));

        expect(bytes.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
        expect(bytes.readUInt32BE(16)).toBe(16);
        expect(bytes.readUInt32BE(20)).toBe(16);
        expect(createHash('sha256').update(bytes).digest('hex'))
            .toBe('724a9c4c885c6826b4f850a71d28a1071d6bdfbbb8e455009371965ee023ba38');
    });
});
