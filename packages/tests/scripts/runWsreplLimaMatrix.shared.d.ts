export interface WsreplLimaMatrixInvocationFailure {
    ok: false;
    exitCode: number;
    message: string;
}

export interface WsreplLimaMatrixInvocationSuccess {
    ok: true;
    command: string;
    args: string[];
    configLabel: string;
    spawnOptions: {
        stdio: 'inherit';
        env: NodeJS.ProcessEnv;
        cwd: string;
        detached: boolean;
    };
}

export type WsreplLimaMatrixInvocation = WsreplLimaMatrixInvocationFailure | WsreplLimaMatrixInvocationSuccess;

export function resolveWsreplLimaMatrixScriptPath(env: NodeJS.ProcessEnv, repoRoot?: string): string;
export function resolveWsreplLimaMatrixWorkingDirectory(repoRoot?: string): string;
export function resolveWsreplLimaMatrixInvocation(params: {
    argv: string[];
    env: NodeJS.ProcessEnv;
    platform: NodeJS.Platform;
    repoRoot?: string;
}): WsreplLimaMatrixInvocation;
