const english = {
    accountReleaseSelection: {
        groupTitle: 'Account release',
        groupFooter: 'Select an exact release for this Account. This does not install, update, or trust the plugin on any machine.',
        entryTitle: 'Use for this Account',
        entrySubtitle: ({ version }: { version: string }) => `Select version ${version} for the current Account without changing any machine installation.`,
        selectedTitle: 'Account release selected',
        selectedBody: 'The selected plugin release will now be used for this Account.',
        conflictTitle: 'Account release changed',
        conflictBody: 'The Account release changed while this action was open. Reopen it and try again.',
        unavailableTitle: 'Account release unavailable',
        unavailableBody: 'The exact release or its required migration source is unavailable for the current Account. Try again when the Account is ready.',
        rejectedTitle: 'Account release was not selected',
        rejectedBody: 'The Account did not accept this release selection. Check the Account state and try again.',
    },
} as const;

// These values intentionally fall back to the English source copy until the
// localization pipeline supplies reviewed translations. The complete shape is
// still present in every locale, so this Account-only action never renders a
// raw key or machine-management wording.
export const pluginAccountReleaseSelectionTranslations = {
    en: english,
    fr: english,
    ru: english,
    pl: english,
    es: english,
    it: english,
    pt: english,
    ca: english,
    'zh-Hans': english,
    'zh-Hant': english,
    ja: english,
} as const;
