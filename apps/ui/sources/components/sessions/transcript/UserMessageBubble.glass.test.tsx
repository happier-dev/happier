import * as React from 'react';
import { describe, expect, it } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { installMessageViewCommonModuleMocks } from './messageViewTestHelpers';

installMessageViewCommonModuleMocks();

describe('user bubble material', () => {
    it('lets the content coat show through its background without fading message text', async () => {
        const { UserMessageBubble } = await import('./UserMessageBubble');
        const { useUnistyles } = await import('react-native-unistyles');
        const { glassSurfaceBackgroundColor } = await import('@/components/ui/glass/glassSurfacePaint');
        const { theme } = useUnistyles();
        const screen = await renderScreen(<UserMessageBubble><React.Fragment>message</React.Fragment></UserMessageBubble>);
        const bubble = screen.tree.root.findAll(node => typeof node.type === 'string' && node.props.style?.backgroundColor)[0];
        expect(bubble.props.style.backgroundColor).toBe(glassSurfaceBackgroundColor(theme.colors.message.user.background, 'content', true));
        expect(bubble.props.style.opacity).toBeUndefined();
    });
});
