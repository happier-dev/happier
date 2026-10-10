

export type PersonalHomeRuntimeActionKey = 'installOrUpdateAction' | 'startAction' | 'stopAction';



export type PersonalHomeSettingsCopy = Omit<{ [Key in keyof typeof en]: string }, PersonalHomeRuntimeActionKey>
    & Partial<Record<PersonalHomeRuntimeActionKey, string>>;



export type EraseOutcomeCounts = Readonly<{ removed: number; remaining: number }>;



export type OperationOutcomeCopy = Readonly<{
    erasePartialTitle: string;
    eraseOutcomeSummary: (counts: EraseOutcomeCounts) => string;
    eraseNotPerformed: string;
    eraseBlockedBackupMismatch: string;
    eraseBlockedIdentityUnknown: string;
    eraseVerificationDetail: string;
    operationFailed: string;
    /** The safety copy of the data a restore replaced. */
    restorePreviousDataTitle: string;
}>;



export function pluralPl(count: number, one: string, few: string, many: string): string {
    const lastDigit = count % 10;
    const lastTwoDigits = count % 100;
    if (count === 1) return one;
    if (lastDigit >= 2 && lastDigit <= 4 && (lastTwoDigits < 12 || lastTwoDigits > 14)) return few;
    return many;
}



export function pluralRu(count: number, one: string, few: string, many: string): string {
    const lastDigit = count % 10;
    const lastTwoDigits = count % 100;
    if (lastDigit === 1 && lastTwoDigits !== 11) return one;
    if (lastDigit >= 2 && lastDigit <= 4 && (lastTwoDigits < 12 || lastTwoDigits > 14)) return few;
    return many;
}



export const en = {
    standardOnlyTitle: 'Connect through Home addresses',
    standardOnlySubtitle: 'On this device, use each Home’s address rather than a peer-to-peer connection.',
    defaultHomeLabel: 'Personal Home',
    homeTitle: 'Home',
    canonicalAddress: 'Home address',
    identityComparison: 'Current Home',
    identityComparisonMatch: 'Matches',
    identityComparisonMismatch: 'Doesn’t match',
    identityComparisonUnknown: 'Couldn’t confirm',
    unknownSize: 'Unknown size',
    unknownTimestamp: 'Timestamp unknown',
    restoreBackupTitle: 'Backup',
    identityTitle: 'Home identity',
    identityUnavailable: 'Identity unavailable',
    restoreBackupDate: 'Created',
    restoreCompatibility: 'Compatibility',
    restoreCompatible: 'Compatible',
    restoreCompatibilityVerified: 'Verified by this version',
    restoreBackupSize: 'Size',
    restoreReplacementNotice: 'The current Home data will be replaced. A verified recovery backup will be retained.',
    restoreConfirmTitle: 'Replace and restore this Personal Home?',
    restoreConfirmAction: 'Replace and Restore',
    relocateConfirmTitle: 'Move this Personal Home?',
    relocateConfirmBody: 'Your current Home will be stopped before its verified copy becomes active on the destination.',
    relocateDestination: 'Destination',
    relocateConfirmAction: 'Move Home',
    recoverRestoreTitle: 'Recover interrupted restore?',
    recoverRestoreBody: 'Roll back the interrupted restore using retained recovery material.',
    recoverRestoreAction: 'Recover Restore',
    eraseDataTitle: 'Delete Personal Home data?',
    eraseHomeTarget: 'Home',
    eraseDataBody: 'This is separate from uninstall and permanently deletes only these resolved Home paths:',
    estimatedSize: 'Estimated size',
    summaryTitle: 'Personal Home',
    footer: 'Your Home stays on this computer. These actions do not change another Home.',
    statusTitle: 'Status',
    notAvailable: 'Not available',
    storageTitle: 'Storage',
    masterSecretTitle: 'Home access secret',
    masterSecretPresent: 'Present',
    masterSecretUnavailable: 'Not available',
    inspectAction: 'Refresh Home details',
    actionsTitle: 'Backup & Restore',
    protectionTitle: 'Protection',
    backupsSectionFooter: 'Backups contain readable conversations, Home data, trusted-device state, and the Home access secret. Store them only in a location you trust.',
    lastBackupTitle: 'Last backup',
    lastBackupUnknown: 'Last backup unknown',
    backupsTitle: 'Backup archives',
    backupAction: 'Back Up Now',
    backupSubtitle: 'Creates and verifies a plaintext Home archive.',
    exportBackupAction: 'Export Backup…',
    exportBackupSubtitle: 'Creates a verified backup in a location you choose.',
    verifyAction: 'Verify Backup…',
    verifySubtitle: 'Checks an archive without restoring it.',
    restoreAction: 'Restore…',
    restoreSubtitle: 'Validates a backup before replacing Home data.',
    relocateAction: 'Move Home…',
    relocateSubtitle: 'Move this Home to a managed computer.',
    relocationFinishAction: 'Finish Moving',
    relocationReturnAction: 'Return to Original Home',
    relocationFinishSubtitle: 'Finish moving this Home after the destination is verified.',
    relocationReturnSubtitle: 'Keep the original Home as the active location.',
    recoverRestoreSubtitle: 'An interrupted restore can be rolled back explicitly.',
    restoreRecoveryWarningTitle: 'Restore needs repair',
    restoreRecoveryWarningBody: 'Recovery state is ambiguous. No automatic change will be made. Review diagnostics before repairing this Home.',
    restoreCleanupWarningTitle: 'Restore cleanup needs attention',
    restoreCleanupWarningBody: 'The Home was restored, but automatic cleanup did not finish. Review diagnostics and retry the Home operation.',
    backupVerified: 'Backup verified',
    backupNeedsAttention: 'Backup verified; Home restart needs attention',
    backupHomeReady: 'Home restarted',
    backupRevealAction: 'Reveal backup',
    restoreResultTitle: 'Restore result',
    restoreOutcomeRecoveryRequired: 'Recovery needed',
    restoreOutcomeRolledBack: 'Restore rolled back',
    restoreOutcomeRestored: 'Home restored',
    advancedTitle: 'Advanced',
    advancedFooter: 'Runtime controls and diagnostics for this computer.',
    installOrUpdateAction: 'Install or update Personal Home',
    startAction: 'Start Personal Home',
    stopAction: 'Stop Personal Home',
    restartAction: 'Restart Personal Home',
    openDataLocationAction: 'Open Home data location',
    openLogsAction: 'Open runtime logs',
    removeProfileAction: 'Remove Home from Happier',
    removeProfileSubtitle: 'Removes this profile; runtime data stays on this computer.',
    removeProfileTitle: 'Remove Personal Home profile?',
    removeProfileBody: 'This removes the profile but keeps the runtime and data.',
    uninstallRuntimeAction: 'Uninstall runtime, keep data',
    uninstallRuntimeSubtitle: 'Removes the service and binaries; Home data is preserved.',
    deleteHomeDataTitle: 'Delete Home Data',
    removeSectionFooter: 'Uninstall keeps Home data. Permanent deletion is a separate confirmed action.',
    eraseDataAction: 'Delete Personal Home data permanently',
    eraseDataSubtitle: 'Separate from uninstall. Permanently deletes the resolved Home data.',
    eraseResultTitle: 'Home data deleted',
    eraseStoppedHome: 'Running Home was stopped',
    eraseHomeAlreadyStopped: 'Home was already stopped',
    eraseRemainingPaths: 'Could not remove',
    progressTitle: 'Personal Home operation',
    dismissResult: 'Dismiss',
    repairSearchAction: 'Rebuild Home search',
    repairSearchSubtitle: 'Recreates the search index from this Home’s conversations.',
    repairSearchCompleteTitle: 'Home search rebuilt',
    repairSearchCompleteBody: 'The search index was recreated from this Home’s conversations.',
    backupCleanupRequired: 'Backup is safe; remove the protected staging path shown in Details',
    backupCleanupPath: 'Protected staging path to remove',
    backupCleanupError: 'Cleanup error',
    backupDestinationMismatch: 'The backup was not created at the selected destination. Nothing was erased.',
    backupDestinationUnsafe: 'The selected backup destination is inside the Personal Home data that would be deleted. Nothing was erased.',
    eraseInspectionAttention: 'Home data deleted; verification needs attention',
    searchTitle: 'Search',
    searchReady: 'Ready',
    searchIndexing: 'Indexing…',
    searchUnavailable: 'Unavailable',
    localOnlyIngressTitle: 'Reachable only from this computer',
    localOnlyIngressBody: 'Public shares, provider callbacks, plugin webhooks, and notifications while this computer sleeps stay unavailable until this Home is reachable from outside it.',
} as const;


export const backupDisclosureBodyEnglish = { en: 'This backup contains readable conversations, Home data, the Home access secret, and trusted-device state. Anyone who can restore the complete archive can operate a clone of this Home. Save it somewhere you trust.' } as const;


export const eraseBackupOfferEnglish = { en: { title: 'Back up this Home first?', body: 'Deleting Home data cannot be undone. Create a verified backup first, or continue without one.', continueWithoutBackup: 'Continue without backup' } } as const;


export const operationOutcomeEnglish = { en: {
        erasePartialTitle: 'Some Home data could not be deleted',
        eraseOutcomeSummary: ({ removed, remaining }) => `Removed ${removed} ${removed === 1 ? 'item' : 'items'}`
            + (remaining > 0 ? `; ${remaining} could not be removed` : ''),
        eraseNotPerformed: 'Nothing was deleted',
        eraseBlockedBackupMismatch: 'This backup is from a different Home.',
        eraseBlockedIdentityUnknown: 'Happier couldn’t confirm this backup matches this Home.',
        eraseVerificationDetail: 'Verification',
        operationFailed: 'This Home operation didn’t finish. Open Details to see what happened.',
        restorePreviousDataTitle: 'Previous data saved',
    } } as const satisfies Pick<Record<string, OperationOutcomeCopy>, "en">;


export const personalHomeSettingsTranslationsEnglish = { en: { ...en, ...operationOutcomeEnglish.en, backupDisclosureBody: backupDisclosureBodyEnglish.en, eraseBackupOfferTitle: eraseBackupOfferEnglish.en.title, eraseBackupOfferBody: eraseBackupOfferEnglish.en.body, eraseContinueWithoutBackup: eraseBackupOfferEnglish.en.continueWithoutBackup } } as const;
