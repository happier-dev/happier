import { Platform } from 'react-native';

import { isTauriDesktop } from '@/utils/platform/tauri';

import { buildLocalMachineSetupSystemTaskSpec } from './buildLocalMachineSetupSystemTaskSpec';
import { createSystemTaskBridge } from './createSystemTaskBridge';
import { createSystemTaskRunner } from './createSystemTaskRunner';
import type { SystemTaskRunner, SystemTaskRunnerMode } from './types';

let sharedRunner: SystemTaskRunner | null = null;

export function resolveSystemTaskRunnerMode(params: Readonly<{
    explicitMode: string;
    isTauri: boolean;
    nodeEnv: string | undefined;
    platformOS: string;
}>): SystemTaskRunnerMode {
    const explicitMode = params.explicitMode.trim();
    if (explicitMode === 'tauri' || explicitMode === 'native' || explicitMode === 'dev' || explicitMode === 'unavailable') {
        return explicitMode;
    }
    if (params.isTauri) {
        return 'tauri';
    }
    if (params.platformOS === 'ios' || params.platformOS === 'android') {
        return 'native';
    }
    if (params.nodeEnv === 'test') {
        return 'dev';
    }
    return 'unavailable';
}

function resolveRunnerMode(): SystemTaskRunnerMode {
    return resolveSystemTaskRunnerMode({
        explicitMode: String(process.env.EXPO_PUBLIC_SYSTEM_TASKS_RUNNER_MODE ?? ''),
        isTauri: isTauriDesktop(),
        nodeEnv: process.env.NODE_ENV,
        platformOS: String(Platform.OS ?? ''),
    });
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
