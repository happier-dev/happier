import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ResolvedConnectedAccountDescriptorContribution } from '@/plugins/projection/registry/types';

const boundary = vi.hoisted(() => ({ rpc: vi.fn(), prompt: vi.fn(), promptSecret: vi.fn(async () => 'github_pat_secret') }));

// Only persistence credentials, machine RPC and terminal input cross system boundaries.
// Catalog resolution, command orchestration and daemon-client schemas remain real.
vi.mock('@/persistence', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/persistence')>(),
  readStoredCredentials: async () => ({ token: 'test-token', encryption: null }),
}));
vi.mock('@/session/transport/rpc/machineRpc', () => ({ callMachineRpc: boundary.rpc }));
vi.mock('@/terminal/prompts/promptInput', () => ({ promptSecretInput: boundary.promptSecret, promptInput: boundary.prompt }));

describe('connect authentication consumer lifetime', () => {
  let taskDirectory: string;
  let contribution: ResolvedConnectedAccountDescriptorContribution;
  let handleConnectCommand: typeof import('./connect')['handleConnectCommand'];
  beforeAll(async () => {
    taskDirectory = await mkdtemp(join(tmpdir(), 'happier-connect-lifetime-'));
    vi.stubEnv('HAPPIER_HOME_DIR', taskDirectory);
    const catalog = await import('@/plugins/projection/registry/createResolvedContributionRegistry');
    const registry = await catalog.resolveMergedContributionRegistry({ happyHomeDir: taskDirectory });
    const found = (registry.connectedAccountDescriptors ?? []).find((entry) => entry.pluginId === 'happier.scm.forge.github');
    if (!found) throw new Error('Canonical GitHub connected-account contribution is unavailable');
    contribution = found;
    handleConnectCommand = (await import('./connect')).handleConnectCommand;
  }, 120_000);
  afterAll(async () => {
    vi.unstubAllEnvs();
    await rm(taskDirectory, { recursive: true, force: true });
  });

  it.each([
    { name: 'manual code', pasted: '4/0synthetic-code', allowRaw: true, authorizationState: 'current-attempt', succeeds: true, code: '4/0synthetic-code' },
    { name: 'matching callback', pasted: 'https://provider.example.test/callback?code=synthetic-code&state=current-attempt', allowRaw: true, authorizationState: 'current-attempt', succeeds: true, code: 'synthetic-code' },
    { name: 'code and returned state', pasted: 'synthetic-code#current-attempt', allowRaw: true, authorizationState: 'current-attempt', succeeds: true, code: 'synthetic-code' },
    { name: 'manual code without provider permission', pasted: '4/0synthetic-code', allowRaw: false, authorizationState: 'current-attempt', succeeds: false, code: '' },
    { name: 'manual code without current attempt state', pasted: '4/0synthetic-code', allowRaw: true, authorizationState: null, succeeds: false, code: '' },
    { name: 'foreign callback', pasted: 'https://foreign.example.test/callback?code=synthetic-code&state=current-attempt', allowRaw: true, authorizationState: 'current-attempt', succeeds: false, code: '' },
    { name: 'protocol-relative foreign callback', pasted: '//foreign.example.test/callback?ignored=x&code=synthetic-code&state=current-attempt', allowRaw: true, authorizationState: 'current-attempt', succeeds: false, code: '' },
    { name: 'matching callback without returned state', pasted: 'https://provider.example.test/callback?code=synthetic-code', allowRaw: true, authorizationState: 'current-attempt', succeeds: false, code: '' },
    { name: 'callback with another attempt state', pasted: 'https://provider.example.test/callback?code=synthetic-code&state=another-attempt', allowRaw: true, authorizationState: 'current-attempt', succeeds: false, code: '' },
    { name: 'code with another attempt state', pasted: 'synthetic-code#another-attempt', allowRaw: true, authorizationState: 'current-attempt', succeeds: false, code: '' },
    { name: 'provider denial with code and state', pasted: 'https://provider.example.test/callback?error=access_denied&code=synthetic-code&state=current-attempt', allowRaw: true, authorizationState: 'current-attempt', succeeds: false, code: '' },
  ])('consumes provider-declared OAuth paste policy: $name', async ({ pasted, allowRaw, authorizationState, succeeds, code }) => {
    const registry = await (await import('@/plugins/projection/registry/createResolvedContributionRegistry')).resolveMergedContributionRegistry({ happyHomeDir: taskDirectory });
    const codex = registry.connectedAccountDescriptors?.find((entry) => entry.pluginId === 'happier.agent.codex');
    if (!codex) throw new Error('Canonical Codex contribution is unavailable');
    const service = { pluginId: codex.pluginId, localId: codex.definition.id };
    const descriptor = {
      ...codex.definition,
      authentication: {
        defaultModeId: 'oauth',
        modes: [{ id: 'oauth', kind: 'oauthAuthorizationCode', pkce: 'required', outcomeReconciliation: 'none', allowRawAuthorizationCode: allowRaw }],
      },
    };
    const commands: unknown[] = [];
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
        authorizationUrl: `https://provider.example.test/authorize${authorizationState ? `?state=${authorizationState}` : ''}`, callbackUrl: 'https://provider.example.test/callback',
      };
      if (command.operation === 'completeOAuth') return { status: 'connected', attemptId: 'attempt-paste', account: { service, accountId: 'selected-account' } };
      if (command.operation === 'cancel') return { status: 'cancelled', attemptId: 'attempt-paste' };
      throw new Error(`Unexpected command ${command.operation}`);
    });
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const execution = handleConnectCommand(['openai-codex', '--oauth', '--no-open']);
      if (succeeds) {
        await execution;
        expect(commands).toContainEqual({
          operation: 'completeOAuth', attemptId: 'attempt-paste',
          completion: { code, callbackUrl: 'https://provider.example.test/callback', state: 'current-attempt' },
        });
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

  it.each(['connected', 'rejected', 'lostReply'] as const)('closes only a finished %s journey through the existing cancel acknowledgement', async (outcome) => {
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
      if (outcome === 'lostReply') expect(commands).not.toContainEqual({ operation: 'cancel', attemptId: 'attempt-1' });
      else expect(commands).toContainEqual({ operation: 'cancel', attemptId: 'attempt-1' });
    } finally {
      log.mockRestore();
      boundary.rpc.mockReset();
    }
  });
});
