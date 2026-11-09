import { describe, expect, it } from 'vitest';

describe('visibleAgentsSettingsState', () => {
    it('falls back to the protocol defaults for a malformed root setting', async () => {
        const { parseVisibleAgentsSettingV1 } = await import('./visibleAgentsSettingsState');
        expect(parseVisibleAgentsSettingV1('not-an-object')).toMatchObject({
            v: 1,
            defaultVisibilityByIntent: { review: 'hidden', plan: 'hidden', delegate: 'hidden' },
            defaultRoleByIntent: {},
            assembleTeamOnLeadAssignment: false,
        });
    });

    it('updates team settings without rewriting retained run defaults or newer passthrough fields', async () => {
        const { updateVisibleAgentsAssemblyEnabledV1, updateVisibleAgentsTeamTemplateV1 } = await import('./visibleAgentsSettingsState');
        const current = {
            v: 1,
            defaultVisibilityByIntent: { review: 'hidden', plan: 'hidden', delegate: 'session', future: 'kept' },
            defaultRoleByIntent: { delegate: 'worker' },
            defaultTargetByIntent: { delegate: { modelId: 'delegate-model' } },
            assembleTeamOnLeadAssignment: false,
            futureRoot: { retained: true },
        };

        const assembled = updateVisibleAgentsAssemblyEnabledV1(current, true);
        const next = updateVisibleAgentsTeamTemplateV1(assembled, [{
            role: 'worker',
            modelId: 'worker-model',
            permissionMode: 'workspace_write',
        }]);

        expect(next.defaultVisibilityByIntent).toEqual(current.defaultVisibilityByIntent);
        expect(next.defaultRoleByIntent).toEqual(current.defaultRoleByIntent);
        expect(next.defaultTargetByIntent).toEqual(current.defaultTargetByIntent);
        expect(next.assembleTeamOnLeadAssignment).toBe(true);
        expect(next.teamTemplate).toEqual([{
            role: 'worker',
            modelId: 'worker-model',
            permissionMode: 'workspace_write',
        }]);
        expect(next.futureRoot).toEqual({ retained: true });
    });
});
