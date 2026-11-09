import { describe, expect, it, vi } from 'vitest';

// Native rendering and icons are the boundaries; the chip descriptor and copy remain real.
vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());

describe('createSessionRoleActionChip', () => {
    it('offers current built-ins and catalog custom roles but not legacy Delegate', async () => {
        const { createSessionRoleActionChip } = await import('./createSessionRoleActionChip');
        const { t } = await import('@/text');
        const onRoleChange = vi.fn();

        const customId = 'custom:123e4567-e89b-12d3-a456-426614174000' as const;
        const profiles = [
            { id: 'planner', kind: 'builtIn', name: 'Planner', displayName: null, instructions: 'Plan.', color: null },
            { id: 'project_lead', kind: 'builtIn', name: 'Project Manager', displayName: null, instructions: 'Lead.', color: null },
            { id: 'worker', kind: 'builtIn', name: 'Worker', displayName: 'Implementer', instructions: 'Work.', color: '#abcdef' },
            { id: 'reviewer', kind: 'builtIn', name: 'Reviewer', displayName: null, instructions: 'Review.', color: null },
            { id: customId, kind: 'custom', name: 'Architect', displayName: null, instructions: 'Design.', color: '#123456' },
        ] as const;
        const noRole = createSessionRoleActionChip({ role: null, profiles, onRoleChange });
        expect(noRole.collapsedOptionsPopover?.selectedOptionId).toBe('none');
        expect(noRole.collapsedOptionsPopover?.label).toBe(t('sessionRole.label'));
        const section = noRole.collapsedOptionsPopover?.rootStep?.sections?.[0];
        if (!section || section.kind !== 'static') throw new Error('expected static section');
        expect(section.options.map((option) => [option.id, option.label])).toEqual([
            ['planner', t('sessionRole.planner')],
            ['project_lead', t('sessionRole.projectLead')],
            ['worker', 'Implementer'],
            ['reviewer', t('sessionRole.reviewer')],
            [customId, 'Architect'],
            ['none', t('sessionRole.none')],
        ]);
        expect(onRoleChange).not.toHaveBeenCalled();

        section.options.find((option) => option.id === 'worker')?.onSelect?.();
        section.options.find((option) => option.id === customId)?.onSelect?.();
        section.options.find((option) => option.id === 'none')?.onSelect?.();
        expect(onRoleChange.mock.calls).toEqual([['worker'], [customId], [null]]);

        const worker = createSessionRoleActionChip({ role: 'worker', profiles, onRoleChange });
        expect(worker.collapsedOptionsPopover?.label).toBe('Implementer');

        const custom = createSessionRoleActionChip({ role: customId, profiles, onRoleChange });
        expect(custom.collapsedOptionsPopover?.selectedOptionId).toBe(customId);
        expect(custom.collapsedOptionsPopover?.label).toBe('Architect');
    });
});
