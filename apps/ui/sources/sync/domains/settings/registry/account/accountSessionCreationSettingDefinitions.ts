/**
 * Compatibility exports for UI presentation code. Account-backed settings are owned directly by
 * the Protocol catalog; the one remembered picker view is device-local.
 */
export {
    NEW_SESSION_DRAFT_ENTRY_MODES,
    NEW_SESSION_AFTER_SEND_MODES,
    NEW_SESSION_PRESENTATION_MODES,
    NEW_SESSION_BACKDROP_STRENGTHS,
    NEW_SESSION_WIZARD_SECTION_PRESENTATIONS,
    NEW_SESSION_WIZARD_SELECTION_SECTION_IDS,
    resolveNewSessionWizardSectionPresentation,
    type NewSessionDraftEntryMode,
    type NewSessionAfterSendMode,
    type NewSessionPresentationModeV1,
    type NewSessionBackdropStrengthV1,
    type NewSessionWizardSectionPresentation,
    type NewSessionWizardSelectionSectionId,
} from '@happier-dev/protocol/account/settings/accountSettings';

export {
    NewSessionAgentPickerViewV1Schema,
    type NewSessionAgentPickerViewV1,
} from '@/sync/domains/state/newSessionInteractionSchemas';
