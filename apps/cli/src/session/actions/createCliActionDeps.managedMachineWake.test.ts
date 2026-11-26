import axios from 'axios';
import { afterEach, expect, it, vi } from 'vitest';
import { createCliActionDeps } from './createCliActionDeps';

afterEach(() => vi.restoreAllMocks());

it('uses installed host identity for implicit bound wake while preserving addressed and remote transport', async () => {
  // HTTP is the external boundary; the real preparation and wake owners stay installed.
  const http = vi.spyOn(axios, 'get').mockRejectedValue(new Error('No Account authority'));
  const batchRead = vi.spyOn(axios, 'post').mockRejectedValue(new Error('No Account authority'));
  const sessionId = 'bound-session';
  let machineId = 'installed-machine';
  const deps = createCliActionDeps({ token: 'session-bearer', sessionId, mode: 'plain', ctx: null,
    serverId: 'bound-home', serverHttpBaseUrl: 'https://bound-home.test',
    runtimeActionMachineId: 'installed-machine',
    getCurrentSessionMetadata: () => ({ machineId, path: '/work' }),
  });
  const prepare = deps.prepareHostReviewedChildren!;
  const request = { actionId: 'execution.run.start' as const, input: {},
    context: { surface: 'agent' as const, defaultSessionId: sessionId },
    machineRuntimeDemand: { target: { kind: 'session' as const, sessionId }, activation: 'accepted-input' as const },
  };
  await expect(prepare(request)).resolves.toBeNull();
  expect(http).not.toHaveBeenCalled();
  expect(batchRead).not.toHaveBeenCalled();
  await expect(prepare({ ...request, context: { ...request.context,
    expectedSessionAddress: { serverId: 'foreign-home', sessionId } },
  })).resolves.toMatchObject({ ok: false, errorCode: 'not_authenticated' });
  await expect(prepare({ ...request, machineRuntimeDemand: { ...request.machineRuntimeDemand,
    target: { kind: 'session', sessionId: 'remote-session' } },
  })).resolves.toMatchObject({ ok: false, errorCode: 'not_authenticated' });
  expect(http).not.toHaveBeenCalled();
  expect(batchRead).not.toHaveBeenCalled();
  machineId = 'remote-machine';
  await expect(prepare(request)).resolves.toMatchObject({ ok: false, errorCode: 'machine_inventory_unavailable' });
  // Token-only selected Machine reads use the Account batch boundary.
  expect(http).not.toHaveBeenCalled();
  expect(batchRead).toHaveBeenCalledWith('https://bound-home.test/v1/machines/read-batch',
    { machineIds: ['remote-machine'] }, expect.any(Object));
});
