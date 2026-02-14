import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getProjectPath } from './path';
import { join } from 'node:path';

let previousClaudeConfigDir: string | undefined;

function restoreClaudeConfigDir(value: string | undefined): void {
  if (value === undefined) {
    delete process.env.CLAUDE_CONFIG_DIR;
    return;
  }
  process.env.CLAUDE_CONFIG_DIR = value;
}

describe('getProjectPath', () => {
  beforeEach(() => {
    previousClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
    delete process.env.CLAUDE_CONFIG_DIR;
  });

  afterEach(() => {
    restoreClaudeConfigDir(previousClaudeConfigDir);
  });

  it('should replace slashes with hyphens in the project path', () => {
    process.env.CLAUDE_CONFIG_DIR = '/test/home/.claude';
    const workingDir = '/Users/steve/projects/my-app';
    const result = getProjectPath(workingDir);
    expect(result).toBe(join('/test/home/.claude', 'projects', '-Users-steve-projects-my-app'));
  });

  it('should replace dots with hyphens in the project path', () => {
    process.env.CLAUDE_CONFIG_DIR = '/test/home/.claude';
    const workingDir = '/Users/steve/projects/app.test.js';
    const result = getProjectPath(workingDir);
    expect(result).toBe(join('/test/home/.claude', 'projects', '-Users-steve-projects-app-test-js'));
  });

  it('should handle paths with both slashes and dots', () => {
    process.env.CLAUDE_CONFIG_DIR = '/test/home/.claude';
    const workingDir = '/var/www/my.site.com/public';
    const result = getProjectPath(workingDir);
    expect(result).toBe(join('/test/home/.claude', 'projects', '-var-www-my-site-com-public'));
  });

  it('should replace all non [a-zA-Z0-9-] characters to match Claude Code parity', () => {
    process.env.CLAUDE_CONFIG_DIR = '/test/home/.claude';

    expect(getProjectPath('/Users/alice/@work/repo')).toBe(
      join('/test/home/.claude', 'projects', '-Users-alice--work-repo'),
    );

    expect(getProjectPath('/Users/alice/projects/repo (v2) [x]')).toBe(
      join('/test/home/.claude', 'projects', '-Users-alice-projects-repo--v2---x-'),
    );

    expect(getProjectPath('/Users/alice/projects/repo+test#1')).toBe(
      join('/test/home/.claude', 'projects', '-Users-alice-projects-repo-test-1'),
    );

    expect(getProjectPath('/Users/alice/~ scratch/repo')).toBe(
      join('/test/home/.claude', 'projects', '-Users-alice---scratch-repo'),
    );
  });

  it('should handle relative paths by resolving them first', () => {
    process.env.CLAUDE_CONFIG_DIR = '/test/home/.claude';
    const workingDir = './my-project';
    const result = getProjectPath(workingDir);
    expect(result).toContain(join('/test/home/.claude', 'projects'));
    expect(result).toContain('my-project');
  });

  it('should handle empty directory path', () => {
    process.env.CLAUDE_CONFIG_DIR = '/test/home/.claude';
    const workingDir = '';
    const result = getProjectPath(workingDir);
    expect(result).toContain(join('/test/home/.claude', 'projects'));
  });

  describe('CLAUDE_CONFIG_DIR support', () => {
    it('should prefer explicit claudeConfigDir argument over process.env.CLAUDE_CONFIG_DIR', () => {
      process.env.CLAUDE_CONFIG_DIR = '/env/claude/config';
      const workingDir = '/Users/steve/projects/my-app';
      const result = getProjectPath(workingDir, '/override/claude/config');
      expect(result).toBe(join('/override/claude/config', 'projects', '-Users-steve-projects-my-app'));
    });

    it('should use default .claude directory when CLAUDE_CONFIG_DIR is not set', () => {
      const workingDir = '/Users/steve/projects/my-app';
      const result = getProjectPath(workingDir);
      expect(result).toContain('projects');
      expect(result).toContain('-Users-steve-projects-my-app');
    });

    it('should use CLAUDE_CONFIG_DIR when set', () => {
      process.env.CLAUDE_CONFIG_DIR = '/custom/claude/config';
      const workingDir = '/Users/steve/projects/my-app';
      const result = getProjectPath(workingDir);
      expect(result).toBe(join('/custom/claude/config', 'projects', '-Users-steve-projects-my-app'));
    });

    it('should handle relative CLAUDE_CONFIG_DIR path', () => {
      process.env.CLAUDE_CONFIG_DIR = './config/claude';
      const workingDir = '/Users/steve/projects/my-app';
      const result = getProjectPath(workingDir);
      expect(result).toBe(join('./config/claude', 'projects', '-Users-steve-projects-my-app'));
    });

    it('should fallback to default when CLAUDE_CONFIG_DIR is empty string', () => {
      process.env.CLAUDE_CONFIG_DIR = '';
      const workingDir = '/Users/steve/projects/my-app';
      const result = getProjectPath(workingDir);
      expect(result).toContain('projects');
      expect(result).toContain('-Users-steve-projects-my-app');
    });

    it('should handle CLAUDE_CONFIG_DIR with trailing slash', () => {
      process.env.CLAUDE_CONFIG_DIR = '/custom/claude/config/';
      const workingDir = '/Users/steve/projects/my-app';
      const result = getProjectPath(workingDir);
      expect(result).toBe(join('/custom/claude/config/', 'projects', '-Users-steve-projects-my-app'));
    });

    it('should trim whitespace in CLAUDE_CONFIG_DIR', () => {
      process.env.CLAUDE_CONFIG_DIR = '  /custom/claude/config  ';
      const workingDir = '/Users/steve/projects/my-app';
      const result = getProjectPath(workingDir);
      expect(result).toBe(join('/custom/claude/config', 'projects', '-Users-steve-projects-my-app'));
    });
  });
});
