import {
    CLIENT_UPGRADE_REQUIRED_ERROR_CODE,
    classifySessionSyncProtocolCompatibility,
    type ClientCompatibilityDeclarationParseResult,
    type ClientCompatibilityDeclarationV1,
    type ClientKind,
    type ClientUpgradeRequiredV1,
} from '@happier-dev/protocol';

import type { SessionSyncCompatibilityPolicy } from './policy';
import { isAppVersionAtLeastMinimum } from './versionDecision';

export type SessionSyncCompatibilityOutcome =
    | 'accepted'
    | 'observe-missing'
    | 'observe-malformed'
    | 'observe-protocol-too-old'
    | 'observe-app-version-too-old'
    | 'observe-client-kind-mismatch'
    | 'observe-policy-invalid'
    | 'reject-missing'
    | 'reject-malformed'
    | 'reject-protocol-too-old'
    | 'reject-app-version-too-old'
    | 'reject-client-kind-mismatch'
    | 'reject-policy-invalid';

export interface SessionSyncCompatibilityEvaluationConstraints {
    readonly allowedClientKinds?: readonly ClientKind[];
}

export interface SessionSyncCompatibilityEvaluation {
    readonly accepted: boolean;
    readonly outcome: SessionSyncCompatibilityOutcome;
    readonly declaration: ClientCompatibilityDeclarationV1 | null;
    readonly upgradeRequired: ClientUpgradeRequiredV1 | null;
}

export function buildSessionSyncUpgradeRequired(
    policy: SessionSyncCompatibilityPolicy,
    clientKind: ClientKind | null,
): ClientUpgradeRequiredV1 {
    return {
        error: CLIENT_UPGRADE_REQUIRED_ERROR_CODE,
        requirement: {
            v: 1,
            minimumSessionSyncProtocolVersion: policy.requirements.minimumSessionSyncProtocolVersion,
            clientKind,
            minimumAppVersion: clientKind === null
                ? null
                : policy.requirements.minimumVersionsByClientKind?.[clientKind] ?? null,
            updateUrl: clientKind === null
                ? null
                : policy.requirements.upgradeUrlsByClientKind?.[clientKind] ?? null,
        },
    };
}

export function evaluateSessionSyncCompatibility(
    parseResult: ClientCompatibilityDeclarationParseResult,
    policy: SessionSyncCompatibilityPolicy,
    constraints: SessionSyncCompatibilityEvaluationConstraints = {},
): SessionSyncCompatibilityEvaluation {
    const required = policy.requestedEnforcement === 'required';
    if (!policy.valid) {
        const declaration = parseResult.status === 'valid' ? parseResult.declaration : null;
        return {
            accepted: !required,
            outcome: required ? 'reject-policy-invalid' : 'observe-policy-invalid',
            declaration,
            upgradeRequired: required
                ? buildSessionSyncUpgradeRequired(policy, declaration?.clientKind ?? null)
                : null,
        };
    }
    if (parseResult.status === 'missing' || parseResult.status === 'malformed') {
        const suffix = parseResult.status;
        return {
            accepted: !required,
            outcome: `${required ? 'reject' : 'observe'}-${suffix}`,
            declaration: null,
            upgradeRequired: required ? buildSessionSyncUpgradeRequired(policy, null) : null,
        };
    }

    const declaration = parseResult.declaration;
    if (constraints.allowedClientKinds !== undefined && !constraints.allowedClientKinds.includes(declaration.clientKind)) {
        return {
            accepted: !required,
            outcome: required ? 'reject-client-kind-mismatch' : 'observe-client-kind-mismatch',
            declaration,
            upgradeRequired: required ? buildSessionSyncUpgradeRequired(policy, null) : null,
        };
    }

    if (
        (declaration.clientKind === 'daemon' || declaration.clientKind === 'session-runner')
        && policy.requirements.minimumVersionsByClientKind?.[declaration.clientKind] === undefined
        && required
    ) {
        return {
            accepted: false,
            outcome: 'reject-policy-invalid',
            declaration,
            upgradeRequired: buildSessionSyncUpgradeRequired(policy, declaration.clientKind),
        };
    }

    const protocolDecision = classifySessionSyncProtocolCompatibility(
        declaration.sessionSyncProtocolVersion,
        policy.requirements.minimumSessionSyncProtocolVersion,
    );
    if (protocolDecision === 'older' || protocolDecision === 'malformed' || protocolDecision === 'missing') {
        return {
            accepted: !required,
            outcome: required ? 'reject-protocol-too-old' : 'observe-protocol-too-old',
            declaration,
            upgradeRequired: required ? buildSessionSyncUpgradeRequired(policy, declaration.clientKind) : null,
        };
    }

    const minimumAppVersion = policy.requirements.minimumVersionsByClientKind?.[declaration.clientKind];
    if (minimumAppVersion !== undefined && !isAppVersionAtLeastMinimum(declaration.appVersion, minimumAppVersion)) {
        return {
            accepted: !required,
            outcome: required ? 'reject-app-version-too-old' : 'observe-app-version-too-old',
            declaration,
            upgradeRequired: required ? buildSessionSyncUpgradeRequired(policy, declaration.clientKind) : null,
        };
    }

    return { accepted: true, outcome: 'accepted', declaration, upgradeRequired: null };
}
