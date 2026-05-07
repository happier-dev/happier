import {
    type NativeSshExecRequest,
    type NativeSshExecResult,
    type NativeSshHostKeyVerification,
    type NativeSshModule,
} from '@happier-dev/ssh-native';

import type { NativeSshTaskCredentials } from '../bridges/native';

export type NativeRemoteSshCommandRunner = Readonly<{
    runJsonCommand: (params: Readonly<{
        command: string;
        credentials: NativeSshTaskCredentials;
        hostKeyDecision?: NativeSshHostKeyVerification;
        nativeModule: NativeSshModule;
        signal?: AbortSignal;
        requestIdPrefix?: string;
    }>) => Promise<unknown>;
    runTextCommand: (params: Readonly<{
        command: string;
        credentials: NativeSshTaskCredentials;
        hostKeyDecision?: NativeSshHostKeyVerification;
        nativeModule: NativeSshModule;
        signal?: AbortSignal;
        requestIdPrefix?: string;
        execTimeoutMs?: number;
    }>) => Promise<Readonly<{
        status: number;
        stdout: string;
        stderr: string;
    }>>;
}>;

function parseJsonOutput(result: NativeSshExecResult): unknown {
    const text = result.stdout.trim();
    if (text) {
        const parsed = JSON.parse(text);
        if (result.exitCode !== 0 && parsed && typeof parsed === 'object' && 'ok' in parsed) {
            return parsed;
        }
        if (result.exitCode === 0) {
            return parsed;
        }
    }
    if (result.exitCode !== 0) {
        throw new Error('native_ssh_command_failed');
    }
    return null;
}

let nextNativeSshRequestNumber = 1;

function createNativeSshRequestId(prefix?: string): string {
    const safePrefix = String(prefix ?? '').trim().replace(/[^A-Za-z0-9._:-]+/g, '-')
        || 'native-ssh-command';
    return `${safePrefix}:exec-${nextNativeSshRequestNumber++}`;
}

export function createNativeRemoteSshCommandRunner(): NativeRemoteSshCommandRunner {
    async function execCommand(params: Readonly<{
        command: string;
        credentials: NativeSshTaskCredentials;
        hostKeyDecision?: NativeSshHostKeyVerification;
        nativeModule: NativeSshModule;
        signal?: AbortSignal;
        requestIdPrefix?: string;
        execTimeoutMs?: number;
    }>): Promise<NativeSshExecResult> {
        if (params.signal?.aborted) {
            throw new Error('native_ssh_task_cancelled');
        }
        const requestId = createNativeSshRequestId(params.requestIdPrefix);
        const request = {
            requestId,
            host: params.credentials.host,
            port: params.credentials.port,
            username: params.credentials.username,
            command: params.command,
            auth: params.credentials.auth,
            hostKeyVerification: params.hostKeyDecision ?? {
                decision: 'prompt',
            },
            connectTimeoutMs: 15_000,
            authTimeoutMs: 15_000,
            execTimeoutMs: params.execTimeoutMs ?? 120_000,
        } satisfies NativeSshExecRequest;
        const cancelNativeRequest = () => {
            void params.nativeModule.cancelRequest(requestId).catch(() => {});
        };
        params.signal?.addEventListener('abort', cancelNativeRequest, { once: true });
        try {
            const result = await params.nativeModule.exec(request);
            if (params.signal?.aborted) {
                throw new Error('native_ssh_task_cancelled');
            }
            return result;
        } finally {
            params.signal?.removeEventListener('abort', cancelNativeRequest);
        }
    }

    return {
        async runJsonCommand(params) {
            return parseJsonOutput(await execCommand(params));
        },
        async runTextCommand(params) {
            const result = await execCommand(params);
            return {
                status: result.exitCode ?? 1,
                stdout: result.stdout,
                stderr: result.stderr,
            };
        },
    };
}
