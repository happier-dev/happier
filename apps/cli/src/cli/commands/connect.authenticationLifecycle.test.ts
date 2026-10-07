import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ResolvedConnectedAccountDescriptorContribution } from '@/plugins/projection/registry/types';

const boundary = vi.hoisted(() => ({ rpc: vi.fn(), promptSecret: vi.fn(async () => 'github_pat_secret') }));

// Only persistence credentials, machine RPC and terminal input cross system boundaries.
// Catalog resolution, command orchestration and daemon-client schemas remain real.
vi.mock('@/persistence', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/persistence')>(),
  readStoredCredentials: async () => ({ token: 'test-token', encryption: null }),
}));
vi.mock('@/session/transport/rpc/machineRpc', () => ({ callMachineRpc: boundary.rpc }));
vi.mock('@/terminal/prompts/promptInput', () => ({ promptSecretInput: boundary.promptSecret, promptInput: vi.fn() }));

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
