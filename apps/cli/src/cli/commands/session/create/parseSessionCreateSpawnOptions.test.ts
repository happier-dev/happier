import { describe, expect, it } from 'vitest';

import { parseSessionCreateSpawnOptions } from './parseSessionCreateSpawnOptions';

describe('parseSessionCreateSpawnOptions', () => {
  it.each([
    ['read_only', 'read-only'],
    ['read-only', 'read-only'],
    ['default', 'default'],
    ['safe-yolo', 'safe-yolo'],
    ['yolo', 'yolo'],
    ['plan', 'plan'],
  ])('normalizes permission mode %s to %s', (input, expected) => {
    expect(parseSessionCreateSpawnOptions([
      '--permission-mode', input,
    ]).actionInput.permissionMode).toBe(expected);
  });

  it('rejects unsupported nonblank permission modes', () => {
    expect(() => parseSessionCreateSpawnOptions([
      '--permission-mode', 'surprise-me',
    ])).toThrow('Invalid --permission-mode');
  });

  it('preserves exact nonblank opaque model and mode flag values', () => {
    const parsed = parseSessionCreateSpawnOptions([
      '--model', ' model-a\t',
      '--mode', ' plan\t',
    ]);

    expect(parsed.actionInput).toEqual(expect.objectContaining({
      modelId: ' model-a\t',
      agentModeId: ' plan\t',
    }));
  });

  it('preserves exact nonblank opaque config option ids and string values', () => {
    const parsed = parseSessionCreateSpawnOptions([
      '--config-option', ' effort = high ',
      '--reasoning-effort', ' xhigh\t',
    ]);

    expect(parsed.actionInput.configOptions).toEqual({
      ' effort ': ' high ',
      reasoning_effort: ' xhigh\t',
    });
  });

  it('normalizes rich create flags into generic spawn action input', () => {
    const parsed = parseSessionCreateSpawnOptions(
      [
        '--path',
        '/repo',
        '--backend',
        'agent:claude',
        '--title',
        'Spawn title',
        '--tag',
        'spawn-tag',
        '--prompt',
        'Start here',
        '--model',
        'claude-opus-4-8',
        '--permission-mode',
        'acceptEdits',
        '--mode',
        'plan',
        '--config-option',
        'reasoning_effort=xhigh',
        '--config-option',
        'temperature=0.4',
        '--ultracode',
        '--profile',
        'profile-1',
        '--env',
        'FEATURE_FLAG=enabled',
        '--env',
        'EMPTY_VALUE=',
        '--connected-services-json',
        JSON.stringify({
          v: 1,
          bindingsByServiceId: {
            'claude-subscription': { source: 'native' },
          },
        }),
        '--mcp-selection-json',
        JSON.stringify({
          v: 1,
          managedServersEnabled: false,
          forceIncludeServerIds: ['repo-tools'],
          forceExcludeServerIds: ['legacy-tool'],
        }),
        '--transcript-storage',
        'direct',
        '--terminal-json',
        JSON.stringify({
          mode: 'tmux',
          tmux: { sessionName: 'spawn', isolated: true },
        }),
        '--codex-backend-mode',
        'appServer',
        '--agent-runtime-descriptor-json',
        JSON.stringify({
          v: 1,
          providerId: 'codex',
          provider: {
            backendMode: 'appServer',
            providerExtra: { owner: 'codex', schemaId: 'codex.agentRuntimeDescriptorExtra', v: 1 },
          },
        }),
        '--host',
        'leeroy-mbp',
        '--machine-id',
        'machine-1',
      ],
    );

    expect(parsed).toEqual({
      backendRaw: 'agent:claude',
      backendTargetKey: 'agent:claude',
      spawnAttemptId: null,
      resumeSpawnAttempt: false,
      actionInput: {
        path: '/repo',
        backendTargetKey: 'agent:claude',
        title: 'Spawn title',
        tag: 'spawn-tag',
        initialMessage: 'Start here',
        modelId: 'claude-opus-4-8',
        permissionMode: 'acceptEdits',
        agentModeId: 'plan',
        profileId: 'profile-1',
        environmentVariables: {
          FEATURE_FLAG: 'enabled',
          EMPTY_VALUE: '',
        },
        connectedServices: {
          v: 1,
          bindingsByServiceId: {
            'claude-subscription': { source: 'native' },
          },
        },
        mcpSelection: {
          v: 1,
          managedServersEnabled: false,
          forceIncludeServerIds: ['repo-tools'],
          forceExcludeServerIds: ['legacy-tool'],
        },
        transcriptStorage: 'direct',
        terminal: {
          mode: 'tmux',
          tmux: { sessionName: 'spawn', isolated: true },
        },
        codexBackendMode: 'appServer',
        agentRuntimeDescriptorV1: {
          v: 1,
          providerId: 'codex',
          provider: {
            backendMode: 'appServer',
            providerExtra: { owner: 'codex', schemaId: 'codex.agentRuntimeDescriptorExtra', v: 1 },
          },
        },
        host: 'leeroy-mbp',
        machineId: 'machine-1',
        configOptions: {
          reasoning_effort: 'xhigh',
          temperature: 0.4,
          ultracode: true,
        },
      },
    });
  });

  it('requires and preserves a stable attempt id for resolve-only retries', () => {
    expect(() => parseSessionCreateSpawnOptions(['--spawn-attempt-id', 'attempt\n2']))
      .toThrow('Invalid --spawn-attempt-id.');
    expect(() => parseSessionCreateSpawnOptions(['--resume-spawn-attempt']))
      .toThrow('Invalid --resume-spawn-attempt without --spawn-attempt-id.');

    expect(parseSessionCreateSpawnOptions([
      '--spawn-attempt-id', 'attempt-1',
      '--resume-spawn-attempt',
    ])).toMatchObject({
      spawnAttemptId: 'attempt-1',
      resumeSpawnAttempt: true,
    });
  });

  it('keeps canonical --config-overrides-json separate from convenience config flags', () => {
    const parsed = parseSessionCreateSpawnOptions(
      [
        '--config-overrides-json',
        JSON.stringify({
          v: 1,
          updatedAt: 10,
          overrides: {
            reasoning_effort: { updatedAt: 10, value: 'high' },
          },
        }),
        '--config-option',
        'foo=true',
        '--ultracode',
      ],
    );

    expect(parsed.actionInput).toEqual(expect.objectContaining({
      agentId: 'claude',
      sessionConfigOptionOverrides: {
        v: 1,
        updatedAt: 10,
        overrides: {
          reasoning_effort: { updatedAt: 10, value: 'high' },
        },
      },
      configOptions: {
        foo: true,
        ultracode: true,
      },
    }));
  });

  it('rejects malformed config override JSON without echoing the value', () => {
    expect(() => parseSessionCreateSpawnOptions(
      ['--config-overrides-json', '{"secret":"do-not-print"'],
    )).toThrow('Invalid --config-overrides-json');
  });

  it('rejects malformed rich JSON flags without echoing values', () => {
    expect(() => parseSessionCreateSpawnOptions(
      ['--connected-services-json', '{"token":"do-not-print"'],
    )).toThrow('Invalid --connected-services-json');
  });

  it('parses the concise auth selector and keeps it out of the spawn wire shape', () => {
    const parsed = parseSessionCreateSpawnOptions([
      '--backend', 'agent:codex',
      '--auth', 'cs:group:happier',
    ]);

    expect(parsed.connectedServicesAuthIntent).toEqual({
      kind: 'connected',
      serviceId: null,
      selection: 'group',
      id: 'happier',
    });
    expect(parsed.actionInput).not.toHaveProperty('connectedServices');
  });

  it('accepts the readable alias and rejects competing auth inputs', () => {
    expect(parseSessionCreateSpawnOptions([
      '--connected-services', 'native',
    ]).connectedServicesAuthIntent).toEqual({ kind: 'native' });

    expect(() => parseSessionCreateSpawnOptions([
      '--auth', 'native',
      '--connected-services-json', '{"v":1,"bindingsByServiceId":{}}',
    ])).toThrow('Choose only one connected-services auth option');
  });

  it('accepts --launch-profile as the canonical launch-profile spelling', () => {
    expect(parseSessionCreateSpawnOptions([
      '--backend', 'agent:codex',
      '--launch-profile', 'work',
    ]).actionInput).toMatchObject({ profileId: 'work' });
  });
});
