type LocaleCopyShape<T> = T extends string ? string : T extends (...args: infer Args) => infer Result ? (...args: Args) => Result : T extends object ? { [Key in keyof T]: LocaleCopyShape<T[Key]> } : T;
declare const localizedPluginAccountReleaseSelectionTranslations: Record<"ca" | "de" | "es" | "fr" | "it" | "ja" | "pl" | "pt" | "ru" | "zh-Hans" | "zh-Hant", LocaleCopyShape<typeof localizedPluginAccountReleaseSelectionTranslationsEnglish.en>>;



export function completeReleaseSelection(value: typeof localizedPluginAccountReleaseSelectionTranslations[keyof typeof localizedPluginAccountReleaseSelectionTranslations]) {
    return { accountReleaseSelection: { ...english.accountReleaseSelection, ...value.accountReleaseSelection } };
}



export const english = {
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
        hostedGroupFooter: 'Manage the plugin artifacts this Account hosts for the plugin. No machine currently offers this release, so it cannot be selected here.',
        hostedEnableTitle: 'Host plugin artifacts for this Account',
        hostedEnableBody: "Store this plugin’s UI and packaged assets on your Account server. For plaintext Accounts, the server can read the bytes; for E2EE Accounts, it stores encrypted bytes. Release metadata remains visible. This does not install or trust the plugin, or make machine execution available offline.",
        hostedDisableTitle: 'Stop hosting plugin artifacts',
        hostedStatusDisabled: "Disabled. Enable hosting to download this release’s artifacts while its source machine is offline.",
        hostedStatusPending: 'Enabled. This release is waiting for the host to publish its exact plugin artifacts.',
        hostedStatusReady: 'Hosted plugin artifacts are available for this exact release.',
        hostedRemoveTitle: 'Disable and remove hosted artifacts',
        hostedRemoveBody: 'Stops Account hosting and removes the exact hosted plugin artifacts for this release. Local cache cleanup is separate.',
        hostedClearCacheTitle: 'Clear local artifact cache',
        hostedClearCacheBody: 'Removes locally cached UI artifact bytes for this exact release without changing Account hosting.',
    },
} as const;


export const localizedPluginAccountReleaseSelectionTranslationsEnglish = { en: english } as const;


export const pluginAccountReleaseSelectionTranslationsEnglish = { en: completeReleaseSelection(localizedPluginAccountReleaseSelectionTranslationsEnglish.en) };