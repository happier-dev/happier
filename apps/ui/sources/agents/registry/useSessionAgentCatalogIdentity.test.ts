import { describe, expect, it } from 'vitest';
import * as React from 'react';

import { resolveAgentCatalogProjection } from '@/agents/backendCatalog/agentCatalogProjection';
import { readBundledPluginBrandPresentation } from '@/components/plugins/shared/installedPluginBrandPresentation';
import { HappierBrandMark } from '@/components/ui/media/HappierBrandMark';
import { Icon } from '@/components/ui/icons/Icon';
import { SessionAgentCatalogIdentityIcon } from '@/components/sessions/presentation/SessionAgentCatalogIdentityIcon';
import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { readSessionPresentationAgentId } from '@/sync/domains/session/presentation/readSessionPresentationAgentId';

describe('useSessionAgentCatalogIdentity', () => {
    it.each([
        ['claude', 'claude'],
        ['unknown-agent', null],
    ] as const)('renders the catalog identity for a %s Session', async (flavor, expectedMark) => {
        const session = createSessionFixture({ metadata: {
            path: '/repo', host: 'test', machineId: 'machine-a', flavor,
        } });
        const screen = await renderScreen(React.createElement(SessionAgentCatalogIdentityIcon, {
            agentId: readSessionPresentationAgentId(session) ?? '',
            machineId: session.metadata?.machineId ?? null,
            serverId: null,
            testID: 'session-agent-identity',
        }));
        try {
            const host = screen.findHostByTestId('session-agent-identity');
            expect(host).not.toBeNull();
            if (expectedMark) {
                // 8e4096d97cb moved Agent artwork onto the shared admitted-brand renderer.
                const entry = resolveAgentCatalogProjection(expectedMark, { enabledAgentIds: [] });
                const brand = readBundledPluginBrandPresentation(entry.installedPackage?.id, entry.title, entry.iconAgentId);
                expect(brand).not.toBeNull();
                expect(screen.tree.root.findByType(HappierBrandMark).props.brand).toEqual(brand);
                expect(screen.tree.root.findAllByType(Icon)).toHaveLength(0);
            } else {
                expect(host?.props.xml).toBeUndefined();
                // 81535ebcb44 gives a Session without a known Agent its neutral Session glyph.
                expect(screen.tree.root.findByType(Icon).props.name).toBe('chat-circle');
            }
        } finally {
            await screen.unmount();
        }
    });
});
