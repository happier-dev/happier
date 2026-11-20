import * as React from 'react';
import { beforeAll, describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { installAgentInputCommonModuleMocks } from './agentInputTestHelpers';

// Native, font/theme and icon adapters are the platform boundaries; the composer's control placement is real.
installAgentInputCommonModuleMocks();
vi.mock('expo-image', () => ({ Image: () => null }));
vi.mock('expo-crypto', async () => ({
    ...await import('@/platform/cryptoRandom.node'),
    ...await import('@/platform/randomUUID.node'),
}));

beforeAll(async () => { await import('./AgentInput'); }, 600_000);

describe('AgentInput fixed engine', () => {
    // A question to a walkthrough is answered by the Run that wrote it: the composer names that model and
    // offers no picker, because nothing chosen here would change who answers.
    it('names a fixed engine without a picker when engine controls are off', async () => {
        const { AgentInput } = await import('./AgentInput');
        const screen = await renderScreen(<AgentInput value="" placeholder="Reply to Walkthrough…" onChangeText={() => undefined}
            onSend={() => undefined} autocompleteKinds={[]} autocompleteSuggestions={async () => []}
            voiceAffordance="none" engineControls="none" engineLabel="GPT-6-Luna" engineAgentId="codex" />);
        const chip = screen.findHostByTestId('agent-input-agent-chip');
        expect(chip, 'the fixed engine is named').not.toBeNull();
        expect(chip?.props.accessibilityLabel ?? chip?.props['aria-label']).toBe('GPT-6-Luna');
        expect(chip?.props.accessibilityState?.disabled ?? chip?.props['aria-disabled']).toBe(true);
    });

    it('draws no engine chip when engine controls are off and nothing names the engine', async () => {
        const { AgentInput } = await import('./AgentInput');
        const screen = await renderScreen(<AgentInput value="" placeholder="Message" onChangeText={() => undefined}
            onSend={() => undefined} autocompleteKinds={[]} autocompleteSuggestions={async () => []}
            voiceAffordance="none" engineControls="none" />);
        expect(screen.findHostByTestId('agent-input-agent-chip')).toBeNull();
    });

    // Bulk compose aimed at sessions running different Agents: the picker offers the Agents they share, but no
    // one of them is chosen, so the chip wears the control's own glyph and opens on no row.
    it('opens an unselected engine picker under the control glyph when no one Agent is chosen', async () => {
        const { AgentInput } = await import('./AgentInput');
        const { Icon } = await import('@/components/ui/icons/Icon');
        const options = [
            { id: 'claude', label: 'Claude', icon: <Icon name="star" size={12} testID="claude-mark" /> },
            { id: 'codex', label: 'Codex', icon: <Icon name="circle" size={12} testID="codex-mark" /> },
        ];
        const screen = await renderScreen(<AgentInput value="" placeholder="Message" onChangeText={() => undefined}
            onSend={() => undefined} autocompleteKinds={[]} autocompleteSuggestions={async () => []}
            voiceAffordance="none" engineLabel="Mixed" engineUnselected agentPickerOptions={options}
            agentPickerSelectedOptionId={null} onAgentPickerSelect={() => undefined} />);
        expect(screen.findHostByTestId('agent-input-agent-chip'), 'the engine chip is drawn').not.toBeNull();
        const logo = screen.findByTestId('agent-input-agent-chip-logo');
        expect(logo, 'the chip has a mark').toBeTruthy();
        expect(logo?.props.name, 'the chip wears the control glyph, not the first row\'s mark').toBe('sparkle');
    });

    // The cross-Agent Favorites rail row is a view the popover opens on, not an engine: while it is browsed the chip
    // keeps the chosen Agent's mark (PICKER-ACCEPT-1120 fix 8).
    it('keeps the chosen Agent\'s mark while a view row such as Favorites is browsed', async () => {
        const { AgentInput } = await import('./AgentInput');
        const { Icon } = await import('@/components/ui/icons/Icon');
        const options = [
            { id: 'favorite-models', label: 'Favorites', view: true as const, icon: <Icon name="star" size={12} /> },
            { id: 'codex', label: 'Codex', icon: <Icon name="circle" size={12} /> },
        ];
        const screen = await renderScreen(<AgentInput value="" placeholder="Message" onChangeText={() => undefined}
            onSend={() => undefined} autocompleteKinds={[]} autocompleteSuggestions={async () => []}
            voiceAffordance="none" agentType="codex" agentPickerOptions={options}
            agentPickerSelectedOptionId="favorite-models" onAgentPickerSelect={() => undefined} />);
        const marks = screen.findAll((node) => node.props?.testID === 'agent-input-agent-chip-logo');
        expect(marks.some((node) => node.props.name === 'star'), 'the chip does not wear the Favorites view\'s star').toBe(false);
        expect(marks.some((node) => node.props.agentId === 'codex'), 'the chip wears the chosen Agent\'s mark').toBe(true);
    });
});
