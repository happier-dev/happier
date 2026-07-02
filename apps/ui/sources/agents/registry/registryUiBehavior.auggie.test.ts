import { describe, expect, it, vi } from 'vitest';

import { getNewSessionAgentInputExtraActionChips } from './registryUiBehavior';

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
        });
        const actionItem = Array.isArray(action) ? action[0] : action;

        expect(actionItem?.id).toBe('auggie-allow-indexing');
        actionItem?.onPress?.();
        expect(setAgentOptionState).toHaveBeenCalledWith('allowIndexing', true);
    });
});
