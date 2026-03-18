import type { ExistingSessionAutomationAvailability } from './sessionAuthoringContext';
import type { SessionAuthoringDraft } from '../draft/sessionAuthoringDraft';
import type { Session } from '@/sync/domains/state/storageTypes';

import type { ExistingSessionAutomationAuthoringContext } from './sessionAuthoringContext';

export function buildExistingSessionAutomationAuthoringContext(params: Readonly<{
    session: Session;
    draft: SessionAuthoringDraft;
    availability: ExistingSessionAutomationAvailability;
}>): ExistingSessionAutomationAuthoringContext {
    return {
        kind: 'automationExistingSession',
        session: params.session,
        draft: params.draft,
        availability: params.availability,
    };
}

