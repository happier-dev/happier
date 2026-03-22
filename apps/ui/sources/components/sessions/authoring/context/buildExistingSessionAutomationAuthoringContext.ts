import type { ExistingSessionAuthoringSnapshotSession } from '@/components/sessions/authoring/draft/sessionAuthoringDraftAdapters';
import {
    resolveExistingSessionAuthoringCapabilities,
} from '@/components/sessions/authoring/draft/sessionAuthoringDraftCapabilities';
import type { SessionAuthoringDraft } from '@/components/sessions/authoring/draft/sessionAuthoringDraft';
import type { ExistingSessionAutomationAvailability } from '@/sync/domains/automations/existingSessionAutomationAvailability';

import type { ExistingSessionAutomationAuthoringContext } from './sessionAuthoringContext';
import { buildExistingSessionSnapshotAuthoringContextBase } from './buildExistingSessionSnapshotAuthoringContextBase';

export function buildExistingSessionAutomationAuthoringContext(params: Readonly<{
    session: ExistingSessionAuthoringSnapshotSession;
    draft: SessionAuthoringDraft;
    availability: ExistingSessionAutomationAvailability;
    sessionDekBase64?: string | null;
}>): ExistingSessionAutomationAuthoringContext {
    return {
        kind: 'automationExistingSession',
        draft: params.draft,
        ...buildExistingSessionSnapshotAuthoringContextBase({
            session: params.session,
            sessionDekBase64: params.sessionDekBase64,
        }),
        capabilities: resolveExistingSessionAuthoringCapabilities({
            draft: params.draft,
            availability: params.availability,
        }),
        availability: params.availability,
    };
}
