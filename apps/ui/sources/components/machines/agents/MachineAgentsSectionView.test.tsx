import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderSettingsView } from '@/dev/testkit';
import { installUiListsCommonModuleMocks } from '@/components/ui/lists/uiListsTestHelpers';
import { MachineAgentsSectionView } from './MachineAgentsSectionView';
import { ListPresentationProvider } from '@/components/ui/lists/listPresentation';

installUiListsCommonModuleMocks();

describe('machine agent inventory recovery', () => {
    it.each(['error', 'ready'] as const)('offers one retry for an empty %s inventory', async (status) => {
        const retry = vi.fn();
        const screen = await renderSettingsView(<ListPresentationProvider value="page"><MachineAgentsSectionView testID="machine-agents"
            agents={[]} status={status} lastCheckedAt={null} machineName="Workstation"
            renderMark={() => null} sessionFor={() => null} renderForm={() => null}
            expandedAgentIds={new Set()} onExpandedChange={() => {}} onAction={() => {}} onCheckAgain={retry} /></ListPresentationProvider>);
        const headerRetry = screen.findByTestId('machine-agents.checkAgain');
        expect(headerRetry !== null).toBe(status === 'ready');
        if (status === 'error') {
            const { SurfaceStateCard } = await import('@/components/ui/surfaces/SurfaceStateCard');
            const error = screen.findByType(SurfaceStateCard);
            error.props.action.onPress();
        } else {
            await screen.pressByTestIdAsync('machine-agents.checkAgain');
        }
        expect(retry).toHaveBeenCalledOnce();
    });
});
