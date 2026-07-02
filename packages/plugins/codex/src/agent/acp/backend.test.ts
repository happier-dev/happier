import { describe, expect, it } from 'vitest';
import { resolve } from 'node:path';

import { CODEX_ACP_TOOL_PATTERNS } from './transport';
import { createCodexAcpBackendSpec } from './backend';

describe('createCodexAcpBackendSpec', () => {
  it('declares Codex ACP through the generic system-tool launch contract', () => {
    const spec = createCodexAcpBackendSpec({ env: {} });

    expect(spec.transport).toMatchObject({
      kind: 'stdio',
      launch: {
        kind: 'system-tool',
        toolId: 'codex-acp',
        purpose: 'Run Codex ACP',
        preferredCommand: 'codex-acp',
      },
    });
  });

  it('declares Codex ACP auth method and tool inference through generic ACP fields', () => {
    const openAiSpec = createCodexAcpBackendSpec({
      env: {
        OPENAI_API_KEY: 'openai-key',
      },
    });
    const codexSpec = createCodexAcpBackendSpec({
      env: {
        CODEX_API_KEY: 'codex-key',
      },
    });

    expect(openAiSpec.auth?.methodId).toBe('openai-api-key');
    expect(codexSpec.auth?.methodId).toBe('codex-api-key');
    expect(openAiSpec.toolNameInference?.patterns).toEqual(CODEX_ACP_TOOL_PATTERNS);
    expect(openAiSpec.callbacks?.toolNameResolver).toEqual(expect.any(Function));
  });

  it('uses provider timeout defaults when no env override is set', () => {
    const spec = createCodexAcpBackendSpec({
      command: 'codex-acp',
      env: {},
    });

    expect(spec.transport.timeouts).toEqual({
      initMs: 180_000,
      preToolCallIdleMs: 1_000,
    });
  });

  it('honors Codex ACP timeout env overrides', () => {
    const spec = createCodexAcpBackendSpec({
      command: 'codex-acp',
      env: {
        HAPPIER_CODEX_ACP_INIT_TIMEOUT_MS: '210000',
        HAPPIER_CODEX_ACP_NPX_INIT_TIMEOUT_MS: '240000',
        HAPPIER_CODEX_ACP_PRE_TOOL_IDLE_TIMEOUT_MS: '1500',
      },
    });

    expect(spec.transport.timeouts).toEqual({
      initMs: 210_000,
      preToolCallIdleMs: 1_500,
    });
  });

  it('uses the npx-specific init timeout only for npx launches', () => {
    const spec = createCodexAcpBackendSpec({
      command: 'npx',
      env: {
        HAPPIER_CODEX_ACP_INIT_TIMEOUT_MS: '210000',
        HAPPIER_CODEX_ACP_NPX_INIT_TIMEOUT_MS: '240000',
      },
    });

    expect(spec.transport.timeouts.initMs).toBe(240_000);
  });

  it('builds ACP child env from the runtime cwd when the spec is created without a fixed project dir', () => {
    const spec = createCodexAcpBackendSpec({
      command: 'codex-acp',
      env: {},
    });

    const env = spec.callbacks?.envBuilder?.({
      baseArgs: [],
      cwd: '/workspace/codex-project',
      env: { PATH: '/usr/bin' },
    });

    expect(env?.PATH?.split(process.platform === 'win32' ? ';' : ':')[0]).toBe(
      resolve('/workspace/codex-project', 'scripts', 'shims'),
    );
  });

  it('builds ACP argv from runtime env config overrides when used through the generic bridge', () => {
    const spec = createCodexAcpBackendSpec({
      command: 'codex-acp',
      env: {},
    });

    const args = spec.callbacks?.argvBuilder?.({
      baseArgs: ['--stdio'],
      cwd: '/workspace/codex-project',
      env: {
        HAPPIER_CODEX_ACP_CONFIG_OVERRIDES: 'model="gpt-5"',
      },
      permissionMode: 'safe-yolo',
    });

    expect(args).toEqual([
      '--stdio',
      '-c',
      'model="gpt-5"',
      '-c',
      'approval_policy="on-request"',
      '-c',
      'sandbox_mode="workspace-write"',
    ]);
  });
});
