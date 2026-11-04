import { BrowserSidecarLaunchResultV1Schema } from '@happier-dev/protocol/browser/sidecar/v1';
import type { BrowserProfileV1, BrowserSidecarErrorCodeV1, BrowserSidecarLaunchResultV1 } from '@happier-dev/protocol';

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

function buildSidecarLaunchArgs(profileDirectory: string, extensionDirectories: readonly string[]): readonly string[] {
    return [
        '--headless=new',
        `--user-data-dir=${profileDirectory}`,
        '--remote-debugging-pipe',
        '--no-first-run',
        '--no-default-browser-check',
        // Managed cookie storage must not use the person's login Keychain.
        // Chromium's fixed mock secret leaves at-rest protection to the profile filesystem.
        ...(process.platform === 'darwin' ? ['--use-mock-keychain'] : []),
        ...(extensionDirectories.length > 0 ? [
            `--load-extension=${extensionDirectories.join(',')}`,
            `--disable-extensions-except=${extensionDirectories.join(',')}`,
        ] : []),
    ];
}

export function createSidecarLaunchPlan(params: Readonly<{
    sidecarId: string;
    nowMs: number;
    profile: BrowserProfileV1;
    profileDirectory: string;
    extensionDirectories?: readonly string[];
    binaryResolution: SidecarBrowserBinaryResolution;
}>): SidecarLaunchPlan {
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
            args: buildSidecarLaunchArgs(profileResolution.cleanup.profileDirectory,
                params.profile.storageMode === 'user' || params.profile.storageMode === 'plugin' ? params.extensionDirectories ?? [] : []),
            source: params.binaryResolution.source,
            profileId: profileResolution.binding.profileId,
            profileDirectory: profileResolution.cleanup.profileDirectory,
            cleanupOnStop: profileResolution.cleanup.cleanupOnStop,
        },
    };
}
