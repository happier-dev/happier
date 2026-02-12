import type { ScmBackendSettingsPlugin } from '@/scm/settings/scmBackendSettingsPlugin';

export const gitScmBackendSettingsPlugin: ScmBackendSettingsPlugin = {
    backendId: 'git',
    title: 'Git',
    description: 'Git supports index-based include/exclude and partial line selection when Git staging mode is enabled.',
    infoItems: [
        {
            id: 'commitModel',
            title: 'Change-set model',
            subtitle: 'Uses the Git index (included vs pending) when Git staging is enabled.',
            iconName: 'layers-outline',
        },
        {
            id: 'partialSelection',
            title: 'Partial selection',
            subtitle: 'File and line-level include/exclude are available only in Git staging mode.',
            iconName: 'cut-outline',
        },
    ],
};
