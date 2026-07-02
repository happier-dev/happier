import { readCodeRabbitReviewConfigFromEnv } from './config.js';
import { preflightCodeRabbitReviewScope, type CodeRabbitReviewScopeFacts } from './scopePreflight.js';

export type CodeRabbitReviewStartPreflightResult =
  | Readonly<{ ok: true }>
  | Readonly<{ ok: false; reason: string }>;

export async function runCodeRabbitReviewStartPreflight(params: Readonly<{
  cwd: string;
  env?: Readonly<Record<string, unknown>>;
  intentInput: unknown;
  scope?: CodeRabbitReviewScopeFacts | null;
}>): Promise<CodeRabbitReviewStartPreflightResult> {
  const env = params.env ?? {};
  if (String(env.CODERABBIT_API_KEY ?? '').trim().length === 0) {
    return {
      ok: false,
      reason: 'CodeRabbit review requires CODERABBIT_API_KEY. Configure the CodeRabbit API key before starting a review.',
    };
  }

  const config = readCodeRabbitReviewConfigFromEnv(env);
  try {
    const preflight = await preflightCodeRabbitReviewScope({
      cwd: params.cwd,
      intentInput: params.intentInput,
      scope: params.scope ?? null,
      maxEligibleFiles: config.maxEligibleFiles,
    });
    return preflight.ok ? { ok: true } : { ok: false, reason: preflight.error };
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error ? error.message : 'Execution run not allowed',
    };
  }
}
