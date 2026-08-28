import { describe, expect, it } from 'vitest';

import { parseSessionCreateSpawnOptions } from './parseSessionCreateSpawnOptions';

describe('parseSessionCreateSpawnOptions', () => {
  it('parses runtime-v2 session create flags into the CLI spawn request', () => {
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
      '--machine-id',
      'machine-1',
      '--server-id',
      'server-1',
      '--json',
    ]);

    expect(parsed.json).toBe(true);
    expect(parsed.spawnRequest).toEqual({
      directory: '/tmp/project',
      backendTargetKey: 'backend:codex',
      title: 'My title',
      initialInput: { text: 'Hello' },
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
    expect(parsed.spawnRequest).toMatchObject({ modelId: 'openrouter/model-a', providerConnectionId: 'pc_work' });
  });

  it('preserves plugin-backed agent shorthand for the strict V2 normalizer', () => {
    const parsed = parseSessionCreateSpawnOptions([
      'create',
      '--backend',
      'grok',
    ]);

    expect(parsed.spawnRequest).toMatchObject({
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

  it.each([
    ['without --wait', ['create', '--timeout', '5']],
    ['with --follow', ['create', '--follow', '--timeout=5']],
  ])('rejects --timeout %s through the typed invalid-arguments path', (_label, argv) => {
    expect(() => parseSessionCreateSpawnOptions(argv))
      .toThrow(expect.objectContaining({ code: 'invalid_arguments', message: '--timeout requires --wait.' }));
  });

  it('retains --timeout for the supported --wait mode', () => {
    expect(() => parseSessionCreateSpawnOptions(['create', '--wait', '--timeout', '5']))
      .not.toThrow();
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
    expect(parsed.spawnRequest).not.toHaveProperty('connectedServices');
  });

  it('supports --auth-json while rejecting competing shortcut and JSON inputs', () => {
    expect(parseSessionCreateSpawnOptions([
      'create',
      '--auth-json', '{"v":1,"bindingsByServiceId":{"openai-codex":{"source":"native"}}}',
    ]).spawnRequest).toHaveProperty('connectedServices');

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
    ]).spawnRequest).toMatchObject({ profileId: 'work' });
  });

  it.each([
    [['--host', 'legacy-host', 'would-be-prompt'], /--machine-id/i],
    [['--host=legacy-host', 'would-be-prompt'], /--machine-id/i],
    [['--tag', 'legacy-label', 'would-be-prompt'], /--title/i],
    [['--tag=legacy-label', 'would-be-prompt'], /--title/i],
    [[
      '--runtime-descriptor-json',
      JSON.stringify({
        v: 1,
        agentId: 'codex',
        provider: {
          providerExtra: { owner: 'happier', schemaId: 'codex-runtime', v: 1 },
          backendMode: 'appServer',
        },
      }),
      'would-be-prompt',
    ], /--agent.*--model.*--mode/i],
    [[
      '--agent-runtime-descriptor-json={"v":1}',
      'would-be-prompt',
    ], /--agent.*--model.*--mode/i],
  ])('rejects retired %o before it can become a positional prompt', (args, guidance) => {
    expect(() => parseSessionCreateSpawnOptions(['create', ...args])).toThrow(guidance);
  });

  it('keeps a retired-looking value after -- as a literal positional prompt', () => {
    expect(parseSessionCreateSpawnOptions([
      'create',
      '--',
      '--host=literal-prompt',
    ]).spawnRequest).toMatchObject({
      initialInput: { text: '--host=literal-prompt' },
    });
  });

  it('uses the shortcut positional prompt through the canonical create parser', () => {
    expect(parseSessionCreateSpawnOptions([
      'create',
      'Fix the failing test',
      '--agent', 'codex',
    ]).spawnRequest).toMatchObject({
      initialInput: { text: 'Fix the failing test' },
      backendTargetKey: 'agent:codex',
    });
  });

  it('rejects unknown options and ignored extra prompts instead of silently spawning', () => {
    expect(() => parseSessionCreateSpawnOptions(['create', '--definitely-invalid']))
      .toThrow('Usage: happier session create [options]');
    expect(() => parseSessionCreateSpawnOptions(['create', '-x']))
      .toThrow('Usage: happier session create [options]');
    expect(() => parseSessionCreateSpawnOptions(['create', 'first prompt', 'ignored prompt']))
      .toThrow('Usage: happier session create [options]');
  });
});
