import type { ExistingSessionAuthoringCapabilities } from '@/components/sessions/authoring/draft/sessionAuthoringDraftCapabilities';
import type { ExistingSessionAuthoringSnapshotSession } from '@/components/sessions/authoring/draft/sessionAuthoringDraftAdapters';
import type { SessionAuthoringDraft } from '@/components/sessions/authoring/draft/sessionAuthoringDraft';
import type { NewSessionAutomationDraft } from '@/sync/domains/automations/automationDraft';
import type { ExistingSessionAutomationAvailability } from '@/sync/domains/automations/existingSessionAutomationAvailability';
import type { SessionAuthoringSnapshot } from '@/sync/domains/sessionAuthoring/sessionAuthoringSnapshot';

export type NewSessionAuthoringSubmissionMode = 'launch' | 'createAutomation' | 'editAutomation';
export type NewSessionSubmitAccessibilityLabelKey =
    | 'automations.create.createButtonTitle'
    | 'automations.edit.saveAutomationLabel';

export type NewSessionAuthoringContext = Readonly<{
    kind: 'newSession';
    draft: SessionAuthoringDraft;
    effectiveAutomationDraft: NewSessionAutomationDraft;
    showAutomationActionChips: boolean;
    canSubmit: boolean;
    submissionMode: NewSessionAuthoringSubmissionMode;
    submitAccessibilityLabelKey?: NewSessionSubmitAccessibilityLabelKey;
}>;

export type ExistingSessionAutomationAuthoringContext = Readonly<{
    kind: 'automationExistingSession';
    session: ExistingSessionAuthoringSnapshotSession;
    draft: SessionAuthoringDraft;
    snapshot: SessionAuthoringSnapshot;
    capabilities: ExistingSessionAuthoringCapabilities;
    availability: ExistingSessionAutomationAvailability;
}>;

export type LiveSessionAuthoringContext = Readonly<{
    kind: 'liveSession';
    session: ExistingSessionAuthoringSnapshotSession;
    snapshot: SessionAuthoringSnapshot;
}>;

export type SessionAuthoringContext =
    | NewSessionAuthoringContext
    | ExistingSessionAutomationAuthoringContext
    | LiveSessionAuthoringContext;
