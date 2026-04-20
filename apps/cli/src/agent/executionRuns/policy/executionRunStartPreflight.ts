export type ExecutionRunStartIntentPolicyResult =
  | Readonly<{ ok: true }>
  | Readonly<{ ok: false; error: string; errorCode: string }>;

export type ExecutionRunIntentStartPreflightParams = Readonly<{
  backendId: string;
  intentInput?: unknown;
  cwd: string;
  env: NodeJS.ProcessEnv;
}>;

export function executionRunStartNotAllowed(error: string): ExecutionRunStartIntentPolicyResult {
  return { ok: false, error, errorCode: 'execution_run_not_allowed' };
}
