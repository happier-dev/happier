import { describe, expect, it } from 'vitest';

import type { IdentityConnectionTestDiagnosticsV1 } from '@happier-dev/protocol/identity/testDiagnostics';

import { identityTestDiagnosticsRows } from './identityTestDiagnosticsPresentation';

function diagnostics(
    overrides: Partial<IdentityConnectionTestDiagnosticsV1> = {},
): IdentityConnectionTestDiagnosticsV1 {
    return {
        subjectPresent: true,
        loginAvailable: true,
        emailAvailable: true,
        emailVerified: true,
        groups: { state: 'complete', count: 2 },
        eligibility: { status: 'eligible', rules: [] },
        mappedGroups: [],
        ...overrides,
    };
}

const detailOf = (rows: readonly { key: string; detail?: string }[], key: string) =>
    rows.find((row) => row.key === key)?.detail;

describe('identityTestDiagnosticsRows', () => {
    it('reports a complete observation with its mapped Group names', () => {
        const rows = identityTestDiagnosticsRows(diagnostics({
            mappedGroups: [{ id: 'group-1', name: 'Engineering' }, { id: 'group-2', name: 'Design' }],
        }), { groupMappings: true });
        expect(detailOf(rows, 'groups')).toContain('2');
        expect(detailOf(rows, 'mappedGroups')).toBe('Engineering, Design');
        expect(rows.some((row) => row.key === 'rule:none')).toBe(true);
    });

    it('omits the mapping row entirely when no connection owns Group mappings', () => {
        const rows = identityTestDiagnosticsRows(diagnostics({
            mappedGroups: [{ id: 'group-1', name: 'Engineering' }],
        }));
        expect(rows.some((row) => row.key === 'mappedGroups')).toBe(false);
        expect(detailOf(rows, 'groups')).toBeDefined();
    });

    it('never claims a Group mapping was evaluated for an incomplete or absent observation', () => {
        const incomplete = identityTestDiagnosticsRows(diagnostics({
            groups: { state: 'incomplete', count: null },
        }), { groupMappings: true });
        const absent = identityTestDiagnosticsRows(diagnostics({
            groups: { state: 'absent', count: null },
        }), { groupMappings: true });
        const empty = identityTestDiagnosticsRows(diagnostics({
            groups: { state: 'complete', count: 3 },
        }), { groupMappings: true });

        expect(detailOf(incomplete, 'mappedGroups')).toBe(detailOf(absent, 'mappedGroups'));
        expect(detailOf(empty, 'mappedGroups')).not.toBe(detailOf(incomplete, 'mappedGroups'));
        expect(detailOf(incomplete, 'groups')).not.toBe(detailOf(absent, 'groups'));
    });

    it('separates a missing email from an unverified one and lists each configured rule outcome', () => {
        const missing = identityTestDiagnosticsRows(diagnostics({ emailAvailable: false, emailVerified: false }));
        const unverified = identityTestDiagnosticsRows(diagnostics({ emailVerified: false }));
        expect(detailOf(missing, 'email')).not.toBe(detailOf(unverified, 'email'));

        const denied = identityTestDiagnosticsRows(diagnostics({
            eligibility: {
                status: 'ineligible',
                rules: [{ kind: 'email_domains', matched: false }, { kind: 'groups_any', matched: true }],
            },
        }));
        expect(denied.map((row) => row.key)).toEqual(expect.arrayContaining([
            'rule:email_domains',
            'rule:groups_any',
        ]));
        expect(detailOf(denied, 'rule:email_domains')).not.toBe(detailOf(denied, 'rule:groups_any'));
        expect(denied.some((row) => row.key === 'rule:none')).toBe(false);
    });
});
