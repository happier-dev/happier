import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createPlainSessionOwnerMetadataEnvelopeV1,
  SessionOwnerMetadataV1Schema,
} from '@happier-dev/protocol';

import { acquireAuthoritativePluginRuntimeRegistryLease } from '@/plugins/runtime/reload/runtimeLease';
import { SUPPORTED_SCHEMA_VERSION, type Settings } from '@/persistence';
import { createSessionRecordFixture } from '@/testkit/backends/sessionFixtures';
import { handleAttachCommand } from './attach';

const localSettings: Settings = {
  schemaVersion: SUPPORTED_SCHEMA_VERSION,
  onboardingCompleted: true,
  machineId: 'machine-local',
};

afterEach(() => vi.restoreAllMocks());

describe('standalone attach without an in-process daemon runtime', () => {
  it.each([
    { mode: 'tmux', active: true },
    { mode: 'zellij', active: true },
    { mode: 'herdr', active: true },
    { mode: 'herdr', active: false },
  ] as const)(
    'opens the synced $mode host (active=$active) through the real command and metadata decoder', async ({ mode, active }) => {
      await expect(acquireAuthoritativePluginRuntimeRegistryLease()).rejects.toMatchObject({
        code: 'PLUGIN_DAEMON_RUNTIME_UNAVAILABLE',
      });
      const terminal = mode === 'tmux'
        ? { mode, requested: mode, tmux: { target: 'happier:standalone' } }
        : mode === 'zellij'
          ? { mode, requested: mode, zellij: { sessionName: 'happier', paneId: '9' } }
          : { mode, requested: mode, herdr: { sessionName: 'happier', socketPath: '/tmp/happier-test.sock', terminalId: 'terminal-1', paneId: 'pane-1' } };
      const ownerMetadata = SessionOwnerMetadataV1Schema.parse({
        v: 1,
        workspace: { machineId: 'machine-local', path: '/tmp/workspace', flavor: 'claude' },
        runtime: { terminal },
      });
      const rawSession = createSessionRecordFixture({
        id: `standalone-${mode}`,
        active,
        encryptionMode: 'plain',
        metadataLayoutVersion: 1,
        metadata: JSON.stringify({ v: 1 }),
        ownerMetadata: createPlainSessionOwnerMetadataEnvelopeV1(ownerMetadata),
      });
      // Only external storage, HTTP and terminal-process boundaries are replaced;
      // the command, bridge, eligibility owner and metadata decoder stay real.
      const launchTerminal = vi.fn(async () => 0);
      await handleAttachCommand([rawSession.id], {
        readCredentialsFn: async () => ({ token: 'test-token', encryption: null }),
        readSettingsFn: async () => localSettings,
        fetchSessionByIdFn: async () => rawSession,
        getAccountEncryptionCurrentnessFn: async () => ({
          mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1,
        }),
        readTerminalAttachmentInfoFn: async () => null,
        runTmuxAttachFn: launchTerminal,
        runZellijAttachFn: launchTerminal,
        runHerdrAttachFn: launchTerminal,
      });
      expect(launchTerminal).toHaveBeenCalledWith(expect.objectContaining({ terminal }));
    },
  );

  it('explains a stopped Session instead of acquiring an executable runtime', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('command-exit'); });
    const rawSession = createSessionRecordFixture({
      id: 'standalone-stopped', active: false, encryptionMode: 'plain',
      metadata: JSON.stringify({ machineId: 'machine-local', path: '/tmp/workspace', flavor: 'claude' }),
    });
    await expect(handleAttachCommand([rawSession.id], {
      readCredentialsFn: async () => ({ token: 'test-token', encryption: null }),
      readSettingsFn: async () => localSettings,
      fetchSessionByIdFn: async () => rawSession,
      getAccountEncryptionCurrentnessFn: async () => ({
        mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1,
      }),
      readTerminalAttachmentInfoFn: async () => null,
      isTmuxAvailableFn: async () => false,
    })).rejects.toThrow('command-exit');
    expect(error).toHaveBeenCalledWith(expect.stringContaining('happier resume'));
  });
});
