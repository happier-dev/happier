import { createDeterministicSystemTaskBridge } from './createDeterministicSystemTaskBridge';
import { createNativeSshBridge } from './createNativeSshBridge';
import { createTauriSystemTaskBridge } from './createTauriSystemTaskBridge';
import { createUnavailableSystemTaskBridge } from './createUnavailableSystemTaskBridge';
import type { SystemTaskRunnerMode, SystemTasksBridge } from './types';
import { getRemoteHostTrustedHostKeyStore } from '@/sync/domains/remoteHosts/hostKeys/trustedHostKeyStore';

export function createSystemTaskBridge(options: Readonly<{
    mode: SystemTaskRunnerMode;
}>): SystemTasksBridge {
    if (options.mode === 'tauri') {
        return createTauriSystemTaskBridge();
    }
    if (options.mode === 'native') {
        return createNativeSshBridge({
            trustedHostKeyStore: getRemoteHostTrustedHostKeyStore(),
        });
    }
    if (options.mode === 'dev') {
        return createDeterministicSystemTaskBridge();
    }
    return createUnavailableSystemTaskBridge();
}
