import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';

const home = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(home);
const { RepositoryTreeRootErrorState } = await import('./RepositoryTreeRootErrorState');
const { t } = await import('@/text');

beforeEach(async () => {
    await home.reset();
    await home.addHome({ name: 'Folder errors', serverUrl: 'https://folder-errors.example.test',
        serverIdentityId: 'folder-errors', accountId: 'account-a' });
});

afterEach(async () => {
    standardCleanup();
    await home.reset();
});

describe('RepositoryTreeRootErrorState recovery', () => {
    it('shows the isolation reason without a retry that cannot fix it', async () => {
        const screen = await renderScreen(<RepositoryTreeRootErrorState error="agent_isolation_unavailable" onRetry={vi.fn()} />);
        expect(screen.getTextContent()).toContain(t('errors.agentIsolationUnavailable'));
        expect(screen.findAllByTestId('repository-tree-root-error-action')).toHaveLength(0);
    });

    it('keeps retry available for a transient timeout', async () => {
        const retry = vi.fn();
        const screen = await renderScreen(<RepositoryTreeRootErrorState error="MACHINE_RPC_TIMEOUT" onRetry={retry} />);
        expect(screen.getTextContent()).toContain(t('errors.connectionTimeout'));
        await screen.pressByTestIdAsync('repository-tree-root-error-action');
        expect(retry).toHaveBeenCalledOnce();
    });
});
