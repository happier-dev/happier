import { isTauriDesktop } from '@/utils/platform/tauri';

import { buildLocalMachineSetupSystemTaskSpec } from './buildLocalMachineSetupSystemTaskSpec';
import { createSystemTaskBridge } from './createSystemTaskBridge';
import { createSystemTaskRunner } from './createSystemTaskRunner';
import type { SystemTaskRunner, SystemTaskRunnerMode } from './types';

let sharedRunner: SystemTaskRunner | null = null;

function resolveRunnerMode(): SystemTaskRunnerMode {
    const explicitMode = String(process.env.EXPO_PUBLIC_SYSTEM_TASKS_RUNNER_MODE ?? '').trim();
    if (explicitMode === 'tauri' || explicitMode === 'native' || explicitMode === 'dev' || explicitMode === 'unavailable') {
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
    const bridge = createSystemTaskBridge({
        mode,
    });
    sharedRunner = createSystemTaskRunner({ bridge, mode });
    return sharedRunner;
}

export function buildDefaultThisComputerTaskSpec() {
    return buildLocalMachineSetupSystemTaskSpec();
}
