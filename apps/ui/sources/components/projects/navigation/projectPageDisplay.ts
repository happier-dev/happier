import type { IconName } from '@/components/ui/icons/Icon';
import type { ProjectPageV1 } from '@/components/workspaceCockpit/project/projectCockpitState';
import { t } from '@/text';

const PAGE_GLYPHS: Readonly<Record<ProjectPageV1, IconName>> = {
    overview: 'list-bullets', code: 'code', changes: 'git-branch', scripts: 'play',
    services: 'hard-drives', deployments: 'rocket-launch', context: 'stack', memory: 'book-bookmark',
};

export function projectPageGlyph(page: ProjectPageV1): IconName {
    return PAGE_GLYPHS[page];
}

export function projectPageLabel(page: ProjectPageV1): string {
    switch (page) {
        case 'overview': return t('projects.pages.overview');
        case 'code': return t('projects.pages.code');
        case 'changes': return t('projects.pages.changes');
        case 'scripts': return t('projects.pages.scripts');
        case 'services': return t('projects.pages.services');
        case 'deployments': return t('projects.pages.deployments');
        case 'context': return t('projects.pages.context');
        case 'memory': return t('projects.pages.memory');
    }
}
