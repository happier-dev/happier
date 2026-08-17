import { describe, expect, it, vi } from 'vitest';

import {
    buildNewSessionOptionsFromUiState,
    buildSpawnEnvironmentVariablesFromUiState,
    buildSpawnSessionExtrasFromUiState,
    getNewSessionAgentInputExtraActionChips,
} from './registryUiBehavior';
import { createAgentUiBehaviorFromDescriptor } from './agentUiBehaviorDescriptors';
import { makeSettings } from './registryUiBehavior.testHelpers';

vi.mock('@/components/ui/theme/haptics', () => ({
    hapticsLight: vi.fn(),
}));

describe('Auggie UI behavior projection', () => {
    it('projects the allow-indexing chip through the generated registry bridge', () => {
        const setAgentOptionState = vi.fn();
        const chips = getNewSessionAgentInputExtraActionChips({
            agentId: 'auggie',
            agentOptionState: { allowIndexing: false },
            setAgentOptionState,
        });

        expect(chips).toHaveLength(1);
        const action = chips?.[0]?.collapsedAction?.({
            tint: 'currentColor',
            dismiss: vi.fn(),
            blurInput: vi.fn(),
            openCollapsedPopover: vi.fn(),
        });
        const actionItem = Array.isArray(action) ? action[0] : action;

        expect(actionItem?.id).toBe('auggie-allow-indexing');
        actionItem?.onPress?.();
        expect(setAgentOptionState).toHaveBeenCalledWith('allowIndexing', true);
    });

    it('keeps provider scoping in the registry instead of the Auggie chip factory', () => {
        const { behavior, diagnostics } = createAgentUiBehaviorFromDescriptor({
            components: {
                slots: [
                    {
                        id: 'auggie.allowIndexingChip',
                        slot: 'newSession.agentInputExtraActionChips',
                        componentId: 'firstParty.auggie.allowIndexingChip',
                        props: {
                            optionStateKey: 'allowIndexing',
                        },
                    },
                ],
            },
        });
        const chips = behavior.newSession?.getAgentInputExtraActionChips?.({
            agentId: 'claude',
            agentOptionState: { allowIndexing: true },
            setAgentOptionState: vi.fn(),
        });

        expect(diagnostics).toEqual([]);
        expect(chips).toHaveLength(1);
        expect(chips?.[0]?.key).toBe('auggie-allow-indexing');
    });

    it('projects plugin-owned allow-indexing options into canonical session configuration', () => {
        expect(buildNewSessionOptionsFromUiState({
            agentId: 'auggie',
            agentOptionState: { allowIndexing: true },
        })).toEqual({ allowIndexing: true });

        const spawnInput = {
            agentId: 'auggie' as const,
            settings: makeSettings(),
            resumeSessionId: '',
            newSessionOptions: { allowIndexing: true },
            sessionConfigOptionOverrides: {
                v: 1 as const,
                updatedAt: 10,
                overrides: {
                    existing: { value: 'kept', updatedAt: 10 },
                },
            },
            updatedAt: 20,
        };
        expect(buildSpawnSessionExtrasFromUiState(spawnInput)).toEqual({
            sessionConfigOptionOverrides: {
                v: 1,
                updatedAt: 20,
                overrides: {
                    existing: { value: 'kept', updatedAt: 10 },
                    allowIndexing: { value: true, updatedAt: 20 },
                },
            },
        });

        expect(buildSpawnEnvironmentVariablesFromUiState({
            agentId: 'auggie',
            settings: makeSettings(),
            environmentVariables: { FOO: '1' },
            newSessionOptions: { allowIndexing: true },
        })).toEqual({ FOO: '1' });
    });
});
