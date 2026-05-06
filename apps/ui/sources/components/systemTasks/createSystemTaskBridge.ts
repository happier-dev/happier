import { createDeterministicSystemTaskBridge } from './createDeterministicSystemTaskBridge';
import { createNativeSshBridge } from './createNativeSshBridge';
import { createTauriSystemTaskBridge } from './createTauriSystemTaskBridge';
import { createUnavailableSystemTaskBridge } from './createUnavailableSystemTaskBridge';
import { unavailableNativeSshCapability, type NativeSshModule } from './bridges/native';
import type { NativeSshSystemTaskCapability, SystemTaskRunnerMode, SystemTasksBridge } from './types';

export function createSystemTaskBridge(options: Readonly<{
    mode: SystemTaskRunnerMode;
    nativeSshCapability?: NativeSshSystemTaskCapability;
    nativeSsh?: NativeSshModule | null;
}>): SystemTasksBridge {
    if (options.mode === 'tauri') {
        return createTauriSystemTaskBridge();
    }
    if (options.mode === 'dev') {
        return createDeterministicSystemTaskBridge();
    }
    if (options.mode === 'native') {
        return createNativeSshBridge({
            capability: options.nativeSshCapability ?? unavailableNativeSshCapability('feature-disabled'),
            nativeSsh: options.nativeSsh,
        });
    }
    return createUnavailableSystemTaskBridge();
}
