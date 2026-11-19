import React from 'react';
import { describe, expect, it, vi } from 'vitest';

import type { ReviewCommentV1 } from '@happier-dev/protocol/reviews/comments/v1';
import { renderScreen, reviewCommentLabelsFixture } from '@/dev/testkit';
import { resolveAgentCatalogTitle } from '@/agents/backendCatalog/agentCatalogProjection';

import { ReviewCommentsList } from './ReviewCommentsList';

// Native recycler layout is the boundary; the list, threads and cards remain real.
vi.mock('@legendapp/list/react-native', async () => {
    const { createLegendListModuleMock } = await import('@/dev/testkit/mocks/legendList');
    return createLegendListModuleMock({ renderItems: true });
});

vi.mock('@/components/ui/text/Text', async () => {
    const { createUiTextModuleMock } = await import('@/dev/testkit/mocks/uiText');
    return createUiTextModuleMock();
});

function comment(overrides: Partial<ReviewCommentV1> = {}): ReviewCommentV1 {
    return {
        v: 1,
        id: overrides.id ?? 'comment-1',
        accountId: 'account-1',
        projectId: 'project-1',
        anchor: overrides.anchor ?? { kind: 'file', filePath: 'src/a.ts' },
        snapshot: { kind: 'too_large', filePath: 'src/a.ts', sizeBytes: 2, capBytes: 1, capturedAt: 1 },
        body: overrides.body ?? 'Fix this.',
        bodyVersion: 1,
        edits: [],
        author: overrides.author ?? { kind: 'plugin', pluginId: 'review-coderabbit' },
        state: overrides.state ?? 'open',
        flags: overrides.flags ?? {},
        dispositions: {},
        threadId: overrides.threadId ?? overrides.id ?? 'comment-1',
        transitions: [
            {
                transitionId: 'transition-1',
                toState: overrides.state ?? 'open',
                transitionedAt: 1,
                transitionedBy: { kind: 'plugin', pluginId: 'review-coderabbit' },
                serverRevision: 1,
            },
        ],
        createdAt: 1,
        updatedAt: 1,
        serverRevision: 1,
        ...overrides,
    };
}

const labels = reviewCommentLabelsFixture;

describe('ReviewCommentsList', () => {
    it('renders durable comments and redacted history state', async () => {
        const screen = await renderScreen(
            <ReviewCommentsList
                comments={[
                    comment({ id: 'c1', state: 'open', body: 'Fix this.', engineId: 'review-deepsec', flags: { stale: true } }),
                    comment({ id: 'c2', state: 'resolved', body: '', flags: { redacted: true } }),
                ]}
                labels={labels}
            />,
        );

        expect(screen.getTextContent()).toContain('Fix this.');
        expect(screen.getTextContent()).toContain('Open');
        expect(screen.getTextContent()).toContain(resolveAgentCatalogTitle('review-deepsec'));
        expect(screen.getTextContent()).toContain('Stale');
        expect(screen.getTextContent()).toContain('Redacted');
        expect(screen.getTextContent()).not.toContain('Proposals only');
        expect(screen.getTextContent()).not.toContain('Direct write enabled');
    });
});
