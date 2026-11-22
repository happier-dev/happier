import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { AgentInputEngineDetail } from '@/components/sessions/agentInput/components/AgentInputEngineDetail';
import { installNewSessionComponentsCommonModuleMocks } from './newSessionComponentsTestHelpers';
import { NewSessionEngineOptionDetail } from './NewSessionEngineOptionDetail';

installNewSessionComponentsCommonModuleMocks();

describe('NewSessionEngineOptionDetail session modes', () => {
    it.each([null, undefined, ''])('preserves an absent mode (%s) when selecting a model', async (sessionModeId) => {
        const onSelectionChange = vi.fn();
        const screen = await renderScreen(<NewSessionEngineOptionDetail
            backendTarget={{ kind: 'builtInAgent', agentId: 'kimi' }}
            selectedMachineId={null}
            capabilityServerId="server-1"
            selectedSessionModeId={sessionModeId}
            onSelectionChange={onSelectionChange}
        />);

        await act(async () => {
            screen.findByType(AgentInputEngineDetail).props.onSelectModel('kimi-code/k3.1-pro');
        });

        expect(onSelectionChange).toHaveBeenLastCalledWith(expect.objectContaining({
            modelId: 'kimi-code/k3.1-pro',
            sessionModeId: '',
        }));
    });

    it.each(['review', 'default'])('preserves an explicit native mode (%s) when selecting a model', async (sessionModeId) => {
        const onSelectionChange = vi.fn();
        const screen = await renderScreen(<NewSessionEngineOptionDetail
            backendTarget={{ kind: 'builtInAgent', agentId: 'codex' }}
            selectedMachineId={null}
            capabilityServerId="server-1"
            selectedSessionModeId={sessionModeId}
            onSelectionChange={onSelectionChange}
        />);

        await act(async () => {
            screen.findByType(AgentInputEngineDetail).props.onSelectModel('gpt-5');
        });

        expect(onSelectionChange).toHaveBeenLastCalledWith(expect.objectContaining({
            modelId: 'gpt-5',
            sessionModeId,
        }));
    });

    it('preserves a cleared mode after the parent updates its selection', async () => {
        const onSelectionChange = vi.fn();
        const props = {
            backendTarget: { kind: 'builtInAgent', agentId: 'codex' } as const,
            selectedMachineId: null,
            capabilityServerId: 'server-1',
            onSelectionChange,
        };
        const screen = await renderScreen(<NewSessionEngineOptionDetail {...props} selectedSessionModeId="review" />);

        await act(async () => {
            screen.update(<NewSessionEngineOptionDetail {...props} selectedSessionModeId={null} />);
        });
        await act(async () => {
            screen.findByType(AgentInputEngineDetail).props.onSelectModel('gpt-5');
        });

        expect(onSelectionChange).toHaveBeenLastCalledWith(expect.objectContaining({
            modelId: 'gpt-5',
            sessionModeId: '',
        }));
    });
});
