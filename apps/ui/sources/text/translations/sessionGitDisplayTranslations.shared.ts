

export const en = {
    settingsLayout: 'Git pane layout',
    settingsShowAs: 'Show changed files as',
    trigger: 'Display options',
    paneGroup: 'Pane',
    changesGroup: 'Changes',
    layout: 'Layout',
    layoutUnified: 'Unified',
    layoutTabs: 'Tabs',
    layoutDescription: 'One scroll from changes to history, or Changes and History as two views.',
    showAs: 'Show as',
    showAsList: 'List',
    showAsTree: 'Tree',
    showAsDescription: 'Changed files as a flat list, or grouped by folder so you can take whole folders at once.',
    density: 'Density',
    densityDefault: 'Default',
    densityCompact: 'Compact',
    note: 'Tree rows are always compact. Remembered for your account.',
    selectFolder: ({ folder }: { folder: string }) => `Select every change in ${folder}`,
    selectFile: ({ file }: { file: string }) => `Select ${file} for the next commit`,
};


export const sessionGitDisplayTranslationsEnglish = { en };