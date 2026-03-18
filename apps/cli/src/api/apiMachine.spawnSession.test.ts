import { describe, expect, it } from 'vitest';

import type { Machine } from '@/api/types';
import { encodeBase64, encrypt } from '@/api/encryption';

import { ApiMachineClient } from './apiMachine';

describe('ApiMachineClient spawn-happy-session handler', () => {
  it('forwards terminal spawn options to daemon spawnSession handler', async () => {
    const machine: Machine = {
      id: 'machine-test',
      encryptionKey: new Uint8Array(32).fill(7),
      encryptionVariant: 'legacy',
      metadata: null,
      metadataVersion: 0,
      daemonState: null,
      daemonStateVersion: 0,
    };

    const client = new ApiMachineClient('token', machine);

    let captured: any = null;
    client.setRPCHandlers({
      spawnSession: async (options) => {
        captured = options;
        return { type: 'success', sessionId: 'session-1' };
      },
      stopSession: async () => true,
      requestShutdown: () => {},
    });

    const rpc = (client as any).rpcHandlerManager;
    const params = {
      directory: '/tmp',
      terminal: { mode: 'tmux', tmux: { sessionName: 'happy', isolated: true } },
    };
    const encrypted = encodeBase64(encrypt(machine.encryptionKey, machine.encryptionVariant, params));

    await rpc.handleRequest({
      method: `${machine.id}:spawn-happy-session`,
      params: encrypted,
    });

    expect(captured).toEqual(
      expect.objectContaining({
        directory: '/tmp',
        terminal: { mode: 'tmux', tmux: { sessionName: 'happy', isolated: true } },
      }),
    );
  });

  it('forwards resume-session vendor resume id using canonical codex backend mode', async () => {
    const machine: Machine = {
      id: 'machine-test',
      encryptionKey: new Uint8Array(32).fill(7),
      encryptionVariant: 'legacy',
      metadata: null,
      metadataVersion: 0,
      daemonState: null,
      daemonStateVersion: 0,
    };

    const client = new ApiMachineClient('token', machine);

    let captured: any = null;
    client.setRPCHandlers({
      spawnSession: async (options) => {
        captured = options;
        return { type: 'success', sessionId: 'session-1' };
      },
      stopSession: async () => true,
      requestShutdown: () => {},
    });

    const rpc = (client as any).rpcHandlerManager;
    const params = {
      type: 'resume-session',
      sessionId: 'happy-session-1',
      directory: '/tmp',
      backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
      resume: 'codex-session-123',
      codexBackendMode: 'appServer',
      experimentalCodexAcp: true,
      attachMetadataIdentityPolicy: 'replace_with_runtime_identity',
      environmentVariables: {
        HAPPIER_OPENCODE_BACKEND_MODE: 'server',
        HAPPIER_OPENCODE_SERVER_URL: 'http://127.0.0.1:4096/',
      },
    };
    const encrypted = encodeBase64(encrypt(machine.encryptionKey, machine.encryptionVariant, params));

    await rpc.handleRequest({
      method: `${machine.id}:spawn-happy-session`,
      params: encrypted,
    });

    expect(captured).toEqual(
      expect.objectContaining({
        directory: '/tmp',
        backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
        existingSessionId: 'happy-session-1',
        resume: 'codex-session-123',
        codexBackendMode: 'appServer',
        attachMetadataIdentityPolicy: 'replace_with_runtime_identity',
        environmentVariables: {
          HAPPIER_OPENCODE_BACKEND_MODE: 'server',
          HAPPIER_OPENCODE_SERVER_URL: 'http://127.0.0.1:4096/',
        },
      }),
    );
    expect(captured).not.toHaveProperty('experimentalCodexAcp');
  });

  it('forwards authoritative mode fields without removed workspace linkage to daemon spawnSession handler', async () => {
    const machine: Machine = {
      id: 'machine-test',
      encryptionKey: new Uint8Array(32).fill(7),
      encryptionVariant: 'legacy',
      metadata: null,
      metadataVersion: 0,
      daemonState: null,
      daemonStateVersion: 0,
    };

    const client = new ApiMachineClient('token', machine);

    let captured: any = null;
    client.setRPCHandlers({
      spawnSession: async (options) => {
        captured = options;
        return { type: 'success', sessionId: 'session-1' };
      },
      stopSession: async () => true,
      requestShutdown: () => {},
    });

    const rpc = (client as any).rpcHandlerManager;
    const params = {
      directory: '/tmp',
      backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
      agentModeId: 'plan',
      agentModeUpdatedAt: 321,
      codexBackendMode: 'appServer',
    };
    const encrypted = encodeBase64(encrypt(machine.encryptionKey, machine.encryptionVariant, params));

    await rpc.handleRequest({
      method: `${machine.id}:spawn-happy-session`,
      params: encrypted,
    });

    expect(captured).toEqual(
      expect.objectContaining({
        directory: '/tmp',
        backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
        agentModeId: 'plan',
        agentModeUpdatedAt: 321,
        codexBackendMode: 'appServer',
      }),
    );
    expect(captured).not.toHaveProperty('workspaceId');
    expect(captured).not.toHaveProperty('workspaceLocationId');
    expect(captured).not.toHaveProperty('workspaceCheckoutId');
  });
});
