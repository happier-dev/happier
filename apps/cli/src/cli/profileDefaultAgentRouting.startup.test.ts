import axios from 'axios';
import tweetnacl from 'tweetnacl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { configuration, reloadConfiguration } from '@/configuration';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { createTempDir, removeTempDir } from '@/testkit/fs/tempDir';
import { setStdioTtyForTest } from '@/testkit/process/stdio';
import { captureConsoleLogAndMuteStdout } from '@/testkit/logger/captureOutput';
import { resetInMemoryAccountSettingsContextForTests } from '@/settings/accountSettings/bootstrapAccountSettingsContext';
import { prepareProfileSessionStart } from './profileDefaultAgentRouting';
import { runBackendSessionCliCommand } from './runBackendSessionCliCommand';
import { handleConfiguredAcpCatalogCliCommand } from '@/agent/acp/catalog/configured/handleConfiguredAcpCatalogCliCommand';
import { dispatchCli } from './dispatch';
import { accountSettingsParse } from '@happier-dev/protocol';
import { handleClaudeCliCommand } from '@/backends/claude/cli/command';
import type { AccountSettingsContext } from '@/settings/accountSettings/bootstrapAccountSettingsContext';

describe('profile startup through authentication and settings', () => {
  const envKeys = ['HAPPIER_HOME_DIR', 'HAPPIER_SERVER_URL', 'HAPPIER_WEBAPP_URL', 'HAPPIER_NO_BROWSER_OPEN', 'HAPPIER_AUTH_METHOD', 'HAPPIER_AUTH_POLL_INTERVAL_MS', 'HAPPIER_TAILSCALE_AUTO_PUBLIC_URL', 'HAPPIER_SESSION_AUTOSTART_DAEMON', 'HAPPIER_ACCOUNT_SETTINGS_MODE', 'ROUTING_PROFILE_TEST', 'HAPPIER_SESSION_PROFILE_ID'] as const;
  let env = createEnvKeyScope(envKeys);
  let directory: string;
  let restoreTty: () => void;
  beforeEach(async () => {
    directory = await createTempDir('happier-profile-first-login-');
    env = createEnvKeyScope(envKeys);
    env.patch({ HAPPIER_HOME_DIR: directory, HAPPIER_SERVER_URL: 'https://routing.test', HAPPIER_WEBAPP_URL: 'https://web.test', HAPPIER_NO_BROWSER_OPEN: '1', HAPPIER_AUTH_METHOD: 'web', HAPPIER_AUTH_POLL_INTERVAL_MS: '1', HAPPIER_TAILSCALE_AUTO_PUBLIC_URL: '0', HAPPIER_SESSION_AUTOSTART_DAEMON: '1', HAPPIER_ACCOUNT_SETTINGS_MODE: undefined });
    restoreTty = setStdioTtyForTest({ stdin: false, stdout: false });
    reloadConfiguration();
    resetInMemoryAccountSettingsContextForTests();
    vi.spyOn(process, 'exit').mockImplementation((code) => { throw new Error(`process.exit(${code})`); });
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    restoreTty();
    env.restore();
    reloadConfiguration();
    resetInMemoryAccountSettingsContextForTests();
    await removeTempDir(directory);
  });

  it('uses cached daemon-started Claude settings while the automatic refresh is pending', async () => {
    const cached: AccountSettingsContext = {
      source: 'cache', settings: accountSettingsParse({ backendEnabledByTargetKey: { 'agent:claude': false } }),
      settingsVersion: 1, loadedAtMs: 1, settingsSecretsReadKeys: [], whenRefreshed: null,
    };
    let completeRefresh!: (snapshot: AccountSettingsContext) => void;
    const whenRefreshed = new Promise<AccountSettingsContext>((resolve) => { completeRefresh = resolve; });
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    let startupError: unknown;
    const startup = handleClaudeCliCommand({
      args: ['--started-by', 'daemon', '--happy-starting-mode', 'remote'], rawArgv: [], terminalRuntime: null,
      sessionStart: { credentials: { token: 'cached-daemon-token', encryption: null }, accountSettingsContext: { ...cached, whenRefreshed } },
    }).catch((error: unknown) => { startupError = error; });
    try {
      // Real parsing/startup and cached admission must finish before the network
      // refresh. The disabled backend stops before any provider process starts.
      await vi.waitFor(() => expect(startupError).toBeInstanceOf(Error));
      expect((startupError as Error).message).toBe('process.exit(1)');
      expect(errors.mock.calls.flat().join(' ')).toContain('disabled in your account settings');
    } finally {
      completeRefresh(cached);
      await startup;
    }
  });

  it.each(['agent:codex', 'acpBackend:review-bot'])('authenticates once and reuses settled settings for %s profile application', async (defaultBackendTargetKey) => {
    let authRequests = 0;
    let settingsRequests = 0;
    // The relay HTTP boundary is fake; auth encryption, credential persistence, machine
    // setup, account bootstrap, argument parsing, and profile application remain real.
    vi.spyOn(axios, 'post').mockImplementation(async (url: string, body?: unknown) => {
      if (url.endsWith('/v1/auth/request')) { authRequests += 1; return { data: { state: 'requested' } }; }
      if (url.endsWith('/v1/auth/request/claim')) {
        const publicKey = (body as { publicKey: string }).publicKey;
        const ephemeral = tweetnacl.box.keyPair();
        const nonce = new Uint8Array(24).fill(9);
        const ciphertext = tweetnacl.box(new Uint8Array(32).fill(7), nonce, new Uint8Array(Buffer.from(publicKey, 'base64')), ephemeral.secretKey);
        const response = Buffer.concat([Buffer.from(ephemeral.publicKey), Buffer.from(nonce), Buffer.from(ciphertext)]).toString('base64');
        return { data: { state: 'authorized', token: 'profile-routing-token', response } };
      }
      throw new Error(`Unexpected HTTP POST ${url}`);
    });
    vi.spyOn(axios, 'get').mockImplementation(async (url: string) => {
      if (url.endsWith('/v1/auth/request/status')) return { data: { status: 'authorized', supportsV2: true } };
      if (url.endsWith('/v2/account/settings')) {
        settingsRequests += 1;
        return { status: 200, data: { version: settingsRequests, content: { t: 'plain', v: { profiles: [{
          id: 'work', name: 'Work', defaultBackendTargetKey,
          environmentVariables: [{ name: 'ROUTING_PROFILE_TEST', value: settingsRequests > 1 ? 'refreshed' : 'selected' }],
          defaultPermissionModeByTargetKey: { [defaultBackendTargetKey]: 'yolo' },
        }] } } } };
      }
      throw new Error(`Unexpected HTTP GET ${url}`);
    });
    const output = captureConsoleLogAndMuteStdout();
    try {
      if (defaultBackendTargetKey.startsWith('acpBackend:')) {
        // Start at the actual bare CLI entry point while logged out. The missing
        // executable declaration is the controlled terminal boundary: reaching its
        // specific error proves the same invocation selected ACP after real login.
        process.env.HAPPIER_SESSION_AUTOSTART_DAEMON = '0';
        const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
        await expect(dispatchCli({ args: ['--launch-profile', 'work'], rawArgv: [], terminalRuntime: null })).rejects.toThrow('process.exit(1)');
        expect(process.env.ROUTING_PROFILE_TEST).toBe('selected');
        expect(errors.mock.calls.flat().join(' ')).toContain('Configured ACP backend not found: review-bot');
        errors.mockRestore();
      }
      const prepared = await prepareProfileSessionStart({ profileQuery: 'work', refreshRequested: !defaultBackendTargetKey.startsWith('acpBackend:') });
      const target = defaultBackendTargetKey.startsWith('acpBackend:')
        ? { kind: 'configuredAcpBackend' as const, backendId: 'review-bot' }
        : { kind: 'builtInAgent' as const, agentId: 'codex' };
      expect(prepared.backendTarget).toEqual(target);
      expect(prepared.sessionStart.accountSettingsContext.source).toBe('network');
      // Provider execution is supplied through the existing runtime boundary. Observe the
      // exact credentials/settings/profile environment the real startup owner hands it.
      process.env.HAPPIER_SESSION_AUTOSTART_DAEMON = '0';
      let ran = false;
      await runBackendSessionCliCommand({
        context: { args: ['--profile', 'work', '--refresh-settings'], rawArgv: [], terminalRuntime: null, sessionStart: prepared.sessionStart },
        backendTargetForProfiles: target,
        loadAccountSettings: true,
        loadRun: async () => async (options) => {
          ran = true;
          expect(options.credentials).toBe(prepared.sessionStart.credentials);
          expect(options.accountSettingsContext).toBe(prepared.sessionStart.accountSettingsContext);
          expect(options.permissionMode).toBe('yolo');
          expect(process.env.ROUTING_PROFILE_TEST).toBe('selected');
          expect(process.env.HAPPIER_SESSION_PROFILE_ID).toBe('work');
        },
      });
      expect(ran).toBe(true);
      expect(authRequests).toBe(1);
      expect(settingsRequests).toBe(1);
      expect(configuration.activeServerDir).toContain(directory);
      if (target.kind === 'builtInAgent') {
        // The explicit backend path must also settle --refresh-settings, rather than
        // applying the earlier fast snapshot while its requested refresh is pending.
        await runBackendSessionCliCommand({
          context: { args: ['codex', '--profile', 'work', '--refresh-settings'], rawArgv: [], terminalRuntime: null },
          agentIdForAccountSettings: 'codex',
          loadRun: async () => async (options) => {
            expect(options.accountSettingsContext?.settingsVersion).toBe(2);
            expect(process.env.ROUTING_PROFILE_TEST).toBe('refreshed');
          },
        });
        expect(authRequests).toBe(1);
        expect(settingsRequests).toBe(2);
      }
      if (target.kind === 'configuredAcpBackend') {
        delete process.env.ROUTING_PROFILE_TEST;
        const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
        // Exercise the real explicit configured CLI handler. This fixture deliberately
        // omits its executable declaration, so runtime admission must fail after the
        // same profile overlay has been applied, rather than launching another backend.
        await expect(handleConfiguredAcpCatalogCliCommand({
          args: ['acp-catalog', '--backend', 'review-bot', '--profile', 'work'], rawArgv: [], terminalRuntime: null,
        })).rejects.toThrow('process.exit(1)');
        expect(process.env.ROUTING_PROFILE_TEST).toBe('selected');
        expect(errors.mock.calls.flat().join(' ')).toContain('Configured ACP backend not found: review-bot');
        expect(authRequests).toBe(1);
        expect(settingsRequests).toBe(1);
      }
    } finally { output.restore(); }
  });
});
