import { exec } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const API_KEY_HELPER_MAX_OUTPUT_BYTES = 64 * 1024;

function readApiKeyHelperCommand(settingsJson: string): string | null {
  try {
    const settings: unknown = JSON.parse(settingsJson);
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) return null;
    const command = (settings as Record<string, unknown>).apiKeyHelper;
    return typeof command === 'string' && command.trim().length > 0 ? command : null;
  } catch {
    return null;
  }
}

/**
 * Run the `apiKeyHelper` from the Claude Code user settings the way Claude Code does: through the
 * shell, with the session environment, using its trimmed stdout as the key.
 *
 * Gateways commonly hand Claude Code short-lived keys through this helper instead of an env var, so
 * model discovery needs it to authenticate as the session will. Only the user settings of the
 * configured config dir are read: project settings come from the repository, and Claude Code runs a
 * project helper only after the workspace is trusted. Returns `null` on any failure. Never throws.
 */
export async function readClaudeApiKeyHelperCredential(params: Readonly<{
  claudeConfigDir: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
}>): Promise<string | null> {
  let command: string | null;
  try {
    command = readApiKeyHelperCommand(await readFile(join(params.claudeConfigDir, 'settings.json'), 'utf8'));
  } catch {
    return null;
  }
  if (!command) return null;

  return await new Promise((resolvePromise) => {
    const child = exec(
      command,
      {
        env: params.env,
        timeout: Math.max(250, params.timeoutMs),
        maxBuffer: API_KEY_HELPER_MAX_OUTPUT_BYTES,
        windowsHide: true,
      },
      (error, stdout) => {
        const key = error ? '' : String(stdout).trim();
        resolvePromise(key.length > 0 ? key : null);
      },
    );
    // A helper that reads stdin must see EOF rather than wait for the timeout.
    child.stdin?.end();
  });
}
