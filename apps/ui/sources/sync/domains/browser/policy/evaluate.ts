import type {
    BrowserOriginSecuritySummaryV1,
    BrowserPolicyReasonCodeV1,
    BrowserProfileV1,
    BrowserTargetPolicyDecisionV1,
    BrowserViewTargetV1,
    FeatureDecision,
} from '@happier-dev/protocol';

type EvaluateBrowserTargetPolicyInput = Readonly<{
    target: BrowserViewTargetV1;
    profile: BrowserProfileV1 | null | undefined;
    browserFeatureDecision: FeatureDecision | null | undefined;
    allowExternalUrlBrowsing?: boolean;
}>;

function isBrowserFeatureEnabled(decision: FeatureDecision | null | undefined): boolean {
    return decision?.featureId === 'browser' && decision.state === 'enabled';
}

function deniedDecision(
    input: EvaluateBrowserTargetPolicyInput,
    reasonCode: BrowserPolicyReasonCodeV1,
    disabledReasons: readonly string[] = [reasonCode],
): BrowserTargetPolicyDecisionV1 {
    return {
        targetKind: input.target.kind,
        state: reasonCode === 'policy_denied' ? 'denied' : 'unavailable',
        reasonCode,
        profileId: input.profile?.profileId,
        profileMode: input.profile?.storageMode,
        disabledReasons: [...disabledReasons],
    };
}

function allowedDecision(input: EvaluateBrowserTargetPolicyInput): BrowserTargetPolicyDecisionV1 {
    return {
        targetKind: input.target.kind,
        state: 'allowed',
        profileId: input.profile?.profileId,
        profileMode: input.profile?.storageMode,
        origin: selectBrowserTargetOrigin(input.target)?.origin,
        security: selectBrowserTargetOrigin(input.target),
        disabledReasons: [],
    };
}

export function selectBrowserTargetOrigin(target: BrowserViewTargetV1): BrowserOriginSecuritySummaryV1 | undefined {
    if (target.kind !== 'externalUrl') {
        if (target.kind === 'localServicePreview') {
            return { securityLevel: 'localPreview', reasonCodes: [] };
        }
        if (target.kind === 'hostedPluginWeb') {
            return { securityLevel: 'hostedPlugin', reasonCodes: [] };
        }
        return { securityLevel: 'unknown', reasonCodes: [] };
    }
    const parsed = new URL(target.url);
    return {
        url: target.url,
        origin: parsed.origin,
        securityLevel: parsed.protocol === 'https:' ? 'secure' : 'insecure',
        reasonCodes: [],
    };
}

export function evaluateBrowserTargetPolicy(
    input: EvaluateBrowserTargetPolicyInput,
): BrowserTargetPolicyDecisionV1 {
    if (!isBrowserFeatureEnabled(input.browserFeatureDecision)) {
        return deniedDecision(input, 'feature_disabled');
    }
    if (input.target.kind === 'externalUrl' && input.allowExternalUrlBrowsing !== true) {
        return deniedDecision(input, 'external_url_disabled');
    }
    const profileUnavailableReason = resolveBrowserTargetProfileUnavailableReason(input);
    if (profileUnavailableReason) {
        return deniedDecision(input, profileUnavailableReason);
    }

    return allowedDecision(input);
}

/** Profile identity and lifecycle are independent of the caller's feature admission. */
export function resolveBrowserTargetProfileUnavailableReason(input: Readonly<{
    target: BrowserViewTargetV1;
    profile: BrowserProfileV1 | null | undefined;
}>): BrowserPolicyReasonCodeV1 | null {
    if (!input.profile) return 'profile_missing';
    if ((input.profile.lifecycleState ?? 'active') !== 'active') return 'profile_unusable';
    if (
        input.target.kind === 'externalUrl'
        && (
            input.profile.storageMode === 'plugin'
            || input.profile.owner.kind === 'plugin'
        )
    ) {
        return 'profile_unusable';
    }

    if (input.target.kind === 'hostedPluginWeb') {
        const owner = input.profile.owner;
        if (
            input.profile.storageMode !== 'plugin' ||
            owner.kind !== 'plugin' ||
            owner.id !== input.target.pluginId ||
            (
                typeof owner.contributionId === 'string'
                && owner.contributionId !== input.target.contributionId
            )
        ) {
            return 'hosted_plugin_profile_mismatch';
        }
    }

    return null;
}
