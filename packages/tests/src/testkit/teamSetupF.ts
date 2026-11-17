import { fakeClaudeFixturePath } from './fakeClaude';
import { startProjectDaemonFixture } from './daemon/projectDaemon';
import type { RecordedHttpProxyRequest } from './httpRequestRecordingProxy';

/** Team journeys extend the canonical fresh-Account daemon fixture. */
export async function startTeamSetupFFixture(params: Readonly<{
  testDir: string;
  dbProvider?: 'postgres' | 'sqlite';
  observeActionRequests?: boolean;
  beforeHttpRequest?: (request: RecordedHttpProxyRequest) => void | Promise<void>;
  serverEnv?: NodeJS.ProcessEnv;
}>) {
  const core = await startProjectDaemonFixture(params);
  async function assertKnownGoodMachineControl(account: Awaited<ReturnType<typeof core.createAccount>>,
    machine: Readonly<{ target: Readonly<{ serverId: string; machineId: string }> }>) {
    const result = await account.execute('machines.list', { serverId: core.serverId });
    if (!result.ok) throw new Error(`F baseline Machine read refused (${result.errorCode})`);
    const listed = result.result;
    const items = listed && typeof listed === 'object' && 'items' in listed ? listed.items : null;
    if (!Array.isArray(items) || !items.some(item => item && typeof item === 'object'
      && 'serverId' in item && item.serverId === machine.target.serverId
      && 'machineId' in item && item.machineId === machine.target.machineId)) {
      throw new Error('F baseline enrolled Machine is not visible to its Account');
    }
  }
  return { ...core, assertKnownGoodMachineControl,
    enrollDaemon(account: Awaited<ReturnType<typeof core.createAccount>>,
      options: Parameters<typeof core.enrollDaemon>[1] = {}) {
      return core.enrollDaemon(account, { ...options, env: {
        HAPPIER_CLAUDE_PATH: fakeClaudeFixturePath(), ...options.env,
      } });
    },
  };
}

export type TeamSetupFFixture = Awaited<ReturnType<typeof startTeamSetupFFixture>>;
