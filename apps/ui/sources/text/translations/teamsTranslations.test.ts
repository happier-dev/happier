import { describe, expect, it } from 'vitest';

import { auditTranslations, flattenTranslationLeaves } from '../../../tools/i18n/translationAudit';

import { teamsTranslations } from './teamsTranslations';

/**
 * Words whose correct translation genuinely matches English in a specific locale.
 * Listed per locale rather than globally so a locale that must translate the same
 * key (Japanese, Russian, Chinese) is still audited.
 */
const COINCIDENTAL_TRANSLATIONS: Readonly<Record<string, readonly string[]>> = {
    'teams.authentication.directory.actions.section': ['fr'],
    'teams.title': ['de'],
    // "Team" is the German and Italian word for the Team section heading too.
    'teams.overview.teamSection': ['de', 'it'],
    'teams.create.descriptionLabel': ['fr'],
    'teams.create.nameLabel': ['de'],
    'teams.groups.nameLabel': ['de'],
    'teams.invitations.byLink': ['de', 'pl'],
    'teams.invitations.stateActive': ['fr'],
    'teams.members.personLabel': ['de'],
    'teams.tabs.invitations': ['fr'],
    // German Happier keeps the loanword "Sessions"; Catalan spells it the same way.
    'teams.tabs.sessions': ['de', 'ca'],
    // "Token" is the loanword these locales actually use for the AI unit.
    'teams.credentials.limits.metric.tokens': ['es', 'de', 'pt', 'ca'],
    // Catalan spells cost, model and person exactly as English does.
    'teams.credentials.limits.metric.cost': ['ca'],
    'teams.credentials.requestPolicy.modelsLabel': ['ca'],
    'teams.credentials.usage.breakdown.model': ['ca', 'pl'],
    'teams.credentials.usage.breakdown.member': ['de'],
    'teams.credentials.usage.breakdown.session': ['fr'],
    'teams.credentials.limits.subject.member': ['de'],
    'teams.credentials.limits.maximumLabel': ['de', 'fr'],
    // These are the public protocol names exposed by their vendors, not UI prose.
    'teams.credentials.requestPolicy.protocol.openaiResponses': ['fr', 'es', 'de', 'it', 'pt', 'ca', 'pl', 'ru', 'ja', 'zhHans', 'zhHant'],
    'teams.credentials.requestPolicy.protocol.openaiChatCompletions': ['fr', 'es', 'de', 'it', 'pt', 'ca', 'pl', 'ru', 'ja', 'zhHans', 'zhHant'],
    'teams.credentials.requestPolicy.protocol.anthropicMessages': ['fr', 'es', 'de', 'it', 'pt', 'ca', 'pl', 'ru', 'ja', 'zhHans', 'zhHant'],
};

function isCoincidental(locale: string, key: string): boolean {
    return (COINCIDENTAL_TRANSLATIONS[key] ?? []).includes(locale);
}

describe('teamsTranslations', () => {
    it('keeps every Team surface complete and localized in every supported locale', () => {
        const { en, ...localesByCode } = teamsTranslations;
        const locales = Object.entries(localesByCode).map(([code, root]) => ({ code, root }));
        const expectedLeaves = flattenTranslationLeaves(en.teams)
            .map((leaf) => `${leaf.key}:${leaf.kind}`)
            .sort();

        const shapeMismatches = locales.flatMap(({ code, root }) => {
            const actualLeaves = flattenTranslationLeaves(root.teams)
                .map((leaf) => `${leaf.key}:${leaf.kind}`)
                .sort();
            return JSON.stringify(actualLeaves) === JSON.stringify(expectedLeaves)
                ? []
                : [`${code}: Teams translation shape differs from English`];
        });

        const untranslated = Object.values(auditTranslations({ en, locales }))
            .flatMap((report) => report.untranslatedStrings)
            .filter((entry) => entry.key.startsWith('teams.'))
            .filter((entry) => !isCoincidental(entry.locale, entry.key));

        expect(shapeMismatches).toEqual([]);
        expect(untranslated).toEqual([]);
    });

    it('localizes the interpolated Team copy instead of falling back to English', () => {
        const { en, ...localesByCode } = teamsTranslations;
        const sample = { name: 'TEAM_NAME', team: 'TEAM_NAME', home: 'HOME_NAME', count: 3, source: 'SOURCE_NAME' };

        const inherited = Object.entries(localesByCode).flatMap(([code, root]) => [
            root.teams.archive.confirmTitle({ name: sample.name }) === en.teams.archive.confirmTitle({ name: sample.name })
                ? `${code}: teams.archive.confirmTitle falls back to English`
                : null,
            root.teams.join.joinAction({ team: sample.team }) === en.teams.join.joinAction({ team: sample.team })
                ? `${code}: teams.join.joinAction falls back to English`
                : null,
            root.teams.groups.memberCount({ count: sample.count }) === en.teams.groups.memberCount({ count: sample.count })
                ? `${code}: teams.groups.memberCount falls back to English`
                : null,
            root.teams.members.managedBy({ source: sample.source }) === en.teams.members.managedBy({ source: sample.source })
                ? `${code}: teams.members.managedBy falls back to English`
                : null,
        ].filter((failure): failure is string => failure !== null));

        expect(inherited).toEqual([]);
        expect(teamsTranslations.de.teams.authentication.directory.setup.confirmTitle({ source: sample.source }))
            .not.toBe(en.teams.authentication.directory.setup.confirmTitle({ source: sample.source }));
    });

    it('never presents a Team name as an identity key or promises unavailable recovery', () => {
        const { en } = teamsTranslations;

        // Archive copy must state retention and the conditional nature of restore.
        expect(en.teams.archive.confirm.kept).toContain('kept');
        expect(en.teams.archive.confirm.restore).toContain('where it still applies');
        expect(en.teams.archive.restoreBody()).toContain('Revoked invitation links');

        // A lost transferable bearer is never recoverable; only reissue is offered.
        expect(en.teams.invitations.reissueNotice).toContain('stop working');
        expect(en.teams.invitations.bearerUnavailable).not.toContain('Copy');

        // Guest admission must not imply Team-default Session access.
        expect(en.teams.join.guestNotice({ team: 'Acme' })).toContain('does not give access');
    });
});
