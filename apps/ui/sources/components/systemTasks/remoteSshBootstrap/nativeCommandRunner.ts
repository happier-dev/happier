import type {
    NativeSshExecRequest,
    NativeSshExecResult,
    NativeSshHostKeyVerification,
    NativeSshModule,
    NativeSshTaskCredentials,
} from '../bridges/native';

const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;
const DEFAULT_AUTH_TIMEOUT_MS = 30_000;
const DEFAULT_EXEC_TIMEOUT_MS = 120_000;

export type NativeSshCommandRunnerOptions = Readonly<{
    nativeSsh: NativeSshModule;
    credentials: NativeSshTaskCredentials;
    hostKeyVerification?: NativeSshHostKeyVerification;
    connectTimeoutMs?: number;
    authTimeoutMs?: number;
    execTimeoutMs?: number;
}>;

export async function runNativeSshCommand(
    options: NativeSshCommandRunnerOptions,
    command: string,
): Promise<NativeSshExecResult> {
    const request: NativeSshExecRequest = {
        host: options.credentials.host,
        port: options.credentials.port,
        username: options.credentials.username,
        command,
        auth: options.credentials.auth,
        connectTimeoutMs: options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS,
        authTimeoutMs: options.authTimeoutMs ?? DEFAULT_AUTH_TIMEOUT_MS,
        execTimeoutMs: options.execTimeoutMs ?? DEFAULT_EXEC_TIMEOUT_MS,
        hostKeyVerification: options.hostKeyVerification ?? {
            decision: 'reject',
            reason: 'host key trust has not been approved',
        },
    };

    return await options.nativeSsh.exec(request);
}

export function parseNativeSshJsonResult(result: NativeSshExecResult): Record<string, unknown> {
    const text = String(result.stdout ?? '').trim();
    if (!text) throw new Error('Native SSH command did not return JSON.');
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('Native SSH command returned non-object JSON.');
    }
    return parsed as Record<string, unknown>;
}
