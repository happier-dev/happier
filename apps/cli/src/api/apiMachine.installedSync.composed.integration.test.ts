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

it('admits an own fresh Account Sync list through normal CLI without a raw Machine stamp', async () => {
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
    const result: unknown = JSON.parse(output);
    // The installed fixture deliberately refuses native acquisition. The owner
    // must admit this requester before listing reaches that real engine boundary;
    // missing requester custody used to refuse it before the engine was reached.
    expect(result, JSON.stringify(result)).toMatchObject({ ok: false, kind: 'actions_invoke',
      error: { code: 'engine_unavailable', failureCause: { phase: 'rpc.handler', errorCode: 'engine_unavailable' } } });
  } finally {
    stdout.mockRestore();
    process.exitCode = originalExitCode;
  }
});
