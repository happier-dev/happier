import type { ScmBackendSettingsPlugin } from '@/scm/settings/scmBackendSettingsPlugin';

export const saplingScmBackendSettingsPlugin: ScmBackendSettingsPlugin = {
    backendId: 'sapling',
    title: 'Sapling',
    description: 'Sapling uses native working-copy semantics. Include/exclude controls are not exposed in the UI.',
    infoItems: [
        {
            id: 'commitModel',
            title: 'Change-set model',
            subtitle: 'Commits operate on pending working-copy changes using Sapling-native semantics.',
            iconName: 'git-branch-outline',
        },
        {
            id: 'partialSelection',
            title: 'Partial selection',
            subtitle: 'Line/file include-exclude controls are hidden for Sapling backends.',
            iconName: 'eye-off-outline',
        },
    ],
};
