import { t } from '@/text';
import type { ShareSheetAdapter } from '../shareSheetTypes';

/** Sources expose one audience level; repository, Machine and document grants stay independent. */
export function createProjectSourceShareAdapter(): ShareSheetAdapter {
    return {
        namespace: 'project-source-share',
        title: t('projects.sources.audience'),
        levels: {
            // A Source grant lets people open the repository with their own Git account: "Can use", not a document's "Can read".
            view: { label: t('projects.sources.canUse'), help: t('projects.sources.ownCredential') },
            edit: { label: t('shareSheet.documents.levels.canEdit') },
            admin: { label: t('shareSheet.documents.levels.admin') },
        },
        // The Source page already says what its audience can read ("Who can see it"): one message per state.
    };
}
