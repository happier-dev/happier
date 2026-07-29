import {
    BrowserSidecarLaunchResultV1Schema,
    type BrowserProfileV1,
    type BrowserSidecarErrorCodeV1,
    type BrowserSidecarLaunchResultV1,
} from '@happier-dev/protocol';

import type { SidecarBrowserBinaryResolution } from './binary';
import { resolveSidecarProfileBinding } from './profiles';

export type SidecarPrivateLaunchPlan = Readonly<{
    sidecarId: string;
    executablePath: string;
    args: readonly string[];
    source: Extract<SidecarBrowserBinaryResolution, { ok: true }>['source'];
    profileId: string;
    profileDirectory: string;
    cleanupOnStop: boolean;
}>;

export type SidecarLaunchPlan = Readonly<{
    publicResult: BrowserSidecarLaunchResultV1;
    privateLaunch: SidecarPrivateLaunchPlan | null;
}>;

function rejectedLaunchResult(input: Readonly<{
    errorCode: BrowserSidecarErrorCodeV1;
    disabledReason: string;
}>): BrowserSidecarLaunchResultV1 {
    return BrowserSidecarLaunchResultV1Schema.parse({
        v: 1,
        accepted: false,
        state: 'unavailable',
        errorCode: input.errorCode,
        disabledReason: input.disabledReason,
    });
}

function buildSidecarLaunchArgs(profileDirectory: string): readonly string[] {
    return [
        `--user-data-dir=${profileDirectory}`,
        '--remote-debugging-port=0',
        '--no-first-run',
        '--no-default-browser-check',
    ];
}

export function createSidecarLaunchPlan(params: Readonly<{
    sidecarId: string;
    nowMs: number;
    featureEnabled: boolean;
    browserUseAllowed: boolean;
    allowPersistentProfiles: boolean;
    profile: BrowserProfileV1;
    profileDirectory: string;
    binaryResolution: SidecarBrowserBinaryResolution;
}>): SidecarLaunchPlan {
    if (!params.featureEnabled) {
        return {
            publicResult: rejectedLaunchResult({
                errorCode: 'feature_disabled',
                disabledReason: 'browser.sidecar feature disabled',
            }),
            privateLaunch: null,
        };
    }

    if (!params.browserUseAllowed) {
        return {
            publicResult: rejectedLaunchResult({
                errorCode: 'browser_policy_denied',
                disabledReason: 'browser use denied by policy',
            }),
            privateLaunch: null,
        };
    }

    if (!params.binaryResolution.ok) {
        return {
            publicResult: rejectedLaunchResult({
                errorCode: params.binaryResolution.errorCode,
                disabledReason: params.binaryResolution.disabledReason,
            }),
            privateLaunch: null,
        };
    }

    const profileResolution = resolveSidecarProfileBinding({
        profile: params.profile,
        allowPersistentProfiles: params.allowPersistentProfiles,
        profileDirectory: params.profileDirectory,
    });
    if (!profileResolution.ok) {
        return {
            publicResult: rejectedLaunchResult({
                errorCode: profileResolution.errorCode,
                disabledReason: profileResolution.disabledReason,
            }),
            privateLaunch: null,
        };
    }

    const publicResult = BrowserSidecarLaunchResultV1Schema.parse({
        v: 1,
        accepted: true,
        sidecarId: params.sidecarId,
        state: 'ready',
        profileBinding: profileResolution.binding,
    });

    return {
        publicResult,
        privateLaunch: {
            sidecarId: params.sidecarId,
            executablePath: params.binaryResolution.executablePath,
            args: buildSidecarLaunchArgs(profileResolution.cleanup.profileDirectory),
            source: params.binaryResolution.source,
            profileId: profileResolution.binding.profileId,
            profileDirectory: profileResolution.cleanup.profileDirectory,
            cleanupOnStop: profileResolution.cleanup.cleanupOnStop,
        },
    };
}
