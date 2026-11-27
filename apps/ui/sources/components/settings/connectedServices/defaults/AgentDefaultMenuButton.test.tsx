import * as React from 'react';
import { expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { AgentDefaultMenuButton } from './AgentDefaultMenuButton';
import { buildAgentDefaultChoices, writeAgentDefaultChoice } from '@happier-dev/protocol/connect/agentDefaultChoices';
import { QualifiedConnectedAccountPurposeBindingsV1Schema, type QualifiedConnectedAccountPurposeBindingTargetV1 } from '@happier-dev/protocol/connect/connectedAccountPurposeBindings';

vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock().module);

it('retains an unavailable default control rather than representing unread choices as an empty set', async () => {
    const screen = await renderScreen(React.createElement(AgentDefaultMenuButton, {
        choices: [], onChange: () => { throw new Error('unavailable_default_must_not_write'); },
        disabledReason: 'Unavailable', presentation: 'icon', testID: 'purpose-default',
    }));
    try {
        expect(screen.findHostByTestId('purpose-default')).not.toBeNull();
        expect(screen.findHostByTestId('purpose-default')?.props.accessibilityState).toMatchObject({ disabled: true });
    } finally { await screen.unmount(); }
});

it.each([
    { kind: 'account', failFollowup: false }, { kind: 'group', failFollowup: false },
    { kind: 'account', failFollowup: true }, { kind: 'group', failFollowup: true },
] as const)('retains the latest $kind choice and another agent during persistence (follow-up failure: $failFollowup)', async ({ kind, failFollowup }) => {
    let acknowledge!: () => void;
    const receipt = new Promise<void>(resolve => { acknowledge = resolve; });
    const intents: Array<Readonly<{ agentId: string; makeDefault: boolean }>> = [];
    const service = { pluginId: 'happier.agent.codex', localId: 'openai-codex' };
    const target: QualifiedConnectedAccountPurposeBindingTargetV1 = kind === 'account'
        ? { kind, account: { service, accountId: 'account-one' } } : { kind, service, groupId: 'pool-one' };
    const agents = ['codex', 'other'].map(agentId => ({ agentId, title: agentId,
        identity: { pluginId: 'happier.agent.codex', localId: agentId }, connectedAccounts: [{ purpose: 'primary', service }] }));
    let stored = QualifiedConnectedAccountPurposeBindingsV1Schema.parse({ v: 1, bindings: [] });
    function Page() {
        const [value, setValue] = React.useState(stored);
        return <AgentDefaultMenuButton choices={buildAgentDefaultChoices({ agents, target, purposeBindings: value })}
            onChange={async (agentId, makeDefault) => {
                intents.push({ agentId, makeDefault });
                // Persistence acknowledgement is the boundary; the real per-agent writer merges current neighbors.
                if (intents.length === 1) await receipt;
                if (failFollowup && agentId === 'codex' && !makeDefault) throw new Error('persistence_refused');
                const next = writeAgentDefaultChoice({ agents, target, purposeBindings: stored, agentId, makeDefault });
                if (next) { stored = next.connectedAccountPurposeBindingsV1; setValue(stored); }
            }} presentation="icon" testID="pending-purpose-default" />;
    }
    const screen = await renderScreen(<Page />);
    try {
        let pending: unknown;
        await act(async () => { pending = screen.findByType(DropdownMenu).props.onSelect('codex'); });
        expect(screen.findHostByTestId('pending-purpose-default')?.props.accessibilityState.disabled).not.toBe(true);
        for (let index = 0; index < 5; index += 1) await act(async () => { screen.findByType(DropdownMenu).props.onSelect('codex'); });
        await act(async () => { screen.findByType(DropdownMenu).props.onSelect('other'); });
        expect(screen.findByType(DropdownMenu).props.items.find((item: { id: string }) => item.id === 'codex').rightElement).toBeNull();
        expect(screen.findByType(DropdownMenu).props.items.find((item: { id: string }) => item.id === 'other').rightElement).not.toBeNull();
        expect(intents).toEqual([{ agentId: 'codex', makeDefault: true }]);
        await act(async () => { acknowledge(); await pending; });
        expect(intents.filter(intent => intent.agentId === 'codex')).toEqual([
            { agentId: 'codex', makeDefault: true }, { agentId: 'codex', makeDefault: false },
        ]);
        expect(buildAgentDefaultChoices({ agents, target, purposeBindings: stored })).toMatchObject([
            { agentId: 'codex', isDefault: failFollowup }, { agentId: 'other', isDefault: true },
        ]);
        expect(Boolean(screen.findByType(DropdownMenu).props.items.find((item: { id: string }) => item.id === 'codex').rightElement)).toBe(failFollowup);
        expect(screen.findHostByTestId('pending-purpose-default')?.props.accessibilityState.disabled).not.toBe(true);
    } finally { acknowledge(); await screen.unmount(); }
});

it('keeps its label while it waits, so the header does not change shape during a reload', async () => {
    const screen = await renderScreen(React.createElement(AgentDefaultMenuButton, {
        choices: [{ agentId: 'codex', title: 'Codex', isDefault: false }], onChange: () => undefined,
        disabledReason: 'Loading', testID: 'reloading-purpose-default',
    }));
    try {
        expect(screen.getTextContent()).not.toContain('Loading');
        expect(screen.findHostByTestId('reloading-purpose-default')?.props.accessibilityState).toMatchObject({ disabled: true });
    } finally { await screen.unmount(); }
});
