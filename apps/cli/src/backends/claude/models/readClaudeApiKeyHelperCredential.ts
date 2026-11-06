import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { killProcessTree } from '@/agent/runtime/process/killProcessTree';
import { withCatalogProbeLifecycle, type CatalogProbeLifecycle, type RegisterNativeCatalogCleanup } from '@/capabilities/probes/catalogProbeLifecycle';
import { logger } from '@/ui/logger';

// Claude Code validates helper tokens against this limit before using them in HTTP headers.
// https://code.claude.com/docs/en/errors#your-apikeyhelper-script-is-failing
const MAX_HELPER_TOKEN_LENGTH = 16_384;

export type ClaudeApiKeyHelperCredential =
  | Readonly<{ status: 'absent' }>
  | Readonly<{ status: 'failed' }>
  | Readonly<{ status: 'ok'; value: string }>;

/**
 * Read only the selected user settings: project helpers require Claude Code's workspace trust.
 * A missing helper or ignored invalid settings allow fallback; configured helper failure is terminal.
 * The caller owns the deadline; helper execution and cleanup consume that same lifecycle.
 */
export async function readClaudeApiKeyHelperCredential(params: CatalogProbeLifecycle & Readonly<{
  claudeConfigDir: string;
  env: NodeJS.ProcessEnv;
  onNativeCleanup?: RegisterNativeCatalogCleanup;
}>): Promise<ClaudeApiKeyHelperCredential> {
  let child: ReturnType<typeof spawn> | undefined;
  let childClosed: Promise<void> | undefined;
  let cleanupPromise: Promise<void> | undefined;
  const cleanup = () => cleanupPromise ??= (async () => {
    try {
      if (child) await killProcessTree(child);
    } finally {
      // An exited shell may leave a background process holding this pipe. The shell's PID
      // is no longer ours to terminate, but closing our reader must still settle cleanup.
      child?.stdout?.destroy();
      await childClosed;
    }
  })();
  try {
    const result = await withCatalogProbeLifecycle(params, async (lifecycle): Promise<ClaudeApiKeyHelperCredential> => {
      let settings: unknown;
      try {
        settings = JSON.parse(await readFile(join(params.claudeConfigDir, 'settings.json'), { encoding: 'utf8', signal: lifecycle.signal }));
      } catch (error) {
        if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
          return { status: 'absent' };
        }
        // Claude Code's non-interactive path skips malformed user JSON; no helper was loaded.
        // https://code.claude.com/docs/en/settings#fix-a-broken-settings-file
        if (error instanceof SyntaxError) {
          logger.warnFile('[claude-models] Invalid user settings JSON; apiKeyHelper settings skipped');
          return { status: 'absent' };
        }
        throw error;
      }
      if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
        logger.warnFile('[claude-models] Invalid user settings root; apiKeyHelper settings skipped');
        return { status: 'absent' };
      }
      const command = (settings as Record<string, unknown>).apiKeyHelper;
      if (command === undefined || command === null || command === '') return { status: 'absent' };
      if (typeof command !== 'string' || command.trim().length === 0) return { status: 'failed' };
      lifecycle.signal.throwIfAborted();

      const value = await new Promise<string | null>((resolve) => {
        const started = spawn(command, {
          shell: true,
          env: params.env,
          stdio: ['ignore', 'pipe', 'ignore'],
          windowsHide: true,
        });
        child = started;
        childClosed = new Promise<void>((closed) => started.once('close', () => closed()));
        params.onNativeCleanup?.(cleanup);
        let token = '';
        let ended = false;
        let invalid = false;
        // Retain only the bounded token. Surrounding whitespace is discarded incrementally,
        // so a valid maximum-length token plus a shell newline is never truncated/rejected.
        started.stdout?.setEncoding('utf8');
        started.stdout?.on('data', (chunk: string) => {
          if (invalid) return;
          for (const character of chunk) {
            if (/\s/u.test(character)) {
              if (token.length > 0) ended = true;
            } else if (ended || !/[\x21-\x7e]/u.test(character) || token.length >= MAX_HELPER_TOKEN_LENGTH) {
              invalid = true;
              resolve(null);
              return;
            } else {
              token += character;
            }
          }
        });
        started.once('error', () => resolve(null));
        started.once('close', (code) => resolve(code === 0 && !invalid && token.length > 0 ? token : null));
      });
      return value === null ? { status: 'failed' } : { status: 'ok', value };
    }, cleanup);
    if (result.status === 'failed') logger.warnFile('[claude-models] Configured apiKeyHelper did not produce a usable credential');
    return result;
  } catch {
    // Never include the command, output, environment, or OS error: all may contain credentials.
    logger.warnFile('[claude-models] apiKeyHelper unavailable or cancelled; model discovery skipped');
    return { status: 'failed' };
  }
}
