import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { handleActionsCommand } from '@/cli/commands/actions';
import { startInstalledDaemonFixture } from '@/daemon/testkit/installedDaemon.testkit';
import { createCliActionExecutorFromCredentials } from '@/session/actions/createCliActionExecutorFromCredentials';

// The normal CLI, authenticated Home and installed daemon execute unchanged.
// The canonical fixture owns its disposable Account, database and native processes.
let h: Awaited<ReturnType<typeof startInstalledDaemonFixture>>;
let stop: (() => Promise<void>) | undefined;
beforeAll(async () => {
  h = await startInstalledDaemonFixture({ registerCleanup: cleanup => { stop = cleanup; } });
}, 120_000);
afterAll(async () => { await stop?.(); }, 120_000);

it('lists an own fresh Account Sync through normal CLI admission without a raw Machine stamp', async () => {
  const executor = createCliActionExecutorFromCredentials({ credentials: h.ownerCredentials,
    serverId: h.serverId, serverIdentityId: h.home.homeId, serverApiUrl: h.home.baseUrl,
    machineId: h.machineId, externalActionClient: true });
  let output = '';
  const originalExitCode = process.exitCode;
  const stdout = vi.spyOn(process.stdout, 'write').mockImplementation((chunk, ...args) => {
    output += String(chunk);
    const callback = args.find(argument => typeof argument === 'function');
    if (typeof callback === 'function') callback();
    return true;
  });
  try {
    await handleActionsCommand(['invoke', 'workspace.sync.relationships.list', '--input-json',
      JSON.stringify({ controllerMachineId: h.machineId }), '--json'], {
      readCredentialsFn: async () => h.ownerCredentials,
      createExecutorFn: async () => executor,
    });
    expect(JSON.parse(output)).toMatchObject({ ok: true, kind: 'actions_invoke',
      data: { relationships: [], sets: [], remoteRelationships: [] } });
  } finally {
    stdout.mockRestore();
    process.exitCode = originalExitCode;
  }
});
