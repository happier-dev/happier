import { Platform } from 'react-native';
import {
    getNativeSshAvailability,
    getOptionalHappierSshNativeModule,
    type NativeSshAuthRequest,
    type NativeSshAvailability,
    type NativeSshExecRequest,
    type NativeSshExecResult,
    type NativeSshHostKeyVerification,
    type NativeSshModule,
} from '@happier-dev/ssh-native';

import type { NativeSshSystemTaskCapability } from '../types';

export type { NativeSshModule, NativeSshExecRequest, NativeSshExecResult, NativeSshHostKeyVerification };

export const NATIVE_SSH_BOOTSTRAP_TASK_KIND = 'remote.ssh.bootstrapMachine.v1' as const;
export const NATIVE_SSH_SUPPORTED_TASK_KINDS = [NATIVE_SSH_BOOTSTRAP_TASK_KIND] as const;

export type NativeSshTaskCredentials = Readonly<{
    host: string;
    port: number;
    username: string;
    auth: NativeSshAuthRequest;
}>;

export type NativeSshSystemTaskBridgeRequest = Readonly<{
    taskKind: typeof NATIVE_SSH_BOOTSTRAP_TASK_KIND;
    taskInput: unknown;
    credentials: NativeSshTaskCredentials;
    hostKeyDecision?: NativeSshHostKeyVerification;
}>;

export function isNativeSshBootstrapCapabilityAvailable(
    capability: NativeSshSystemTaskCapability | undefined,
): boolean {
    return capability?.available === true
        && capability.supportedTaskKinds.includes(NATIVE_SSH_BOOTSTRAP_TASK_KIND);
}

export function unavailableNativeSshCapability(
    unavailableReason: NonNullable<NativeSshSystemTaskCapability['unavailableReason']>,
): NativeSshSystemTaskCapability {
    return {
        available: false,
        unavailableReason,
        supportedTaskKinds: NATIVE_SSH_SUPPORTED_TASK_KINDS,
    };
}

export function resolveNativeSshSystemTaskCapability(params: Readonly<{
    nativeTransportFeatureEnabled: boolean;
    remoteSshMachineSetupFeatureEnabled: boolean;
    nativeAvailability: NativeSshAvailability | null;
    platformOS?: string;
}>): NativeSshSystemTaskCapability {
    if (!params.nativeTransportFeatureEnabled || !params.remoteSshMachineSetupFeatureEnabled) {
        return unavailableNativeSshCapability('feature-disabled');
    }

    const platformOS = params.platformOS ?? Platform.OS;
    if (platformOS !== 'ios' && platformOS !== 'android') {
        return unavailableNativeSshCapability('unsupported-platform');
    }

    const availability = params.nativeAvailability;
    if (!availability || availability.available !== true) {
        return unavailableNativeSshCapability(availability?.reason ?? 'native-module-missing');
    }

    return {
        available: true,
        supportedTaskKinds: NATIVE_SSH_SUPPORTED_TASK_KINDS,
    };
}

export function loadOptionalNativeSshModule(): NativeSshModule | null {
    return getOptionalHappierSshNativeModule();
}

export function resolveDefaultNativeSshSystemTaskCapability(params: Readonly<{
    nativeTransportFeatureEnabled?: boolean;
    remoteSshMachineSetupFeatureEnabled?: boolean;
    buildIncluded?: boolean;
    platformOS?: string;
}> = {}): NativeSshSystemTaskCapability {
    return resolveNativeSshSystemTaskCapability({
        nativeTransportFeatureEnabled: params.nativeTransportFeatureEnabled ?? true,
        remoteSshMachineSetupFeatureEnabled: params.remoteSshMachineSetupFeatureEnabled ?? true,
        nativeAvailability: getNativeSshAvailability({
            nativeModule: loadOptionalNativeSshModule(),
            platform: params.platformOS === 'ios' || params.platformOS === 'android'
                ? params.platformOS
                : (params.platformOS === 'web' ? 'web' : 'unknown'),
            buildIncluded: params.buildIncluded,
        }),
        platformOS: params.platformOS,
    });
}
