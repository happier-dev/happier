import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { installAgentInputCommonModuleMocks } from './agentInputTestHelpers';

installAgentInputCommonModuleMocks();
const { AgentInput } = await import('./AgentInput');
const { storage } = await import('@/sync/domains/state/storageStore');
const initialPlacements = storage.getState().localSettings.navigationSurfacePlacementsV1;
beforeEach(() => {
    storage.setState(state => ({ localSettings: { ...state.localSettings,
        navigationSurfacePlacementsV1: { ...initialPlacements,
            composer: { orderedIds: [], placements: { 'delivery:resetStart': 'pinned' } } },
    } }));
});
afterEach(() => {
    storage.setState(state => ({ localSettings: { ...state.localSettings,
        navigationSurfacePlacementsV1: initialPlacements,
    } }));
});

describe('AgentInput reset start', () => {
    it('offers explicit reset send without submitting or mounting the detailed picker on composer mount', async () => {
        const onSend = vi.fn();
        const props = {
            sessionId: 'session-reset', sessionAddress: { sessionId: 'session-reset', serverId: 'home' },
            value: 'Wait for capacity', placeholder: '', onChangeText: () => {}, onSend,
            autocompleteKinds: [], autocompleteSuggestions: async () => [], resetStartEnabled: true,
        } satisfies React.ComponentProps<typeof AgentInput>;
        const screen = await renderScreen(<AgentInput {...props} />);
        expect(screen.findByTestId('agent-input-reset-start')).not.toBeNull();
        expect(screen.findByTestId('agent-input-reset-start-picker')).toBeNull();
        expect(onSend).not.toHaveBeenCalled();
        await screen.update(<AgentInput {...props} value="" hasSendableAttachments />);
        expect(screen.findByTestId('agent-input-reset-start')?.props.disabled).toBe(false);
        expect(screen.findByTestId('agent-input-reset-start-picker')).toBeNull();
        await screen.update(<AgentInput {...props} armedContinuationTarget={{ agentId: 'claude', label: 'Claude' }} />);
        expect(screen.findByTestId('agent-input-reset-start')).toBeNull();
        await screen.unmount();
    });
});
