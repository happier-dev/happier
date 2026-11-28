import { t, type TranslationKeyNoParams } from '@/text';
import { getSessionName } from '@/utils/sessions/sessionUtils';
import type { SessionActionTarget } from './sessionActionTypes';

import { SESSION_ACTION_METADATA } from '@happier-dev/protocol/sessions/actions/sessionActionMetadata';
import { SESSION_BULK_ACTION_IDS } from './sessionBulkActionTypes';
import type { IconName } from '@/components/ui/icons/Icon';
import type { SessionHeaderMenuGroup } from './sessionHeaderMenuGroups';

export type SessionActionIconName = IconName;

export type SessionActionMetadata = Readonly<{
    titleKey: TranslationKeyNoParams | 'bots.talk';
    subtitleKey?: TranslationKeyNoParams;
    icon: SessionActionIconName;
    /** Where the operation sits in the session's ⋯ menu. */
    group: SessionHeaderMenuGroup;
    /**
     * The operation cannot be undone (Delete). It alone takes the danger tone and asks first; an
     * operation a person can reverse in one press (Archive, Stop, Stop managing) never does
     * (DESIGN.md: destructive treatment only for irreversible consequences).
     */
    irreversible?: true;
}>;

const METADATA_BY_ACTION_ID: Readonly<Record<string, SessionActionMetadata>> = {
    ...SESSION_ACTION_METADATA,
    [SESSION_BULK_ACTION_IDS.tagsAdd]: {
        titleKey: 'sessionsList.selectionAddTags',
        icon: 'tag', group: 'session',
    },
    [SESSION_BULK_ACTION_IDS.tagsRemove]: {
        titleKey: 'sessionsList.selectionRemoveTags',
        icon: 'tag', group: 'session',
    },
    [SESSION_BULK_ACTION_IDS.tagsSet]: {
        titleKey: 'sessionsList.selectionSetTags',
        icon: 'tag', group: 'session',
    },
};

export function getSessionActionMetadata(actionId: string): SessionActionMetadata | null {
    return METADATA_BY_ACTION_ID[actionId] ?? null;
}

export function resolveSessionActionTitle(metadata: SessionActionMetadata, target?: SessionActionTarget): string {
    return metadata.titleKey === 'bots.talk'
        ? t('bots.talk', { name: target ? getSessionName(target.session, target.serverId) : t('session.folderless.untitledChat') })
        : t(metadata.titleKey);
}
