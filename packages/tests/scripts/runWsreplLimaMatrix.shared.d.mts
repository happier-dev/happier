export function resolveWsreplLimaMatrixScriptPath(env: NodeJS.ProcessEnv, repoRoot?: string): string;

export function resolveWsreplLimaMatrixWorkingDirectory(repoRoot?: string): string;

export type WsreplLimaMatrixInvocationFailure = {
  ok: false;
  exitCode: number;
  message: string;
};

export type WsreplLimaMatrixInvocationSuccess = {
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
};

export function resolveWsreplLimaMatrixInvocation(params: {
  argv: readonly string[];
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  repoRoot?: string;
}): WsreplLimaMatrixInvocationFailure | WsreplLimaMatrixInvocationSuccess;
