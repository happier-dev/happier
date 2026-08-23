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

/**
 * Copy for `capabilities.localServices.{preview,publicPreview}.disabledReasons`.
 *
 * This is a third reason vocabulary, separate from the two above on purpose: the two maps above
 * translate what the *daemon* reports about one preview at runtime (`LocalServicePreviewDiagnosticV1`),
 * whereas these codes come from the *server*'s feature payload and name a deployment prerequisite the
 * operator has not satisfied — see `apps/server/sources/app/features/localServicesFeature.ts:52-110`,
 * the only producer. The two nodes are keyed separately because `disabled_by_server_policy` means
 * "the private preview feature is off" under `preview` and "the public exposure feature is off"
 * under `publicPreview`; the tunnel codes mean the same thing in both and share their copy.
 *
 * The server declares these as `z.array(z.string())`, so an unknown code from a newer server is
 * expected: it is dropped and the caller falls back to its generic sentence rather than rendering
 * a raw identifier.
 */
const CAPABILITY_DISABLED_REASON_KEYS = {
    preview: {
        disabled_by_server_policy: 'localServices.publicPreview.disabledReason.previewServerDisabled',
        pms_allowed_ports_empty: 'localServices.publicPreview.disabledReason.tunnelPortsUnconfigured',
        pms_server_relay_disabled: 'localServices.publicPreview.disabledReason.tunnelRelayDisabled',
    },
    publicPreview: {
        audit_required_disabled: 'localServices.publicPreview.disabledReason.auditRequirementDisabled',
        audit_sink_unavailable: 'localServices.publicPreview.disabledReason.auditUnavailable',
        disabled_by_server_policy: 'localServices.publicPreview.disabledReason.serverDisabled',
        dns_tls_unavailable: 'localServices.publicPreview.disabledReason.dnsTlsUnavailable',
        max_ttl_unconfigured: 'localServices.publicPreview.disabledReason.linkLifetimeUnconfigured',
        mode_unconfigured: 'localServices.publicPreview.disabledReason.modeUnconfigured',
        pms_allowed_ports_empty: 'localServices.publicPreview.disabledReason.tunnelPortsUnconfigured',
        pms_server_relay_disabled: 'localServices.publicPreview.disabledReason.tunnelRelayDisabled',
        rate_limit_checker_unavailable: 'localServices.publicPreview.disabledReason.rateLimitUnavailable',
        rate_limit_profile_unconfigured: 'localServices.publicPreview.disabledReason.rateLimitProfileUnconfigured',
    },
} as const satisfies Record<'preview' | 'publicPreview', Record<string, TranslationKey>>;

type CapabilityDisabledReasonNode = keyof typeof CAPABILITY_DISABLED_REASON_KEYS;

function resolveCapabilityDisabledReasonText(
    node: CapabilityDisabledReasonNode,
    reasons: readonly string[] | undefined,
): string | null {
    if (!reasons || reasons.length === 0) return null;
    const keys = CAPABILITY_DISABLED_REASON_KEYS[node] as Record<string, TranslationKey | undefined>;
    const sentences: string[] = [];
    for (const reason of reasons) {
        const key = keys[reason.trim()];
        if (!key) continue;
        const sentence = t(key);
        if (!sentences.includes(sentence)) sentences.push(sentence);
    }
    return sentences.length > 0 ? sentences.join(' ') : null;
}

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

/**
 * Why this target cannot be exposed publicly right now.
 *
 * `capabilityDisabledReasons` is `capabilities.localServices.publicPreview.disabledReasons` from the
 * server feature payload. It names the exact unmet prerequisite, so it replaces the generic
 * "public previews are disabled" sentence whenever the client recognises at least one of its codes.
 * A live daemon diagnostic still wins: it describes what happened to *this* preview, which is more
 * specific than a deployment-wide prerequisite.
 */
export function resolveLocalServicePublicPreviewCreateDisabledSubtitle(input: Readonly<{
    state: LocalServicePublicPreviewState;
    activeExposureCount: number;
    previewId: string | null;
    capabilityDisabledReasons?: readonly string[];
}>): string | null {
    const diagnosticSubtitle = resolveDiagnosticSubtitle(input.state, input.previewId);
    if (diagnosticSubtitle) return diagnosticSubtitle;

    const policy = input.state.policy;
    if (!policy?.enabled || !policy.allowedModes.includes('secret_link')) {
        const capabilitySubtitle = resolveCapabilityDisabledReasonText(
            'publicPreview',
            input.capabilityDisabledReasons,
        );
        if (capabilitySubtitle) return capabilitySubtitle;
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

/**
 * Why this service has no local preview to expose.
 *
 * `capabilityDisabledReasons` is `capabilities.localServices.preview.disabledReasons`. Without it the
 * row says "open a local preview first", which is wrong advice when the server is the reason no
 * preview can be registered at all.
 */
export function resolveLocalServicePreviewUnavailableSubtitle(input: Readonly<{
    capabilityDisabledReasons?: readonly string[];
}>): string {
    return resolveCapabilityDisabledReasonText('preview', input.capabilityDisabledReasons)
        ?? t('localServices.publicPreview.disabledNoPreviewSubtitle');
}
