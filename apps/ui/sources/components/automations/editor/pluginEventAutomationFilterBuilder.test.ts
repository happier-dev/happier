import { describe, expect, it } from 'vitest';
import { AutomationEventFilterV1Schema } from '@happier-dev/protocol/automations/automationEventFilterV1';

import {
    readPluginEventAutomationFilterClauses,
    readPluginEventAutomationFilterDraft,
} from './pluginEventAutomationFilterBuilder';

describe('Plugin Event Automation filter builder', () => {
    it('rejects unfinished JSON instead of saving it as a null comparison', () => {
        for (const valueText of ['', '{', 'tru']) {
            expect(readPluginEventAutomationFilterDraft([
                { id: 'changes', field: '/changedFiles', op: 'eq', valueText },
            ])).toEqual({ valid: false, filter: null });
        }
        expect(readPluginEventAutomationFilterDraft([
            { id: 'profile', field: '/launchProfileId', op: 'eq', valueText: 'null' },
        ])).toEqual({ valid: true, filter: { v: 1, all: [{ op: 'eq', field: '/launchProfileId', value: null }] } });
    });
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

    it('preserves ordered numeric and lossless decimal operands when editing a saved filter', () => {
        const filter = AutomationEventFilterV1Schema.parse({
            v: 1,
            all: [
                { op: 'gt', field: '/counter', value: '9007199254740993.000000000000000002' },
                { op: 'gte', field: '/count', value: 10 },
                { op: 'lt', field: '/counter', value: '1e99999999999999999999' },
                { op: 'lte', field: '/count', value: 12 },
            ],
        });
        const clauses = readPluginEventAutomationFilterClauses(filter);

        expect(readPluginEventAutomationFilterDraft(clauses)).toEqual({ valid: true, filter });
    });
});
