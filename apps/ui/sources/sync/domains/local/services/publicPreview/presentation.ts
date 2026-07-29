import type { LocalServicePreviewDiagnosticV1 } from '@happier-dev/protocol';

import { t } from '@/text';
import type { TranslationKey } from '@/text/i18n';

import type { LocalServicePublicPreviewState } from './store';

const PUBLIC_PREVIEW_DIAGNOSTIC_REASON_KEYS: Partial<Record<LocalServicePreviewDiagnosticV1['code'], TranslationKey>> = {
    dns_tls_not_ready: 'localServices.publicPreview.disabledReason.dnsTlsUnavailable',
    pms_relay_unavailable: 'localServices.publicPreview.disabledReason.relayUnavailable',
    public_policy_denied: 'localServices.publicPreview.disabledPolicySubtitle',
    public_preview_expired: 'localServices.publicPreview.disabledReason.expired',
    public_preview_rate_limited: 'localServices.publicPreview.disabledReason.rateLimited',
    public_preview_revoked: 'localServices.publicPreview.disabledReason.revoked',
};

const PUBLIC_PREVIEW_POLICY_REASON_KEYS = {
    audit_sink_unavailable: 'localServices.publicPreview.disabledReason.auditUnavailable',
    dns_tls_unavailable: 'localServices.publicPreview.disabledReason.dnsTlsUnavailable',
    invalid_policy: 'localServices.publicPreview.disabledReason.policyInvalid',
    invalid_public_base_url: 'localServices.publicPreview.disabledReason.publicBaseUrlUnavailable',
    mode_not_allowed: 'localServices.publicPreview.disabledUnsupportedModeSubtitle',
    preview_not_eligible: 'localServices.publicPreview.disabledReason.previewNotEligible',
    public_preview_disabled: 'localServices.publicPreview.disabledPolicySubtitle',
    public_token_secret_missing: 'localServices.publicPreview.disabledReason.secretLinkUnavailable',
    rate_limit_checker_unavailable: 'localServices.publicPreview.disabledReason.rateLimitUnavailable',
    rate_limit_profile_not_allowed: 'localServices.publicPreview.disabledReason.rateLimitUnavailable',
    session_not_authorized: 'localServices.publicPreview.disabledReason.sessionNotAuthorized',
    too_many_public_exposures: 'localServices.publicPreview.disabledLimitSubtitle',
} as const satisfies Record<string, TranslationKey>;

function readReasonCodeFromDetails(
    details: LocalServicePreviewDiagnosticV1['details'] | undefined,
): string | null {
    const value = details?.reasonCode;
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function isRelevantPublicPreviewDiagnostic(
    diagnostic: LocalServicePreviewDiagnosticV1,
    previewId: string | null,
): boolean {
    if (diagnostic.scope !== 'publicPreview') return false;
    if (!previewId || !diagnostic.previewId) return true;
    return diagnostic.previewId === previewId;
}

function selectPublicPreviewDiagnostic(
    state: LocalServicePublicPreviewState,
    previewId: string | null,
): LocalServicePreviewDiagnosticV1 | null {
    let fallback: LocalServicePreviewDiagnosticV1 | null = null;
    for (const diagnostic of state.diagnostics) {
        if (!isRelevantPublicPreviewDiagnostic(diagnostic, previewId)) continue;
        if (previewId && diagnostic.previewId === previewId) return diagnostic;
        fallback ??= diagnostic;
    }
    return fallback;
}

function resolveDiagnosticSubtitle(
    state: LocalServicePublicPreviewState,
    previewId: string | null,
): string | null {
    const diagnostic = selectPublicPreviewDiagnostic(state, previewId);
    if (!diagnostic) return null;

    const reasonCode = readReasonCodeFromDetails(diagnostic.details);
    const reasonKey = reasonCode
        ? PUBLIC_PREVIEW_POLICY_REASON_KEYS[reasonCode as keyof typeof PUBLIC_PREVIEW_POLICY_REASON_KEYS]
        : undefined;
    if (reasonKey) return t(reasonKey);

    const diagnosticKey = PUBLIC_PREVIEW_DIAGNOSTIC_REASON_KEYS[diagnostic.code];
    return diagnosticKey ? t(diagnosticKey) : null;
}

export function resolveLocalServicePublicPreviewCreateDisabledSubtitle(input: Readonly<{
    state: LocalServicePublicPreviewState;
    activeExposureCount: number;
    previewId: string | null;
}>): string | null {
    const diagnosticSubtitle = resolveDiagnosticSubtitle(input.state, input.previewId);
    if (diagnosticSubtitle) return diagnosticSubtitle;

    const policy = input.state.policy;
    if (!policy?.enabled || !policy.allowedModes.includes('secret_link')) {
        return policy?.enabled
            ? t('localServices.publicPreview.disabledUnsupportedModeSubtitle')
            : t('localServices.publicPreview.disabledPolicySubtitle');
    }
    const limit = policy.maxConcurrentExposures;
    if (typeof limit !== 'number') {
        return null;
    }
    return input.activeExposureCount < limit
        ? null
        : t('localServices.publicPreview.disabledLimitSubtitle');
}
