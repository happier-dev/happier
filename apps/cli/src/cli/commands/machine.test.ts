import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  SYSTEM_TASK_PROTOCOL_VERSION,
  type SystemTaskEvent,
  type SystemTaskResult,
} from '@happier-dev/protocol';

import { handleMachineCommand } from './machine';

describe('handleMachineCommand', () => {
  const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

  afterEach(() => {
    logSpy.mockClear();
    errorSpy.mockClear();
    process.exitCode = undefined;
  });

  it('streams remote setup task events/results in json mode and forwards parsed relay/task options', async () => {
    const event: SystemTaskEvent = {
      protocolVersion: SYSTEM_TASK_PROTOCOL_VERSION,
      taskId: 'task-1',
      tsMs: 1,
      type: 'progress',
      stepId: 'ssh.installCli',
      message: 'Installing Happier on the remote machine',
    };
    const result: SystemTaskResult = {
      protocolVersion: SYSTEM_TASK_PROTOCOL_VERSION,
      taskId: 'task-1',
      ok: true,
      data: {
        machineId: 'machine-1',
        relayRuntime: {
          relayUrl: 'https://relay.remote.example.test',
          mode: 'system',
        },
      },
    };

    const start = vi.fn(async () => ({ taskId: 'task-1' }));
    const poll = vi.fn()
      .mockResolvedValueOnce({
        events: [event],
        nextCursor: 1,
        result: null,
        pendingPrompt: null,
      })
      .mockResolvedValueOnce({
        events: [],
        nextCursor: 1,
        result,
        pendingPrompt: null,
      });

    await handleMachineCommand(
      [
        'setup',
        '--ssh',
        'dev@example.test',
        '--identity-file',
        '/tmp/id_ed25519',
        '--ssh-config-file',
        '/tmp/lima-ssh.config',
        '--known-hosts-path',
        '/tmp/known_hosts',
        '--trusted-host-key',
        'example.test ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAA',
        '--install-relay-runtime',
        '--relay-runtime-mode',
        'system',
        '--service-mode',
        'none',
        '--preview',
        '--json',
      ],
      {
        applyServerSelectionFromArgs: async (args) => args,
        createRunner: () => ({
          start,
          poll,
          respond: vi.fn(),
        }),
        readRelaySelection: () => ({
          relayUrl: 'https://relay.example.test',
          webappUrl: 'https://app.example.test',
          publicRelayUrl: 'https://relay.example.test',
        }),
        promptInput: async () => {
          throw new Error('prompt should not be used');
        },
        promptSecret: async () => {
          throw new Error('promptSecret should not be used');
        },
        isInteractiveTerminal: () => false,
        sleep: async () => undefined,
      },
    );

    expect(start).toHaveBeenCalledWith({
      spec: {
        protocolVersion: 1,
        kind: 'remote.ssh.bootstrapMachine.v1',
        params: {
          ssh: {
            target: 'dev@example.test',
            auth: 'keyfile',
            identityFile: '/tmp/id_ed25519',
            sshConfigFile: '/tmp/lima-ssh.config',
            knownHostsPath: '/tmp/known_hosts',
            trustedHostKey: 'example.test ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAA',
          },
          relay: {
            relayUrl: 'https://relay.example.test',
            webappUrl: 'https://app.example.test',
            publicRelayUrl: 'https://relay.example.test',
          },
          channel: 'preview',
          serviceMode: 'none',
          knownHostsMode: 'app',
          relayRuntime: {
            enabled: true,
            mode: 'system',
            switchRelayUrl: true,
          },
        },
      },
    });
    expect(logSpy.mock.calls.map((call) => call[0])).toEqual([
      JSON.stringify(event),
      JSON.stringify(result),
    ]);
  });

  it('supports --require-local-approval to ensure the remote machine is paired via the current CLI credentials', async () => {
    const start = vi.fn(async () => ({ taskId: 'task-require-local' }));
    const poll = vi.fn().mockResolvedValue({
      events: [],
      nextCursor: 1,
      result: {
        protocolVersion: SYSTEM_TASK_PROTOCOL_VERSION,
        taskId: 'task-require-local',
        ok: true,
        data: {},
      } satisfies SystemTaskResult,
      pendingPrompt: null,
    });

    await handleMachineCommand(
      ['setup', '--ssh', 'dev@example.test', '--require-local-approval', '--json'],
      {
        applyServerSelectionFromArgs: async (args) => args,
        createRunner: () => ({
          start,
          poll,
          respond: vi.fn(async () => undefined),
        }),
        readRelaySelection: () => ({
          relayUrl: 'https://relay.example.test',
          webappUrl: 'https://app.example.test',
        }),
        promptInput: async () => {
          throw new Error('prompt should not be used');
        },
        promptSecret: async () => {
          throw new Error('promptSecret should not be used');
        },
        isInteractiveTerminal: () => false,
        sleep: async () => undefined,
      },
    );

    expect(start).toHaveBeenCalledWith({
      spec: expect.objectContaining({
        kind: 'remote.ssh.bootstrapMachine.v1',
        params: expect.objectContaining({
          requireLocalApproval: true,
        }),
      }),
    });
  });

  it('uses the current hdev invoker channel when setup omits explicit channel flags', async () => {
    const originalArgv = [...process.argv];
    const result: SystemTaskResult = {
      protocolVersion: SYSTEM_TASK_PROTOCOL_VERSION,
      taskId: 'task-1',
      ok: true,
      data: { machineId: 'machine-1' },
    };
    const start = vi.fn(async () => ({ taskId: 'task-1' }));
    const poll = vi.fn(async () => ({
      events: [],
      nextCursor: 0,
      result,
      pendingPrompt: null,
    }));

    try {
      process.argv = ['hdev', 'machine', 'setup'];
      await handleMachineCommand(
        ['setup', '--ssh', 'dev@example.test', '--json'],
        {
          applyServerSelectionFromArgs: async (args) => args,
          createRunner: () => ({
            start,
            poll,
            respond: vi.fn(),
          }),
          readRelaySelection: () => ({
            relayUrl: 'https://relay.example.test',
            webappUrl: 'https://app.example.test',
          }),
          promptInput: async () => {
            throw new Error('prompt should not be used');
          },
          promptSecret: async () => {
            throw new Error('promptSecret should not be used');
          },
          isInteractiveTerminal: () => false,
          sleep: async () => undefined,
        },
      );

      expect(start).toHaveBeenCalledWith({
        spec: expect.objectContaining({
          params: expect.objectContaining({
            channel: 'dev',
          }),
        }),
      });
    } finally {
      process.argv = originalArgv;
    }
  });

  it('prints explicit relay switching guidance after installing a remote relay runtime', async () => {
    const result: SystemTaskResult = {
      protocolVersion: SYSTEM_TASK_PROTOCOL_VERSION,
      taskId: 'task-2',
      ok: true,
      data: {
        machineId: 'machine-2',
        relayRuntime: {
          relayUrl: 'https://relay.remote.example.test',
          mode: 'user',
        },
      },
    };

    const poll = vi.fn()
      .mockResolvedValueOnce({
        events: [],
        nextCursor: 1,
        result: null,
        pendingPrompt: null,
      })
      .mockResolvedValueOnce({
        events: [],
        nextCursor: 1,
        result,
        pendingPrompt: null,
      });

    await handleMachineCommand(
      ['setup', '--ssh', 'dev@example.test', '--install-relay-runtime'],
      {
        applyServerSelectionFromArgs: async (args) => args,
        createRunner: () => ({
          start: vi.fn(async () => ({ taskId: 'task-2' })),
          poll,
          respond: vi.fn(async () => undefined),
        }),
        readRelaySelection: () => ({
          relayUrl: 'https://relay.example.test',
          webappUrl: 'https://app.example.test',
        }),
        promptInput: async () => {
          throw new Error('prompt should not be used');
        },
        promptSecret: async () => {
          throw new Error('promptSecret should not be used');
        },
        isInteractiveTerminal: () => false,
        sleep: async () => undefined,
      },
    );

    const output = logSpy.mock.calls.flat().join('\n');
    expect(output).toContain('Remote relay URL: https://relay.remote.example.test');
    expect(output).toContain('happier relay set https://relay.remote.example.test --use');
  });

  it('does not suggest switching to a loopback relay URL after installing a remote relay runtime', async () => {
    const result: SystemTaskResult = {
      protocolVersion: SYSTEM_TASK_PROTOCOL_VERSION,
      taskId: 'task-loopback',
      ok: true,
      data: {
        machineId: 'machine-loopback',
        relayRuntime: {
          relayUrl: 'http://localhost.:53388',
          mode: 'user',
        },
      },
    };

    const poll = vi.fn()
      .mockResolvedValueOnce({
        events: [],
        nextCursor: 1,
        result: null,
        pendingPrompt: null,
      })
      .mockResolvedValueOnce({
        events: [],
        nextCursor: 1,
        result,
        pendingPrompt: null,
      });

    await handleMachineCommand(
      ['setup', '--ssh', 'dev@example.test', '--install-relay-runtime'],
      {
        applyServerSelectionFromArgs: async (args) => args,
        createRunner: () => ({
          start: vi.fn(async () => ({ taskId: 'task-loopback' })),
          poll,
          respond: vi.fn(async () => undefined),
        }),
        readRelaySelection: () => ({
          relayUrl: 'https://relay.example.test',
          webappUrl: 'https://app.example.test',
        }),
        promptInput: async () => {
          throw new Error('prompt should not be used');
        },
        promptSecret: async () => {
          throw new Error('promptSecret should not be used');
        },
        isInteractiveTerminal: () => false,
        sleep: async () => undefined,
      },
    );

    const output = logSpy.mock.calls.flat().join('\n');
    expect(output).toContain('Remote relay URL: http://localhost.:53388');
    expect(output).not.toContain('happier relay set http://localhost.:53388 --use');
    expect(output.toLowerCase()).toContain('remote machine');
  });

  it('supports password-based SSH auth and answers the password prompt securely', async () => {
    const respond = vi.fn(async () => undefined);
    const promptSecret = vi.fn(async () => 'super-secret');
    const start = vi.fn(async () => ({ taskId: 'task-password' }));
    const poll = vi.fn()
      .mockResolvedValueOnce({
        events: [],
        nextCursor: 1,
        result: null,
        pendingPrompt: {
          kind: 'ssh.password',
          data: {
            target: 'dev@example.test',
          },
        },
      })
      .mockResolvedValueOnce({
        events: [],
        nextCursor: 1,
        result: {
          protocolVersion: SYSTEM_TASK_PROTOCOL_VERSION,
          taskId: 'task-password',
          ok: true,
          data: {
            machineId: 'machine-password',
          },
        } satisfies SystemTaskResult,
        pendingPrompt: null,
      });

    await handleMachineCommand(
      [
        'setup',
        '--ssh',
        'dev@example.test',
        '--ssh-auth',
        'password',
      ],
      {
        applyServerSelectionFromArgs: async (args) => args,
        createRunner: () => ({
          start,
          poll,
          respond,
        }),
        readRelaySelection: () => ({
          relayUrl: 'https://relay.example.test',
          webappUrl: 'https://app.example.test',
        }),
        promptInput: async () => {
          throw new Error('promptInput should not be used for SSH password auth');
        },
        promptSecret,
        isInteractiveTerminal: () => true,
        sleep: async () => undefined,
      },
    );

    expect(start).toHaveBeenCalledWith({
      spec: {
        protocolVersion: 1,
        kind: 'remote.ssh.bootstrapMachine.v1',
        params: expect.objectContaining({
          ssh: expect.objectContaining({
            target: 'dev@example.test',
            auth: 'password',
          }),
        }),
      },
    });
    expect(promptSecret).toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith({
      taskId: 'task-password',
      answer: {
        password: 'super-secret',
      },
    });
  });

  it('accepts --ssh-port with legacy --ssh target syntax', async () => {
    const respond = vi.fn(async () => undefined);
    const promptSecret = vi.fn(async () => 'super-secret');
    const start = vi.fn(async () => ({ taskId: 'task-ssh-port' }));
    const poll = vi.fn()
      .mockResolvedValueOnce({
        events: [],
        nextCursor: 1,
        result: null,
        pendingPrompt: {
          kind: 'ssh.password',
          data: {
            target: 'dev@example.test',
          },
        },
      })
      .mockResolvedValueOnce({
        events: [],
        nextCursor: 1,
        result: {
          protocolVersion: SYSTEM_TASK_PROTOCOL_VERSION,
          taskId: 'task-ssh-port',
          ok: true,
          data: {
            machineId: 'machine-ssh-port',
          },
        } satisfies SystemTaskResult,
        pendingPrompt: null,
      });

    await handleMachineCommand(
      [
        'setup',
        '--ssh',
        'dev@example.test',
        '--ssh-port',
        '2222',
        '--ssh-auth=password',
      ],
      {
        applyServerSelectionFromArgs: async (args) => args,
        createRunner: () => ({
          start,
          poll,
          respond,
        }),
        readRelaySelection: () => ({
          relayUrl: 'https://relay.example.test',
          webappUrl: 'https://app.example.test',
        }),
        promptInput: async () => {
          throw new Error('promptInput should not be used for SSH password auth');
        },
        promptSecret,
        isInteractiveTerminal: () => true,
        sleep: async () => undefined,
      },
    );

    expect(start).toHaveBeenCalledWith({
      spec: {
        protocolVersion: 1,
        kind: 'remote.ssh.bootstrapMachine.v1',
        params: expect.objectContaining({
          ssh: expect.objectContaining({
            target: 'dev@example.test',
            port: 2222,
            auth: 'password',
          }),
        }),
      },
    });
    expect(promptSecret).toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith({
      taskId: 'task-ssh-port',
      answer: {
        password: 'super-secret',
      },
    });
  });

  it('accepts split SSH fields while keeping the legacy --ssh target syntax available', async () => {
    const respond = vi.fn(async () => undefined);
    const promptSecret = vi.fn(async () => 'super-secret');
    const start = vi.fn(async () => ({ taskId: 'task-split-ssh' }));
    const poll = vi.fn()
      .mockResolvedValueOnce({
        events: [],
        nextCursor: 1,
        result: null,
        pendingPrompt: {
          kind: 'ssh.password',
          data: {
            target: 'dev@example.test',
          },
        },
      })
      .mockResolvedValueOnce({
        events: [],
        nextCursor: 1,
        result: {
          protocolVersion: SYSTEM_TASK_PROTOCOL_VERSION,
          taskId: 'task-split-ssh',
          ok: true,
          data: {
            machineId: 'machine-split-ssh',
          },
        } satisfies SystemTaskResult,
        pendingPrompt: null,
      });

    await handleMachineCommand(
      [
        'setup',
        '--ssh-user',
        'dev',
        '--ssh-host',
        'example.test',
        '--ssh-port',
        '2222',
        '--ssh-auth=password',
      ],
      {
        applyServerSelectionFromArgs: async (args) => args,
        createRunner: () => ({
          start,
          poll,
          respond,
        }),
        readRelaySelection: () => ({
          relayUrl: 'https://relay.example.test',
          webappUrl: 'https://app.example.test',
        }),
        promptInput: async () => {
          throw new Error('promptInput should not be used for split SSH password auth');
        },
        promptSecret,
        isInteractiveTerminal: () => true,
        sleep: async () => undefined,
      },
    );

    expect(start).toHaveBeenCalledWith({
      spec: {
        protocolVersion: 1,
        kind: 'remote.ssh.bootstrapMachine.v1',
        params: expect.objectContaining({
          ssh: expect.objectContaining({
            target: 'dev@example.test',
            port: 2222,
            auth: 'password',
          }),
        }),
      },
    });
    expect(promptSecret).toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith({
      taskId: 'task-split-ssh',
      answer: {
        password: 'super-secret',
      },
    });
  });

  it('accepts prefixed relay selection flags before remote machine setup and reuses the selected relay profile', async () => {
    const start = vi.fn(async () => ({ taskId: 'task-3' }));
    const poll = vi.fn().mockResolvedValue({
      events: [],
      nextCursor: 1,
      result: {
        protocolVersion: SYSTEM_TASK_PROTOCOL_VERSION,
        taskId: 'task-3',
        ok: true,
        data: {
          machineId: 'machine-3',
        },
      } satisfies SystemTaskResult,
      pendingPrompt: null,
    });

    await handleMachineCommand(
      [
        'setup',
        '--server-url',
        'https://stack.example.test',
        '--local-server-url',
        'http://127.0.0.1:53545',
        '--ssh',
        'dev@example.test',
        '--json',
      ],
      {
        applyServerSelectionFromArgs: async (args) => {
          expect(args.slice(0, 4)).toEqual([
            '--server-url',
            'https://stack.example.test',
            '--local-server-url',
            'http://127.0.0.1:53545',
          ]);
          return ['--ssh', 'dev@example.test', '--json'];
        },
        createRunner: () => ({
          start,
          poll,
          respond: vi.fn(async () => undefined),
        }),
        readRelaySelection: () => ({
          relayUrl: 'https://stack.example.test',
          webappUrl: 'https://app.example.test',
          publicRelayUrl: 'https://stack.example.test',
        }),
        promptInput: async () => {
          throw new Error('prompt should not be used');
        },
        promptSecret: async () => {
          throw new Error('promptSecret should not be used');
        },
        isInteractiveTerminal: () => false,
        sleep: async () => undefined,
      },
    );

    expect(start).toHaveBeenCalledWith({
      spec: {
        protocolVersion: 1,
        kind: 'remote.ssh.bootstrapMachine.v1',
        params: expect.objectContaining({
          relay: {
            relayUrl: 'https://stack.example.test',
            webappUrl: 'https://app.example.test',
            publicRelayUrl: 'https://stack.example.test',
          },
        }),
      },
    });
  });

  it('answers SSH trust prompts interactively in text mode', async () => {
    const promptEvent: SystemTaskEvent = {
      protocolVersion: SYSTEM_TASK_PROTOCOL_VERSION,
      taskId: 'task-1',
      tsMs: 1,
      type: 'prompt',
      stepId: 'ssh.hostTrust',
      message: 'Trust remote SSH host key?',
      data: {
        kind: 'ssh.trustHost',
        host: 'dev.example.test',
        keyType: 'ssh-ed25519',
        fingerprint: 'SHA256:abc',
      },
    };
    const result: SystemTaskResult = {
      protocolVersion: SYSTEM_TASK_PROTOCOL_VERSION,
      taskId: 'task-1',
      ok: true,
      data: {
        machineId: 'machine-1',
      },
    };
    const respond = vi.fn(async () => undefined);
    const poll = vi.fn()
      .mockResolvedValueOnce({
        events: [promptEvent],
        nextCursor: 1,
        result: null,
        pendingPrompt: {
          kind: 'ssh.trustHost',
          data: promptEvent.data ?? {},
        },
      })
      .mockResolvedValueOnce({
        events: [],
        nextCursor: 1,
        result,
        pendingPrompt: null,
      });

    await handleMachineCommand(
      ['setup', '--ssh', 'dev@example.test'],
      {
        applyServerSelectionFromArgs: async (args) => args,
        createRunner: () => ({
          start: vi.fn(async () => ({ taskId: 'task-1' })),
          poll,
          respond,
        }),
        readRelaySelection: () => ({
          relayUrl: 'https://relay.example.test',
          webappUrl: 'https://app.example.test',
        }),
        promptInput: async () => 'y',
        promptSecret: async () => {
          throw new Error('promptSecret should not be used');
        },
        isInteractiveTerminal: () => true,
        sleep: async () => undefined,
      },
    );

    expect(respond).toHaveBeenCalledWith({
      taskId: 'task-1',
      answer: { trusted: true },
    });
    expect(logSpy.mock.calls.flat().join('\n')).toContain('Remote machine ready.');
  });

  it('auto-answers prompts in --yes mode even when the runner does not surface pendingPrompt', async () => {
    const respond = vi.fn(async () => {
      responded = true;
    });
    let responded = false;
    let pollCount = 0;

    const promptEvent: SystemTaskEvent = {
      protocolVersion: SYSTEM_TASK_PROTOCOL_VERSION,
      taskId: 'task-1',
      tsMs: 1,
      type: 'prompt',
      stepId: 'ssh.hostTrust',
      message: 'Trust this SSH host?',
      data: {
        kind: 'ssh.trustHost',
        host: '[127.0.0.1]:56494',
        keyType: 'ssh-ed25519',
        fingerprint: 'SHA256:example',
      },
    };

    const result: SystemTaskResult = {
      protocolVersion: SYSTEM_TASK_PROTOCOL_VERSION,
      taskId: 'task-1',
      ok: true,
      data: {},
    };

    const poll = vi.fn(async () => {
      pollCount += 1;
      if (pollCount === 1) {
        return {
          events: [promptEvent],
          nextCursor: 1,
          result: null,
          pendingPrompt: null,
        };
      }

      if (responded) {
        return {
          events: [],
          nextCursor: 1,
          result,
          pendingPrompt: null,
        };
      }

      return {
        events: [],
        nextCursor: 1,
        result: null,
        pendingPrompt: null,
      };
    });

    await handleMachineCommand(
      ['setup', '--ssh', 'dev@example.test', '--yes', '--json'],
      {
        applyServerSelectionFromArgs: async (args) => args,
        createRunner: () => ({
          start: vi.fn(async () => ({ taskId: 'task-1' })),
          poll,
          respond,
        }),
        readRelaySelection: () => ({
          relayUrl: 'https://relay.example.test',
          webappUrl: 'https://app.example.test',
        }),
        promptInput: async () => {
          throw new Error('prompt should not be used');
        },
        promptSecret: async () => {
          throw new Error('promptSecret should not be used');
        },
        isInteractiveTerminal: () => false,
        sleep: async () => {
          if (pollCount > 3) {
            throw new Error('loop guard: prompt was not answered');
          }
        },
      },
    );

    expect(respond).toHaveBeenCalledWith({
      taskId: 'task-1',
      answer: { trusted: true },
    });
    expect(logSpy.mock.calls.map((call) => call[0])).toContain(JSON.stringify(promptEvent));
    expect(logSpy.mock.calls.map((call) => call[0])).toContain(JSON.stringify(result));
  });

  it('fails closed in non-interactive mode without --yes when a prompt is required', async () => {
    const respond = vi.fn(async () => undefined);
    await handleMachineCommand(
      ['setup', '--ssh', 'dev@example.test'],
      {
        applyServerSelectionFromArgs: async (args) => args,
        createRunner: () => ({
          start: vi.fn(async () => ({ taskId: 'task-1' })),
          poll: vi.fn(async () => ({
            events: [],
            nextCursor: 0,
            result: null,
            pendingPrompt: {
              kind: 'auth.approveRemoteProvisioning',
              data: {
                publicKey: 'pub-key',
              },
            },
          })),
          respond,
        }),
        readRelaySelection: () => ({
          relayUrl: 'https://relay.example.test',
          webappUrl: 'https://app.example.test',
        }),
        promptInput: async () => {
          throw new Error('prompt should not be used');
        },
        promptSecret: async () => {
          throw new Error('promptSecret should not be used');
        },
        isInteractiveTerminal: () => false,
        sleep: async () => undefined,
      },
    );

    expect(respond).not.toHaveBeenCalled();
    expect(errorSpy.mock.calls.flat().join('\n')).toContain('Non-interactive mode requires --yes');
  });

  it('answers remote background service replacement prompts interactively', async () => {
    const respond = vi.fn(async () => undefined);
    let promptMessage = '';
    await handleMachineCommand(
      ['setup', '--ssh', 'dev@example.test'],
      {
        applyServerSelectionFromArgs: async (args) => args,
        createRunner: () => ({
          start: vi.fn(async () => ({ taskId: 'task-service-replace' })),
          poll: vi.fn()
            .mockResolvedValueOnce({
              events: [],
              nextCursor: 0,
              result: null,
              pendingPrompt: {
                kind: 'daemon.replaceRemoteBackgroundServices',
                data: {
                  targetServerUrl: 'https://relay.example.test',
                  targetReleaseChannel: 'preview',
                  services: [
                    { label: 'happier-daemon.stable', releaseChannel: 'stable', targetMode: 'pinned', running: true },
                  ],
                },
              },
            })
            .mockResolvedValueOnce({
              events: [],
              nextCursor: 1,
              result: {
                protocolVersion: SYSTEM_TASK_PROTOCOL_VERSION,
                taskId: 'task-service-replace',
                ok: true,
                data: { machineId: 'machine-1' },
              },
              pendingPrompt: null,
            }),
          respond,
        }),
        readRelaySelection: () => ({
          relayUrl: 'https://relay.example.test',
          webappUrl: 'https://app.example.test',
        }),
        promptInput: async (value) => {
          promptMessage = value;
          return 'y';
        },
        promptSecret: async () => {
          throw new Error('promptSecret should not be used');
        },
        isInteractiveTerminal: () => true,
        sleep: async () => undefined,
      },
    );

    expect(respond).toHaveBeenCalledWith({
      taskId: 'task-service-replace',
      answer: { replaceExistingServices: true },
    });
    expect(promptMessage).toContain('legacy pinned background service');
    expect(promptMessage).not.toContain('(stable, pinned)');
  });

  it('rejects unknown setup flags instead of ignoring them', async () => {
    await handleMachineCommand(
      ['setup', '--ssh', 'dev@example.test', '--bogus', '--json'],
      {
        applyServerSelectionFromArgs: async (args) => args,
        createRunner: () => ({
          start: vi.fn(async () => ({ taskId: 'task-1' })),
          poll: vi.fn(async () => ({
            events: [],
            nextCursor: 0,
            result: null,
            pendingPrompt: null,
          })),
          respond: vi.fn(async () => undefined),
        }),
        readRelaySelection: () => ({
          relayUrl: 'https://relay.example.test',
          webappUrl: 'https://app.example.test',
        }),
        promptInput: async () => 'y',
        promptSecret: async () => {
          throw new Error('promptSecret should not be used');
        },
        isInteractiveTerminal: () => false,
        sleep: async () => undefined,
      },
    );

    expect(logSpy.mock.calls.flat().join('\n')).toContain('"ok":false');
    expect(logSpy.mock.calls.flat().join('\n')).toContain('invalid_arguments');
  });

  it('rejects multi-line --trusted-host-key values', async () => {
    await handleMachineCommand(
      [
        'setup',
        '--ssh',
        'dev@example.test',
        '--known-hosts-path',
        '/tmp/known_hosts',
        '--trusted-host-key',
        'example.test ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAA\nbad',
        '--json',
      ],
      {
        applyServerSelectionFromArgs: async (args) => args,
        createRunner: () => ({
          start: vi.fn(async () => ({ taskId: 'task-1' })),
          poll: vi.fn(async () => ({
            events: [],
            nextCursor: 0,
            result: null,
            pendingPrompt: null,
          })),
          respond: vi.fn(async () => undefined),
        }),
        readRelaySelection: () => ({
          relayUrl: 'https://relay.example.test',
          webappUrl: 'https://app.example.test',
        }),
        promptInput: async () => 'y',
        promptSecret: async () => {
          throw new Error('promptSecret should not be used');
        },
        isInteractiveTerminal: () => false,
        sleep: async () => undefined,
      },
    );

    expect(logSpy.mock.calls.flat().join('\n')).toContain('"ok":false');
    expect(logSpy.mock.calls.flat().join('\n')).toContain('invalid_arguments');
  });

  it('rejects specifying a port in --ssh with actionable guidance', async () => {
    await handleMachineCommand(
      ['setup', '--ssh', 'dev@example.test:2222'],
      {
        applyServerSelectionFromArgs: async (args) => args,
        createRunner: () => ({
          start: vi.fn(async () => ({ taskId: 'task-1' })),
          poll: vi.fn(async () => ({
            events: [],
            nextCursor: 0,
            result: null,
            pendingPrompt: null,
          })),
          respond: vi.fn(async () => undefined),
        }),
        readRelaySelection: () => ({
          relayUrl: 'https://relay.example.test',
          webappUrl: 'https://app.example.test',
        }),
        promptInput: async () => 'y',
        promptSecret: async () => {
          throw new Error('promptSecret should not be used');
        },
        isInteractiveTerminal: () => false,
        sleep: async () => undefined,
      },
    );

    expect(errorSpy.mock.calls.flat().join('\n')).toContain('port in --ssh');
    expect(errorSpy.mock.calls.flat().join('\n')).toContain('--ssh-config-file');
  });

  it('sets a non-zero exit code when the JSON result is not ok', async () => {
    const result: SystemTaskResult = {
      protocolVersion: SYSTEM_TASK_PROTOCOL_VERSION,
      taskId: 'task-1',
      ok: false,
      error: {
        code: 'system_task_failed',
        message: 'boom',
      },
    };

    const poll = vi.fn()
      .mockResolvedValueOnce({
        events: [],
        nextCursor: 1,
        result: null,
        pendingPrompt: null,
      })
      .mockResolvedValueOnce({
        events: [],
        nextCursor: 1,
        result,
        pendingPrompt: null,
      });

    await handleMachineCommand(
      ['setup', '--ssh', 'dev@example.test', '--json'],
      {
        applyServerSelectionFromArgs: async (args) => args,
        createRunner: () => ({
          start: vi.fn(async () => ({ taskId: 'task-1' })),
          poll,
          respond: vi.fn(async () => undefined),
        }),
        readRelaySelection: () => ({
          relayUrl: 'https://relay.example.test',
          webappUrl: 'https://app.example.test',
        }),
        promptInput: async () => {
          throw new Error('prompt should not be used');
        },
        promptSecret: async () => {
          throw new Error('promptSecret should not be used');
        },
        isInteractiveTerminal: () => false,
        sleep: async () => undefined,
      },
    );

    expect(logSpy.mock.calls.map((call) => call[0])).toContain(JSON.stringify(result));
    expect(process.exitCode).toBe(1);
  });
});
