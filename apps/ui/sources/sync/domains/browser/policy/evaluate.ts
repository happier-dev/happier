import type {
    BrowserOriginSecuritySummaryV1,
    BrowserPolicyReasonCodeV1,
    BrowserProfileV1,
    BrowserTargetPermissionPolicyV1,
    BrowserTargetPolicyDecisionV1,
    BrowserViewTargetV1,
    FeatureDecision,
} from '@happier-dev/protocol';

const DENY_RISKY_BROWSER_PERMISSIONS: BrowserTargetPermissionPolicyV1 = {
    downloads: 'deny',
    uploads: 'deny',
    clipboard: 'deny',
    camera: 'deny',
    microphone: 'deny',
    fileAccess: 'deny',
    popups: 'deny',
    browserUse: 'prompt',
};

const ENABLED_BROWSER_SURFACE_DECISION: FeatureDecision = {
    featureId: 'browser',
    state: 'enabled',
    blockedBy: null,
    blockerCode: 'none',
    diagnostics: [],
    evaluatedAt: 0,
    scope: { scopeKind: 'runtime' },
};

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
        permissions: DENY_RISKY_BROWSER_PERMISSIONS,
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
        permissions: DENY_RISKY_BROWSER_PERMISSIONS,
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
    if (!input.profile) {
        return deniedDecision(input, 'profile_missing');
    }
    if ((input.profile.lifecycleState ?? 'active') !== 'active') {
        return deniedDecision(input, 'profile_unusable');
    }

    if (input.target.kind === 'externalUrl' && input.allowExternalUrlBrowsing !== true) {
        return deniedDecision(input, 'external_url_disabled');
    }
    if (
        input.target.kind === 'externalUrl'
        && (
            input.profile.storageMode === 'plugin'
            || input.profile.owner.kind === 'plugin'
        )
    ) {
        return deniedDecision(input, 'profile_unusable', ['external_url_profile_not_isolated']);
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
            return deniedDecision(input, 'hosted_plugin_profile_mismatch');
        }
    }

    if (input.target.kind === 'streamedBrowser') {
        return deniedDecision(input, 'adapter_unavailable');
    }

    return allowedDecision(input);
}

export function resolveHostedPluginBrowserPolicyUnavailableReason(input: Readonly<{
    target: BrowserViewTargetV1;
    profile: BrowserProfileV1 | null | undefined;
}>): BrowserPolicyReasonCodeV1 | null {
    if (input.target.kind !== 'hostedPluginWeb') {
        return null;
    }
    const decision = evaluateBrowserTargetPolicy({
        target: input.target,
        profile: input.profile,
        browserFeatureDecision: ENABLED_BROWSER_SURFACE_DECISION,
    });
    return decision.state === 'allowed'
        ? null
        : decision.reasonCode ?? 'policy_denied';
}
