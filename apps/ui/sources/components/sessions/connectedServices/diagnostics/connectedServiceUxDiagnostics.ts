import {
    CONNECTED_SERVICE_UX_DIAGNOSTIC_ACTIONS,
    CONNECTED_SERVICE_UX_DIAGNOSTIC_CODES,
    ConnectedServiceUxDiagnosticV1Schema,
    type ConnectedServiceUxDiagnosticCodeV1,
    type ConnectedServiceUxDiagnosticSuggestedActionV1,
    type ConnectedServiceUxDiagnosticV1,
} from '@happier-dev/protocol';

import type { TranslationKey } from '@/text';

type DiagnosticTitleKey = Extract<
    TranslationKey,
    `connectedServices.diagnostics.title.${ConnectedServiceUxDiagnosticCodeV1}`
>;

type DiagnosticBodyKey = Extract<
    TranslationKey,
    `connectedServices.diagnostics.body.${ConnectedServiceUxDiagnosticCodeV1}`
>;

type DiagnosticStatusKey = Extract<
    TranslationKey,
    `connectedServices.diagnostics.status.${ConnectedServiceUxDiagnosticCodeV1}`
>;

const DIAGNOSTIC_TITLE_KEYS = {
    [CONNECTED_SERVICE_UX_DIAGNOSTIC_CODES.providerSessionStateUnavailableForResume]:
        'connectedServices.diagnostics.title.provider_session_state_unavailable_for_resume',
    [CONNECTED_SERVICE_UX_DIAGNOSTIC_CODES.connectedServiceMaterializationIdentityMissing]:
        'connectedServices.diagnostics.title.connected_service_materialization_identity_missing',
    [CONNECTED_SERVICE_UX_DIAGNOSTIC_CODES.resumeReachabilityInputsMissing]:
        'connectedServices.diagnostics.title.resume_reachability_inputs_missing',
    [CONNECTED_SERVICE_UX_DIAGNOSTIC_CODES.metadataUpdateFailed]:
        'connectedServices.diagnostics.title.metadata_update_failed',
    [CONNECTED_SERVICE_UX_DIAGNOSTIC_CODES.noEligibleGroupMember]:
        'connectedServices.diagnostics.title.no_eligible_group_member',
    [CONNECTED_SERVICE_UX_DIAGNOSTIC_CODES.recoveryRetryScheduled]:
        'connectedServices.diagnostics.title.recovery_retry_scheduled',
    [CONNECTED_SERVICE_UX_DIAGNOSTIC_CODES.recoveryDeadLettered]:
        'connectedServices.diagnostics.title.recovery_dead_lettered',
    [CONNECTED_SERVICE_UX_DIAGNOSTIC_CODES.providerAccountAdoptionMismatch]:
        'connectedServices.diagnostics.title.provider_account_adoption_mismatch',
    [CONNECTED_SERVICE_UX_DIAGNOSTIC_CODES.postSwitchVerificationFailed]:
        'connectedServices.diagnostics.title.post_switch_verification_failed',
    [CONNECTED_SERVICE_UX_DIAGNOSTIC_CODES.connectedServiceCredentialReconnectRequired]:
        'connectedServices.diagnostics.title.connected_service_credential_reconnect_required',
    [CONNECTED_SERVICE_UX_DIAGNOSTIC_CODES.connectedServiceCredentialRefreshUnavailable]:
        'connectedServices.diagnostics.title.connected_service_credential_refresh_unavailable',
    [CONNECTED_SERVICE_UX_DIAGNOSTIC_CODES.claudeSubscriptionMissingClaudeCodeScope]:
        'connectedServices.diagnostics.title.claude_subscription_missing_claude_code_scope',
    [CONNECTED_SERVICE_UX_DIAGNOSTIC_CODES.claudeSubscriptionNativeAuthMaterializationFailed]:
        'connectedServices.diagnostics.title.claude_subscription_native_auth_materialization_failed',
    [CONNECTED_SERVICE_UX_DIAGNOSTIC_CODES.claudeSubscriptionSetupTokenNotSupportedForUnified]:
        'connectedServices.diagnostics.title.claude_subscription_setup_token_not_supported_for_unified',
} satisfies Record<ConnectedServiceUxDiagnosticCodeV1, DiagnosticTitleKey>;

const DIAGNOSTIC_BODY_KEYS = {
    [CONNECTED_SERVICE_UX_DIAGNOSTIC_CODES.providerSessionStateUnavailableForResume]:
        'connectedServices.diagnostics.body.provider_session_state_unavailable_for_resume',
    [CONNECTED_SERVICE_UX_DIAGNOSTIC_CODES.connectedServiceMaterializationIdentityMissing]:
        'connectedServices.diagnostics.body.connected_service_materialization_identity_missing',
    [CONNECTED_SERVICE_UX_DIAGNOSTIC_CODES.resumeReachabilityInputsMissing]:
        'connectedServices.diagnostics.body.resume_reachability_inputs_missing',
    [CONNECTED_SERVICE_UX_DIAGNOSTIC_CODES.metadataUpdateFailed]:
        'connectedServices.diagnostics.body.metadata_update_failed',
    [CONNECTED_SERVICE_UX_DIAGNOSTIC_CODES.noEligibleGroupMember]:
        'connectedServices.diagnostics.body.no_eligible_group_member',
    [CONNECTED_SERVICE_UX_DIAGNOSTIC_CODES.recoveryRetryScheduled]:
        'connectedServices.diagnostics.body.recovery_retry_scheduled',
    [CONNECTED_SERVICE_UX_DIAGNOSTIC_CODES.recoveryDeadLettered]:
        'connectedServices.diagnostics.body.recovery_dead_lettered',
    [CONNECTED_SERVICE_UX_DIAGNOSTIC_CODES.providerAccountAdoptionMismatch]:
        'connectedServices.diagnostics.body.provider_account_adoption_mismatch',
    [CONNECTED_SERVICE_UX_DIAGNOSTIC_CODES.postSwitchVerificationFailed]:
        'connectedServices.diagnostics.body.post_switch_verification_failed',
    [CONNECTED_SERVICE_UX_DIAGNOSTIC_CODES.connectedServiceCredentialReconnectRequired]:
        'connectedServices.diagnostics.body.connected_service_credential_reconnect_required',
    [CONNECTED_SERVICE_UX_DIAGNOSTIC_CODES.connectedServiceCredentialRefreshUnavailable]:
        'connectedServices.diagnostics.body.connected_service_credential_refresh_unavailable',
    [CONNECTED_SERVICE_UX_DIAGNOSTIC_CODES.claudeSubscriptionMissingClaudeCodeScope]:
        'connectedServices.diagnostics.body.claude_subscription_missing_claude_code_scope',
    [CONNECTED_SERVICE_UX_DIAGNOSTIC_CODES.claudeSubscriptionNativeAuthMaterializationFailed]:
        'connectedServices.diagnostics.body.claude_subscription_native_auth_materialization_failed',
    [CONNECTED_SERVICE_UX_DIAGNOSTIC_CODES.claudeSubscriptionSetupTokenNotSupportedForUnified]:
        'connectedServices.diagnostics.body.claude_subscription_setup_token_not_supported_for_unified',
} satisfies Record<ConnectedServiceUxDiagnosticCodeV1, DiagnosticBodyKey>;

const DIAGNOSTIC_STATUS_KEYS = {
    [CONNECTED_SERVICE_UX_DIAGNOSTIC_CODES.providerSessionStateUnavailableForResume]:
        'connectedServices.diagnostics.status.provider_session_state_unavailable_for_resume',
    [CONNECTED_SERVICE_UX_DIAGNOSTIC_CODES.connectedServiceMaterializationIdentityMissing]:
        'connectedServices.diagnostics.status.connected_service_materialization_identity_missing',
    [CONNECTED_SERVICE_UX_DIAGNOSTIC_CODES.resumeReachabilityInputsMissing]:
        'connectedServices.diagnostics.status.resume_reachability_inputs_missing',
    [CONNECTED_SERVICE_UX_DIAGNOSTIC_CODES.metadataUpdateFailed]:
        'connectedServices.diagnostics.status.metadata_update_failed',
    [CONNECTED_SERVICE_UX_DIAGNOSTIC_CODES.noEligibleGroupMember]:
        'connectedServices.diagnostics.status.no_eligible_group_member',
    [CONNECTED_SERVICE_UX_DIAGNOSTIC_CODES.recoveryRetryScheduled]:
        'connectedServices.diagnostics.status.recovery_retry_scheduled',
    [CONNECTED_SERVICE_UX_DIAGNOSTIC_CODES.recoveryDeadLettered]:
        'connectedServices.diagnostics.status.recovery_dead_lettered',
    [CONNECTED_SERVICE_UX_DIAGNOSTIC_CODES.providerAccountAdoptionMismatch]:
        'connectedServices.diagnostics.status.provider_account_adoption_mismatch',
    [CONNECTED_SERVICE_UX_DIAGNOSTIC_CODES.postSwitchVerificationFailed]:
        'connectedServices.diagnostics.status.post_switch_verification_failed',
    [CONNECTED_SERVICE_UX_DIAGNOSTIC_CODES.connectedServiceCredentialReconnectRequired]:
        'connectedServices.diagnostics.status.connected_service_credential_reconnect_required',
    [CONNECTED_SERVICE_UX_DIAGNOSTIC_CODES.connectedServiceCredentialRefreshUnavailable]:
        'connectedServices.diagnostics.status.connected_service_credential_refresh_unavailable',
    [CONNECTED_SERVICE_UX_DIAGNOSTIC_CODES.claudeSubscriptionMissingClaudeCodeScope]:
        'connectedServices.diagnostics.status.claude_subscription_missing_claude_code_scope',
    [CONNECTED_SERVICE_UX_DIAGNOSTIC_CODES.claudeSubscriptionNativeAuthMaterializationFailed]:
        'connectedServices.diagnostics.status.claude_subscription_native_auth_materialization_failed',
    [CONNECTED_SERVICE_UX_DIAGNOSTIC_CODES.claudeSubscriptionSetupTokenNotSupportedForUnified]:
        'connectedServices.diagnostics.status.claude_subscription_setup_token_not_supported_for_unified',
} satisfies Record<ConnectedServiceUxDiagnosticCodeV1, DiagnosticStatusKey>;

export type ConnectedServiceUxDiagnosticPresentationAction = Readonly<{
    kind: ConnectedServiceUxDiagnosticSuggestedActionV1;
    labelKey: TranslationKey;
}>;

export type ConnectedServiceUxDiagnosticPresentation = Readonly<{
    code: ConnectedServiceUxDiagnosticV1['code'];
    titleKey: DiagnosticTitleKey;
    bodyKey: DiagnosticBodyKey;
    statusKey: DiagnosticStatusKey;
    actions: ReadonlyArray<ConnectedServiceUxDiagnosticPresentationAction>;
}>;

function labelKeyForAction(action: ConnectedServiceUxDiagnosticSuggestedActionV1): TranslationKey {
    switch (action) {
        case CONNECTED_SERVICE_UX_DIAGNOSTIC_ACTIONS.retry:
            return 'common.retry';
        case CONNECTED_SERVICE_UX_DIAGNOSTIC_ACTIONS.startFreshUnderSelectedAccount:
            return 'newSession.connectedServiceSwitchUnavailable.startFreshAction';
        case CONNECTED_SERVICE_UX_DIAGNOSTIC_ACTIONS.openConnectedAccounts:
            return 'connectedServices.title';
        case CONNECTED_SERVICE_UX_DIAGNOSTIC_ACTIONS.reconnectProfile:
            return 'connectedServices.detail.actions.reconnect';
        case CONNECTED_SERVICE_UX_DIAGNOSTIC_ACTIONS.enableStateSharing:
            return 'connectedServices.providerStateSharing.title';
        case CONNECTED_SERVICE_UX_DIAGNOSTIC_ACTIONS.resumeCurrentAccount:
            return 'common.continue';
        case CONNECTED_SERVICE_UX_DIAGNOSTIC_ACTIONS.viewLatestFork:
            return 'connectedServices.diagnostics.actions.viewLatestFork';
        case CONNECTED_SERVICE_UX_DIAGNOSTIC_ACTIONS.viewNativeFork:
            return 'connectedServices.diagnostics.actions.viewNativeFork';
        case CONNECTED_SERVICE_UX_DIAGNOSTIC_ACTIONS.dismiss:
            return 'common.cancel';
    }
}

export function resolveConnectedServiceUxDiagnosticPresentation(
    value: unknown,
): ConnectedServiceUxDiagnosticPresentation | null {
    const parsed = ConnectedServiceUxDiagnosticV1Schema.safeParse(value);
    if (!parsed.success) return null;
    const diagnostic = parsed.data;
    return {
        code: diagnostic.code,
        titleKey: DIAGNOSTIC_TITLE_KEYS[diagnostic.code],
        bodyKey: DIAGNOSTIC_BODY_KEYS[diagnostic.code],
        statusKey: DIAGNOSTIC_STATUS_KEYS[diagnostic.code],
        actions: diagnostic.suggestedActions.map((action) => ({
            kind: action,
            labelKey: labelKeyForAction(action),
        })),
    };
}
