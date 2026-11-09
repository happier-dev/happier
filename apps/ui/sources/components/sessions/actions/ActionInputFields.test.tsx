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

    it('paints current custom roles from the canonical dynamic-options resolver without legacy Delegate', async () => {
        const { getActionSpec } = await import('@happier-dev/protocol');
        const { ActionInputFields } = await import('./ActionInputFields');
        const { buildSessionActionFieldOptionsResolver } = await import('./sessionActionFieldOptions');
        const onPatch = vi.fn();
        const field = getActionSpec('session.role.set').inputHints?.fields.find((candidate) => candidate.path === 'role');
        if (!field) throw new Error('Missing role field');
        const resolveFieldOptions = buildSessionActionFieldOptionsResolver({
            enabledAgentIds: [],
            executionRunsBackends: null,
            resolveAgentLabel: (id) => id,
            roleProfiles: [
                { id: 'planner', kind: 'builtIn', name: 'Planner', displayName: 'Planning Lead', instructions: 'Plan.', color: null },
                { id: 'custom:123e4567-e89b-12d3-a456-426614174000', kind: 'custom', name: 'Architect', displayName: null, instructions: 'Design.', color: '#123456' },
            ],
        });
        const screen = await renderScreen(<ActionInputFields
            fields={[field]}
            input={{ role: 'custom:123e4567-e89b-12d3-a456-426614174000' }}
            editable
            resolveFieldOptions={resolveFieldOptions}
            onPatch={onPatch}
        />);

        const planningLead = findTestInstanceByTypeContainingText(screen.tree, 'Pressable', 'Planning Lead');
        expect(planningLead).toBeDefined();
        if (!planningLead) throw new Error('Missing display alias option');
        expect(findTestInstanceByTypeContainingText(screen.tree, 'Pressable', 'Architect')).toBeDefined();
        expect(findTestInstanceByTypeContainingText(screen.tree, 'Pressable', 'Delegate')).toBeUndefined();

        await pressTestInstanceAsync(planningLead);
        expect(onPatch).toHaveBeenCalledWith({ role: 'planner' });
        expect(onPatch).not.toHaveBeenCalledWith(expect.objectContaining({ role: 'Planning Lead' }));
    });
});
