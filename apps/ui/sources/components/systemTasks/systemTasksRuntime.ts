import { isTauriDesktop } from '@/utils/platform/tauri';
import { Platform } from 'react-native';

import { buildLocalMachineSetupSystemTaskSpec } from './buildLocalMachineSetupSystemTaskSpec';
import { createSystemTaskBridge } from './createSystemTaskBridge';
import { createSystemTaskRunner } from './createSystemTaskRunner';
import type { SystemTaskRunner, SystemTaskRunnerMode } from './types';
import { resolveDefaultNativeSshSystemTaskCapability } from './bridges/native';

let sharedRunner: SystemTaskRunner | null = null;

function resolveRunnerMode(): SystemTaskRunnerMode {
    const explicitMode = String(process.env.EXPO_PUBLIC_SYSTEM_TASKS_RUNNER_MODE ?? '').trim();
    if (explicitMode === 'tauri' || explicitMode === 'native' || explicitMode === 'dev' || explicitMode === 'unavailable') {
        return explicitMode;
    }
    if (isTauriDesktop()) {
        return 'tauri';
    }
    if (Platform.OS === 'ios' || Platform.OS === 'android') {
        return 'native';
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
    const nativeSshCapability = mode === 'native'
        ? resolveDefaultNativeSshSystemTaskCapability({
            platformOS: Platform.OS,
            buildIncluded: String(process.env.HAPPIER_ENABLE_NATIVE_SSH ?? '').trim() === '1',
        })
        : undefined;
    const bridge = createSystemTaskBridge({
        mode,
        nativeSshCapability,
    });
    sharedRunner = createSystemTaskRunner({ bridge, mode });
    return sharedRunner;
}

export function buildDefaultThisComputerTaskSpec() {
    return buildLocalMachineSetupSystemTaskSpec();
}
