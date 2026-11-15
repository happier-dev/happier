import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';

vi.mock('expo-image', () => ({
    Image: (props: any) => React.createElement('Image', props, props.children),
}));

vi.mock('react-native-svg', async () => await import('@/dev/testkit/mocks/reactNativeSvg'));

vi.mock('./AvatarGradient', () => ({
    AvatarGradient: (props: any) => React.createElement('AvatarGradient', props),
}));

vi.mock('./AvatarSkia', () => ({
    AvatarSkia: (props: any) => React.createElement('AvatarSkia', props),
}));

vi.mock('./AvatarBrutalist', () => ({
    AvatarBrutalist: (props: any) => React.createElement('AvatarBrutalist', props),
}));

afterEach(standardCleanup);

const { Avatar } = await import('./Avatar');
const { AgentIcon } = await import('@/agents/registry/AgentIcon');

/**
 * The Agent mark on an avatar is a brand claim about which Agent produced the
 * session. The catalog only carries presentation for bundled Agents, so a
 * session run by an installed or otherwise unresolvable Agent has no mark to
 * show — and showing the product default in its place would tell the user the
 * session belongs to Claude.
 */
describe('Avatar Agent mark', () => {
    it('shows the bundled Agent’s own mark', async () => {
        const screen = await renderScreen(<Avatar id="session-1" flavor="claude" size={48} />);

        expect(screen.findAllByType('SvgXml' as any).length).toBe(1);
    });

    it.each([
        ['an installed Agent with no bundled presentation', 'acme.agent/custom-agent'],
        ['a session whose Agent is unreadable', null],
    ])('shows no mark for %s', async (_name, flavor) => {
        const screen = await renderScreen(<Avatar id="session-1" flavor={flavor} size={48} />);

        expect(screen.findAllByType('SvgXml' as any)).toEqual([]);
        expect(screen.findAllByType('Image' as any)).toEqual([]);
    });

    // QA-SHELL-1114 R2-1: Muse is bundled but carries no mark of its own. Its badge was drawn anyway, an empty
    // opaque disc the size of the avatar, so every Muse Session header showed a blank circle.
    it('draws no badge for a bundled Agent that carries no mark of its own', async () => {
        const screen = await renderScreen(<Avatar id="session-1" flavor="muse" size={32} />);

        expect(screen.findAllByType(AgentIcon)).toEqual([]);
    });

    it('still shows the unread badge for an Agent with no mark', async () => {
        const screen = await renderScreen(
            <Avatar
                id="session-1"
                flavor="acme.agent/custom-agent"
                size={48}
                hasUnreadMessages
                unreadBadgeTestID="unread-badge"
            />,
        );

        expect(screen.findAllByProps({ testID: 'unread-badge' }).length).toBeGreaterThan(0);
        expect(screen.findAllByType('SvgXml' as any)).toEqual([]);
    });

    it('overlays the bundled Agent’s mark on an uploaded image', async () => {
        const screen = await renderScreen(
            <Avatar
                id="session-1"
                flavor="claude"
                imageUrl="https://example.com/avatar.png"
                size={48}
            />,
        );

        expect(screen.findAllByType('SvgXml' as any).length).toBe(1);
    });

    it('keeps the uploaded image unmarked when the Agent has no mark', async () => {
        const screen = await renderScreen(
            <Avatar
                id="session-1"
                flavor="acme.agent/custom-agent"
                imageUrl="https://example.com/avatar.png"
                size={48}
            />,
        );

        expect(screen.findAllByType('SvgXml' as any)).toEqual([]);
    });
});
