import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { configuration, reloadConfiguration } from '@/configuration';

const readCredentialsMock = vi.fn();
const readSettingsMock = vi.fn();
const updateSettingsMock = vi.fn();
const decodeJwtPayloadMock = vi.fn();
const checkDaemonMock = vi.fn();

const createKvClientMock = vi.fn();
const upsertKvConfigMock = vi.fn();
const clearKvConfigMock = vi.fn();

vi.mock('@/persistence', () => ({
  readCredentials: readCredentialsMock,
  readSettings: readSettingsMock,
  updateSettings: updateSettingsMock,
}));

vi.mock('@/cloud/decodeJwtPayload', () => ({
  decodeJwtPayload: decodeJwtPayloadMock,
}));

vi.mock('@/daemon/controlClient', () => ({
  checkIfDaemonRunningAndCleanupStaleState: checkDaemonMock,
}));

vi.mock('@/channels/channelBridgeServerKv', () => ({
  createAxiosChannelBridgeKvClient: createKvClientMock,
  upsertChannelBridgeTelegramConfigInKv: upsertKvConfigMock,
  clearChannelBridgeTelegramConfigInKv: clearKvConfigMock,
  readChannelBridgeTelegramConfigFromKv: vi.fn(),
}));

describe('happier bridge command', () => {
  let homeDir: string;
  const prevHomeDir = process.env.HAPPIER_HOME_DIR;
  const prevServerUrl = process.env.HAPPIER_SERVER_URL;
  const prevWebappUrl = process.env.HAPPIER_WEBAPP_URL;

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();

    readCredentialsMock.mockResolvedValue({ token: 'token.jwt' });
    decodeJwtPayloadMock.mockReturnValue({ sub: 'acct_123' });
    readSettingsMock.mockResolvedValue({});
    checkDaemonMock.mockResolvedValue(false);

    updateSettingsMock.mockImplementation(async (updater: (current: unknown) => Promise<unknown> | unknown) => {
      await updater({});
    });

    createKvClientMock.mockReturnValue({ get: vi.fn(), mutate: vi.fn() });
    upsertKvConfigMock.mockResolvedValue(undefined);
    clearKvConfigMock.mockResolvedValue(undefined);

    homeDir = await mkdtemp(join(tmpdir(), 'happier-bridge-cmd-'));
    process.env.HAPPIER_HOME_DIR = homeDir;
    process.env.HAPPIER_SERVER_URL = 'http://127.0.0.1:3005';
    process.env.HAPPIER_WEBAPP_URL = 'http://127.0.0.1:3006';
    reloadConfiguration();
  });

  afterEach(async () => {
    process.exitCode = undefined;
    if (prevHomeDir === undefined) delete process.env.HAPPIER_HOME_DIR;
    else process.env.HAPPIER_HOME_DIR = prevHomeDir;
    if (prevServerUrl === undefined) delete process.env.HAPPIER_SERVER_URL;
    else process.env.HAPPIER_SERVER_URL = prevServerUrl;
    if (prevWebappUrl === undefined) delete process.env.HAPPIER_WEBAPP_URL;
    else process.env.HAPPIER_WEBAPP_URL = prevWebappUrl;
    reloadConfiguration();
    await rm(homeDir, { recursive: true, force: true });
  });

  it('writes telegram non-secret set updates to server KV and local settings', async () => {
    const { handleBridgeCliCommand } = await import('./bridge');

    await handleBridgeCliCommand({
      args: ['bridge', 'telegram', 'set', '--bot-token', 'bot-token-1', '--allow-all', '--require-topics', 'true'],
      rawArgv: [],
      terminalRuntime: null,
    });

    expect(createKvClientMock).toHaveBeenCalledWith({ token: 'token.jwt' });
    expect(upsertKvConfigMock).toHaveBeenCalledWith({
      kv: expect.any(Object),
      serverId: configuration.activeServerId,
      accountId: 'acct_123',
      update: {
        allowedChatIds: [],
        requireTopics: true,
      },
    });
    expect(updateSettingsMock).toHaveBeenCalledTimes(1);
    expect(upsertKvConfigMock.mock.invocationCallOrder[0]).toBeLessThan(updateSettingsMock.mock.invocationCallOrder[0]);
    expect(process.exitCode).toBeUndefined();
  });

  it('does not update local settings when shared KV write fails', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    upsertKvConfigMock.mockRejectedValueOnce(new Error('KV unavailable'));

    try {
      const { handleBridgeCliCommand } = await import('./bridge');

      await handleBridgeCliCommand({
        args: ['bridge', 'telegram', 'set', '--bot-token', 'bot-token-1', '--require-topics', 'true'],
        rawArgv: [],
        terminalRuntime: null,
      });

      expect(upsertKvConfigMock).toHaveBeenCalledTimes(1);
      expect(updateSettingsMock).not.toHaveBeenCalled();
      expect(process.exitCode).toBe(1);
      expect(errorSpy).toHaveBeenCalledWith(expect.anything(), expect.stringContaining('KV unavailable'));
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('does not write secrets-only updates to server KV', async () => {
    const { handleBridgeCliCommand } = await import('./bridge');

    await handleBridgeCliCommand({
      args: ['bridge', 'telegram', 'set', '--bot-token', 'bot-token-1'],
      rawArgv: [],
      terminalRuntime: null,
    });

    expect(createKvClientMock).not.toHaveBeenCalled();
    expect(upsertKvConfigMock).not.toHaveBeenCalled();
    expect(updateSettingsMock).toHaveBeenCalledTimes(1);
    expect(process.exitCode).toBeUndefined();
  });

  it('clears telegram config in server KV and local settings', async () => {
    const { handleBridgeCliCommand } = await import('./bridge');

    await handleBridgeCliCommand({
      args: ['bridge', 'telegram', 'clear'],
      rawArgv: [],
      terminalRuntime: null,
    });

    expect(createKvClientMock).toHaveBeenCalledWith({ token: 'token.jwt' });
    expect(clearKvConfigMock).toHaveBeenCalledWith({
      kv: expect.any(Object),
      serverId: configuration.activeServerId,
      accountId: 'acct_123',
    });
    expect(updateSettingsMock).toHaveBeenCalledTimes(1);
    expect(clearKvConfigMock.mock.invocationCallOrder[0]).toBeLessThan(updateSettingsMock.mock.invocationCallOrder[0]);
    expect(process.exitCode).toBeUndefined();
  });

  it('does not update local settings when shared KV clear fails', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    clearKvConfigMock.mockRejectedValueOnce(new Error('KV clear unavailable'));

    try {
      const { handleBridgeCliCommand } = await import('./bridge');

      await handleBridgeCliCommand({
        args: ['bridge', 'telegram', 'clear'],
        rawArgv: [],
        terminalRuntime: null,
      });

      expect(clearKvConfigMock).toHaveBeenCalledTimes(1);
      expect(updateSettingsMock).not.toHaveBeenCalled();
      expect(process.exitCode).toBe(1);
      expect(errorSpy).toHaveBeenCalledWith(expect.anything(), expect.stringContaining('KV clear unavailable'));
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('rejects webhook secrets that do not match Telegram-safe token charset', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const { handleBridgeCliCommand } = await import('./bridge');

      await handleBridgeCliCommand({
        args: ['bridge', 'telegram', 'set', '--webhook-secret', 'bad$secret'],
        rawArgv: [],
        terminalRuntime: null,
      });

      expect(updateSettingsMock).not.toHaveBeenCalled();
      expect(createKvClientMock).not.toHaveBeenCalled();
      expect(upsertKvConfigMock).not.toHaveBeenCalled();
      expect(process.exitCode).toBe(1);
      expect(errorSpy).toHaveBeenCalledWith(
        expect.anything(),
        expect.stringContaining('Invalid --webhook-secret value'),
      );
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('rejects explicitly passed empty --bot-token values', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    try {
      const { handleBridgeCliCommand } = await import('./bridge');

      await handleBridgeCliCommand({
        args: ['bridge', 'telegram', 'set', '--bot-token'],
        rawArgv: [],
        terminalRuntime: null,
      });

      expect(updateSettingsMock).not.toHaveBeenCalled();
      expect(createKvClientMock).not.toHaveBeenCalled();
      expect(process.exitCode).toBe(1);
      expect(errorSpy).toHaveBeenCalledWith(
        expect.anything(),
        expect.stringContaining('Invalid --bot-token value: cannot be empty'),
      );
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('rejects malformed --allowed-chat-ids that parse to an empty list', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    try {
      const { handleBridgeCliCommand } = await import('./bridge');

      await handleBridgeCliCommand({
        args: ['bridge', 'telegram', 'set', '--allowed-chat-ids', ',,,'],
        rawArgv: [],
        terminalRuntime: null,
      });

      expect(updateSettingsMock).not.toHaveBeenCalled();
      expect(createKvClientMock).not.toHaveBeenCalled();
      expect(process.exitCode).toBe(1);
      expect(errorSpy).toHaveBeenCalledWith(
        expect.anything(),
        expect.stringContaining('Invalid --allowed-chat-ids value'),
      );
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('rejects non-loopback --webhook-host values', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    try {
      const { handleBridgeCliCommand } = await import('./bridge');

      await handleBridgeCliCommand({
        args: ['bridge', 'telegram', 'set', '--webhook-host', '0.0.0.0'],
        rawArgv: [],
        terminalRuntime: null,
      });

      expect(updateSettingsMock).not.toHaveBeenCalled();
      expect(createKvClientMock).not.toHaveBeenCalled();
      expect(process.exitCode).toBe(1);
      expect(errorSpy).toHaveBeenCalledWith(
        expect.anything(),
        expect.stringContaining('Invalid --webhook-host value'),
      );
    } finally {
      errorSpy.mockRestore();
    }
  });
});
