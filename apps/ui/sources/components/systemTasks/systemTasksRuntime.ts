import { isTauriDesktop } from '@/utils/platform/tauri';

import { buildLocalMachineSetupSystemTaskSpec } from './buildLocalMachineSetupSystemTaskSpec';
import { createDeterministicSystemTaskBridge } from './createDeterministicSystemTaskBridge';
import { createSystemTaskRunner } from './createSystemTaskRunner';
import { createTauriSystemTaskBridge } from './createTauriSystemTaskBridge';
import { createUnavailableSystemTaskBridge } from './createUnavailableSystemTaskBridge';
import type { SystemTaskRunner, SystemTaskRunnerMode } from './types';

let sharedRunner: SystemTaskRunner | null = null;

function resolveRunnerMode(): SystemTaskRunnerMode {
    const explicitMode = String(process.env.EXPO_PUBLIC_SYSTEM_TASKS_RUNNER_MODE ?? '').trim();
    if (explicitMode === 'tauri' || explicitMode === 'dev' || explicitMode === 'unavailable') {
        return explicitMode;
    }
    if (isTauriDesktop()) {
        return 'tauri';
    }
    if (process.env.NODE_ENV === 'test') {
        return 'dev';
    }
    return 'unavailable';
}

export function getSystemTasksRunner(): SystemTaskRunner {
    if (sharedRunner) {
        return sharedRunner;
    }

    const mode = resolveRunnerMode();
    const bridge = mode === 'tauri'
        ? createTauriSystemTaskBridge()
        : (mode === 'dev'
            ? createDeterministicSystemTaskBridge()
            : createUnavailableSystemTaskBridge());
    sharedRunner = createSystemTaskRunner({ bridge, mode });
    return sharedRunner;
}

export function buildDefaultThisComputerTaskSpec() {
    return buildLocalMachineSetupSystemTaskSpec();
}
