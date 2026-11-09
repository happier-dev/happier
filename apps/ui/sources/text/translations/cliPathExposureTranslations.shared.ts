

export const en = {
    title: 'Command line',
    footer: "Happier Desktop only changes PATH entries it created; shell installer entries stay untouched.",
    cleanupTitle: "Remove Desktop components",
    cleanupSubtitle: "Clean up Desktop-owned command line and background services, then quit.",
    cleanupConfirmTitle: "Remove Desktop components and quit?",
    cleanupConfirmBody: "This removes command line files, PATH entries and background services owned by Desktop when no other Desktop app needs them. Shared and user-installed components are kept. Sessions and account data are kept.\n\nDesktop will quit after cleanup. Then remove the app using your operating system; on macOS or portable Linux, remove the app bundle or file. Opening Desktop again may set up its components again.",
    cleanupConfirmAction: "Remove components and quit",
    cleanupBusy: "Removing Desktop components…",
    cleanupFailed: "Cleanup did not finish. Try again.",
    cleanupQuitFailed: "Cleanup finished, but Desktop could not quit. Quit the app before removing it.",
    addTitle: 'Add happier to PATH',
    addSubtitle: 'Make the happier command available in new terminals.',
    removeTitle: 'Remove happier from PATH',
    removeSubtitle: 'Removes only the PATH entries Happier Desktop added.',
    working: 'Updating your shell profile…',
    added: 'Added. Open a new terminal to use happier.',
    alreadyPresent: 'happier is already on your PATH.',
    removed: 'Removed the PATH entries Happier Desktop added.',
    nothingToRemove: 'Happier Desktop has not added any PATH entries.',
};


export const cliPathExposureTranslationsEnglish = { en: en };