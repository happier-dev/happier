import * as React from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import { preloadTranslations, setPreferredLanguageFromSettings, t } from '@/text';
import { installApprovalCommonModuleMocks } from './approvalsTestHelpers';
import { SETTINGS_DECLARATION_ACTION_IDS_V1 } from '@happier-dev/protocol/actions/settingsDeclarationActionFamily';

installApprovalCommonModuleMocks({ text: () => vi.importActual<typeof import('@/text')>('@/text') });
const { ActionApprovalFieldsCard } = await import('./ActionApprovalFieldsCard');
const { describeApprovalActionFields } = await import('./approvalFieldValues');
const { getActionSpec } = await import('@happier-dev/protocol/actions/actionSpecs');
afterEach(() => { standardCleanup(); setPreferredLanguageFromSettings('en'); });

it('reads public-link choices and boolean labels from the real declaration in French', async () => {
    await preloadTranslations('fr');
    setPreferredLanguageFromSettings('fr');
    for (const input of [
        { artifactId: 'document', audience: 'anonymous', isConsentRequired: true, networkOff: false },
        { artifactId: 'document', audience: 'signed_in', preserveExisting: true },
    ]) {
        const presentation = describeApprovalActionFields({ actionId: 'artifact.public_link.create',
            actionArgs: getActionSpec('artifact.public_link.create').inputSchema.parse(input) });
        const screen = await renderScreen(<ActionApprovalFieldsCard presentation={presentation} />);
        try {
            const text = screen.getTextContent();
            expect(text).not.toContain(input.audience);
            expect(text).not.toContain('Is consent required');
            expect(text).not.toContain('Network off');
            expect(text).not.toContain('Preserve existing');
            expect(text).toContain(t('approvals.publicLinkFields.audience'));
            expect(text).toContain(t(input.audience === 'anonymous'
                ? 'approvals.publicLinkFields.anonymous' : 'approvals.publicLinkFields.signedIn'));
            expect(text).toContain(t(input.audience === 'anonymous'
                ? 'approvals.publicLinkFields.consent' : 'approvals.publicLinkFields.preserveExisting'));
            if (input.audience === 'anonymous') expect(text).toContain(t('approvals.publicLinkFields.networkOff'));
            expect(text).toContain(t('common.yes'));
        } finally { await screen.unmount(); }
    }
});

it('preserves unknown setting identifiers and their declared code format through every setting Action', async () => {
    for (const id of SETTINGS_DECLARATION_ACTION_IDS_V1.filter(id => getActionSpec(id).inputHints?.fields.some(field => field.path === 'anchor'))) {
        const presentation = describeApprovalActionFields({ actionId: id,
            actionArgs: getActionSpec(id).inputSchema.parse({ anchor: 'unknown.setting',
                ...(id === 'settings.set' ? { value: false } : {}) }) });
        expect(presentation.rows).toContainEqual(expect.objectContaining({ path: 'anchor',
            value: 'unknown.setting', valueFormat: 'code' }));
        for (const anatomy of ['card', 'page'] as const) {
            const screen = await renderScreen(<ActionApprovalFieldsCard anatomy={anatomy} presentation={presentation} />);
            try { expect(screen.getTextContent()).toContain('unknown.setting'); }
            finally { await screen.unmount(); }
        }
    }
});

it.each(['notifications.quietHoursAccount', 'notifications.quietHours'])('names setting or section %s through its page label owner', async anchor => {
    const { builtInSettingUiDeclaration } = await import('@/components/settings/catalog/settingDeclarations');
    const { NOTIFICATIONS_SETTINGS } = await import('@/components/settings/notifications/notificationsSettings');
    await preloadTranslations('fr');
    setPreferredLanguageFromSettings('fr');
    const titleKey = anchor === 'notifications.quietHours'
        ? NOTIFICATIONS_SETTINGS.sections.quietHours.titleKey!
        : builtInSettingUiDeclaration(anchor).titleKey;
    for (const id of SETTINGS_DECLARATION_ACTION_IDS_V1.filter(id => getActionSpec(id).inputHints?.fields.some(field => field.path === 'anchor'))) {
        const presentation = describeApprovalActionFields({ actionId: id,
            actionArgs: getActionSpec(id).inputSchema.parse({ anchor, ...(id === 'settings.set' ? { value: false } : {}) }) });
        for (const anatomy of ['card', 'page'] as const) {
            const screen = await renderScreen(<ActionApprovalFieldsCard anatomy={anatomy} presentation={presentation} />);
            try { expect(screen.getTextContent()).toContain(t(titleKey)); }
            finally { await screen.unmount(); }
        }
    }
});

it('shows the declared document sort label instead of its enum token', async () => {
    await preloadTranslations('fr');
    setPreferredLanguageFromSettings('fr');
    const presentation = describeApprovalActionFields({ actionId: 'artifact.list',
        actionArgs: getActionSpec('artifact.list').inputSchema.parse({ sort: 'updated_desc' }) });
    const screen = await renderScreen(<ActionApprovalFieldsCard anatomy="page" presentation={presentation} />);
    expect(screen.getTextContent()).toContain(t('artifacts.browser.sort.updated_desc'));
    expect(screen.getTextContent()).not.toContain('updated_desc');
    await screen.unmount();
});

it('localizes declared choices and explicit clears inside a structured review', async () => {
    await preloadTranslations('fr');
    setPreferredLanguageFromSettings('fr');
    const screen = await renderScreen(<ActionApprovalFieldsCard anatomy="page" presentation={{
        rows: [{ kind: 'value', path: 'operation', title: 'Operation', value: '{}', entries: [
            { label: 'Protocol', value: 'Readable protocol', depth: 0,
                selectedOptions: [{ label: 'Readable protocol', labelKey: 'common.yes' }] },
            { label: 'Placement', value: 'null', depth: 0, valueFormat: 'clear' },
        ] }], unrepresentable: null,
    }} />);
    try {
        expect(screen.getTextContent()).toContain(t('common.yes'));
        expect(screen.getTextContent()).toContain(t('approvals.clearsField', { field: 'Placement' }));
        expect(screen.getTextContent()).not.toContain('Readable protocol');
    } finally { await screen.unmount(); }
});
