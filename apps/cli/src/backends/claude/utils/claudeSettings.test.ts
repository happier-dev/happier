/**
 * Tests for Claude co-authored-by behavior.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, writeFileSync, unlinkSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { shouldIncludeCoAuthoredBy } from './claudeSettings';

describe('Claude Settings', () => {
  let testClaudeDir: string;
  let originalClaudeConfigDir: string | undefined;
  let originalIncludeCoauthoredByEnv: string | undefined;

  beforeEach(() => {
    // Create a temporary directory for testing
    testClaudeDir = join(tmpdir(), `test-claude-${Date.now()}`);
    mkdirSync(testClaudeDir, { recursive: true });
    
    // Set environment variable to point to test directory
    originalClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = testClaudeDir;
    originalIncludeCoauthoredByEnv = process.env.HAPPIER_SCM_INCLUDE_CO_AUTHORED_BY;
    delete process.env.HAPPIER_SCM_INCLUDE_CO_AUTHORED_BY;
  });

  afterEach(() => {
    // Restore original environment variable
    if (originalClaudeConfigDir !== undefined) {
      process.env.CLAUDE_CONFIG_DIR = originalClaudeConfigDir;
    } else {
      delete process.env.CLAUDE_CONFIG_DIR;
    }
    if (originalIncludeCoauthoredByEnv !== undefined) {
      process.env.HAPPIER_SCM_INCLUDE_CO_AUTHORED_BY = originalIncludeCoauthoredByEnv;
    } else {
      delete process.env.HAPPIER_SCM_INCLUDE_CO_AUTHORED_BY;
    }
    
    // Clean up test directory
    if (existsSync(testClaudeDir)) {
      rmSync(testClaudeDir, { recursive: true, force: true });
    }
  });

  describe('shouldIncludeCoAuthoredBy', () => {
    it('defaults to false when env is unset', () => {
      expect(shouldIncludeCoAuthoredBy()).toBe(false);
    });

    it('honors HAPPIER_SCM_INCLUDE_CO_AUTHORED_BY=1 even when file says false', () => {
      const settingsPath = join(testClaudeDir, 'settings.json');
      writeFileSync(settingsPath, JSON.stringify({ includeCoAuthoredBy: false }));
      process.env.HAPPIER_SCM_INCLUDE_CO_AUTHORED_BY = '1';

      expect(shouldIncludeCoAuthoredBy()).toBe(true);
    });

    it('honors HAPPIER_SCM_INCLUDE_CO_AUTHORED_BY=0 even when file says true', () => {
      const settingsPath = join(testClaudeDir, 'settings.json');
      writeFileSync(settingsPath, JSON.stringify({ includeCoAuthoredBy: true }));
      process.env.HAPPIER_SCM_INCLUDE_CO_AUTHORED_BY = '0';

      expect(shouldIncludeCoAuthoredBy()).toBe(false);
    });

    it('does not read Claude settings.json (file cannot enable it)', () => {
      const settingsPath = join(testClaudeDir, 'settings.json');
      writeFileSync(settingsPath, JSON.stringify({ includeCoAuthoredBy: true }));
      expect(shouldIncludeCoAuthoredBy()).toBe(false);
    });
  });
});
