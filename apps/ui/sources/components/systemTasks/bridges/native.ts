import {
    getNativeSshAvailability,
    getOptionalHappierSshNativeModule,
    type NativeSshAvailability,
    type NativeSshAuthRequest,
    type NativeSshHostKeyVerification,
    type NativeSshModule,
} from '@happier-dev/ssh-native';

import { getFeatureBuildPolicyDecision } from '@/sync/domains/features/featureBuildPolicy';

import type { NativeSshSystemTaskCapability } from '../types';

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

export function isNativeSshBootstrapTaskKind(kind: string): kind is typeof NATIVE_SSH_BOOTSTRAP_TASK_KIND {
    return kind === NATIVE_SSH_BOOTSTRAP_TASK_KIND;
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

export function isNativeSshBootstrapCapabilityAvailable(
    capability: NativeSshSystemTaskCapability | undefined,
): boolean {
    return capability?.available === true
        && capability.supportedTaskKinds.includes(NATIVE_SSH_BOOTSTRAP_TASK_KIND);
}

export function resolveNativeSshSystemTaskCapability(
    availability: NativeSshAvailability,
): NativeSshSystemTaskCapability {
    if (!availability.available) {
        return unavailableNativeSshCapability(availability.reason);
    }
    return {
        available: true,
        supportsLoopbackTunnel: availability.supportsLoopbackTunnel,
        supportedTaskKinds: NATIVE_SSH_SUPPORTED_TASK_KINDS,
    };
}

export function loadOptionalNativeSshModule(): NativeSshModule | null {
    return getOptionalHappierSshNativeModule();
}

export function resolveDefaultNativeSshSystemTaskCapability(params: Readonly<{
    nativeModule?: NativeSshModule | null;
    buildIncluded?: boolean;
}> = {}): NativeSshSystemTaskCapability {
    if (getFeatureBuildPolicyDecision('setup.machine.allowRemoteSshMachineSetup') === 'deny') {
        return unavailableNativeSshCapability('feature-disabled');
    }
    const buildIncluded = params.buildIncluded
        ?? getFeatureBuildPolicyDecision('setup.ssh.nativeTransport') !== 'deny';
    return resolveNativeSshSystemTaskCapability(getNativeSshAvailability({
        nativeModule: params.nativeModule,
        buildIncluded,
    }));
}
