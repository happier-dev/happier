import { describe, expect, it, vi } from 'vitest';
import { delimiter, resolve } from 'node:path';

import { resolveCausalPermissionMode } from '@/agent/permissions/causalPermissionMode';

import { CODEX_ACP_TOOL_PATTERNS } from './transport';
import {
  buildCodexNativeAcpRuntimeOptions,
  resolveCodexAcpBackendTimeouts,
} from './backend';

describe('buildCodexNativeAcpRuntimeOptions', () => {
  it('uses each invocation baseline and honors explicit launch unsets without restoring host PATH', () => {
    vi.stubEnv('PATH', '/host-bin');
    vi.stubEnv('HAPPIER_CODEX_APP_SERVER_BIN', '/host-codex');
    try {
      for (const id of ['first', 'second']) {
        const scoped = { PATH: `/${id}-bin`, HAPPIER_CODEX_APP_SERVER_BIN: `/${id}-codex`, OPENAI_API_KEY: `${id}-fixture-key`, HAPPIER_CODEX_ACP_INIT_TIMEOUT_MS: '4321' };
        const exec = { readEnvironment: (keys: readonly string[]) => Object.fromEntries(
          Object.entries(scoped).filter(([key]) => keys.includes(key)),
        ) };
        const request = { kind: 'create' as const, sessionId: id, cwd: `/workspace/${id}` };
        const options = buildCodexNativeAcpRuntimeOptions(request, exec);
        expect(options.transport.env?.HAPPIER_CODEX_APP_SERVER_BIN).toBe(`/${id}-codex`);
        expect(options.definition?.auth?.methodId).toBe('openai-api-key');
        expect(options.transport.timeouts?.initializeMs).toBe(4321);
        const shims = resolve(request.cwd, 'scripts', 'shims');
        expect(options.transport.env?.PATH).toBe(`${shims}${delimiter}${scoped.PATH}`);
        const overridden = buildCodexNativeAcpRuntimeOptions({ ...request,
          launchEnvironment: { values: { HAPPIER_CODEX_APP_SERVER_BIN: `/${id}-launch` }, unset: ['path'] },
        }, exec);
        expect(overridden.transport.env?.HAPPIER_CODEX_APP_SERVER_BIN).toBe(`/${id}-launch`);
        expect(overridden.transport.env?.PATH).toBe(shims);
      }
    } finally { vi.unstubAllEnvs(); }
  });

  it.each([
    { mode: 'read-only', nativeSandbox: 'off', approval: 'untrusted', sandbox: 'danger-full-access' },
    { mode: 'read-only', nativeSandbox: 'on', approval: 'never', sandbox: 'read-only' },
    { mode: 'safe-yolo', nativeSandbox: 'off', approval: 'on-request', sandbox: 'danger-full-access' },
    { mode: 'yolo', nativeSandbox: 'off', approval: 'never', sandbox: 'danger-full-access' },
    { mode: 'default', nativeSandbox: 'off', approval: 'untrusted', sandbox: 'danger-full-access' },
    { mode: 'plan', nativeSandbox: 'off', approval: 'untrusted', sandbox: 'danger-full-access' },
    { mode: 'yolo', nativeSandbox: 'off', workspaceWrites: 'deny', approval: 'never', sandbox: 'read-only' },
  ] as const)('applies the admitted $mode policy to ACP launch with sandbox $nativeSandbox', (policy) => {
    const options = buildCodexNativeAcpRuntimeOptions({ kind: 'create', sessionId: 'sandbox', cwd: '/workspace',
      configuration: { mode: { value: null, updatedAtMs: 0 }, model: { value: null, updatedAtMs: 0 },
        permissionIntent: { value: policy.mode, updatedAtMs: 0 }, nativeSandbox: policy.nativeSandbox, options: {},
        ...('workspaceWrites' in policy ? { workspaceWrites: policy.workspaceWrites } : {}) } });
    expect(options.transport.args).toEqual([
      '-c', `approval_policy="${policy.approval}"`, '-c', `sandbox_mode="${policy.sandbox}"`,
    ]);
  });
  it('requires approvals for an imposed read-only ceiling at ACP launch with the sandbox off', () => {
    const constrained = resolveCausalPermissionMode({
      currentPermissionMode: 'yolo',
      context: { causalPermissionAuthority: {
        kind: 'admittedSessionInputV1', admittedPermissionCeiling: 'read-only',
      } },
    });
    if (!constrained.ok) throw new Error(`Causal read-only ceiling refused: ${constrained.reason}`);
    const options = buildCodexNativeAcpRuntimeOptions({ kind: 'create', sessionId: 'ceiling', cwd: '/workspace',
      configuration: { mode: { value: null, updatedAtMs: 0 }, model: { value: null, updatedAtMs: 0 },
        permissionIntent: { value: constrained.effectiveMode, updatedAtMs: 0 }, nativeSandbox: 'off', options: {} } });
    expect(options.transport.args).toEqual(['-c', 'approval_policy="untrusted"', '-c', 'sandbox_mode="danger-full-access"']);
  });
  it('applies the default approval policy when only a sandbox choice is supplied on resume', () => {
    const options = buildCodexNativeAcpRuntimeOptions({ kind: 'resume', sessionId: 'sandbox',
      providerSessionId: 'native-sandbox', cwd: '/workspace',
      configuration: { mode: { value: null, updatedAtMs: 0 }, model: { value: null, updatedAtMs: 0 },
        permissionIntent: { value: null, updatedAtMs: 0 }, nativeSandbox: 'off', options: {} } });
    expect(options.transport.args).toEqual(['-c', 'approval_policy="untrusted"', '-c', 'sandbox_mode="danger-full-access"']);
  });
  it('preserves each admitted Session PATH, including an explicitly empty value', () => {
    vi.stubEnv('PATH', '/ambient-host-bin');
    try {
      const sessions = [
        { sessionId: 'empty-path', cwd: '/workspace/empty-path', path: '' },
        { sessionId: 'authored-path', cwd: '/workspace/authored-path', path: '/session-bin' },
      ];
      const paths = sessions.map(session => buildCodexNativeAcpRuntimeOptions({
        kind: 'create', sessionId: session.sessionId, cwd: session.cwd,
        launchEnvironment: { values: { PATH: session.path }, unset: [] },
      }).transport.env?.PATH);

      expect(paths).toEqual(sessions.map(session => {
        const shims = resolve(session.cwd, 'scripts', 'shims');
        return session.path ? `${shims}${delimiter}${session.path}` : shims;
      }));
    } finally { vi.unstubAllEnvs(); }
  });

  it('refuses MCP tool policy when ACP cannot apply the native knob', () => {
    expect(() => buildCodexNativeAcpRuntimeOptions({ kind: 'create', sessionId: 'policy', cwd: '/workspace',
      mcpToolPolicy: { docs: { unlisted: 'ask', tools: { write: 'off' } } },
    })).toThrow(expect.objectContaining({ code: 'codex_mcp_tool_policy_unsupported_transport' }));
  });
  it('refuses confinement before ACP launch when underlying native support cannot be established', () => {
    expect(() => buildCodexNativeAcpRuntimeOptions({
      kind: 'create', sessionId: 'restricted', cwd: '/workspace',
      launchEnvironment: { values: {
        HAPPIER_CODEX_ACP_CONFIG_OVERRIDES: 'features.shell_tool=true',
      }, unset: [] },
      configuration: {
        mode: { value: null, updatedAtMs: 0 }, model: { value: null, updatedAtMs: 0 },
        permissionIntent: { value: 'read-only', updatedAtMs: 0 }, options: {},
        allowedTools: ['mcp__wilson-intake__*'], unlistedTools: 'deny',
      },
    })).toThrow(expect.objectContaining({ code: 'codex_tool_restriction_unsupported_transport' }));
  });
  it('refuses confined MCP inputs when ACP cannot prove the native tool filter is retained', () => {
    expect(() => buildCodexNativeAcpRuntimeOptions({
      kind: 'create', sessionId: 'restricted', cwd: '/workspace',
      configuration: {
        mode: { value: null, updatedAtMs: 0 }, model: { value: null, updatedAtMs: 0 },
        permissionIntent: { value: 'read-only', updatedAtMs: 0 }, options: {},
        allowedTools: ['mcp__wilson__*'], unlistedTools: 'deny',
      },
      mcpServers: { wilson: { command: 'fixture', enabledTools: ['allowed_echo'] } },
    })).toThrow(expect.objectContaining({ code: 'codex_tool_restriction_unsupported_transport' }));
  });
  it.each(['openai-codex', 'happier.agent.codex/openai-codex'])(
    'declines Connected Account ACP without a host-managed refresh bridge (%s)',
    (serviceId) => {
      expect(() => buildCodexNativeAcpRuntimeOptions({
        kind: 'create', sessionId: 'session-1', cwd: '/workspace',
        launchEnvironment: { values: {
          HAPPIER_CONNECTED_SERVICE_SELECTIONS_JSON: JSON.stringify([{
            kind: 'profile', serviceId, profileId: 'work',
          }]),
        }, unset: [] },
      })).toThrow(expect.objectContaining({ code: 'codex_refresh_free_auth_unsupported' }));
    },
  );

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
