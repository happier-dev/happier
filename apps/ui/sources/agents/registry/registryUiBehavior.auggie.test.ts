import { describe, expect, it, vi } from 'vitest';

import { createAgentUiBehaviorFromDescriptor } from './agentUiBehaviorDescriptors';
import {
    buildNewSessionOptionsFromUiState,
    getNewSessionAgentInputExtraActionChips,
} from './registryUiBehavior';

vi.mock('@/components/ui/theme/haptics', () => ({
    hapticsLight: vi.fn(),
}));

/**
 * Auggie's indexing control, read through the public declarative seams only.
 *
 * These assertions build the behavior from the descriptor the plugin ships
 * rather than from `AGENTS_UI_BEHAVIOR`, because the bundled projection those
 * registry helpers read is a generated artifact that only the bundled-plugin
 * publisher may rewrite. The declaration mirrors
 * `packages/plugins/auggie/src/ui/descriptor.ts`, whose own test pins it.
 */
const AUGGIE_DECLARATION = {
    newSession: {
        agentOptions: [
            { key: 'allowIndexing', kind: 'boolean', spawnConfigOption: true },
        ],
    },
    components: {
        slots: [
            {
                id: 'auggie-allow-indexing',
                slot: 'newSession.agentInputExtraActionChips',
                chip: {
                    kind: 'booleanOption',
                    optionStateKey: 'allowIndexing',
                    iconName: 'magnifying-glass',
                    onLabelKey: 'agentInput.auggieIndexingChip.on',
                    offLabelKey: 'agentInput.auggieIndexingChip.off',
                },
            },
        ],
    },
} as const;

describe('Auggie UI behavior projection', () => {
    it('reaches the same declared behavior through the bundled registry bridge', () => {
        const setAgentOptionState = vi.fn();
        const chips = getNewSessionAgentInputExtraActionChips({
            agentId: 'auggie',
            agentOptionState: { allowIndexing: false },
            setAgentOptionState,
        });

        expect(chips).toHaveLength(1);
        expect(chips?.[0]?.key).toBe('auggie-allow-indexing');
        expect(buildNewSessionOptionsFromUiState({
            agentId: 'auggie',
            agentOptionState: { allowIndexing: true },
        })).toEqual({ allowIndexing: true });
    });

    it('projects the declared boolean option chip without a host component id', () => {
        const setAgentOptionState = vi.fn();
        const { behavior, diagnostics } = createAgentUiBehaviorFromDescriptor(AUGGIE_DECLARATION);
        const chips = behavior.newSession?.getAgentInputExtraActionChips?.({
            agentId: 'auggie',
            agentOptionState: { allowIndexing: false },
            setAgentOptionState,
        });

        expect(diagnostics).toEqual([]);
        expect(chips).toHaveLength(1);
        const action = chips?.[0]?.collapsedAction?.({
            tint: 'currentColor',
            dismiss: vi.fn(),
            blurInput: vi.fn(),
            openCollapsedPopover: vi.fn(),
        });
        const actionItem = Array.isArray(action) ? action[0] : action;

        expect(actionItem?.id).toBe('auggie-allow-indexing');
        // The declared label keys resolve, and the chip reads the live option value.
        expect(actionItem?.label).toBe('Indexing off');
        actionItem?.onPress?.();
        expect(setAgentOptionState).toHaveBeenCalledWith('allowIndexing', true);

        const onChips = createAgentUiBehaviorFromDescriptor(AUGGIE_DECLARATION)
            .behavior.newSession?.getAgentInputExtraActionChips?.({
                agentId: 'auggie',
                agentOptionState: { allowIndexing: true },
                setAgentOptionState,
            });
        const onAction = onChips?.[0]?.collapsedAction?.({
            tint: 'currentColor',
            dismiss: vi.fn(),
            blurInput: vi.fn(),
            openCollapsedPopover: vi.fn(),
        });
        expect((Array.isArray(onAction) ? onAction[0] : onAction)?.label).toBe('Indexing on');
    });

    it('refuses a chip slot that declares no supported chip instead of rendering nothing silently', () => {
        const { behavior, diagnostics } = createAgentUiBehaviorFromDescriptor({
            components: {
                slots: [
                    {
                        id: 'auggie-allow-indexing',
                        slot: 'newSession.agentInputExtraActionChips',
                    },
                ],
            },
        });
        const chips = behavior.newSession?.getAgentInputExtraActionChips?.({
            agentId: 'auggie',
            agentOptionState: { allowIndexing: true },
            setAgentOptionState: vi.fn(),
        });

        expect(chips).toEqual([]);
        expect(diagnostics.map((entry) => entry.code)).toContain('A16X1_MALFORMED_DESCRIPTOR');
    });

    it('normalizes every declared option key into the new-session options payload', () => {
        const { behavior } = createAgentUiBehaviorFromDescriptor(AUGGIE_DECLARATION);

        expect(behavior.newSession?.buildNewSessionOptions?.({
            agentId: 'auggie',
            agentOptionState: { allowIndexing: true },
        })).toEqual({ allowIndexing: true });
        expect(behavior.newSession?.buildNewSessionOptions?.({
            agentId: 'auggie',
            agentOptionState: null,
        })).toEqual({ allowIndexing: false });
    });

    it('projects the declared option into canonical session configuration overrides', () => {
        const { behavior } = createAgentUiBehaviorFromDescriptor(AUGGIE_DECLARATION);

        expect(behavior.payload?.buildSpawnSessionExtras?.({
            agentId: 'auggie',
            settings: {} as never,
            experiments: { enabled: false, switches: {} },
            resumeSessionId: '',
            newSessionOptions: { allowIndexing: true },
            sessionConfigOptionOverrides: {
                v: 1,
                updatedAt: 10,
                overrides: {
                    existing: { value: 'kept', updatedAt: 10 },
                },
            },
            updatedAt: 20,
        })).toEqual({
            sessionConfigOptionOverrides: {
                v: 1,
                updatedAt: 20,
                overrides: {
                    existing: { value: 'kept', updatedAt: 10 },
                    allowIndexing: { value: true, updatedAt: 20 },
                },
            },
        });
    });

    it('emits no session configuration when the option never reached the spawn payload', () => {
        const { behavior } = createAgentUiBehaviorFromDescriptor(AUGGIE_DECLARATION);

        expect(behavior.payload?.buildSpawnSessionExtras?.({
            agentId: 'auggie',
            settings: {} as never,
            experiments: { enabled: false, switches: {} },
            resumeSessionId: '',
            newSessionOptions: {},
            sessionConfigOptionOverrides: null,
            updatedAt: 20,
        })).toEqual({});
    });
});
