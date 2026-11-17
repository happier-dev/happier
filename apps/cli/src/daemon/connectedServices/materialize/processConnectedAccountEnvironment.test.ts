import { describe, expect, it } from 'vitest';
import { createForegroundPurposeOwnerFixture } from '@/daemon/agentRuntime/prepareForegroundAdmission.connectedServices.testkit';
import { materializeSessionConnectedAccountProcessEnvironment, prepareFiniteConnectedAccountProcessEnvironment } from './processConnectedAccountEnvironment';
import { createActionPurposeBindingAdmission } from '../purposeBindings/teamDirectMaterialAdmission';
import { PluginError } from '@happier-dev/plugin-sdk/errors';

const consumer = { pluginId: 'acme.github', localId: 'gh' };
const service = { pluginId: 'acme.github', localId: 'github' };
const purpose = { consumer, purpose: 'cli' };
const declarations = [{ consumer, declarations: [], snapshot: { purposes: [purpose],
  authorizedPurposes: [{ purpose, serviceRefs: [service] }], fileMaterializationPurposes: [],
  environmentUses: [{ purpose, serviceRefs: [service], environmentKey: 'GH_TOKEN',
    gitCredentialHelper: { host: 'github.com', executable: 'gh', args: ['auth', 'git-credential'] } }],
  environmentUnsetUses: [{ purpose, serviceRefs: [service], environmentKey: 'GITHUB_TOKEN' }],
} }];

describe('associated process Connected Account environment', () => {
  it('preserves a tool-owned refusal from the next Session credential acquisition', async () => {
    const fixture = createForegroundPurposeOwnerFixture({ consumer, service, purpose: 'cli',
      // The plugin credential-materialization boundary returns its typed refusal.
      materializeAccount: async () => { throw new PluginError({ code: 'github_cli_team_brokered_unavailable',
        message: 'The selected credential is unavailable for gh', retryable: false,
        details: { reason: 'github_cli_team_brokered_unavailable' } }); } });
    const lease = fixture.owner.activateSessionPurposeBindings({ sessionId: 'refused', purposes: [purpose], bindings: [fixture.binding] });
    try {
      await expect(materializeSessionConnectedAccountProcessEnvironment({ runtime: { ...fixture.owner, owner: fixture.owner },
        declarations, sessionId: 'refused', environment: { GH_TOKEN: 'native-fallback' }, signal: new AbortController().signal }))
        .rejects.toMatchObject({ code: 'github_cli_team_brokered_unavailable', details: { reason: 'github_cli_team_brokered_unavailable' } });
    } finally { lease.dispose(); }
  });
  it('retains the tool-owned broker refusal before any native fallback or credential acquisition', async () => {
    let acquisitions = 0;
    const fixture = createForegroundPurposeOwnerFixture({ consumer, service, purpose: 'cli',
      materializeAccount: async () => { acquisitions++; return { kind: 'environment', env: { GH_TOKEN: 'unexpected' } }; } });
    await fixture.store.update(() => ({ v: 1, bindings: [], teamResourceSelections: [{ purpose, teamId: 'team',
      selection: { source: 'team_resource', resourceId: 'resource', deliveryMode: 'brokered' } }] }));
    await expect(prepareFiniteConnectedAccountProcessEnvironment({
      runtime: { ...fixture.owner, owner: fixture.owner, admitActionPurposeBindings: createActionPurposeBindingAdmission({ activatePurposeBindings: fixture.owner.activatePurposeBindings }) },
      declarations: declarations.map(declaration => ({ ...declaration, brokeredUnavailableCode: 'github_cli_team_brokered_unavailable' })),
      subject: { kind: 'action_operation', operationId: 'broker', actionId: 'machines.setup.apply', pluginVersion: '0.3.0', isCurrent: () => true },
      signal: new AbortController().signal,
    })).rejects.toMatchObject({ code: 'github_cli_team_brokered_unavailable', details: { reason: 'github_cli_team_brokered_unavailable' } });
    expect(acquisitions).toBe(0);
  });
  it('keeps one finite selection across setup steps while acquiring for each admitted process', async () => {
    let acquisitions = 0;
    const fixture = createForegroundPurposeOwnerFixture({ consumer, service, purpose: 'cli', accountId: 'setup-account',
      materializeAccount: async ({ account }) => { acquisitions++; return { kind: 'environment', env: { GH_TOKEN: account.accountId } }; } });
    const prepared = await prepareFiniteConnectedAccountProcessEnvironment({
      runtime: { ...fixture.owner, owner: fixture.owner, admitActionPurposeBindings: createActionPurposeBindingAdmission({ activatePurposeBindings: fixture.owner.activatePurposeBindings }) },
      declarations, subject: { kind: 'action_operation', operationId: 'setup', actionId: 'machines.setup.apply', pluginVersion: '0.3.0', isCurrent: () => true },
      signal: new AbortController().signal });
    await fixture.store.update(() => ({ v: 1, bindings: [] }));
    try {
      expect((await prepared.produce({}, new AbortController().signal)).environment.GH_TOKEN).toBe('setup-account');
      expect((await prepared.produce({}, new AbortController().signal)).environment.GH_TOKEN).toBe('setup-account');
      expect(acquisitions).toBe(2);
    } finally { prepared.dispose(); }
  });
  it('uses the admitted Session account after defaults change and acquires once per process', async () => {
    let acquisitions = 0;
    const fixture = createForegroundPurposeOwnerFixture({ consumer, service, purpose: 'cli', accountId: 'admitted',
      materializeAccount: async ({ account }) => { acquisitions++; return { kind: 'environment', env: { GH_TOKEN: account.accountId } }; } });
    const lease = fixture.owner.activateSessionPurposeBindings({ sessionId: 'session', purposes: [purpose], bindings: [fixture.binding] });
    await fixture.store.update(() => ({ v: 1, bindings: [{ purpose, target: { kind: 'account', account: { service, accountId: 'new-default' } } }] }));
    try {
      const input = { runtime: { ...fixture.owner, owner: fixture.owner }, declarations, sessionId: 'session',
        environment: { GITHUB_TOKEN: 'ambient', PATH: '/bin', GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.editor', GIT_CONFIG_VALUE_0: 'vim' },
        signal: new AbortController().signal };
      const first = await materializeSessionConnectedAccountProcessEnvironment(input);
      const second = await materializeSessionConnectedAccountProcessEnvironment(input);
      expect(first).toMatchObject({ environment: { GH_TOKEN: 'admitted', PATH: '/bin', GIT_CONFIG_COUNT: '3',
        GIT_CONFIG_KEY_0: 'core.editor', GIT_CONFIG_KEY_1: 'credential.https://github.com.helper', GIT_CONFIG_VALUE_1: '' }, secretValues: ['admitted'] });
      expect(first.environment.GITHUB_TOKEN).toBeUndefined();
      expect(second.environment.GH_TOKEN).toBe('admitted');
      expect(acquisitions).toBe(2);
    } finally { lease.dispose(); }
  });

  it('preserves native authentication when the admitted Session explicitly has no binding', async () => {
    const fixture = createForegroundPurposeOwnerFixture({ consumer, service, purpose: 'cli',
      materializeAccount: async () => { throw new Error('Unbound native process must not acquire'); } });
    const lease = fixture.owner.activateSessionPurposeBindings({ sessionId: 'native', purposes: [purpose], bindings: [] });
    try {
      expect(await materializeSessionConnectedAccountProcessEnvironment({ runtime: { ...fixture.owner, owner: fixture.owner },
        declarations, sessionId: 'native', environment: { GH_TOKEN: 'native-token', PATH: '/bin' }, signal: new AbortController().signal }))
        .toEqual({ environment: { GH_TOKEN: 'native-token', PATH: '/bin' }, secretValues: [] });
    } finally { lease.dispose(); }
  });

  it('refuses a missing admitted Session snapshot instead of selecting a current default', async () => {
    const fixture = createForegroundPurposeOwnerFixture({ consumer, service, purpose: 'cli',
      materializeAccount: async () => { throw new Error('Missing Session must not acquire defaults'); } });
    await expect(materializeSessionConnectedAccountProcessEnvironment({ runtime: { ...fixture.owner, owner: fixture.owner }, declarations,
      sessionId: 'missing', environment: {}, signal: new AbortController().signal })).rejects.toMatchObject({ code: 'credential_unavailable' });
  });
});
