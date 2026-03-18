import type { Session } from '@/sync/domains/state/storageTypes';

import type { SessionAuthoringDraft } from '../draft/sessionAuthoringDraft';

export type NewSessionAuthoringSubmissionMode = 'launch' | 'createAutomation' | 'editAutomation';
export type NewSessionSubmitAccessibilityLabelKey =
    | 'automations.create.createButtonTitle'
    | 'automations.edit.saveAutomationLabel';

export type NewSessionAuthoringContext = Readonly<{
    kind: 'newSession';
    draft: SessionAuthoringDraft;
    effectiveAutomationDraft: NonNullable<SessionAuthoringDraft['automation']>;
    showAutomationActionChips: boolean;
    canSubmit: boolean;
    submissionMode: NewSessionAuthoringSubmissionMode;
    submitAccessibilityLabelKey?: NewSessionSubmitAccessibilityLabelKey;
}>;

export type ExistingSessionAutomationAvailability = Readonly<
    | {
        kind: 'hydrating';
    }
    | {
        kind: 'blocked';
        reason: 'session_not_found' | 'machine_id_missing' | 'resume_key_missing' | 'session_not_eligible';
    }
    | {
        kind: 'ready';
        machineId: string;
    }
>;

export type ExistingSessionAutomationAuthoringContext = Readonly<{
    kind: 'automationExistingSession';
    session: Session;
    draft: SessionAuthoringDraft;
    availability: ExistingSessionAutomationAvailability;
}>;

export type SessionAuthoringContext = NewSessionAuthoringContext | ExistingSessionAutomationAuthoringContext;

