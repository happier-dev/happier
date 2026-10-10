import { expect, it, vi } from 'vitest';
import { normalizeActionsSettingsV1 } from '@happier-dev/protocol';
import { createCliActionExecutor } from './createCliActionExecutor';

const { request } = vi.hoisted(() => ({ request: vi.fn() }));
// Daemon control RPC is the system boundary; the CLI and Action owners stay real.
vi.mock('@/daemon/controlClient', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/daemon/controlClient')>(),
  requestDaemonPluginActionExecution: request,
}));

it('generic plugin wait reaches the existing daemon contributed-Action admission', async () => {
  request.mockImplementation(async (value: { actionId: string; input: unknown }) => {
    expect(value).toMatchObject({ actionId: 'action.invoke', surface: 'cli', input: {
      action: { pluginId: 'acme.checks', localId: 'observe/checks' },
      input: { sourceId: 'checkpoint', condition: 'checks_passed' },
    } });
    return { matched: true, result: { ok: true, result: { disposition: 'matched', snapshot: { passed: true } } } };
  });
  const controller = new AbortController();
  const executor = createCliActionExecutor({ token: 'token', credentials: {
    token: 'token', credentialProvenance: 'stored_session', encryption: null,
  }, sessionId: 'session', mode: 'plain', ctx: null, serverId: 'home', serverHttpBaseUrl: 'https://example.invalid',
    actionsSettingsProvider: { getActionsSettings: () => normalizeActionsSettingsV1(undefined) },
  });
  expect(await executor.execute('wait', {
    target: { kind: 'plugin_source', serverId: 'home', pluginId: 'acme.checks', sourceId: 'checkpoint' },
    condition: { kind: 'plugin', actionLocalId: 'observe/checks', condition: 'checks_passed' },
  }, { surface: 'cli', signal: controller.signal })).toMatchObject({ ok: true, result: { disposition: 'matched', snapshot: { passed: true } } });
  expect(request.mock.calls[0]?.[1]).toEqual({ signal: controller.signal });
});
