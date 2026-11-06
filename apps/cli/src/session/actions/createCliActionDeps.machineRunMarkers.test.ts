import { expect, it, vi } from 'vitest';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { createCliActionDeps } from './createCliActionDeps';

it('requires authenticated Machine admission for an agent marker read on the local daemon', async () => {
  // The daemon invocation is the process boundary. An unadmitted direct hop
  // cannot supply the caller identity needed for the Use projection.
  const invoke = vi.fn(async () => ({ runs: [] }));
  const executor = createActionExecutor(createCliActionDeps({ token: 'local', sessionId: 'cli-global',
    serverId: 'home', serverHttpBaseUrl: 'https://home.example.test', mode: 'plain', ctx: null,
    machineActionDirectTargetTransport: { machineId: 'machine', invoke },
  }));
  await expect(executor.execute('machines.runs.list', { machineId: 'machine' }, {
    surface: 'agent', authority: 'account_automation',
  })).resolves.toMatchObject({ ok: false, errorCode: 'not_authenticated' });
  expect(invoke).not.toHaveBeenCalled();
});
