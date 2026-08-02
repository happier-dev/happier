import type {
    ClientKind,
    ClientVersionCheckResponseV1,
} from '@happier-dev/protocol';
import * as semver from 'semver';

import type { SessionSyncCompatibilityPolicy } from './policy';

export interface ClientVersionDecisionInput {
    readonly clientKind: ClientKind;
    readonly appVersion: string;
    readonly policy: SessionSyncCompatibilityPolicy;
    readonly distributionUpdateUrl?: string | null;
}

export function isAppVersionAtLeastMinimum(appVersion: string, minimumVersion: string): boolean {
    const declared = semver.valid(appVersion);
    const minimum = semver.valid(minimumVersion);
    return declared !== null && minimum !== null && semver.gte(declared, minimum);
}

export function resolveClientVersionDecision(
    input: ClientVersionDecisionInput,
): ClientVersionCheckResponseV1 {
    // The compatibility policy is the only upgrade floor. A store listing version
    // tracks a distribution channel rather than the version line clients report,
    // so measuring against one reports a permanent, unactionable upgrade.
    const minimum = input.policy.requirements.minimumVersionsByClientKind?.[input.clientKind];
    if (minimum === undefined || isAppVersionAtLeastMinimum(input.appVersion, minimum)) {
        return { v: 1, status: 'current' };
    }

    return {
        v: 1,
        status: 'upgrade-required',
        minimumAppVersion: minimum,
        updateUrl: input.policy.requirements.upgradeUrlsByClientKind?.[input.clientKind]
            ?? input.distributionUpdateUrl
            ?? null,
    };
}
