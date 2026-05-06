import { createDeterministicSystemTaskBridge } from './createDeterministicSystemTaskBridge';
import { createTauriSystemTaskBridge } from './createTauriSystemTaskBridge';
import { createUnavailableSystemTaskBridge } from './createUnavailableSystemTaskBridge';
import type { SystemTaskRunnerMode, SystemTasksBridge } from './types';

export function createSystemTaskBridge(options: Readonly<{
    mode: SystemTaskRunnerMode;
}>): SystemTasksBridge {
    if (options.mode === 'tauri') {
        return createTauriSystemTaskBridge();
    }
    if (options.mode === 'dev') {
        return createDeterministicSystemTaskBridge();
    }
    return createUnavailableSystemTaskBridge();
}
