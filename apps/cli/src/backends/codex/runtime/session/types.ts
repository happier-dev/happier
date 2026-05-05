import type {
    HostSessionRuntimeConfig,
    HostSessionRuntimeRunOptions,
} from '@/agent/runtime/session/loop/runHostSessionRuntime';
import type { RuntimeTurnOperations } from '@/agent/runtime/turns/runtimeTurnOperations';
import type { CodexBackendMode } from '@happier-dev/agents';

export type CodexRuntimeMode = 'terminal' | 'remote';
export type CodexHostStartingMode = 'local' | 'remote';

export function codexRuntimeModeFromHostStartingMode(
    startingMode: CodexHostStartingMode | null | undefined,
): CodexRuntimeMode | null {
    if (startingMode === 'local') {
        return 'terminal';
    }
    if (startingMode === 'remote') {
        return 'remote';
    }
    return null;
}

export function codexRuntimeModeToHostStartingMode(
    runtimeMode: CodexRuntimeMode,
): CodexHostStartingMode {
    return runtimeMode === 'terminal' ? 'local' : 'remote';
}

export type CodexSessionRuntimeOptions = HostSessionRuntimeRunOptions & Readonly<{
    startingMode?: CodexHostStartingMode;
    codexBackendMode?: CodexBackendMode;
}>;

export type CodexRuntimeFactoryParams = Parameters<NonNullable<HostSessionRuntimeConfig['createSessionRuntime']>>[0];

export type CodexNativeRuntime = RuntimeTurnOperations & Partial<{
    shouldResumeAfterPermissionModeChange: () => boolean;
    supportsInFlightSteer: () => boolean;
    isTurnInFlight: () => boolean;
    steerPrompt: (prompt: string) => Promise<void>;
}>;
