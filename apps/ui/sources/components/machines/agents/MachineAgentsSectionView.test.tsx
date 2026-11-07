import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderSettingsView } from '@/dev/testkit';
import { installUiListsCommonModuleMocks } from '@/components/ui/lists/uiListsTestHelpers';
import { MachineAgentsSectionView } from './MachineAgentsSectionView';
import { ListPresentationProvider } from '@/components/ui/lists/listPresentation';
import { projectMachineAgent } from '@/agents/machineAgents/machineAgentModel';
import { MachineAgentInventoryItemSchema, buildMachineAgentInventoryKey } from '@happier-dev/protocol/capabilities';
import { FirstAgentSetupBlock } from './FirstAgentSetupBlock';
import { MachineAgentRow } from './MachineAgentRow';
import { Text } from '@/components/ui/text/Text';

installUiListsCommonModuleMocks();

describe('machine agent inventory recovery', () => {
    const definitions = ['first', 'second'].map(definitionId => projectMachineAgent({
        agentId: 'custom-acp', definitionId, title: definitionId, checking: false, stale: false, connectedServices: [], job: null,
        facts: MachineAgentInventoryItemSchema.parse({ agentId: 'custom-acp', definitionId, title: definitionId,
            installed: false, version: null, latestVersion: null, update: { supported: false, command: null },
            signIn: { status: 'unknown', loginSupport: 'unsupported' }, platform: { supported: true },
            install: { available: true, mode: 'managed', sizeBytes: null, guideUrl: null }, dependencies: [] }),
    }));

    it('opens only the selected configured definition row', async () => {
        const changed = vi.fn();
        const secondKey = buildMachineAgentInventoryKey(definitions[1]!);
        const screen = await renderSettingsView(<MachineAgentsSectionView testID="machine-agents"
            agents={definitions} status="ready" lastCheckedAt={1} machineName="Workstation"
            renderMark={() => null} sessionFor={() => null} renderForm={() => <Text>Setup</Text>}
            expandedAgentIds={new Set([secondKey])} onExpandedChange={changed} onAction={() => {}} onCheckAgain={() => {}} />);
        const rows = screen.findAllByType(MachineAgentRow);
        expect(rows.map(row => row.props.expanded)).toEqual([false, true]);
        rows[1]!.props.onExpandedChange(false);
        expect(changed).toHaveBeenCalledWith(secondKey, false);
    });

    it('keeps the chosen first-agent definition after the inventory order changes', async () => {
        const props = { testID: 'first-agent', machineName: 'Workstation', phone: false, agents: definitions,
            renderMark: () => null, renderForm: (agent: typeof definitions[number]) => <Text testID="chosen-definition">{agent.definitionId}</Text>,
            onAllAgents: () => {}, onDismiss: () => {} };
        const screen = await renderSettingsView(<FirstAgentSetupBlock {...props} />);
        // Choose the second actual setup control, independent of its DOM/test identifier.
        const { RoundButton } = await import('@/components/ui/buttons/RoundButton');
        const { act } = await import('react-test-renderer');
        await act(async () => { screen.findAllByType(RoundButton)[1]!.props.onPress(); });
        expect(screen.findByTestId('chosen-definition')?.props.children).toBe('second');
        await screen.update(<FirstAgentSetupBlock {...props} agents={[...definitions].reverse()} />);
        expect(screen.findByTestId('chosen-definition')?.props.children).toBe('second');
    });

    it('hosts the section under a page that already says Agents without repeating the title', async () => {
        const { t } = await import('@/text');
        const render = (titled: boolean) => renderSettingsView(<ListPresentationProvider value="page"><MachineAgentsSectionView testID="machine-agents"
            agents={definitions} status="ready" lastCheckedAt={1} machineName="Workstation" titled={titled}
            renderMark={() => null} sessionFor={() => null} renderForm={() => null}
            expandedAgentIds={new Set()} onExpandedChange={() => {}} onAction={() => {}} onCheckAgain={() => {}} /></ListPresentationProvider>);
        expect((await render(true)).getTextContent()).toContain(t('machineAgents.sectionTitle'));
        const hosted = (await render(false)).getTextContent();
        expect(hosted).not.toContain(t('machineAgents.sectionTitle'));
        // The sentence and the one recovery stay: only the repeated heading goes.
        expect(hosted).toContain(t('machineAgents.sectionDescription'));
    });

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

    it.each([
        ['checking', 'loading', true, 'machine-agents.loading'],
        ['unknown', 'error', false, 'machine-agents.error'],
        ['unknown', 'ready', false, 'machine-agents.error'],
        // A machine whose presence reads online but whose check never ran stays idle: that is a state to say, not a blank section.
        ['unknown', 'idle', false, 'machine-agents.error'],
    ] as const)('does not claim no agent is installed from descriptor-only rows that are %s (status %s)', async (_state, status, checking, expected) => {
        const descriptors = ['first', 'second'].map(definitionId => projectMachineAgent({
            agentId: 'custom-acp', definitionId, title: definitionId, checking, stale: false, connectedServices: [], job: null, facts: null }));
        const screen = await renderSettingsView(<ListPresentationProvider value="page"><MachineAgentsSectionView testID="machine-agents"
            agents={descriptors} status={status} lastCheckedAt={null} machineName="Workstation"
            renderMark={() => null} sessionFor={() => null} renderForm={() => null}
            expandedAgentIds={new Set()} onExpandedChange={() => {}} onAction={() => {}} onCheckAgain={() => {}} /></ListPresentationProvider>);
        expect(screen.findByTestId('machine-agents.empty')).toBeNull();
        expect(screen.findByTestId(expected)).not.toBeNull();
        // Unresolved rows are not yet "to add": an installed agent would jump groups once its check lands (UIR5).
        for (const agent of descriptors) expect(screen.findByTestId(`machine-agents.${buildMachineAgentInventoryKey(agent)}`)).toBeNull();
        // One cause, one affordance: the line (or its Check again) owns the state, not a second spinner in the header.
        expect(screen.findByTestId('machine-agents.checkAgain')).toBeNull();
    });

    it('shows the offline line with one Check again for a cold inventory that never observed absence', async () => {
        const retry = vi.fn();
        const screen = await renderSettingsView(<ListPresentationProvider value="page"><MachineAgentsSectionView testID="machine-agents"
            agents={[]} status="offline" lastCheckedAt={null} machineName="Workstation"
            renderMark={() => null} sessionFor={() => null} renderForm={() => null}
            expandedAgentIds={new Set()} onExpandedChange={() => {}} onAction={() => {}} onCheckAgain={retry} /></ListPresentationProvider>);
        expect(screen.findByTestId('machine-agents.offline')).not.toBeNull();
        expect(screen.findByTestId('machine-agents.empty')).toBeNull();
        expect(screen.findByTestId('machine-agents.loading')).toBeNull();
        // An offline inventory is recoverable from the section: the one Check again, not a Machine-wide retry.
        await screen.pressByTestIdAsync('machine-agents.checkAgain');
        expect(retry).toHaveBeenCalledOnce();
    });

    it('says no agent is installed only once the check finished and every agent resolved to not installed', async () => {
        const screen = await renderSettingsView(<ListPresentationProvider value="page"><MachineAgentsSectionView testID="machine-agents"
            agents={definitions} status="ready" lastCheckedAt={1} machineName="Workstation"
            renderMark={() => null} sessionFor={() => null} renderForm={() => null}
            expandedAgentIds={new Set()} onExpandedChange={() => {}} onAction={() => {}} onCheckAgain={() => {}} /></ListPresentationProvider>);
        expect(screen.findByTestId('machine-agents.empty')).not.toBeNull();
    });

    it('keeps the last installed row alongside the offline line', async () => {
        const held = { ...definitions[0]!, installed: true, state: 'ready' as const, stale: true };
        const screen = await renderSettingsView(<ListPresentationProvider value="page"><MachineAgentsSectionView testID="machine-agents"
            agents={[held]} status="offline" lastCheckedAt={1} machineName="Workstation"
            renderMark={() => null} sessionFor={() => null} renderForm={() => null}
            expandedAgentIds={new Set()} onExpandedChange={() => {}} onAction={() => {}} onCheckAgain={() => {}} /></ListPresentationProvider>);
        expect(screen.findByTestId('machine-agents.offline')).not.toBeNull();
        expect(screen.findByTestId('machine-agents.empty')).toBeNull();
        expect(screen.findByTestId('machine-agents.checkAgain')).not.toBeNull();
        expect(screen.findAllByType(MachineAgentRow).map(row => row.props.agent)).toEqual([held]);
    });

    it('never says no agent is installed while an agent just installed here stays in the add list (R88)', async () => {
        const justInstalled = { ...definitions[0]!, installed: true, state: 'needsSignIn' as const, version: '0.162.1',
            job: { jobId: 'j', intent: 'install' as const, startedAtMs: 0, logLine: null, steps: [], outcome: { kind: 'succeeded' as const, version: '0.162.1' } } };
        const screen = await renderSettingsView(<ListPresentationProvider value="page"><MachineAgentsSectionView testID="machine-agents"
            agents={[justInstalled, definitions[1]!]} status="ready" lastCheckedAt={1} machineName="Workstation"
            renderMark={() => null} sessionFor={() => null} renderForm={() => null}
            expandedAgentIds={new Set([buildMachineAgentInventoryKey(justInstalled)])} onExpandedChange={() => {}} onAction={() => {}} onCheckAgain={() => {}} /></ListPresentationProvider>);
        expect(screen.findByTestId('machine-agents.empty')).toBeNull();
        // The row keeps the place its setup form opened in.
        expect(screen.findAllByType(MachineAgentRow).map(row => row.props.agent)).toEqual([justInstalled, definitions[1]]);
    });
});
