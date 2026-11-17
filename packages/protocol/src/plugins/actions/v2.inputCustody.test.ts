import { describe, expect, it } from 'vitest';
import { PluginActionContributionV2Schema } from './v2.js';
import { projectTargetActionApprovalInput } from '../../actions/actionApprovalPresentation.js';

describe('contributed Action confidential input custody', () => {
    it('preserves exact paths and one-level array paths without matching siblings or deeper values', () => {
        const input = { auth: { token: 'private-token', tokenLabel: 'visible-label' },
            rows: [{ value: 'private-row', nested: { value: 'visible-nested' } }],
            other: { token: 'visible-other' } };
        expect(projectTargetActionApprovalInput(input, ['auth.token', 'rows.[].value'])?.input).toEqual({
            auth: { token: '[REDACTED]', tokenLabel: 'visible-label' },
            rows: [{ value: '[REDACTED]', nested: { value: 'visible-nested' } }],
            other: { token: 'visible-other' },
        });
    });

    it('admits live-only operands and uses the existing approval projection for nested parameter values', () => {
        const declaration = PluginActionContributionV2Schema.parse({
            id: 'statement/run', title: 'Run SQL', scopes: ['global'], surfaces: ['plugin'],
            execution: { target: 'daemon' }, dangerLevel: 'writesRemote',
            approvalInputCustody: 'live_only',
            secretInputPaths: ['statement.parameters.[]', 'statements.[].parameters.[]'],
        });
        const input = { mode: 'write', statements: [{ sql: 'UPDATE users SET name = $1', parameters: ['private-name'] }] };
        expect(projectTargetActionApprovalInput(input, declaration.secretInputPaths ?? [])?.input).toEqual({
            mode: 'write', statements: [{ sql: 'UPDATE users SET name = $1', parameters: ['[REDACTED]'] }],
        });
        expect(declaration.approvalInputCustody).toBe('live_only');
        expect(PluginActionContributionV2Schema.safeParse({ ...declaration, approvalInputCustody: 'durable' }).success).toBe(false);
    });

    it('projects recursive confidential leaves while preserving typed filter metadata', () => {
        const input = { filter: { kind: 'and', filters: [
            { kind: 'comparison', column: 'name', operator: 'eq', value: { type: 'text', value: 'private-name' } },
            { kind: 'not', filter: { kind: 'or', filters: [
                { kind: 'comparison', column: 'count', operator: 'gt', value: { type: 'integer', value: '123456789' } },
                { kind: 'null', column: 'deleted', isNull: true },
            ] } },
        ] } };
        expect(projectTargetActionApprovalInput(input, ['filter.**.value.value'])?.input).toEqual({ filter: {
            kind: 'and', filters: [
                { kind: 'comparison', column: 'name', operator: 'eq', value: { type: 'text', value: '[REDACTED]' } },
                { kind: 'not', filter: { kind: 'or', filters: [
                    { kind: 'comparison', column: 'count', operator: 'gt', value: { type: 'integer', value: '[REDACTED]' } },
                    { kind: 'null', column: 'deleted', isNull: true },
                ] } },
            ],
        } });
        expect(projectTargetActionApprovalInput({ filter: {
            kind: 'comparison', column: 'name', operator: 'eq', value: { type: 'text', value: 'private-direct' },
        } }, ['filter.**.value.value'])?.input).toEqual({ filter: {
            kind: 'comparison', column: 'name', operator: 'eq', value: { type: 'text', value: '[REDACTED]' },
        } });
    });
});
