import { describe, expect, it } from 'vitest';

import {
    readPluginEventAutomationFilterClauses,
    readPluginEventAutomationFilterDraft,
} from './pluginEventAutomationFilterBuilder';

describe('Plugin Event Automation filter builder', () => {
    it('constructs the one Protocol filter grammar from bounded scalar clause controls', () => {
        expect(readPluginEventAutomationFilterDraft([
            { id: 'one', field: '/action', op: 'eq', valueText: '"opened"' },
            { id: 'two', field: '/repository/id', op: 'in', valueText: '[42, 99]' },
        ])).toEqual({
            valid: true,
            filter: {
                v: 1,
                all: [
                    { op: 'eq', field: '/action', value: 'opened' },
                    { op: 'in', field: '/repository/id', values: [42, 99] },
                ],
            },
        });
    });

    it('rejects a raw object, non-scalar, or invalid bounded operand without accepting a parallel grammar', () => {
        expect(readPluginEventAutomationFilterDraft([
            { id: 'one', field: '/action', op: 'eq', valueText: '{"nested":true}' },
        ])).toEqual({ valid: false, filter: null });
        expect(readPluginEventAutomationFilterDraft([
            { id: 'one', field: '/action', op: 'in', valueText: '["opened", {"nested":true}]' },
        ])).toEqual({ valid: false, filter: null });
        expect(readPluginEventAutomationFilterDraft([
            { id: 'one', field: 'action', op: 'eq', valueText: '"opened"' },
        ])).toEqual({ valid: false, filter: null });
    });

    it('round-trips a persisted Protocol filter to editable clauses and treats no clauses as no filter', () => {
        const clauses = readPluginEventAutomationFilterClauses({
            v: 1,
            all: [
                { op: 'eq', field: '/action', value: 'opened' },
                { op: 'in', field: '/repository/id', values: [42, 99] },
            ],
        });

        expect(clauses).toEqual([
            { id: 'persisted-0', field: '/action', op: 'eq', valueText: '"opened"' },
            { id: 'persisted-1', field: '/repository/id', op: 'in', valueText: '[42,99]' },
        ]);
        expect(readPluginEventAutomationFilterDraft(clauses)).toEqual({
            valid: true,
            filter: {
                v: 1,
                all: [
                    { op: 'eq', field: '/action', value: 'opened' },
                    { op: 'in', field: '/repository/id', values: [42, 99] },
                ],
            },
        });
        expect(readPluginEventAutomationFilterDraft([])).toEqual({ valid: true, filter: null });
    });
});
