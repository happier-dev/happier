import { expect, it } from 'vitest';
import type {
  AgentExecutionRunOpenRequest,
  AgentSessionOpenRequest,
  AgentSessionRuntime,
} from '@happier-dev/plugin-sdk/agents/runtime';

import { createExecutionRunHostBackendFromSessionRuntime } from './sessionAdapter';

it.each([
  ['create', false],
  ['create', true],
  ['resume', false],
  ['resume', true],
] as const)('preserves the %s Session opening and exact input contract through the public Run owner (strict MCP: %s)', async (kind, mcpServersStrictMode) => {
  const configuration = {
    mode: { value: null, updatedAtMs: 0 },
    model: { value: 'model-a', updatedAtMs: 1 },
    permissionIntent: { value: 'read-only' as const, updatedAtMs: 1 },
    options: {},
  };
  const providerBinding: NonNullable<AgentExecutionRunOpenRequest['providerBinding']> = {
    connectionId: 'fixture-provider',
    upstream: { protocol: 'openai.responses', normalizedUrl: 'https://example.com/v1', credential: 'apiKey' as const },
    model: { id: 'model-a', name: 'Model A' },
    materialization: { v: 1 as const, kind: 'spawnEnv' as const },
  };
  const skills = {
    pluginRoot: '/skills/run', skillsRoot: '/skills/run/skills',
    items: [{ name: 'guide', skillId: 'skill-1', digest: 'sha256:abc', directory: '/skills/run/skills/guide' }],
    nativeDisables: [{ name: 'native', path: '/user/skills/native/SKILL.md' }],
  };
  const causalPermissionAuthority = {
    kind: 'admittedSessionInputV1' as const,
    admittedPermissionCeiling: 'read-only' as const,
  };
  const common = {
    cwd: '/repo', configuration, providerBinding, skills,
    launchEnvironment: { values: { AGENT_HOME: '/agent' }, unset: ['LEGACY_HOME'] },
    mcpServers: { docs: { command: '/mcp/docs', args: [] } },
    mcpServersStrictMode,
    mcpToolPolicy: { docs: { unlisted: 'ask' as const, tools: { read: 'allow' as const, write: 'off' as const } } },
  };
  const input = { text: 'Use the guide.' };
  const inputOptions = {
    localInputId: 'host-input', resultContract: { kind: 'json' as const, schema: { type: 'object' as const } },
    causalPermissionAuthority,
  };
  const request = {
    ...common,
    runId: 'run', profile: { pluginId: 'fixture', localId: 'default' }, causalPermissionAuthority,
    ...(kind === 'create' ? { kind, input, ...inputOptions } : { kind, checkpointId: 'provider-checkpoint' }),
  } satisfies AgentExecutionRunOpenRequest;
  let opened: AgentSessionOpenRequest | undefined;
  const sends: Parameters<AgentSessionRuntime['send']>[] = [];
  const session: AgentSessionRuntime = {
    async send(...args) { sends.push(args); return { status: 'admitted' }; },
    watch() { return { dispose() {} }; },
    dispose() {},
  };
  const runtime = await createExecutionRunHostBackendFromSessionRuntime({
    request, sessionId: 'owning-session',
    openSession(value) { opened = value; return session; },
  });
  try {
    if (kind === 'resume') {
      expect(sends).toEqual([]);
      await runtime.send(input, inputOptions);
    }
    expect(opened).toEqual({
      ...common, sessionId: 'owning-session', kind,
      ...(kind === 'resume' ? { providerSessionId: 'provider-checkpoint' } : {}),
    });
    expect(sends).toEqual([[{
      inputIds: ['host-input'], input,
      delivery: { kind: 'newTurn', turnId: 'run-turn-1' }, causalPermissionAuthority,
    }, inputOptions]]);
  } finally {
    await runtime.dispose();
  }
});
