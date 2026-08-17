import { describe, expect, it } from 'vitest';

import { FOOTER_COLUMNS } from '../data/navigation';
import { GET_STARTED_SECTION_ID } from './GetStarted';
import { SELF_HOST_STACK_NODES, SELF_HOST_TERMINAL_LINES } from './SelfHost';
import { DISCORD_INVITE_URL } from '../data/community';
import { GUIDES_URL } from '../data/downloads';

describe('website public surface links', () => {
    it('keeps the footer get-started link aligned with the section anchor', () => {
        const productLinks = FOOTER_COLUMNS.find((column) => column.id === 'product')?.links ?? [];

        expect(productLinks).toContainEqual(expect.objectContaining({
            label: 'Get started',
            href: `#${GET_STARTED_SECTION_ID}`,
        }));
    });

    // The nav slot Guides used to hold now belongs to Enterprise
    // (src/sections/Nav.tsx), which makes this footer entry the only link to
    // guides.happier.dev anywhere on the site. Those 53 guides were orphaned
    // once already — crawlable by sitemap and by nothing else — and this is the
    // check that stops the next tidy-up doing it again.
    it('keeps guides.happier.dev linked from the footer, its last inbound link', () => {
        const resourceLinks = FOOTER_COLUMNS.find((column) => column.id === 'resources')?.links ?? [];

        expect(resourceLinks).toContainEqual(expect.objectContaining({
            label: 'Guides',
            href: GUIDES_URL,
        }));
    });

    it('links self-host users to the canonical deployment docs route', () => {
        const openSourceLinks = FOOTER_COLUMNS.find((column) => column.id === 'open-source')?.links ?? [];

        expect(openSourceLinks).toContainEqual(expect.objectContaining({
            label: 'Self-host',
            href: 'https://docs.happier.dev/deployment/self-host-runtime',
        }));
    });

    // The footer shipped `discord.gg/happier` — a URL Discord answers with
    // `10006 Unknown Invite`. Pinning it to the shared constant keeps every
    // surface on one invite instead of a hand-typed guess per surface.
    it('points the footer Discord link at the canonical invite', () => {
        const resourceLinks = FOOTER_COLUMNS.find((column) => column.id === 'resources')?.links ?? [];

        expect(resourceLinks).toContainEqual(expect.objectContaining({
            label: 'Discord',
            href: DISCORD_INVITE_URL,
        }));
        expect(DISCORD_INVITE_URL).toMatch(/^https:\/\/discord\.gg\/[A-Za-z0-9]+$/);
    });

    it('describes the managed Relay runtime without implying local daemon setup', () => {
        expect(SELF_HOST_TERMINAL_LINES.map((line) => line.text)).toContain('✓ Relay service started');
        expect(SELF_HOST_TERMINAL_LINES.map((line) => line.text)).not.toContain('✓ Daemon started');

        // The static service list became the self-host stack diagram, so the
        // vocabulary guard follows the copy rather than the widget: the relay is
        // the middle layer the reader hosts, and no node may call it a daemon.
        expect(SELF_HOST_STACK_NODES.map((node) => node.id)).toEqual(['device', 'relay', 'machine']);
        expect(SELF_HOST_STACK_NODES.find((node) => node.id === 'relay')?.label).toBe('Your relay');
        expect(
            SELF_HOST_STACK_NODES.flatMap((node) => [node.label, node.detail]).join(' '),
        ).not.toMatch(/daemon/i);
    });
});
