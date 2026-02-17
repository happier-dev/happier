/**
 * Utilities for reading Claude's settings.json configuration
 * 
 * Handles reading Claude's settings.json file to respect user preferences
 * like includeCoAuthoredBy setting for commit message generation.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { logger } from '@/ui/logger';

export interface ClaudeSettings {
  includeCoAuthoredBy?: boolean;
  [key: string]: any;
}

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
 * Read Claude's settings.json file from the default location
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
