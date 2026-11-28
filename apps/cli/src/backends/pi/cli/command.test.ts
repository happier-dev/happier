import { afterEach, describe, expect, it, vi } from 'vitest';

import { handlePiCliCommand } from './command';
import * as runPiModule from '@/backends/pi/runPi';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import * as authModule from '@/ui/auth';
import { type Credentials } from '@/persistence';
import * as persistenceModule from '@/persistence';

describe('handlePiCliCommand', () => {
  const envScope = createEnvKeyScope(['HAPPIER_ACCOUNT_SETTINGS_MODE']);

  afterEach(() => {
    vi.restoreAllMocks();
    envScope.restore();
  });

  async function runWithArgs(args: string[]) {
    envScope.patch({ HAPPIER_ACCOUNT_SETTINGS_MODE: 'never' });
    const credentials: Credentials = { token: 't', encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) } };
    vi.spyOn(persistenceModule, 'readCredentials').mockResolvedValue(null);
    vi.spyOn(authModule, 'authAndSetupMachineIfNeeded').mockResolvedValue({ credentials } as never);
    const runSpy = vi.spyOn(runPiModule, 'runPi').mockResolvedValue();
    await handlePiCliCommand({ args, terminalRuntime: null } as never);
    return runSpy.mock.calls[0]?.[0];
  }

  it.each([['--continue'], ['-c']])('asks runPi to continue the recent Pi session for %s', async (flag) => {
    await expect(runWithArgs(['pi', flag])).resolves.toMatchObject({ continueRecentSession: true });
  });

  it('does not continue a session without the flag', async () => {
    await expect(runWithArgs(['pi', '--resume', 'pi-1'])).resolves.toMatchObject({
      continueRecentSession: false,
      resume: 'pi-1',
    });
  });

  it.each(['--continue', '-c'])('does not interpret %s after the argument separator', async (flag) => {
    await expect(runWithArgs(['pi', '--', flag])).resolves.toMatchObject({ continueRecentSession: false });
  });
});
