import { t } from '@/text';
import type { AgentInputControlPlacement } from '@/components/sessions/agentInput/controls/agentInputControlTypes';

export const NEW_SESSION_TRIGGERS_CHIP_KEY = 'new-session-triggers';

export function getNewSessionCheckoutActionChipPlacement(): AgentInputControlPlacement {
    return { id: 'checkout', title: t('newSession.sessionType.worktree'), icon: 'stack-simple' };
}

export function getNewSessionOrganizationActionChipPlacement(id: 'organization' | 'tags', options?: Readonly<{ chosen?: boolean }>): AgentInputControlPlacement {
    // A chosen section (New session here) shows on the rail by default; otherwise it waits in the overflow.
    return id === 'organization'
        ? { id, title: t('sessionsList.sectionTitle'), icon: 'list', defaultPlacement: options?.chosen ? 'pinned' : 'overflow' }
        : { id, title: t('settingsSession.sessionList.tagsTitle'), icon: 'tag', defaultPlacement: 'hidden' };
}

/** The space a new session starts in, a second organization placement beside its section. */
export const NEW_SESSION_SPACE_CHIP_KEY = 'new-session-space';
export function getNewSessionSpaceActionChipPlacement(options?: Readonly<{ chosen?: boolean }>): AgentInputControlPlacement {
    // Like a section: a captured space (New from a space) shows on the rail; otherwise it waits in the overflow.
    return { id: `organization:${NEW_SESSION_SPACE_CHIP_KEY}`, title: t('sessionsList.spacesPickerTitle'), icon: 'squares-four',
        defaultPlacement: options?.chosen ? 'pinned' : 'overflow' };
}

export function getNewSessionTriggersActionChipPlacement(): AgentInputControlPlacement {
    return { id: `automation:${NEW_SESSION_TRIGGERS_CHIP_KEY}`, title: t('workflows.triggers.section.title'), icon: 'lightning', defaultPlacement: 'overflow' };
}
