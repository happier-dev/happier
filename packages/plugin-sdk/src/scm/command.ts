import {
    readCurrentScmBackendRuntimeServices,
    type ScmBackendCommandRunResult,
} from './backend.js';

export type ScmBackendCommandSpec = Readonly<{
    installableKey: string;
    command: string;
    unavailableLabel?: string;
}>;

export type ScmBackendCommandInput = Readonly<{
    cwd: string;
    args: readonly string[];
    timeoutMs?: number;
    stdin?: string;
    maxOutputBytes?: number;
    env?: Readonly<Record<string, string | undefined>>;
}>;

const DEFAULT_SCM_BACKEND_COMMAND_MAX_OUTPUT_BYTES = 4 * 1024 * 1024;

export function resolveScmBackendCommandMaxOutputBytes(input?: Readonly<{
    inputMaxOutputBytes?: number;
    envValue?: string | null;
    defaultMaxOutputBytes?: number;
}>): number {
    const defaultMaxOutputBytes = input?.defaultMaxOutputBytes ?? DEFAULT_SCM_BACKEND_COMMAND_MAX_OUTPUT_BYTES;
    if (
        typeof input?.inputMaxOutputBytes === 'number'
        && Number.isFinite(input.inputMaxOutputBytes)
        && input.inputMaxOutputBytes > 0
    ) {
        return Math.floor(input.inputMaxOutputBytes);
    }

    const envValue = input?.envValue;
    if (envValue) {
        const parsed = Number(envValue);
        if (Number.isFinite(parsed) && parsed > 0) {
            return Math.floor(parsed);
        }
    }

    return defaultMaxOutputBytes;
}

export function runScmBackendCommand(
    command: ScmBackendCommandSpec,
    input: ScmBackendCommandInput,
): Promise<ScmBackendCommandRunResult> {
    const runtimeServices = readCurrentScmBackendRuntimeServices();
    if (!runtimeServices) {
        return Promise.resolve({
            success: false,
            stdout: '',
            stderr: `SCM command runner is unavailable for ${command.unavailableLabel ?? command.command}`,
            exitCode: -1,
        });
    }

    return runtimeServices.runCommand({
        installableKey: command.installableKey,
        command: command.command,
        cwd: input.cwd,
        args: input.args,
        timeoutMs: input.timeoutMs,
        stdin: input.stdin,
        maxOutputBytes: input.maxOutputBytes,
        env: input.env,
    });
}
