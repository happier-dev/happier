import * as React from 'react';
import { describe, expect, it } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { resolveGlassPaint } from '@/dev/testkit/glass/resolveGlassPaint';
import { installMessageViewCommonModuleMocks } from './messageViewTestHelpers';

installMessageViewCommonModuleMocks();
const { UserMessageBubble } = await import('./UserMessageBubble');
const { StyleSheet } = await import('react-native');

async function renderBubbleFill(): Promise<string> {
    const screen = await renderScreen(<UserMessageBubble><React.Fragment>message</React.Fragment></UserMessageBubble>);
    const bubble = screen.tree.root.findAll(node => typeof node.type === 'string' && node.props.dataSet?.surface === 'user-bubble')[0];
    const style = StyleSheet.flatten(bubble.props.style);
    expect(style.opacity).toBeUndefined();
    return String(style.backgroundColor);
}

describe('user bubble material', () => {
    // GLASS-TRANSCRIPT-AUDIT §2: with a Picture behind Sessions the document publishes
    // `--happier-glass-content-nested-plane-opacity: 0%`, and a bubble that inherited the page plane went clear.
    it('keeps the translucent inner fill while the content nested plane opacity is 0%', async () => {
        const { resolveGlassPresentationVariables } = await import('@/components/ui/glass/glassDocumentPresentation');
        const { useUnistyles } = await import('react-native-unistyles');
        const settings = { glassBlurEnabled: true, glassSurfaceMaterials: null, glassBlurIntensity: 'regular' } as const;
        const environment = { atmosphereBehind: 'wallpaper' } as const;
        const variables = resolveGlassPresentationVariables(settings, environment);
        expect(variables['--happier-glass-content-nested-plane-opacity']).toBe('0%');

        const painted = resolveGlassPaint(await renderBubbleFill(), variables);
        expect(painted).not.toBe('transparent');
        expect(painted).toBe(useUnistyles().theme.colors.surface.selected);
    });

    it('is its own solid fill when glass is off', async () => {
        const { resolveGlassPresentationVariables } = await import('@/components/ui/glass/glassDocumentPresentation');
        const { useUnistyles } = await import('react-native-unistyles');
        const variables = resolveGlassPresentationVariables({ glassBlurEnabled: false }, {});
        expect(resolveGlassPaint(await renderBubbleFill(), variables)).toBe(useUnistyles().theme.colors.message.user.background);
    });
});
