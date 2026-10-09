import * as React from 'react';
import { expect, it } from 'vitest';
import { act } from 'react-test-renderer';
import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { AgentDefaultMenuButton } from './AgentDefaultMenuButton';

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

it('keeps the default control pending until its Account write acknowledges', async () => {
    let acknowledge!: () => void;
    const receipt = new Promise<void>(resolve => { acknowledge = resolve; });
    const intents: Array<Readonly<{ agentId: string; makeDefault: boolean }>> = [];
    const screen = await renderScreen(React.createElement(AgentDefaultMenuButton, {
        choices: [{ agentId: 'codex', title: 'Codex', isDefault: false }],
        onChange: async (agentId, makeDefault) => { intents.push({ agentId, makeDefault }); await receipt; },
        presentation: 'icon', testID: 'pending-purpose-default',
    }));
    try {
        let pending: unknown;
        await act(async () => { pending = screen.findByType(DropdownMenu).props.onSelect('codex'); });
        expect(screen.findHostByTestId('pending-purpose-default')?.props.accessibilityState).toMatchObject({ disabled: true });
        await act(async () => { screen.findByType(DropdownMenu).props.onSelect('codex'); });
        expect(intents).toEqual([{ agentId: 'codex', makeDefault: true }]);
        await act(async () => { acknowledge(); await pending; });
        expect(screen.findHostByTestId('pending-purpose-default')?.props.accessibilityState.disabled).not.toBe(true);
    } finally { acknowledge(); await screen.unmount(); }
});
