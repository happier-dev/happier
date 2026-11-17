import { createServer, type Server } from 'node:http';
import { afterEach, expect, it } from 'vitest';

import { normalizeActionsSettingsV1, setActionApprovalOverride } from '@happier-dev/protocol/actions/actionSettings';
import type { BoundApprovalProfileV1 } from '@happier-dev/protocol/actions/approvalProfiles';
import { formatQualifiedPluginActionId } from '@happier-dev/protocol/plugins/actions/qualifiedActionId';
import { createAuthoredAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { executeContributedAction } from './executeContributedAction';

let provider: Server | undefined;
afterEach(async () => {
  await new Promise<void>((resolve, reject) => provider ? provider.close(error => error ? reject(error) : resolve()) : resolve());
  provider = undefined;
});

it.each([
  { name: 'Off refuses agent invocation', mode: 'off', ownAsk: false, derived: false,
    expectedCode: 'plugin_action_unavailable' },
  { name: 'Ask on plugin callers asks for the person’s own press', mode: 'ask', ownAsk: false, derived: false,
    expectedCode: 'action_interactive_review_required' },
  { name: 'a picked Allow replaces the Account Ask', mode: 'allow', ownAsk: true, derived: false,
    expectedCode: null },
  { name: 'a Team-derived Allow retains the Account Ask', mode: 'allow', ownAsk: true, derived: true,
    expectedCode: 'action_interactive_review_required' },
] as const)('uses the bound profile: $name', async ({ mode, ownAsk, derived, expectedCode }) => {
  let effects = 0;
  // The provider HTTP endpoint is the only external effect. Plugin admission,
  // physical module loading, target preparation and approval policy stay real.
  provider = createServer((request, response) => {
    if (request.method !== 'POST' || request.url !== '/deploy') { response.writeHead(404).end(); return; }
    effects += 1;
    response.writeHead(200, { 'content-type': 'application/json' }).end('{"deployed":true}');
  });
  await new Promise<void>(resolve => provider!.listen(0, '127.0.0.1', resolve));
  const address = provider.address();
  if (!address || typeof address === 'string') throw new Error('Provider did not bind');
  const identity = { pluginId: 'example.profile-deploy', localId: 'deploy' };
  const actionId = formatQualifiedPluginActionId(identity);
  const account = ownAsk ? setActionApprovalOverride({ settings: normalizeActionsSettingsV1(undefined),
    actionId, surface: 'plugin', approvalRequired: true }) : normalizeActionsSettingsV1(undefined);
  const approvalProfile: BoundApprovalProfileV1 = { resolution: { status: 'available', requestedId: 'profile' },
    profile: { id: 'profile', name: 'Deployment approvals', actions: { [actionId]: {
      ...(mode === 'off' ? { disabledSurfaces: ['agent'] } : {}),
      approvalRequiredSurfaces: mode === 'ask' ? ['plugin'] : [],
    } }, ...(mode === 'allow' ? { approvalWaivedSurfaces: { [actionId]: ['plugin'] } } : {}) } };
  const fixture = await createAuthoredAdmittedPluginRuntimeFixture({ plugins: [{ manifest: {
    schemaVersion: 2, id: identity.pluginId, version: '1.0.0', displayName: 'Profile deployment fixture',
    engines: { happier: '^0.2.0' }, runtime: { apiVersion: 1 }, entrypoints: { daemon: './daemon.mjs' },
    contributes: { actions: [{ id: identity.localId, title: 'Deploy', scopes: ['global'],
      surfaces: ['ui', 'agent', 'plugin'], placementBindings: [], execution: { target: 'daemon' }, dangerLevel: 'safe' }] },
  }, files: { 'daemon.mjs': `export function activate(api) {
    api.actions.register('deploy', async () => {
      const response = await fetch('http://127.0.0.1:${address.port}/deploy', { method: 'POST' });
      if (!response.ok) throw new Error('provider_failed');
      return await response.json();
    });
  }` } }], runtimeOptions: {
    scopedActionRuntime: { credentials: null, actionsSettingsProvider: { getActionsSettings: () => account } },
    resolveCurrentMachineId: () => 'machine',
    resolveCurrentMachineExecutionOriginContext: async () => ({ serverIdentityId: 'home', machineId: 'machine' }),
  } });
  try {
    const approvalContext = { surface: mode === 'off' ? 'agent' as const : 'ui' as const,
      authority: mode === 'off' ? 'account_automation' as const : 'present_user' as const,
      actionCaller: { kind: 'host' as const }, approvalProfileId: 'profile', approvalProfile,
      approvalProfileTeamOrGroupDerived: derived };
    const result = await executeContributedAction({ runtimeRegistry: fixture.registry,
      actionId: `${identity.pluginId}/${identity.localId}`, input: {}, actionsSettings: account,
      context: { surface: mode === 'off' ? 'agent' : 'plugin', originSurface: 'ui' }, approvalContext,
      ...(mode === 'off' ? {} : { presentUserIntent: 'confirmed' as const }) });
    if (expectedCode) expect(result).toMatchObject({ matched: true, result: { ok: false, errorCode: expectedCode } });
    else expect(result).toMatchObject({ matched: true, result: { ok: true, result: { deployed: true } } });
    expect(effects).toBe(expectedCode ? 0 : 1);
  } finally { await fixture.dispose(); }
});
