import { describe, expect, it } from 'vitest';
import { AccountSettingsSchema } from '@happier-dev/protocol';
import type { ActionExecutorContext } from '@happier-dev/protocol/actions';
import { createActionSettingsProvider } from '@/settings/actionsSettingsProvider';
import { createUnavailableActionTransportDeps } from '@/testkit/actionTransportDeps';
import { createCliActionExecutor } from './createCliActionExecutor';
import { createCliActionExecutorFromCredentials } from './createCliActionExecutorFromCredentials';
import { createCliActionExecutorHarness } from './createCliActionExecutorHarness';

const token = `fixture.${Buffer.from(JSON.stringify({ sub: 'account' })).toString('base64url')}.signature`;
const credentials = {
  token,
  encryption: null,
  credentialProvenance: 'stored_session' as const,
};
const context: ActionExecutorContext = {
  surface: 'cli',
  authority: 'present_user',
  actionCaller: { kind: 'host' },
  runtimeAccountId: 'account',
  serverId: 'home',
  serverIdentityId: 'srv_home',
};
const actionId = 'action.spec.get';
const input = { id: 'session.list' };

// Protocol projects the reviewed operation only for a review-only preparation;
// a CLI wrapper that drops the options turns review into ordinary preparation.
describe('CLI prepare wrappers carry review options to Protocol', () => {
  const executors = {
    host: () =>
      createCliActionExecutor({
        token,
        credentials,
        sessionId: '',
        mode: 'plain',
        ctx: null,
        pluginActionExecutionOwner: 'current_process',
      }),
    harness: () =>
      createCliActionExecutorHarness(
        {
          token,
          credentials,
          sessionId: '',
          mode: 'plain',
          ctx: null,
          serverId: 'home',
          serverIdentityId: 'srv_home',
          pluginActionExecutionOwner: 'current_process',
        },
        createUnavailableActionTransportDeps(),
      ).executor,
    credentials: () =>
      createCliActionExecutorFromCredentials({
        credentials,
        serverId: 'home',
        serverIdentityId: 'srv_home',
        serverApiUrl: 'https://prepare.test',
        pluginActionExecutionOwner: 'current_process',
        actionsSettingsProvider: createActionSettingsProvider({
          accountSettings: AccountSettingsSchema.parse({}),
        }),
      }),
  };

  for (const [name, create] of Object.entries(executors)) {
    it(`returns the reviewed operation without running it (${name})`, async () => {
      const prepared = await create().prepare(actionId, input, context, {
        reviewOnly: true,
      });
      expect(prepared, JSON.stringify(prepared)).toMatchObject({
        kind: 'ready',
        operation: { actionId },
      });
    });
  }
});
