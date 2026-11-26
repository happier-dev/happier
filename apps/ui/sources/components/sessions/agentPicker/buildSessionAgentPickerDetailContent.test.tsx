import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/components/sessions/new/components/NewSessionEngineOptionDetail', () => ({
    NewSessionEngineOptionDetail: 'NewSessionEngineOptionDetail',
}));

import { buildSessionAgentPickerDetailContent, type SessionAgentPickerSelection } from './buildSessionAgentPickerDetailContent';

const CHOSEN = {
    v: 1 as const,
    bindingsByServiceId: {
        anthropic: { source: 'connected' as const, selection: 'profile' as const, profileId: 'claude1' },
    },
};

function build(selection: SessionAgentPickerSelection) {
    const onSelectionChange = vi.fn();
    const element = buildSessionAgentPickerDetailContent({
        backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
        selectedMachineId: 'machine-1',
        capabilityServerId: 'server-1',
        cwd: '/repo',
        settings: {} as never,
        selection,
        onSelectionChange,
    }) as React.ReactElement<{
        onSelectionChange: (next: Omit<SessionAgentPickerSelection, 'connectedServices'>) => void;
    }>;
    return { element, onSelectionChange };
}

const CHANGED_MODEL = { modelId: 'opus', modelLabel: 'Opus', sessionModeId: null, configOverrides: {} };

describe('buildSessionAgentPickerDetailContent', () => {
    it('keeps the account chosen for the armed Agent when the model changes', () => {
        const { element, onSelectionChange } = build({
            modelId: 'default', modelLabel: null, sessionModeId: null, configOverrides: {}, connectedServices: CHOSEN,
        });

        element.props.onSelectionChange(CHANGED_MODEL);

        expect(onSelectionChange).toHaveBeenCalledWith({ ...CHANGED_MODEL, connectedServices: CHOSEN });
    });

    it('leaves the account absent when none was chosen, so the account default still applies', () => {
        const { element, onSelectionChange } = build({
            modelId: 'default', modelLabel: null, sessionModeId: null, configOverrides: {},
        });

        element.props.onSelectionChange(CHANGED_MODEL);

        expect(onSelectionChange.mock.calls[0]?.[0]).not.toHaveProperty('connectedServices');
    });
});
