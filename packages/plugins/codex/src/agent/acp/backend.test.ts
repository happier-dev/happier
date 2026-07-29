import { describe, expect, it } from 'vitest';
import { resolve } from 'node:path';

import { CODEX_ACP_TOOL_PATTERNS } from './transport';
import {
  buildCodexNativeAcpRuntimeOptions,
  resolveCodexAcpBackendTimeouts,
} from './backend';

describe('buildCodexNativeAcpRuntimeOptions', () => {
  it('projects the host launch snapshot into the native ACP composer contract', () => {
    const options = buildCodexNativeAcpRuntimeOptions({
      kind: 'create',
      sessionId: 'session-1',
      cwd: '/workspace/codex-project',
      launchEnvironment: {
        values: {
          PATH: '/usr/bin',
          OPENAI_API_KEY: 'secret',
          HAPPIER_CODEX_ACP_CONFIG_OVERRIDES: 'model="gpt-5"',
          CODEX_THREAD_ID: 'must-not-leak',
        },
        unset: [],
      },
      configuration: {
        mode: { value: null, updatedAtMs: 0 },
        model: { value: null, updatedAtMs: 0 },
        permissionIntent: { value: 'safe-yolo', updatedAtMs: 1 },
        options: {},
      },
    });

    expect(options.transport).toMatchObject({
      kind: 'stdio',
      executable: { kind: 'managedDependency', id: 'codex-acp' },
      args: [
        '-c',
        'model="gpt-5"',
        '-c',
        'approval_policy="on-request"',
        '-c',
        'sandbox_mode="workspace-write"',
      ],
      timeouts: { initializeMs: 180_000 },
    });
    expect(options.transport.env?.PATH?.split(process.platform === 'win32' ? ';' : ':')[0]).toBe(
      resolve('/workspace/codex-project', 'scripts', 'shims'),
    );
    expect(options.transport.env).not.toHaveProperty('CODEX_THREAD_ID');
    expect(options.definition?.auth?.methodId).toBe('openai-api-key');
    expect(options.definition?.toolNameInference?.patterns).toEqual(CODEX_ACP_TOOL_PATTERNS);
  });

  it('uses provider timeout defaults when no env override is set', () => {
    const timeouts = resolveCodexAcpBackendTimeouts({
      command: 'codex-acp',
      env: {},
    });

    expect(timeouts).toEqual({
      initMs: 180_000,
      preToolCallIdleMs: 1_000,
    });
  });

  it('honors Codex ACP timeout env overrides', () => {
    const timeouts = resolveCodexAcpBackendTimeouts({
      command: 'codex-acp',
      env: {
        HAPPIER_CODEX_ACP_INIT_TIMEOUT_MS: '210000',
        HAPPIER_CODEX_ACP_NPX_INIT_TIMEOUT_MS: '240000',
        HAPPIER_CODEX_ACP_PRE_TOOL_IDLE_TIMEOUT_MS: '1500',
      },
    });

    expect(timeouts).toEqual({
      initMs: 210_000,
      preToolCallIdleMs: 1_500,
    });
  });

  it('uses the npx-specific init timeout only for npx launches', () => {
    const timeouts = resolveCodexAcpBackendTimeouts({
      command: 'npx',
      env: {
        HAPPIER_CODEX_ACP_INIT_TIMEOUT_MS: '210000',
        HAPPIER_CODEX_ACP_NPX_INIT_TIMEOUT_MS: '240000',
      },
    });

    expect(timeouts.initMs).toBe(240_000);
  });
});
