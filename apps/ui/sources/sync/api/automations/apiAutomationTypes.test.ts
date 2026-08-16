import { describe, expect, it } from 'vitest';

import { ApiAutomationScheduleSchema } from './apiAutomationTypes';

describe('ApiAutomationScheduleSchema', () => {
    it('accepts manual definitions without schedule values', () => {
        expect(ApiAutomationScheduleSchema.parse({
            kind: 'manual',
            scheduleExpr: null,
            everyMs: null,
            timezone: null,
        })).toEqual({
            kind: 'manual',
            scheduleExpr: null,
            everyMs: null,
            timezone: null,
        });
    });
});
