/**
 * Utilities for reading Claude's settings.json configuration
 *
 * Handles reading Claude's settings.json file to respect user preferences
 * like includeCoAuthoredBy setting for commit message generation.
 */

import { existsSync, readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { logger } from '@/ui/logger';

export interface ClaudeSettings {
  includeCoAuthoredBy?: boolean;
  [key: string]: any;
}

/** Maximum time to wait for settings file read before giving up. */
const SETTINGS_READ_TIMEOUT_MS = 5_000;

/**
 * Get the path to Claude's settings.json file
 */
function getClaudeSettingsPath(claudeConfigDirOverride?: string | null): string {
  const override = typeof claudeConfigDirOverride === 'string' ? claudeConfigDirOverride.trim() : '';
  const claudeConfigDir =
    override.length > 0 ? override : (process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'));
  return join(claudeConfigDir, 'settings.json');
}

/**
 * Read Claude's settings.json file synchronously.
 *
 * WARNING: This can block indefinitely if the settings file is on a slow or
 * inaccessible filesystem (e.g. iCloud Drive symlinks in a LaunchAgent
 * context on macOS). Prefer readClaudeSettingsAsync() for startup-critical
 * code paths.
 *
 * @returns Claude settings object or null if file doesn't exist or can't be read
 */
export function readClaudeSettings(claudeConfigDirOverride?: string | null): ClaudeSettings | null {
  try {
    const settingsPath = getClaudeSettingsPath(claudeConfigDirOverride);

    if (!existsSync(settingsPath)) {
      logger.debug(`[ClaudeSettings] No Claude settings file found at ${settingsPath}`);
      return null;
    }

    const settingsContent = readFileSync(settingsPath, 'utf-8');
    const settings = JSON.parse(settingsContent) as ClaudeSettings;

    logger.debug(`[ClaudeSettings] Successfully read Claude settings from ${settingsPath}`);
    logger.debug(`[ClaudeSettings] includeCoAuthoredBy: ${settings.includeCoAuthoredBy}`);

    return settings;
  } catch (error) {
    logger.debug(`[ClaudeSettings] Error reading Claude settings: ${error}`);
    return null;
  }
}

/**
 * Read Claude's settings.json file asynchronously with a timeout.
 *
 * This is the preferred method for startup-critical code paths. It will not
 * block indefinitely if the settings file is on a slow or inaccessible
 * filesystem (e.g. symlinks to iCloud Drive in LaunchAgent/daemon context
 * on macOS where TCC entitlements may prevent filesystem access).
 *
 * @returns Claude settings object or null if file doesn't exist, can't be read, or times out
 */
export async function readClaudeSettingsAsync(claudeConfigDirOverride?: string | null): Promise<ClaudeSettings | null> {
  try {
    const settingsPath = getClaudeSettingsPath(claudeConfigDirOverride);

    if (!existsSync(settingsPath)) {
      logger.debug(`[ClaudeSettings] No Claude settings file found at ${settingsPath}`);
      return null;
    }

    const settingsContent = await readFile(settingsPath, {
      encoding: 'utf-8',
      signal: AbortSignal.timeout(SETTINGS_READ_TIMEOUT_MS),
    });
    const settings = JSON.parse(settingsContent) as ClaudeSettings;

    logger.debug(`[ClaudeSettings] Successfully read Claude settings from ${settingsPath}`);
    logger.debug(`[ClaudeSettings] includeCoAuthoredBy: ${settings.includeCoAuthoredBy}`);

    return settings;
  } catch (error) {
    if (error instanceof Error && error.name === 'TimeoutError') {
      logger.debug(`[ClaudeSettings] Timed out reading settings after ${SETTINGS_READ_TIMEOUT_MS}ms — file may be on a slow or inaccessible filesystem`);
    } else {
      logger.debug(`[ClaudeSettings] Error reading Claude settings: ${error}`);
    }
    return null;
  }
}

/**
 * Check if Co-Authored-By lines should be included in commit messages
 * based on Claude's settings
 *
 * @returns true if Co-Authored-By should be included, false otherwise
 */
export function shouldIncludeCoAuthoredBy(): boolean {
  const envRaw = typeof process.env.HAPPIER_SCM_INCLUDE_CO_AUTHORED_BY === 'string'
    ? process.env.HAPPIER_SCM_INCLUDE_CO_AUTHORED_BY.trim()
    : '';
  if (envRaw === '1') return true;
  if (envRaw === '0') return false;

  const settings = readClaudeSettings();

  // Opt-in: only enable attribution when explicitly configured.
  if (!settings) return false;
  return settings.includeCoAuthoredBy === true;
}
