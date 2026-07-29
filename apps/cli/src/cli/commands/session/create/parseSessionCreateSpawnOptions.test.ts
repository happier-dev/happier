import { describe, expect, it } from 'vitest';

import { parseSessionCreateSpawnOptions } from './parseSessionCreateSpawnOptions';

describe('parseSessionCreateSpawnOptions', () => {
  it('parses runtime-v2 session create flags into session.spawn_new input', () => {
    const runtimeDescriptorV1 = {
      v: 1,
      agentId: 'codex',
      provider: {
        providerExtra: {
          owner: 'happier',
          schemaId: 'codex-runtime',
          v: 1,
        },
        backendMode: 'appServer',
      },
    } as const;
    const connectedServices = {
      v: 1,
      bindingsByServiceId: {
        'openai-codex': {
          source: 'connected',
          selection: 'profile',
          profileId: 'codex-profile',
        },
      },
    } as const;
    const mcpSelection = {
      v: 1,
      managedServersEnabled: true,
      forceIncludeServerIds: ['server-a'],
      forceExcludeServerIds: ['server-b'],
    } as const;

    const parsed = parseSessionCreateSpawnOptions([
      'create',
      '--path',
      '/tmp/project',
      '--backend',
      'backend:codex',
      '--title',
      'My title',
      '--tag',
      'tag-1',
      '--prompt',
      'Hello',
      '--model',
      'gpt-5',
      '--provider-connection',
      'pc_work',
      '--permission-mode',
      'safe-yolo',
      '--mode',
      'plan',
      '--config-option',
      'reasoning_effort=xhigh',
      '--config-option',
      'ultracode=true',
      '--profile',
      'codex-profile',
      '--env',
      'FEATURE_FLAG=enabled',
      '--env',
      'EMPTY_VALUE=',
      '--connected-services-json',
      JSON.stringify(connectedServices),
      '--mcp-selection-json',
      JSON.stringify(mcpSelection),
      '--transcript-storage',
      'direct',
      '--terminal-json',
      JSON.stringify({ mode: 'tmux' }),
      '--runtime-descriptor-json',
      JSON.stringify(runtimeDescriptorV1),
      '--host',
      'leeroy-mbp',
      '--machine-id',
      'machine-1',
      '--server-id',
      'server-1',
      '--json',
    ]);

    expect(parsed.json).toBe(true);
    expect(parsed.actionInput).toEqual({
      path: '/tmp/project',
      backendTargetKey: 'backend:codex',
      agentId: 'codex',
      title: 'My title',
      tag: 'tag-1',
      initialMessage: 'Hello',
      modelId: 'gpt-5',
      providerConnectionId: 'pc_work',
      permissionMode: 'safe-yolo',
      agentModeId: 'plan',
      configOptions: {
        reasoning_effort: 'xhigh',
        ultracode: true,
      },
      profileId: 'codex-profile',
      environmentVariables: {
        FEATURE_FLAG: 'enabled',
        EMPTY_VALUE: '',
      },
      connectedServices,
      mcpSelection,
      transcriptStorage: 'direct',
      terminal: { mode: 'tmux' },
      runtimeDescriptorV1: {
        v: 1,
        agentId: 'codex',
        agent: {
          agentExtra: { owner: 'happier', schemaId: 'codex-runtime', v: 1 },
          backendMode: 'appServer',
        },
      },
      host: 'leeroy-mbp',
      machineId: 'machine-1',
      serverId: 'server-1',
    });
  });

  it('requires --model with --provider-connection and never parses slash-encoded identity', () => {
    expect(() => parseSessionCreateSpawnOptions([
      'create', '--backend', 'backend:codex', '--provider-connection', 'pc_work',
    ])).toThrow(/requires --model/i);
    const parsed = parseSessionCreateSpawnOptions([
      'create', '--backend', 'backend:codex', '--model', 'openrouter/model-a', '--provider-connection', 'pc_work',
    ]);
    expect(parsed.actionInput).toMatchObject({ modelId: 'openrouter/model-a', providerConnectionId: 'pc_work' });
  });

  it('carries the concrete Agent identity for strict plugin-backed agent shorthands', () => {
    const parsed = parseSessionCreateSpawnOptions([
      'create',
      '--backend',
      'grok',
    ]);

    expect(parsed.actionInput).toMatchObject({
      agentId: 'grok',
      backendTargetKey: 'agent:grok',
    });
  });

  it('rejects malformed rich JSON flags', () => {
    expect(() => parseSessionCreateSpawnOptions([
      'create',
      '--connected-services-json',
      '{',
    ])).toThrow(/--connected-services-json must be valid JSON/);
  });

  it('requires and preserves a stable attempt id for resolve-only retries', () => {
    expect(() => parseSessionCreateSpawnOptions(['create', '--spawn-attempt-id', 'attempt\n2']))
      .toThrow('Invalid --spawn-attempt-id.');
    expect(() => parseSessionCreateSpawnOptions(['create', '--resume-spawn-attempt']))
      .toThrow('Invalid --resume-spawn-attempt without --spawn-attempt-id.');

    expect(parseSessionCreateSpawnOptions([
      'create',
      '--spawn-attempt-id', 'attempt-1',
      '--resume-spawn-attempt',
    ])).toMatchObject({
      spawnAttemptId: 'attempt-1',
      resumeSpawnAttempt: true,
    });
  });

  it('parses concise connected-services auth without adding a second spawn schema', () => {
    const parsed = parseSessionCreateSpawnOptions([
      'create',
      '--backend', 'backend:codex',
      '--auth', 'cs:openai-codex:profile:work',
    ]);

    expect(parsed.connectedServicesAuthIntent).toEqual({
      kind: 'connected',
      serviceId: 'openai-codex',
      selection: 'profile',
      id: 'work',
    });
    expect(parsed.actionInput).not.toHaveProperty('connectedServices');
  });

  it('supports --auth-json while rejecting competing shortcut and JSON inputs', () => {
    expect(parseSessionCreateSpawnOptions([
      'create',
      '--auth-json', '{"v":1,"bindingsByServiceId":{"openai-codex":{"source":"native"}}}',
    ]).actionInput).toHaveProperty('connectedServices');

    expect(() => parseSessionCreateSpawnOptions([
      'create',
      '--connected-services', 'default',
      '--auth-json', '{"v":1,"bindingsByServiceId":{}}',
    ])).toThrow('Choose only one connected-services auth option');
  });

  it('accepts --launch-profile as the canonical launch-profile spelling', () => {
    expect(parseSessionCreateSpawnOptions([
      'create',
      '--backend', 'backend:codex',
      '--launch-profile', 'work',
    ]).actionInput).toMatchObject({ profileId: 'work' });
  });
});
