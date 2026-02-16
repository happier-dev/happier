import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { createOpenCodeBackend } from './backend';

// Mock the logger to avoid console output during tests
vi.mock('@/ui/logger', () => ({
  logger: {
    debug: vi.fn(),
  },
}));

type AcpBackendLike = {
  options: {
    command: string;
    args: string[];
    env: Record<string, string>;
  };
};

function makeTempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function makeUnixExecutable(params: { dir: string; name: string; content: string }): string {
  const filePath = join(params.dir, params.name);
  writeFileSync(filePath, params.content, 'utf8');
  chmodSync(filePath, 0o755);
  return filePath;
}

function makeWindowsCmdExecutable(params: { dir: string; name: string; content: string }): string {
  const filePath = join(params.dir, `${params.name}.cmd`);
  writeFileSync(filePath, params.content, 'utf8');
  return filePath;
}

describe('createOpenCodeBackend command resolution', () => {
  const originalOpenCodePath = process.env.HAPPIER_OPENCODE_PATH;
  const tempDirs: string[] = [];

  afterEach(() => {
    if (originalOpenCodePath === undefined) delete process.env.HAPPIER_OPENCODE_PATH;
    else process.env.HAPPIER_OPENCODE_PATH = originalOpenCodePath;

    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) rmSync(dir, { recursive: true, force: true });
    }
  });

  it.each([
    { label: 'unset override', override: undefined, expected: 'opencode' },
    { label: 'whitespace override', override: '   ', expected: 'opencode' },
    { label: 'non-existent override', override: join(tmpdir(), 'definitely-missing-opencode-binary'), expected: 'opencode' },
  ])('falls back to opencode for $label', ({ override, expected }) => {
    if (override === undefined) delete process.env.HAPPIER_OPENCODE_PATH;
    else process.env.HAPPIER_OPENCODE_PATH = override;

    const backend = createOpenCodeBackend({ cwd: tmpdir(), env: {} }) as unknown as AcpBackendLike;
    expect(backend.options.command).toBe(expected);
  });

  it('handles non-executable override paths with explicit platform semantics', () => {
    const workDir = makeTempDir('happier-opencode-backend-');
    tempDirs.push(workDir);
    const binDir = join(workDir, 'bin');
    mkdirSync(binDir, { recursive: true });
    const nonExecutablePath = join(binDir, process.platform === 'win32' ? 'opencode.txt' : 'opencode');
    writeFileSync(nonExecutablePath, '#!/bin/sh\necho "ok"\n', 'utf8');

    process.env.HAPPIER_OPENCODE_PATH = nonExecutablePath;

    const backend = createOpenCodeBackend({ cwd: workDir, env: {} }) as unknown as AcpBackendLike;
    if (process.platform === 'win32') {
      // Windows override probing uses existence checks; keep this explicit in the test.
      expect(backend.options.command).toBe(nonExecutablePath);
      return;
    }
    expect(backend.options.command).toBe('opencode');
  });

  it('uses HAPPIER_OPENCODE_PATH when it points to an existing executable', () => {
    const workDir = makeTempDir('happier-opencode-backend-');
    tempDirs.push(workDir);
    const binDir = join(workDir, 'bin');
    mkdirSync(binDir, { recursive: true });

    const opencodePath = process.platform === 'win32'
      ? makeWindowsCmdExecutable({
          dir: binDir,
          name: 'opencode',
          content: ['@echo off', 'echo ok', ''].join('\r\n'),
        })
      : makeUnixExecutable({
          dir: binDir,
          name: 'opencode',
          content: ['#!/bin/sh', 'echo "ok"', ''].join('\n'),
        });

    process.env.HAPPIER_OPENCODE_PATH = opencodePath;

    const backend = createOpenCodeBackend({ cwd: workDir, env: {} }) as unknown as AcpBackendLike;
    expect(backend.options.command).toBe(opencodePath);
    expect(backend.options.args).toEqual(['acp']);
    expect(backend.options.env.NODE_ENV).toBe('production');
    expect(backend.options.env.DEBUG).toBe('');
  });
});

describe('createOpenCodeBackend config file reading', () => {
  const tempDirs: string[] = [];
  const originalProcessEnv = { ...process.env };
  const originalPlatform = process.platform;

  afterEach(() => {
    // Restore process env without reassigning `process.env` (which breaks native lookups
    // like `os.homedir()` reading from updated env vars within the same process).
    for (const key of Object.keys(process.env)) {
      if (!(key in originalProcessEnv)) delete process.env[key];
    }
    for (const [key, value] of Object.entries(originalProcessEnv)) {
      process.env[key] = value;
    }

    // Clean up temp dirs
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) rmSync(dir, { recursive: true, force: true });
    }
  });

  function makeTempConfigDir(): string {
    const dir = makeTempDir('happier-opencode-config-');
    tempDirs.push(dir);
    process.env.HOME = dir;
    return dir;
  }

  function writeConfigFile(dir: string, config: Record<string, unknown>): string {
    const configDir = join(dir, '.config', 'opencode');
    mkdirSync(configDir, { recursive: true });
    const configPath = join(configDir, 'opencode.json');
    writeFileSync(configPath, JSON.stringify(config), 'utf-8');
    return configPath;
  }

  describe('config precedence', () => {
    it('prioritizes process.env.OPENCODE_CONFIG_CONTENT over file-based config', () => {
      const workDir = makeTempConfigDir();
      writeConfigFile(workDir, { model: 'zai/glm-5' });

      process.env.OPENCODE_CONFIG_CONTENT = JSON.stringify({ model: 'process-env-model' });

      const backend = createOpenCodeBackend({ cwd: workDir, env: {} }) as unknown as AcpBackendLike;
      expect(backend.options.env.OPENCODE_CONFIG_CONTENT).toBe('{"model":"process-env-model"}');
    });

    it('prioritizes options.env.OPENCODE_CONFIG_CONTENT over file-based config', () => {
      const workDir = makeTempConfigDir();
      writeConfigFile(workDir, { model: 'zai/glm-5' });

      const backend = createOpenCodeBackend({
        cwd: workDir,
        env: { OPENCODE_CONFIG_CONTENT: JSON.stringify({ model: 'options-env-model' }) },
      }) as unknown as AcpBackendLike;
      expect(backend.options.env.OPENCODE_CONFIG_CONTENT).toBe('{"model":"options-env-model"}');
    });

    it('prioritizes process.env over options.env when both are set', () => {
      const workDir = makeTempConfigDir();
      writeConfigFile(workDir, { model: 'zai/glm-5' });

      process.env.OPENCODE_CONFIG_CONTENT = JSON.stringify({ model: 'process-env-model' });

      const backend = createOpenCodeBackend({
        cwd: workDir,
        env: { OPENCODE_CONFIG_CONTENT: JSON.stringify({ model: 'options-env-model' }) },
      }) as unknown as AcpBackendLike;
      expect(backend.options.env.OPENCODE_CONFIG_CONTENT).toBe('{"model":"process-env-model"}');
    });

    it('reads from file when no env override is set', () => {
      const workDir = makeTempConfigDir();
      const config = { model: 'zai/glm-5', small_model: 'zai/glm-4.5-air' };
      writeConfigFile(workDir, config);

      const backend = createOpenCodeBackend({ cwd: workDir, env: {} }) as unknown as AcpBackendLike;
      expect(backend.options.env.OPENCODE_CONFIG_CONTENT).toBe(JSON.stringify(config));
    });
  });

  describe('file-based config reading', () => {
    it('does not set OPENCODE_CONFIG_CONTENT when config file does not exist', () => {
      const workDir = makeTempDir('happier-opencode-no-config-');
      tempDirs.push(workDir);

      const backend = createOpenCodeBackend({ cwd: workDir, env: {} }) as unknown as AcpBackendLike;
      expect(backend.options.env.OPENCODE_CONFIG_CONTENT).toBeUndefined();
    });

    it('handles invalid JSON in config file gracefully', () => {
      const workDir = makeTempConfigDir();
      const configDir = join(workDir, '.config', 'opencode');
      mkdirSync(configDir, { recursive: true });
      const configPath = join(configDir, 'opencode.json');
      writeFileSync(configPath, 'invalid json{', 'utf-8');

      const backend = createOpenCodeBackend({ cwd: workDir, env: {} }) as unknown as AcpBackendLike;
      expect(backend.options.env.OPENCODE_CONFIG_CONTENT).toBeUndefined();
    });

    it('reads and validates config file with model and MCP servers', () => {
      const workDir = makeTempConfigDir();
      const config = {
        model: 'zai/glm-5',
        small_model: 'zai/glm-4.5-air',
        mcp: {
          'zai-mcp-server': {
            type: 'local',
            command: ['npx', '-y', '@z_ai/mcp-server'],
          },
        },
      };
      writeConfigFile(workDir, config);

      const backend = createOpenCodeBackend({ cwd: workDir, env: {} }) as unknown as AcpBackendLike;
      const parsedConfig = JSON.parse(backend.options.env.OPENCODE_CONFIG_CONTENT!);
      expect(parsedConfig.model).toBe('zai/glm-5');
      expect(parsedConfig.small_model).toBe('zai/glm-4.5-air');
      expect(parsedConfig.mcp['zai-mcp-server']).toBeDefined();
    });
  });

  describe('XDG_CONFIG_HOME support', () => {
    it('uses XDG_CONFIG_HOME when set on Linux', () => {
      const workDir = makeTempConfigDir();
      const customConfigDir = join(workDir, 'my-custom-config');
      mkdirSync(customConfigDir, { recursive: true });
      const opencodeDir = join(customConfigDir, 'opencode');
      mkdirSync(opencodeDir, { recursive: true });
      const configPath = join(opencodeDir, 'opencode.json');
      writeFileSync(configPath, JSON.stringify({ model: 'xdg-model' }), 'utf-8');

      process.env.XDG_CONFIG_HOME = customConfigDir;

      const backend = createOpenCodeBackend({ cwd: workDir, env: {} }) as unknown as AcpBackendLike;
      const parsedConfig = JSON.parse(backend.options.env.OPENCODE_CONFIG_CONTENT!);
      expect(parsedConfig.model).toBe('xdg-model');
    });

    it('falls back to ~/.config when XDG_CONFIG_HOME is not set', () => {
      const workDir = makeTempConfigDir();
      const config = { model: 'default-config-model' };
      writeConfigFile(workDir, config);

      delete process.env.XDG_CONFIG_HOME;

      const backend = createOpenCodeBackend({ cwd: workDir, env: {} }) as unknown as AcpBackendLike;
      const parsedConfig = JSON.parse(backend.options.env.OPENCODE_CONFIG_CONTENT!);
      expect(parsedConfig.model).toBe('default-config-model');
    });
  });

  describe('cross-platform config paths', () => {
    it('calculates correct config path for Windows', () => {
      // This test verifies the path logic; actual file reading would require Windows platform
      const workDir = makeTempDir('happier-opencode-windows-');
      tempDirs.push(workDir);

      // On Windows, would use %APPDATA%\opencode\opencode.json
      // We can't fully test this without mocking platform, but we verify the backend doesn't crash
      const backend = createOpenCodeBackend({ cwd: workDir, env: {} }) as unknown as AcpBackendLike;
      expect(backend.options.command).toBeTruthy();
    });
  });

  describe('config with complex values', () => {
    it('preserves nested configuration objects', () => {
      const workDir = makeTempConfigDir();
      const config = {
        model: 'zai/glm-5',
        mcp: {
          'server-one': {
            type: 'local',
            command: ['npx', '-y', 'server-one'],
            environment: {
              API_KEY: 'test-key',
              DEBUG: '1',
            },
          },
          'server-two': {
            type: 'stdio',
            command: 'python',
            args: ['-m', 'server_two'],
          },
        },
        snapshot: false,
      };
      writeConfigFile(workDir, config);

      const backend = createOpenCodeBackend({ cwd: workDir, env: {} }) as unknown as AcpBackendLike;
      const parsedConfig = JSON.parse(backend.options.env.OPENCODE_CONFIG_CONTENT!);

      expect(parsedConfig).toEqual(config);
      expect(parsedConfig.mcp['server-one'].environment.API_KEY).toBe('test-key');
      expect(parsedConfig.mcp['server-two'].args).toEqual(['-m', 'server_two']);
    });

    it('handles configuration with special characters in values', () => {
      const workDir = makeTempConfigDir();
      const config = {
        model: 'model-with-special-chars-<>-"-\\"',
        path: 'C:\\Users\\Test\\Path',
        regex: '.*\\.test$',
      };
      writeConfigFile(workDir, config);

      const backend = createOpenCodeBackend({ cwd: workDir, env: {} }) as unknown as AcpBackendLike;
      const parsedConfig = JSON.parse(backend.options.env.OPENCODE_CONFIG_CONTENT!);

      expect(parsedConfig.model).toBe('model-with-special-chars-<>-"-\\"');
      expect(parsedConfig.path).toBe('C:\\Users\\Test\\Path');
      expect(parsedConfig.regex).toBe('.*\\.test$');
    });
  });
});
