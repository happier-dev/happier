import { describe, expect, it } from 'vitest';

import type { Machine } from '@/api/types';
import { decodeBase64, encodeBase64, decrypt, encrypt } from '@/api/encryption';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { SPAWN_SESSION_ERROR_CODES } from '@/session/shared/spawnSessionContract';

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
      backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
      terminal: { mode: 'tmux', tmux: { sessionName: 'happy', isolated: true } },
    };
    const encrypted = encodeBase64(encrypt(machine.encryptionKey, machine.encryptionVariant, params));

    await rpc.handleRequest({
      method: `${machine.id}:${RPC_METHODS.SPAWN_HAPPY_SESSION}`,
      params: encrypted,
    });

    expect(captured).toEqual(
      expect.objectContaining({
        directory: '/tmp',
        backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
        terminal: { mode: 'tmux', tmux: { sessionName: 'happy', isolated: true } },
      }),
    );
  });

  it('enforces the advertised V1 outcome contract through the live machine RPC registration', async () => {
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
    client.setRPCHandlers({
      spawnSession: async () => ({ type: 'success', sessionId: 'session-without-outcome' }),
      sessionSpawnV1OutcomeRequired: true,
      stopSession: async () => true,
      requestShutdown: () => {},
    });

    const rpc = (client as any).rpcHandlerManager;
    const params = {
      directory: '/tmp',
      backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
    };
    const result = await rpc.handleRequest({
      method: `${machine.id}:${RPC_METHODS.SPAWN_HAPPY_SESSION}`,
      params: encodeBase64(encrypt(machine.encryptionKey, machine.encryptionVariant, params)),
    });

    expect(decrypt(machine.encryptionKey, machine.encryptionVariant, decodeBase64(result))).toEqual({
      type: 'error',
      errorCode: SPAWN_SESSION_ERROR_CODES.DAEMON_RPC_UNAVAILABLE,
      errorMessage: 'Advertised session-spawn V1 did not return create-or-rejoin outcome',
    });
  });

  it('normalizes released resume-session Codex mode into runtimeDescriptorV1', async () => {
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
      backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
      resume: 'codex-session-123',
      codexBackendMode: 'appServer',
      experimentalCodexAcp: true,
      attachMetadataIdentityPolicy: 'replace_with_runtime_identity',
      initialTranscriptAfterSeq: 199,
      environmentVariables: {
        HAPPIER_OPENCODE_BACKEND_MODE: 'server',
        HAPPIER_OPENCODE_SERVER_URL: 'http://127.0.0.1:4096/',
      },
    };
    const encrypted = encodeBase64(encrypt(machine.encryptionKey, machine.encryptionVariant, params));

    await rpc.handleRequest({
      method: `${machine.id}:${RPC_METHODS.SPAWN_HAPPY_SESSION}`,
      params: encrypted,
    });

    expect(captured).toEqual(
      expect.objectContaining({
        directory: '/tmp',
        backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
        existingSessionId: 'happy-session-1',
        resume: 'codex-session-123',
        runtimeDescriptorV1: {
          v: 1,
          agentId: 'codex',
          agent: { backendMode: 'appServer' },
        },
        attachMetadataIdentityPolicy: 'replace_with_runtime_identity',
        initialTranscriptAfterSeq: 199,
        environmentVariables: {
          HAPPIER_OPENCODE_BACKEND_MODE: 'server',
          HAPPIER_OPENCODE_SERVER_URL: 'http://127.0.0.1:4096/',
        },
      }),
    );
    expect(captured).not.toHaveProperty('codexBackendMode');
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
      backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
      agentModeId: 'plan',
      agentModeUpdatedAt: 321,
      codexBackendMode: 'appServer',
    };
    const encrypted = encodeBase64(encrypt(machine.encryptionKey, machine.encryptionVariant, params));

    await rpc.handleRequest({
      method: `${machine.id}:${RPC_METHODS.SPAWN_HAPPY_SESSION}`,
      params: encrypted,
    });

    expect(captured).toEqual(
      expect.objectContaining({
        directory: '/tmp',
        backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
        agentModeId: 'plan',
        agentModeUpdatedAt: 321,
        runtimeDescriptorV1: {
          v: 1,
          agentId: 'codex',
          agent: { backendMode: 'appServer' },
        },
      }),
    );
    expect(captured).not.toHaveProperty('codexBackendMode');
    expect(captured).not.toHaveProperty('workspaceId');
    expect(captured).not.toHaveProperty('workspaceLocationId');
    expect(captured).not.toHaveProperty('workspaceCheckoutId');
  });

  it('registers direct transfer export prepare handlers on the machine rpc registry', async () => {
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

    let captured: unknown = null;
    client.setRPCHandlers({
      spawnSession: async () => ({ type: 'success', sessionId: 'session-1' }),
      stopSession: async () => true,
      requestShutdown: () => {},
      directTransferExport: {
        prepareExportSession: async (request) => {
          captured = request;
          return {
            transferId: 'transfer-1',
            endpointCandidates: [],
            expiresAt: 5_000,
            name: 'hello.txt',
            sizeBytes: 5,
          };
        },
      },
    });

    const rpc = (client as any).rpcHandlerManager;
    const params = {
      t: 'workspace_file_download_v1',
      workingDirectory: '/repo',
      path: '/repo/hello.txt',
      asZip: false,
    };
    const encrypted = encodeBase64(encrypt(machine.encryptionKey, machine.encryptionVariant, params));

    const result = await rpc.handleRequest({
      method: `${machine.id}:${RPC_METHODS.DAEMON_DIRECT_TRANSFER_EXPORT_PREPARE}`,
      params: encrypted,
    });

    expect(captured).toEqual(params);
    expect(decrypt(machine.encryptionKey, machine.encryptionVariant, decodeBase64(result))).toEqual({
      success: true,
      transferId: 'transfer-1',
      endpointCandidates: [],
      expiresAt: 5_000,
      name: 'hello.txt',
      sizeBytes: 5,
    });
  });
});
