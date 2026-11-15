import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import axios from 'axios';
import type { ResolvedConnectedAccountDescriptorContribution } from '@/plugins/projection/registry/types';
import { readRequestedIntentPluginIds } from '@/testkit/http/accountPluginAvailability';

const boundary = vi.hoisted(() => ({ rpc: vi.fn(), prompt: vi.fn(), promptSecret: vi.fn(async () => 'github_pat_secret'), openBrowser: vi.fn(async () => true) }));

// Only persistence credentials, machine RPC, terminal input and browser launch cross
// system boundaries. Catalog resolution, command orchestration and daemon-client schemas remain real.
vi.mock('@/persistence', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/persistence')>(),
  readStoredCredentials: async () => ({ token: 'test-token', encryption: null }),
}));
vi.mock('@/session/transport/rpc/machineRpc', async importOriginal => ({
  ...await importOriginal<typeof import('@/session/transport/rpc/machineRpc')>(),
  callMachineRpc: boundary.rpc, callExactMachineRpc: boundary.rpc,
}));
vi.mock('@/terminal/prompts/promptInput', () => ({ promptSecretInput: boundary.promptSecret, promptInput: boundary.prompt }));
vi.mock('@/ui/openBrowser', () => ({ openBrowser: boundary.openBrowser }));

describe('connect authentication consumer lifetime', () => {
  let taskDirectory: string;
  let contribution: ResolvedConnectedAccountDescriptorContribution;
  let handleConnectCommand: typeof import('./connect')['handleConnectCommand'];
  beforeAll(async () => {
    taskDirectory = await mkdtemp(join(tmpdir(), 'happier-connect-lifetime-'));
    vi.stubEnv('HAPPIER_HOME_DIR', taskDirectory);
    // Account currentness and settings are HTTP boundaries; the real Action owner admits them.
    const accountSettings = { actionsSettingsV1: { v: 1, approvalWaivedSurfaces: {
      'connectedServices.authentication.beginConnect': ['cli'],
      'connectedServices.authentication.submitManual': ['cli'],
      'connectedServices.authentication.completeOAuth': ['cli'],
      'connectedServices.authentication.cancel': ['cli'],
    } } };
    const currentness = { mode: 'plain', version: 0, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 0 };
    vi.spyOn(axios, 'get').mockImplementation(async url => {
      const path = new URL(String(url)).pathname;
      if (path === '/v1/account/encryption/currentness') return { status: 200, data: currentness };
      if (path === '/v1/account/encryption') return { status: 200, data: { mode: 'plain', updatedAt: 0 } };
      if (path === '/v2/account/settings') return { status: 200, data: { version: 1, content: { t: 'plain', v: accountSettings } } };
      throw new Error(`Unexpected synthetic HTTP path: ${path}`);
    });
    vi.spyOn(axios, 'post').mockImplementation(async (url, body) => {
      const path = new URL(String(url)).pathname;
      // The Account plugin census is an HTTP boundary; every bundled plugin keeps its default intent.
      if (path === '/v1/plugins/availability/intents/list') {
        const pluginIds = readRequestedIntentPluginIds(body);
        return { status: 200, data: { availabilityCursor: 0, pluginIds, nextCursor: null, failedPluginIds: [],
          intentReads: pluginIds.map(pluginId => ({ pluginId, response: { availabilityCursor: 0,
            hostingCapability: { enabled: false }, intent: null, release: null, uiArtifacts: [], packageAssets: [] } })) } };
      }
      throw new Error(`Missing synthetic POST fixture: ${path}`);
    });
    vi.spyOn(axios, 'request').mockImplementation(async config => { throw new Error(`Missing synthetic request fixture: ${config.method} ${config.url}`); });
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async input => {
      const path = new URL(String(input)).pathname;
      if (path === '/v1/account/encryption/currentness') return Response.json(currentness);
      if (path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 0 });
      return Response.json({ error: 'not_found' }, { status: 404 });
    }));
    const catalog = await import('@/plugins/projection/registry/createResolvedContributionRegistry');
    const registry = await catalog.resolveMergedContributionRegistry({ happyHomeDir: taskDirectory });
    const found = (registry.connectedAccountDescriptors ?? []).find((entry) => entry.pluginId === 'happier.scm.forge.github');
    if (!found) throw new Error('Canonical GitHub connected-account contribution is unavailable');
    contribution = found;
    handleConnectCommand = (await import('./connect')).handleConnectCommand;
  }, 120_000);
  afterAll(async () => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    await rm(taskDirectory, { recursive: true, force: true });
  });

  it('imports a declared native source through the real CLI and qualified daemon attempt without prompting', async () => {
    const registry = await (await import('@/plugins/projection/registry/createResolvedContributionRegistry')).resolveMergedContributionRegistry({ happyHomeDir: taskDirectory });
    const codex = registry.connectedAccountDescriptors?.find(entry => entry.pluginId === 'happier.agent.codex');
    if (!codex) throw new Error('Canonical Codex contribution is unavailable');
    const service = { pluginId: codex.pluginId, localId: codex.definition.id };
    const descriptor = { ...codex.definition, authentication: { defaultModeId: 'native-import', modes: [
      { id: 'native-import', kind: 'manual', outcomeReconciliation: 'none', fields: [
        { id: 'source', title: 'Native login source', secret: false, schema: { type: 'string', enum: ['native'] } },
      ] },
    ] } };
    const commands: unknown[] = [];
    boundary.prompt.mockClear();
    boundary.promptSecret.mockClear();
    boundary.rpc.mockImplementation(async ({ request }: { request: { command: { operation: string } } }) => {
      const command = request.command;
      commands.push(command);
      if (command.operation === 'describeService') return {
        status: 'described', service, descriptor, accounts: [], occurrenceId: 'occurrence-test',
        sourceCustody: { kind: 'managed', immutableGenerationId: 'artifact-test', installSource: 'archive' }, operationTransport: { kind: 'v4' },
      };
      if (command.operation === 'beginConnect') return { status: 'awaitingManual', attemptId: 'native-attempt' };
      if (command.operation === 'submitManual') return { status: 'connected', attemptId: 'native-attempt', account: { service, accountId: 'host-owned-account' } };
      if (command.operation === 'cancel') return { status: 'cancelled', attemptId: 'native-attempt' };
      throw new Error(`Unexpected native acquisition command ${command.operation}`);
    });
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await handleConnectCommand(['openai-codex', '--import', '--source', 'native']);
      expect(commands).toContainEqual({ operation: 'beginConnect', service, modeId: 'native-import' });
      expect(commands).toContainEqual({ operation: 'submitManual', attemptId: 'native-attempt', fields: { source: 'native' } });
      expect(commands).not.toContainEqual(expect.objectContaining({ operation: 'beginReconnect' }));
      expect(boundary.prompt).not.toHaveBeenCalled();
      expect(boundary.promptSecret).not.toHaveBeenCalled();
    } finally { log.mockRestore(); boundary.rpc.mockReset(); }
  });

  it.each([
    { name: 'manual code', pasted: '4/0synthetic-code', allowRaw: true, authorizationState: 'current-attempt', succeeds: true, code: '4/0synthetic-code' },
    { name: 'matching callback', pasted: 'https://provider.example.test/callback?code=synthetic-code&state=current-attempt&iss=https%3A%2F%2Fissuer.example.test', allowRaw: true, authorizationState: 'current-attempt', succeeds: true, code: 'synthetic-code', issuer: 'https://issuer.example.test', openBrowser: true },
    { name: 'code and returned state', pasted: 'synthetic-code#current-attempt', allowRaw: true, authorizationState: 'current-attempt', succeeds: true, code: 'synthetic-code' },
    { name: 'manual code without provider permission', pasted: '4/0synthetic-code', allowRaw: false, authorizationState: 'current-attempt', succeeds: false, code: '' },
    { name: 'manual code without current attempt state', pasted: '4/0synthetic-code', allowRaw: true, authorizationState: null, succeeds: false, code: '' },
    { name: 'foreign callback', pasted: 'https://foreign.example.test/callback?code=synthetic-code&state=current-attempt', allowRaw: true, authorizationState: 'current-attempt', succeeds: false, code: '' },
    { name: 'protocol-relative foreign callback', pasted: '//foreign.example.test/callback?ignored=x&code=synthetic-code&state=current-attempt', allowRaw: true, authorizationState: 'current-attempt', succeeds: false, code: '' },
    { name: 'matching callback without returned state', pasted: 'https://provider.example.test/callback?code=synthetic-code', allowRaw: true, authorizationState: 'current-attempt', succeeds: false, code: '' },
    { name: 'callback with another attempt state', pasted: 'https://provider.example.test/callback?code=synthetic-code&state=another-attempt', allowRaw: true, authorizationState: 'current-attempt', succeeds: false, code: '' },
    { name: 'code with another attempt state', pasted: 'synthetic-code#another-attempt', allowRaw: true, authorizationState: 'current-attempt', succeeds: false, code: '' },
    { name: 'provider denial with code and state', pasted: 'https://provider.example.test/callback?error=access_denied&code=synthetic-code&state=current-attempt', allowRaw: true, authorizationState: 'current-attempt', succeeds: false, code: '' },
  ])('consumes provider-declared OAuth paste policy: $name', async ({ pasted, allowRaw, authorizationState, succeeds, code, issuer, openBrowser }) => {
    const registry = await (await import('@/plugins/projection/registry/createResolvedContributionRegistry')).resolveMergedContributionRegistry({ happyHomeDir: taskDirectory });
    const codex = registry.connectedAccountDescriptors?.find((entry) => entry.pluginId === 'happier.agent.codex');
    if (!codex) throw new Error('Canonical Codex contribution is unavailable');
    const service = { pluginId: codex.pluginId, localId: codex.definition.id };
    const descriptor = {
      ...codex.definition,
      authentication: {
        defaultModeId: 'oauth',
        modes: [{ id: 'oauth', kind: 'oauthAuthorizationCode', callbackUrl: 'https://provider.example.test/callback', pkce: 'required', outcomeReconciliation: 'none', allowRawAuthorizationCode: allowRaw }],
      },
    };
    const commands: unknown[] = [];
    const authorizationUrl = `https://provider.example.test/authorize${authorizationState ? `?state=${authorizationState}` : ''}`;
    boundary.openBrowser.mockClear();
    boundary.prompt.mockResolvedValueOnce(pasted);
    boundary.rpc.mockImplementation(async ({ request }: { request: { command: { operation: string } } }) => {
      const command = request.command;
      commands.push(command);
      if (command.operation === 'describeService') return {
        status: 'described', service, descriptor, accounts: [], occurrenceId: 'occurrence-test',
        sourceCustody: { kind: 'managed', immutableGenerationId: 'artifact-test', installSource: 'archive' }, operationTransport: { kind: 'v4' },
      };
      if (command.operation === 'beginConnect') return {
        status: 'awaitingOAuth', attemptId: 'attempt-paste',
        authorizationUrl, callbackUrl: 'https://provider.example.test/callback',
      };
      if (command.operation === 'completeOAuth') return { status: 'connected', attemptId: 'attempt-paste', account: { service, accountId: 'selected-account' } };
      if (command.operation === 'cancel') return { status: 'cancelled', attemptId: 'attempt-paste' };
      throw new Error(`Unexpected command ${command.operation}`);
    });
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const execution = handleConnectCommand(['openai-codex', '--oauth', ...(openBrowser ? [] : ['--no-open'])]);
      if (succeeds) {
        await execution;
        // The CLI returns callback facts only; the daemon keeps PKCE custody (no verifier).
        expect(commands).toContainEqual({
          operation: 'completeOAuth', attemptId: 'attempt-paste',
          completion: { code, callbackUrl: 'https://provider.example.test/callback', state: 'current-attempt', ...(issuer ? { iss: issuer } : {}) },
        });
        if (openBrowser) expect(boundary.openBrowser).toHaveBeenCalledWith(authorizationUrl);
        else expect(boundary.openBrowser).not.toHaveBeenCalled();
      } else {
        await expect(execution).rejects.toThrow();
        expect(commands).not.toContainEqual(expect.objectContaining({ operation: 'completeOAuth' }));
      }
    } finally {
      log.mockRestore();
      boundary.rpc.mockReset();
      boundary.prompt.mockReset();
    }
  });

  // A terminal reply settles the attempt. A cancel after it is a reviewed Action
  // that --yes cannot answer, so it would block a finished Connect on approval.
  it.each(['connected', 'rejected', 'lostReply'] as const)('ends a %s journey without cancelling its settled attempt', async (outcome) => {
    const service = { pluginId: 'happier.scm.forge.github', localId: contribution.definition.id };
    const commands: unknown[] = [];
    boundary.rpc.mockImplementation(async ({ request }: { request: { command: { operation: string } } }) => {
      const command = request.command;
      commands.push(command);
      if (command.operation === 'describeService') return {
        status: 'described', service, descriptor: contribution.definition, accounts: [],
        occurrenceId: 'occurrence-test', sourceCustody: { kind: 'managed', immutableGenerationId: 'artifact-test', installSource: 'archive' },
        operationTransport: { kind: 'v4' },
      };
      if (command.operation === 'beginConnect') return { status: 'awaitingManual', attemptId: 'attempt-1' };
      if (command.operation === 'submitManual') {
        if (outcome === 'lostReply') throw new Error('machine reply lost');
        return outcome === 'connected'
          ? { status: 'connected', attemptId: 'attempt-1', account: { service, accountId: 'account-1' } }
          : { status: 'rejected', attemptId: 'attempt-1', code: 'key_rejected' };
      }
      if (command.operation === 'cancel') return { status: 'cancelled', attemptId: 'attempt-1' };
      throw new Error(`Unexpected command ${command.operation}`);
    });
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const execution = handleConnectCommand(['github', '--token']);
      if (outcome === 'connected') await execution;
      else await expect(execution).rejects.toThrow(outcome === 'lostReply' ? 'machine reply lost' : 'key_rejected');
      // Manual fields travel only through the machine-owned attempt, and the PAT is never echoed.
      expect(commands).toContainEqual({ operation: 'beginConnect', service, modeId: 'fine-grained-pat' });
      expect(commands).toContainEqual({ operation: 'submitManual', attemptId: 'attempt-1', fields: { token: 'github_pat_secret' } });
      expect(log.mock.calls.flat().join('\n')).not.toContain('github_pat_secret');
      expect(commands).not.toContainEqual(expect.objectContaining({ operation: 'cancel' }));
    } finally {
      log.mockRestore();
      boundary.rpc.mockReset();
    }
  });

  it('cancels the daemon attempt when the user interrupts the OAuth paste prompt', async () => {
    const controller = new AbortController();
    const service = { pluginId: 'happier.agent.codex', localId: 'openai-codex' };
    const commands: unknown[] = [];
    boundary.prompt.mockImplementationOnce(async () => { controller.abort(); throw new DOMException('Interrupted', 'AbortError'); });
    boundary.rpc.mockImplementation(async ({ request }: { request: { command: { operation: string } } }) => {
      commands.push(request.command);
      if (request.command.operation === 'describeService') return { status: 'described', service,
        descriptor: { id: 'openai-codex', title: 'Codex', authentication: { defaultModeId: 'oauth', modes: [
          { id: 'oauth', kind: 'oauthAuthorizationCode', callbackUrl: 'https://provider.example.test/callback',
            pkce: 'required', outcomeReconciliation: 'none' },
        ] } }, accounts: [], occurrenceId: 'occurrence-test',
        sourceCustody: { kind: 'managed', immutableGenerationId: 'artifact-test', installSource: 'archive' }, operationTransport: { kind: 'v4' } };
      if (request.command.operation === 'beginConnect') return { status: 'awaitingOAuth', attemptId: 'interrupted-attempt',
        authorizationUrl: 'https://provider.example.test/authorize?state=interrupted-attempt.nonce', callbackUrl: 'https://provider.example.test/callback' };
      if (request.command.operation === 'cancel') return { status: 'cancelled', attemptId: 'interrupted-attempt' };
      throw new Error('Unexpected OAuth command');
    });
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await expect(handleConnectCommand(['openai-codex', '--oauth', '--no-open'], controller.signal)).rejects.toThrow('Interrupted');
      expect(commands).toContainEqual({ operation: 'cancel', attemptId: 'interrupted-attempt' });
    } finally { log.mockRestore(); boundary.rpc.mockReset(); boundary.prompt.mockReset(); }
  });
});
