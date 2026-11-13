import { projectSessionRuntimeFailureCause } from '@happier-dev/protocol/sessions/control/runtimeIssueV1';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PluginError } from '@happier-dev/plugin-sdk';
import { resolveConfiguredNativeHomePath, writeAtomicJsonFile } from '@happier-dev/plugin-sdk/fs';

import { resolveClaudeConfigDirOverride } from '../../environment.js';

/** Prepare the explicitly selected native home, never copy another Claude account's config. */
export async function prepareClaudeTerminalConfigHome(
  env: Readonly<Record<string, string | undefined>>,
): Promise<void> {
  const override = resolveClaudeConfigDirOverride(env);
  if (!override) return;
  const root = resolveConfiguredNativeHomePath({
    environmentKey: 'CLAUDE_CONFIG_DIR', defaultRelativePath: '.claude',
  }, { ...env, CLAUDE_CONFIG_DIR: override });
  const path = join(root, '.claude.json');
  let config: Record<string, unknown> = {};
  try {
    let bytes: string | null;
    try { bytes = await readFile(path, 'utf8'); }
    catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
      bytes = null;
    }
    if (bytes !== null) {
      const value: unknown = JSON.parse(bytes);
      if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        throw new TypeError('Claude native config must be an object');
      }
      config = value as Record<string, unknown>;
    }
    if (config.hasCompletedOnboarding === true && config.theme !== undefined) return;
    // Claude Code 2.1.296 gates the theme/security onboarding on this field.
    // Workspace trust is separate: preserve every project trust record unchanged.
    await writeAtomicJsonFile({ path, mode: 0o600, value: {
      ...config, hasCompletedOnboarding: true, theme: config.theme ?? 'dark',
    } });
  } catch (error) {
    const failureCause = projectSessionRuntimeFailureCause(error, 'client_start', 'agent.launch');
    throw new PluginError({
      code: 'claude_terminal_config_unavailable',
      ...(failureCause ? { details: { failureCause } } : {}),
      message: 'Claude setup could not be prepared. Repair the selected Claude config home and retry this Session.',
    }, { cause: error });
  }
}
