import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';

import { PullRequestActionRail } from './PullRequestActionRail';

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key) => key });
});

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const theme = {
    colors: {
        button: {
            primary: {
                background: 'button-primary-background',
                tint: 'button-primary-tint',
            },
        },
        divider: 'divider',
        surfaceHigh: 'surface-high',
        text: 'text',
        textSecondary: 'text-secondary',
    },
};

describe('PullRequestActionRail', () => {
    it('disables open-or-reuse when the branch is dirty and unpublished', async () => {
        const screen = await renderScreen(
            <PullRequestActionRail
                theme={theme}
                model={{
                    kind: 'ready_to_create',
                    provider: {
                        kind: 'github',
                        name: 'GitHub',
                        baseUrl: 'https://github.com',
                        nameWithOwner: 'happier/dev',
                        remoteName: 'origin',
                    },
                    providerLabel: 'GitHub',
                    repositoryLabel: 'happier/dev',
                    baseBranch: 'main',
                    headBranch: 'feature/prs',
                    canCreatePullRequest: true,
                    createBlockedReason: null,
                    createStrategy: {
                        kind: 'open_or_reuse',
                        disabledReason: 'dirty_unpublished_branch',
                    },
                    defaultBranchAction: null,
                }}
                onViewPullRequest={vi.fn()}
                onOpenOrReusePullRequest={vi.fn()}
                onCreateFeatureBranch={vi.fn()}
                onCreateFeatureBranchAndOpenPullRequest={vi.fn()}
            />,
        );

        expect(screen.findByTestId('scm-pull-request-open-or-reuse')?.props.disabled).toBe(true);
    });
});
