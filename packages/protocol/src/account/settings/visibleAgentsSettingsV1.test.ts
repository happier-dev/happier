import { describe, expect, it } from 'vitest';

import { accountSettingsParse } from './accountSettings.js';
import {
    DEFAULT_VISIBLE_AGENTS_V1,
    VisibleAgentsV1Schema,
    resolveExecutionRunVisibleDefaultsV1,
    resolveVisibleAgentsV1,
} from './visibleAgentsSettingsV1.js';

describe('visibleAgentsV1 account setting', () => {
    it('ships every intent hidden, no default roles, and assembly off', () => {
        expect(DEFAULT_VISIBLE_AGENTS_V1).toEqual({
            v: 1,
            defaultVisibilityByIntent: { review: 'hidden', plan: 'hidden', delegate: 'hidden' },
            defaultRoleByIntent: {},
            assembleTeamOnLeadAssignment: false,
        });
        expect(accountSettingsParse({}).visibleAgentsV1).toEqual(DEFAULT_VISIBLE_AGENTS_V1);
    });

    it('drops only the malformed field and preserves unknown keys', () => {
        const parsed = VisibleAgentsV1Schema.parse({
            v: 1,
            defaultVisibilityByIntent: { review: 'session', plan: 'bogus' },
            defaultRoleByIntent: { review: 'reviewer', delegate: 'project_lead' },
            assembleTeamOnLeadAssignment: 'yes',
            teamTemplate: [{ role: 'reviewer', permissionMode: 'read_only' }, { role: 'project_lead' }],
            future: { kept: true },
        });
        expect(parsed.defaultVisibilityByIntent).toEqual({ review: 'session', plan: 'hidden', delegate: 'hidden' });
        expect(parsed.defaultRoleByIntent).toEqual({ review: 'reviewer' });
        expect(parsed.assembleTeamOnLeadAssignment).toBe(false);
        expect(parsed.teamTemplate).toEqual([{ role: 'reviewer', permissionMode: 'read_only' }]);
        expect((parsed as Record<string, unknown>).future).toEqual({ kept: true });
        expect(resolveVisibleAgentsV1({ visibleAgentsV1: 'garbage' })).toEqual(DEFAULT_VISIBLE_AGENTS_V1);
    });
});

describe('resolveExecutionRunVisibleDefaultsV1', () => {
    const settings = { visibleAgentsV1: { v: 1, defaultVisibilityByIntent: { review: 'session' }, defaultRoleByIntent: { review: 'reviewer', delegate: 'worker' } } };

    it('takes visibility only from the start request, so a saved per-intent visibility never promotes a run', () => {
        expect(resolveExecutionRunVisibleDefaultsV1({ settings, intent: 'review', requested: {} }))
            .toEqual({ visibility: 'hidden', roleSource: 'none' });
        expect(resolveExecutionRunVisibleDefaultsV1({ settings, intent: 'review', requested: { visibility: 'hidden' } }))
            .toEqual({ visibility: 'hidden', roleSource: 'none' });
        expect(resolveExecutionRunVisibleDefaultsV1({ settings, intent: 'review', requested: { role: 'planner' } }))
            .toEqual({ visibility: 'hidden', role: 'planner', roleSource: 'explicit' });
        expect(resolveExecutionRunVisibleDefaultsV1({ settings: {}, intent: 'plan', requested: {} }))
            .toEqual({ visibility: 'hidden', roleSource: 'none' });
    });

    it('keeps the explicit visible start: an explicit role wins and a default role fills only a visible run', () => {
        expect(resolveExecutionRunVisibleDefaultsV1({ settings, intent: 'review', requested: { visibility: 'session' } }))
            .toEqual({ visibility: 'session', role: 'reviewer', roleSource: 'settings' });
        expect(resolveExecutionRunVisibleDefaultsV1({ settings, intent: 'review', requested: { visibility: 'session', role: 'planner' } }))
            .toEqual({ visibility: 'session', role: 'planner', roleSource: 'explicit' });
    });
});
