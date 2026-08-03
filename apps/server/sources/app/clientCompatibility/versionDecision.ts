import type { ClientKind } from '@happier-dev/protocol';
import * as semver from 'semver';

import type { SessionSyncCompatibilityPolicy } from './policy';

export type ClientAppVersionDecision =
    | Readonly<{ status: 'current' }>
    | Readonly<{
        status: 'upgrade-required';
        minimumAppVersion: string;
        updateUrl: string | null;
    }>;

export interface ClientAppVersionDecisionInput {
    readonly clientKind: ClientKind;
    readonly appVersion: string;
    readonly policy: SessionSyncCompatibilityPolicy;
    readonly fallbackUpdateUrl?: string | null;
}

export function isAppVersionAtLeastMinimum(appVersion: string, minimumVersion: string): boolean {
    const declared = semver.valid(appVersion);
    const minimum = semver.valid(minimumVersion);
    return declared !== null && minimum !== null && semver.gte(declared, minimum);
}

/**
 * Resolves the app-version portion of the session-sync compatibility policy.
 * Store destinations do not define version floors; they are used only when a
 * policy minimum requires an upgrade.
 */
export function resolveClientAppVersionDecision(
    input: ClientAppVersionDecisionInput,
): ClientAppVersionDecision {
    const minimum = input.policy.requirements.minimumVersionsByClientKind?.[input.clientKind];
    if (minimum === undefined || isAppVersionAtLeastMinimum(input.appVersion, minimum)) {
        return { status: 'current' };
    }

    return {
        status: 'upgrade-required',
        minimumAppVersion: minimum,
        updateUrl: input.policy.requirements.upgradeUrlsByClientKind?.[input.clientKind]
            ?? input.fallbackUpdateUrl
            ?? null,
    };
}
