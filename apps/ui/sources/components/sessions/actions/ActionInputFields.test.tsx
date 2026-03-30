import { describe, expect, it, vi } from 'vitest';
import { findTestInstanceByTypeContainingText, pressTestInstanceAsync, renderScreen } from '@/dev/testkit';
import { installSessionActionsCommonModuleMocks } from './sessionActionsTestHelpers';

installSessionActionsCommonModuleMocks();

describe('ActionInputFields', () => {
    it('does not clear the last selected value for required multiselect fields', async () => {
        const { ActionInputFields } = await import('./ActionInputFields');
        const onPatch = vi.fn();

        const screen = await renderScreen(<ActionInputFields
            fields={[
                {
                    path: 'engineIds',
                    title: 'Review engines',
                    widget: 'multiselect',
                    required: true,
                } as any,
            ]}
            input={{ engineIds: ['claude'] }}
            editable
            resolveFieldOptions={() => [
                { value: 'claude', label: 'Claude' },
                { value: 'codex', label: 'Codex' },
            ]}
            onPatch={onPatch}
        />);

        const claudeChip = findTestInstanceByTypeContainingText(screen.tree, 'Pressable', 'Claude');
        expect(claudeChip).toBeDefined();

        await pressTestInstanceAsync(claudeChip);

        expect(onPatch).not.toHaveBeenCalled();
    });
});
