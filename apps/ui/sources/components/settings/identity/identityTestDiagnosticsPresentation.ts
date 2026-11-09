import type { IdentityConnectionTestDiagnosticsV1 } from '@happier-dev/protocol/identity/testDiagnostics';

import { t } from '@/text';

export type IdentityTestDiagnosticsRow = Readonly<{
    key: string;
    title: string;
    /** Omitted for a row whose title already carries the whole statement. */
    detail?: string;
}>;

function ruleTitle(kind: IdentityConnectionTestDiagnosticsV1['eligibility']['rules'][number]['kind']): string {
    switch (kind) {
        case 'users': return t('identityAdministration.diagnosticsRuleUsers');
        case 'email_domains': return t('identityAdministration.diagnosticsRuleEmailDomains');
        case 'groups_any': return t('identityAdministration.groupsAny');
        case 'groups_all': return t('identityAdministration.groupsAll');
    }
}

/**
 * The rows Home and Team administration both show after a non-mutating sign-in test.
 *
 * Every value is a localized status word, never a claim value. A group count is shown
 * only for a complete observation, and mapped Groups report "not evaluated" rather than
 * "no mapping matched" whenever the observation could not decide it.
 */
export function identityTestDiagnosticsRows(
    diagnostics: IdentityConnectionTestDiagnosticsV1,
    options: Readonly<{ groupMappings?: boolean }> = {},
): readonly IdentityTestDiagnosticsRow[] {
    const groupsComplete = diagnostics.groups.state === 'complete';
    const rows: IdentityTestDiagnosticsRow[] = [
        {
            key: 'subject',
            title: t('identityAdministration.diagnosticsSubject'),
            detail: diagnostics.subjectPresent
                ? t('identityAdministration.diagnosticsPresent')
                : t('identityAdministration.diagnosticsMissing'),
        },
        {
            key: 'login',
            title: t('identityAdministration.diagnosticsLogin'),
            detail: diagnostics.loginAvailable
                ? t('identityAdministration.diagnosticsProvided')
                : t('identityAdministration.diagnosticsNotProvided'),
        },
        {
            key: 'email',
            title: t('identityAdministration.diagnosticsEmail'),
            detail: !diagnostics.emailAvailable
                ? t('identityAdministration.diagnosticsNotProvided')
                : diagnostics.emailVerified
                    ? t('identityAdministration.diagnosticsEmailVerified')
                    : t('identityAdministration.diagnosticsEmailUnverified'),
        },
        {
            key: 'groups',
            title: t('identityAdministration.diagnosticsGroups'),
            detail: diagnostics.groups.count !== null
                ? t('identityAdministration.diagnosticsGroupsCount', { count: diagnostics.groups.count })
                : diagnostics.groups.state === 'incomplete'
                    ? t('identityAdministration.diagnosticsGroupsIncomplete')
                    : t('identityAdministration.diagnosticsNotProvided'),
        },
        {
            key: 'eligibility',
            title: t('identityAdministration.diagnosticsEligibility'),
            detail: diagnostics.eligibility.status === 'eligible'
                ? t('identityAdministration.diagnosticsEligible')
                : t('identityAdministration.diagnosticsIneligible'),
        },
    ];

    if (diagnostics.eligibility.rules.length === 0) {
        rows.push({
            key: 'rule:none',
            title: t('identityAdministration.diagnosticsNoRules'),
        });
    }
    for (const rule of diagnostics.eligibility.rules) {
        rows.push({
            key: `rule:${rule.kind}`,
            title: ruleTitle(rule.kind),
            detail: rule.matched
                ? t('identityAdministration.diagnosticsRuleMatched')
                : t('identityAdministration.diagnosticsRuleUnmatched'),
        });
    }

    // Group mappings belong to a Team connection. A provider-scope test has none to evaluate,
    // so the row is absent rather than reporting an empty match.
    if (options.groupMappings) {
        rows.push({
            key: 'mappedGroups',
            title: t('identityAdministration.diagnosticsMappedGroups'),
            detail: !groupsComplete
                ? t('identityAdministration.diagnosticsMappedGroupsUnavailable')
                : diagnostics.mappedGroups.length === 0
                    ? t('identityAdministration.diagnosticsMappedGroupsEmpty')
                    : diagnostics.mappedGroups.map((group) => group.name).join(', '),
        });
    }

    return rows;
}
