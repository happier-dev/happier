import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { reloadConfiguration } from '@/configuration';

const readCredentialsMock = vi.fn();
const readSettingsMock = vi.fn();
const updateSettingsMock = vi.fn();
const decodeJwtPayloadMock = vi.fn();
const checkDaemonMock = vi.fn();

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

describe('happier bridge command (local-only v1)', () => {
  let homeDir: string;
  const prevHomeDir = process.env.HAPPIER_HOME_DIR;
  const prevServerUrl = process.env.HAPPIER_SERVER_URL;
  const prevWebappUrl = process.env.HAPPIER_WEBAPP_URL;
  let logSpy: ReturnType<typeof vi.spyOn> | null = null;
  let lastUpdatedSettings: unknown = null;

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    logSpy?.mockRestore();
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    readCredentialsMock.mockResolvedValue({ token: 'token.jwt' });
    decodeJwtPayloadMock.mockReturnValue({ sub: 'acct_123' });
    readSettingsMock.mockResolvedValue({});
    checkDaemonMock.mockResolvedValue(false);

    updateSettingsMock.mockImplementation(async (updater: (current: unknown) => Promise<unknown> | unknown) => {
      lastUpdatedSettings = await updater({});
    });

    homeDir = await mkdtemp(join(tmpdir(), 'happier-bridge-cmd-'));
    process.env.HAPPIER_HOME_DIR = homeDir;
    process.env.HAPPIER_SERVER_URL = 'http://127.0.0.1:3005';
    process.env.HAPPIER_WEBAPP_URL = 'http://127.0.0.1:3006';
    reloadConfiguration();
  });

  afterEach(async () => {
    logSpy?.mockRestore();
    logSpy = null;
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

  it('writes telegram set updates to local settings', async () => {
    const { handleBridgeCliCommand } = await import('./bridge');

    await handleBridgeCliCommand({
      args: ['bridge', 'telegram', 'set', '--bot-token', 'bot-token-1', '--allow-all', '--require-topics', 'true'],
      rawArgv: [],
      terminalRuntime: null,
    });

    expect(updateSettingsMock).toHaveBeenCalledTimes(1);
    expect(lastUpdatedSettings).toMatchObject({
      experiments: true,
      featureToggles: {
        channelBridges: true,
      },
    });
    expect(process.exitCode).toBeUndefined();
  });

  it('clears telegram config in local settings', async () => {
    const { handleBridgeCliCommand } = await import('./bridge');

    await handleBridgeCliCommand({
      args: ['bridge', 'telegram', 'clear'],
      rawArgv: [],
      terminalRuntime: null,
    });

    expect(updateSettingsMock).toHaveBeenCalledTimes(1);
    expect(process.exitCode).toBeUndefined();
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
        args: ['bridge', 'telegram', 'set', '--bot-token', '   '],
        rawArgv: [],
        terminalRuntime: null,
      });

      expect(updateSettingsMock).not.toHaveBeenCalled();
      expect(process.exitCode).toBe(1);
      expect(errorSpy).toHaveBeenCalledWith(
        expect.anything(),
        expect.stringContaining('Invalid --bot-token value'),
      );
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('rejects explicitly passed empty --webhook-secret values', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const { handleBridgeCliCommand } = await import('./bridge');

      await handleBridgeCliCommand({
        args: ['bridge', 'telegram', 'set', '--webhook-secret', '   '],
        rawArgv: [],
        terminalRuntime: null,
      });

      expect(updateSettingsMock).not.toHaveBeenCalled();
      expect(process.exitCode).toBe(1);
      expect(errorSpy).toHaveBeenCalledWith(
        expect.anything(),
        expect.stringContaining('Invalid --webhook-secret value'),
      );
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('rejects overlong webhook secret values before persisting settings', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const { handleBridgeCliCommand } = await import('./bridge');

      await handleBridgeCliCommand({
        args: ['bridge', 'telegram', 'set', '--webhook-secret', 'x'.repeat(257)],
        rawArgv: [],
        terminalRuntime: null,
      });

      expect(updateSettingsMock).not.toHaveBeenCalled();
      expect(process.exitCode).toBe(1);
      expect(errorSpy).toHaveBeenCalledWith(
        expect.anything(),
        expect.stringContaining('Webhook secret token is too long'),
      );
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('rejects explicitly passed empty --allowed-chat-ids values', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const { handleBridgeCliCommand } = await import('./bridge');

      await handleBridgeCliCommand({
        args: ['bridge', 'telegram', 'set', '--allowed-chat-ids', '   '],
        rawArgv: [],
        terminalRuntime: null,
      });

      expect(updateSettingsMock).not.toHaveBeenCalled();
      expect(process.exitCode).toBe(1);
      expect(errorSpy).toHaveBeenCalledWith(
        expect.anything(),
        expect.stringContaining('Invalid --allowed-chat-ids value'),
      );
    } finally {
      errorSpy.mockRestore();
    }
  });
});
