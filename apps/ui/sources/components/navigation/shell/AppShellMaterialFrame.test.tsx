/** @vitest-environment jsdom */
import * as React from 'react';
import type { ReactTestInstance } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit/render/renderScreen';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

import { AppShellMaterialFrame } from './AppShellMaterialFrame';
import { applyGlassDocumentPresentation } from '@/components/ui/glass/glassDocumentPresentation';
import { glassPresetMaterials } from '@/components/ui/glass/glassMaterial';
import { StyleSheet, View } from 'react-native';

function alphaAt(leaf: ReactTestInstance, doc: Document) {
    let remaining = 1;
    for (let node: ReactTestInstance | null = leaf; node; node = node.parent) {
        if (typeof node.type !== 'string') continue;
        const color = StyleSheet.flatten(node.props.style)?.backgroundColor;
        if (typeof color !== 'string' || color === 'transparent') continue;
        const variable = color.match(/var\((--happier-glass-(?:chrome|sidebar|content|floating)-(?:nested-)?opacity),/);
        const alpha = variable ? parseFloat(doc.documentElement.style.getPropertyValue(variable[1]!)) / 100 : 1;
        remaining *= 1 - alpha;
    }
    return 1 - remaining;
}

describe('real shell material planes', () => {
    it('applies each coat once in its own region with live material variables', async () => {
        const screen = await renderScreen(<AppShellMaterialFrame showChrome dragEnabled={false} leftOffsetPx={384} sidebarWidth={320}
            titleStrip={<View testID="title" />} rail={<View testID="rail" />}
            column={<View testID="sidebar-body" />} peek={null}><View testID="content" /></AppShellMaterialFrame>);
        const doc = document.implementation.createHTMLDocument();
        const check = (materials: ReturnType<typeof glassPresetMaterials>) => {
            const stop = applyGlassDocumentPresentation(doc, { glassSurfaceMaterials: materials }, { desktopWindow: true, nativeWindowMaterialLive: true });
            try {
                for (const [id, group] of [['title', 'chrome'], ['rail', 'chrome'], ['sidebar-body', 'sidebar'], ['content', 'content']] as const) {
                    expect(alphaAt(screen.findHostByTestId(id)!, doc), id).toBeCloseTo(materials[group].opacity);
                }
            } finally { stop(); }
        };
        for (const opacity of [0.2, 0.8]) check({ ...glassPresetMaterials('everywhere'), chrome: { blur: 'regular', opacity }, sidebar: { blur: 'off', opacity: 0 }, content: { blur: 'off', opacity: 1 } });
        check(glassPresetMaterials('everywhere'));
        check(glassPresetMaterials('auto'));
        check(glassPresetMaterials('solid'));
    });
});
