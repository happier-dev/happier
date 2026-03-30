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
    logSpy.mockReset();
    errorSpy.mockReset();
    process.exitCode = undefined;
  });

  it('streams remote bootstrap task events/results in json mode and forwards parsed relay/task options', async () => {
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
        'bootstrap',
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
          },
        },
      },
    });
    expect(logSpy.mock.calls.map((call) => call[0])).toEqual([
      JSON.stringify(event),
      JSON.stringify(result),
    ]);
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
      ['bootstrap', '--ssh', 'dev@example.test'],
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

  it('fails closed in non-interactive mode without --yes when a prompt is required', async () => {
    const respond = vi.fn(async () => undefined);
    await handleMachineCommand(
      ['bootstrap', '--ssh', 'dev@example.test'],
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
        isInteractiveTerminal: () => false,
        sleep: async () => undefined,
      },
    );

    expect(respond).not.toHaveBeenCalled();
    expect(errorSpy.mock.calls.flat().join('\n')).toContain('Non-interactive mode requires --yes');
  });

  it('rejects unknown bootstrap flags instead of ignoring them', async () => {
    await handleMachineCommand(
      ['bootstrap', '--ssh', 'dev@example.test', '--bogus', '--json'],
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
        isInteractiveTerminal: () => false,
        sleep: async () => undefined,
      },
    );

    expect(logSpy.mock.calls.flat().join('\n')).toContain('"ok":false');
    expect(logSpy.mock.calls.flat().join('\n')).toContain('invalid_arguments');
  });
});
