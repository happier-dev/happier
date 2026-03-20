import type { JsRuntime } from '@/backends/claude/runClaude';
import { ensureJavaScriptRuntimeExecutable } from '@/runtime/js/ensureJavaScriptRuntimeExecutable';
import { isBun } from '@/utils/runtime';

export async function ensureClaudeJsRuntimeExecutable(jsRuntime?: JsRuntime): Promise<string | undefined> {
  if (jsRuntime === 'bun') return 'bun';
  return await ensureJavaScriptRuntimeExecutable({ isBunRuntime: isBun() }) ?? undefined;
}
