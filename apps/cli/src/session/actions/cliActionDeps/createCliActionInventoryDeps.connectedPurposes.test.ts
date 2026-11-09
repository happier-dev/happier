import axios from 'axios';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { accountSettingsParse } from '@happier-dev/protocol/account/settings/accountSettings';
import { AccountProfileSchema } from '@happier-dev/protocol/account/profile';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { AUTHORITY_CEILING_HEADER_V1 } from '@happier-dev/protocol/actions/invocationAuthority';
import { resolveDirectCliConnectedServiceBindings } from '@/cli/connectedServices/resolveDirectCliConnectedServiceBindings';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import { getActiveAccountSettingsSnapshot, resetActiveAccountSettingsSnapshotForTests, setActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { createInvocationSavedSecretOperationContextV1 } from "@/settings/secrets/savedSecretOperationContext";
import { createCliActionDeps } from '../createCliActionDeps';
import { readCurrentContributionRegistry } from '@/agent/catalog/snapshot';
import { resolveQualifiedPurposeDeclarationSnapshotForAgentSpawn } from '@/daemon/connectedServices/requestAuth/prepareConnectedAccountRequestAuthForSpawn';
import { listAgentExecutionTargetsV1 } from '@happier-dev/protocol/agents/executionTargetV1';
import { buildBackendTargetKeyV2 } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';
import { ScmDiffSummaryModelCatalogObservationV1Schema } from '@happier-dev/protocol/actions/settings/scmDiffSummarySettings';

afterEach(() => { vi.restoreAllMocks(); resetActiveAccountSettingsSnapshotForTests(); });

describe('direct CLI and Action inventory purpose authority', () => {
  it('offers only declared credential kinds for Oh My Pi while retaining typed unavailable accounts', async () => {
    const credentials = { token: 'credential-kind-inventory', encryption: null };
    const service = { pluginId: 'happier.agent.claude', localId: 'anthropic' };
    const serviceKey = `${service.pluginId}/${service.localId}`;
    // Raw V4 shape from the recorded inventory: older producers publish null kind.
    const profile = { id: 'credential-kind-owner', connectedAccountsV4: [
      ...(['oauth', 'token', 'unknown'] as const).map(kind => ({ ref: { service, accountId: kind }, kind: kind === 'unknown' ? null : kind,
        status: 'connected', authenticationModeId: kind === 'unknown' ? 'oauth' : kind, configurationReady: false, configurationRevision: null,
        revisionSemantics: 'revisioned', credentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS', scopes: [] })),
    ] };
    setActiveAccountSettingsSnapshot({ source: 'network', scopeKey: resolveAccountSettingsScopeKey(credentials),
      settings: accountSettingsParse({}), rawSettings: {}, settingsVersion: 7, loadedAtMs: Date.now(), settingsSecretsReadKeys: [] });
    // Only Home HTTP is substituted; inventory, declarations and Action result normalization stay real.
    vi.spyOn(axios, 'get').mockImplementation(async input => {
      const path = new URL(String(input)).pathname;
      if (path.endsWith('/currentness')) return { status: 200, data: { mode: 'plain', version: 1,
        signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } };
      if (path === '/v1/account/profile') return { status: 200, data: profile };
      if (path.endsWith('/connected-metadata/presentation')) return { status: 200, data: {
        status: 'present', revision: 1, content: { t: 'plain', v: { v: 1, entries: [] } } } };
      throw new Error(`Unexpected credential-kind inventory request: ${path}`);
    });
    await runWithServerHttpBaseUrl('https://credential-kind-inventory.example.test', async () => {
      const executor = createActionExecutor(createCliActionDeps({ token: credentials.token, credentials,
        sessionId: 'credential-kind-session', mode: 'plain', ctx: null }));
      const available = await executor.execute('sessions.spawn.connected_services.list',
        { agentId: 'ohMyPi', includeDefaults: false }, { surface: 'cli' });
      expect(available).toMatchObject({ ok: true, result: {
        profileOptionsByServiceId: { [serviceKey]: [
          { profileId: 'oauth', status: 'unsupported_kind' }, { profileId: 'token', status: 'connected' },
          { profileId: 'unknown', status: 'unsupported_kind' },
        ] }, items: [{ value: `${serviceKey}:profile:token` }],
      } });
      const all = await executor.execute('sessions.spawn.connected_services.list',
        { agentId: 'ohMyPi', includeDefaults: false, includeUnavailable: true }, { surface: 'cli' });
      expect(all).toMatchObject({ ok: true, result: { items: [
        { value: `${serviceKey}:profile:oauth` }, { value: `${serviceKey}:profile:token` },
        { value: `${serviceKey}:profile:unknown` },
      ] } });
    });
  });

  it.each([true, false])('lists the authoritative V4 pool autoSwitch=%s without a separate policy read', async autoSwitch => {
    const credentials = { token: 'pool-policy-inventory', encryption: null };
    const home = 'https://pool-policy-inventory.example.test';
    const service = { pluginId: 'happier.agent.codex', localId: 'openai-codex' };
    const serviceKey = `${service.pluginId}/${service.localId}`;
    const profile = AccountProfileSchema.parse({ id: 'pool-policy-owner', connectedAccountGroupsV4: [{
      v: 1, ref: { service, groupId: 'work' }, displayName: 'Work', incarnation: 'work:1',
      generation: 2, runtimeStateRevision: 3, policy: { autoSwitch }, activeConnectedAccountId: 'primary',
      state: {}, createdAt: 0, updatedAt: 0, members: [
        { v: 1, connectedAccountId: 'primary', priority: 0, enabled: true, state: {}, createdAt: 0, updatedAt: 0 },
        { v: 1, connectedAccountId: 'disabled', priority: 1, enabled: false, state: {}, createdAt: 0, updatedAt: 0 },
      ],
    }] });
    setActiveAccountSettingsSnapshot({ source: 'network', scopeKey: resolveAccountSettingsScopeKey(credentials),
      settings: accountSettingsParse({}), rawSettings: {}, settingsVersion: 7, loadedAtMs: Date.now(), settingsSecretsReadKeys: [] });
    const paths: string[] = [];
    // Only HTTP is substituted: the Action handler, profile parser and option projection stay real.
    vi.spyOn(axios, 'get').mockImplementation(async input => {
      const path = new URL(String(input)).pathname;
      paths.push(path);
      if (path.endsWith('/currentness')) return { status: 200, data: { mode: 'plain', version: 1,
        signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } };
      if (path === '/v1/account/profile') return { status: 200, data: profile };
      if (path.endsWith('/connected-accounts/purposes')) return { status: 200, data: {
        status: 'present', revision: 1, content: { t: 'plain', v: { key: 'purposes', value: { v: 1, bindings: [] } } } } };
      if (path.endsWith('/connected-metadata/presentation')) return { status: 200, data: {
        status: 'present', revision: 1, content: { t: 'plain', v: { v: 1, entries: [] } } } };
      if (path === '/v2/account/settings') return { status: 200, data: { version: 7, content: { t: 'plain', v: {} } } };
      throw new Error(`Unexpected pool inventory request: ${path}`);
    });
    const result = await runWithServerHttpBaseUrl(home, () => createActionExecutor(createCliActionDeps({
      token: credentials.token, credentials, sessionId: 'pool-policy-session', mode: 'plain', ctx: null,
    })).execute('sessions.spawn.connected_services.list', { agentId: 'codex' }, { surface: 'cli' }));
    expect(result).toMatchObject({ ok: true, result: { groupOptionsByServiceId: { [serviceKey]: [{
      groupId: 'work', autoSwitch, memberProfileIds: ['primary'], enabledMemberCount: 1,
    }] } } });
    expect(paths.filter(path => path.startsWith('/v3/connect/') || path === '/v4/connect/qualified/groups')).toEqual([]);
  });

  it.each(['daemon', 'captured'] as const)('reobserves current purpose authority on every %s inventory demand after the Home recovers', async custody => {
    const credentials = { token: 'recovering-purpose-consumer', encryption: null };
    const home = 'https://recovering-purpose-consumer.example.test';
    const declaration = resolveQualifiedPurposeDeclarationSnapshotForAgentSpawn({ agentId: 'codex',
      contributions: readCurrentContributionRegistry() })?.authorizedPurposes.find(scope => scope.serviceRefs[0]?.localId === 'openai-codex');
    if (!declaration?.serviceRefs[0]) throw new Error('Missing current declared Codex purpose');
    const service = declaration.serviceRefs[0];
    const snapshot = { source: 'network' as const, scopeKey: resolveAccountSettingsScopeKey(credentials),
      settings: accountSettingsParse({}), rawSettings: {}, settingsVersion: 7, loadedAtMs: Date.now(), settingsSecretsReadKeys: [] };
    setActiveAccountSettingsSnapshot(snapshot);
    const operationContext = custody === 'captured' ? createInvocationSavedSecretOperationContextV1({ credentials,
      snapshot, serverHttpBaseUrl: home, isCurrent: async () => true }) : undefined;
    let reachable = false;
    let hasBinding = true;
    let purposeReads = 0;
    // Only Home HTTP is replaced; Account publication, recovery, catalog parsing,
    // default interpretation and Action failure normalization remain real.
    vi.spyOn(axios, 'get').mockImplementation(async input => {
      const path = new URL(String(input)).pathname;
      if (path.endsWith('/currentness')) return { status: 200, data: { mode: 'plain', version: 1,
        signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } };
      if (path === '/v1/account/profile') return { status: 200, data: AccountProfileSchema.parse({ id: 'recovering-purpose-account' }) };
      if (path.endsWith('/connected-accounts/purposes')) { purposeReads += 1; return reachable
        ? { status: 200, data: { status: 'present', revision: hasBinding ? 4 : 5, content: { t: 'plain', v: {
          key: 'purposes', value: { v: 1, bindings: hasBinding ? [{ purpose: declaration.purpose,
            target: { kind: 'group', service, groupId: 'recovered-group' } }] : [] },
        } } } } : { status: 503, data: { error: 'unreachable' } }; }
      if (path === '/v2/account/settings') return { status: 200, data: { version: 7, content: { t: 'plain', v: {} } } };
      throw new Error(`Unexpected Home request: ${path}`);
    });
    await runWithServerHttpBaseUrl(home, async () => {
      const deps = createCliActionDeps({ token: credentials.token, credentials,
        ...(operationContext ? { savedSecretOperationContext: operationContext } : {}),
        sessionId: 'recovering-purpose-session', mode: 'plain', ctx: null });
      const executor = createActionExecutor(deps);
      expect(await executor.execute('sessions.spawn.connected_services.list', { agentId: 'codex' }, { surface: 'cli' }))
        .toMatchObject({ ok: false, errorCode: 'connected_services_default_unavailable',
          error: 'connected_account_purpose_catalog_unavailable', details: {
            v: 1, source: 'account_default', reason: 'connected_account_purpose_catalog_unavailable',
            phase: 'purpose_binding',
          } });
      expect((operationContext?.readSnapshot() ?? getActiveAccountSettingsSnapshot())?.connectedPurposeCatalog)
        .toMatchObject({ status: 'unavailable', reason: 'unreachable' });
      const beforeExplicitDiscovery = purposeReads;
      expect(await executor.execute('sessions.spawn.connected_services.list',
        { agentId: 'codex', includeDefaults: false }, { surface: 'cli' }))
        .toMatchObject({ ok: true, result: { supportedServiceIds: [`${service.pluginId}/${service.localId}`] } });
      expect(purposeReads).toBe(beforeExplicitDiscovery);
      reachable = true;
      expect(await executor.execute('sessions.spawn.connected_services.list', { agentId: 'codex' }, { surface: 'cli' }))
        .toMatchObject({ ok: true, result: { defaultBindings: { v: 2, bindingsByServiceId: {
          [`${service.pluginId}/${service.localId}`]: { source: 'connected', selection: 'group', groupId: 'recovered-group' },
        } } } });
      hasBinding = false;
      const restored = await executor.execute('sessions.spawn.connected_services.list', { agentId: 'codex' }, { surface: 'cli' });
      expect(restored).toMatchObject({ ok: true });
      if (!restored.ok) throw new Error('Expected current inventory');
      expect(restored.result).not.toHaveProperty('defaultBindings');
      if (operationContext) expect(getActiveAccountSettingsSnapshot()).toBe(snapshot);
    });
  });

  it.each(['spawn', 'summary'] as const)('reads %s purpose inventory with the original named Action token, authority ceiling and captured Home', async kind => {
    const accountId = 'named-purpose-inventory';
    const home = 'https://named-purpose-inventory.example.test';
    const credentials = { token: `header.${Buffer.from(JSON.stringify({ sub: accountId })).toString('base64url')}.signature`, encryption: null };
    const actionToken = 'named-purpose-action-token';
    const agentId = kind === 'summary' ? 'claude' : 'codex';
    const declaration = resolveQualifiedPurposeDeclarationSnapshotForAgentSpawn({ agentId,
      contributions: readCurrentContributionRegistry() })?.authorizedPurposes.find(scope => scope.serviceRefs[0]?.localId === (kind === 'summary' ? 'claude-subscription' : 'openai-codex'));
    if (!declaration?.serviceRefs[0]) throw new Error('Missing current declared Codex purpose');
    const service = declaration.serviceRefs[0];
    const snapshot = { source: 'network' as const, scopeKey: resolveAccountSettingsScopeKey(credentials),
      settings: accountSettingsParse({ backendEnabledByTargetKey: Object.fromEntries(
        [...readCurrentContributionRegistry().agentDefinitionsById.values()].flatMap(entry => entry.identity
          ? listAgentExecutionTargetsV1(entry.identity).map(target => [buildBackendTargetKeyV2(target), entry.id === agentId]) : [])),
      }), rawSettings: {}, settingsVersion: 7, loadedAtMs: 1, settingsSecretsReadKeys: [] };
    setActiveAccountSettingsSnapshot({ ...snapshot, scopeKey: resolveAccountSettingsScopeKey({ token: 'ambient-daemon', encryption: null }) });
    const incumbent = getActiveAccountSettingsSnapshot();
    let current = true;
    const operationContext = createInvocationSavedSecretOperationContextV1({ credentials, serverHttpBaseUrl: home,
      snapshot, isCurrent: async () => current });
    const denied: string[] = [];
    // Tokens are opaque HTTP credentials, not a new token parser. The real
    // Action executor and request-header owner must retain original authority.
    vi.spyOn(axios, 'get').mockImplementation(async (input, options) => {
      const url = new URL(String(input));
      expect(url.origin).toBe(home);
      const authorization = Object.entries(options?.headers ?? {}).filter(([name]) => name.toLowerCase() === 'authorization');
      // The existing ACP row owner uses captured Account credentials. Purpose
      // reads below must retain the named Action's original authorization.
      if (authorization[0]?.[1] === `Bearer ${credentials.token}`) {
        if (url.pathname.endsWith('/currentness')) return { status: 200, data: { mode: 'plain', version: 1,
          signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } };
        if (url.pathname.endsWith('/entity-rows/acp')) return { status: 200, data: { status: 'present', revision: 1,
          content: { t: 'plain', v: { v: 1, definitions: [] } } } };
      }
      if (authorization.length !== 1 || authorization[0]?.[1] !== `Bearer ${actionToken}`
        || options?.headers?.[AUTHORITY_CEILING_HEADER_V1] !== 'account_automation') {
        denied.push(url.pathname);
        return { status: 403, data: { error: 'forbidden' } };
      }
      if (url.pathname === '/v1/account/profile') return { status: 200, data: AccountProfileSchema.parse({ id: accountId }) };
      if (url.pathname.endsWith('/currentness')) return { status: 200, data: { mode: 'plain', version: 1,
        signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } };
      if (url.pathname.endsWith('/connected-accounts/purposes')) return { status: 200, data: {
        status: 'present', revision: 4, content: { t: 'plain', v: { key: 'purposes', value: { v: 1,
          bindings: [{ purpose: declaration.purpose, target: { kind: 'group', service, groupId: 'row-group' } }] } } } } };
      if (url.pathname === '/v2/account/settings') return { status: 200, data: { version: 7, content: { t: 'plain', v: {} } } };
      throw new Error(`Unexpected named Action request: ${url.pathname}`);
    });
    const executor = createActionExecutor(createCliActionDeps({ token: actionToken, credentials,
      savedSecretOperationContext: operationContext, serverId: 'named-purpose-home', serverHttpBaseUrl: home,
      sessionId: 'named-purpose-session', mode: 'plain', ctx: null,
      machineActionDirectTargetTransport: { machineId: 'requester-summary-machine', invoke: async () => { throw new Error('Unexpected recursion'); } } }));
    // The invocation's captured Home must win over the daemon's ambient Home.
    const result = await runWithServerHttpBaseUrl('https://ambient-daemon.example.test', () => executor.execute(
      kind === 'summary' ? 'agents.models.list' : 'sessions.spawn.connected_services.list',
      kind === 'summary' ? { purpose: 'scm_diff_summary', machineId: 'requester-summary-machine' } : { agentId: 'codex', includeUnavailable: false },
      { surface: 'cli', authority: 'account_automation', actionCaller: { kind: 'host' } }));
    expect(denied).toEqual([]);
    if (kind === 'summary') {
      expect(result).toMatchObject({ ok: true });
      if (!result.ok || !result.result || typeof result.result !== 'object' || !('scmDiffSummaryCatalog' in result.result)) throw new Error('Missing Summary catalog');
      const catalog = ScmDiffSummaryModelCatalogObservationV1Schema.parse(result.result.scmDiffSummaryCatalog);
      expect(catalog.profiles, JSON.stringify({ purpose: operationContext.readSnapshot()?.connectedPurposeCatalog, denied })).toEqual(expect.arrayContaining([expect.objectContaining({ structuredOutput: 'supported',
        modelSelector: expect.objectContaining({ backendTargetKey: 'agent:happier.agent.claude/claude' }) })]));
    } else expect(result).toMatchObject({ ok: true, result: { defaultBindings: { v: 2, bindingsByServiceId: {
      [`${service.pluginId}/${service.localId}`]: { source: 'connected', selection: 'group', groupId: 'row-group' },
    } } } });
    expect(operationContext.readSnapshot()?.connectedPurposeCatalog).toMatchObject({ status: 'ready', revision: 4 });
    expect(getActiveAccountSettingsSnapshot()).toBe(incumbent);
    if (kind === 'summary') {
      current = false;
      expect(await executor.execute('agents.models.list', { purpose: 'scm_diff_summary', machineId: 'requester-summary-machine' },
        { surface: 'cli', authority: 'account_automation', actionCaller: { kind: 'host' } })).toMatchObject({ ok: false });
      expect(operationContext.readSnapshot()).toBeNull();
      expect(getActiveAccountSettingsSnapshot()).toBe(incumbent);
    }
  });

  it.each([
    ['direct', 'ready'], ['inventory', 'ready'],
    ['direct', 'mode-mismatch'], ['inventory', 'mode-mismatch'],
  ] as const)('%s requires %s purpose authority instead of a legacy default', async (owner, outcome) => {
    const credentials = { token: 'current-purpose-consumer', encryption: null };
    const home = 'https://purpose-consumer.example.test';
    const raw = { connectedServicesAdditionalDefaultAuthByAgentIdV1: { v: 1, bindingsByAgentId: {
      codex: { v: 1, bindingsByServiceId: { 'openai-codex': {
        source: 'connected', selection: 'profile', profileId: 'retired-account',
      } } },
    } } };
    const snapshot = { source: 'network' as const, scopeKey: resolveAccountSettingsScopeKey(credentials),
      settings: accountSettingsParse(raw), rawSettings: raw, settingsVersion: 7, loadedAtMs: 1, settingsSecretsReadKeys: [] };
    setActiveAccountSettingsSnapshot(snapshot);
    const incumbent = getActiveAccountSettingsSnapshot();
    // Only Home HTTP is replaced. Public launch/inventory, purpose parsing,
    // captured custody and default interpretation use their real owners.
    vi.spyOn(axios, 'get').mockImplementation(async input => {
      const url = new URL(String(input));
      expect(url.origin).toBe(home);
      if (url.pathname.endsWith('/currentness')) return { status: 200, data: { mode: 'plain', version: 1,
        signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } };
      if (url.pathname === '/v1/account/profile') return { status: 200, data: AccountProfileSchema.parse({ id: 'purpose-inventory-account' }) };
      if (url.pathname.endsWith('/connected-accounts/purposes')) return { status: 200, data: {
        status: 'present', revision: 4, content: outcome === 'ready'
          ? { t: 'plain', v: { key: 'purposes', value: { v: 1, bindings: [] } } }
          : { t: 'encrypted', c: 'incompatible-account-mode' } } };
      if (url.pathname === '/v2/account/settings') return { status: 200, data: { version: 7, content: { t: 'plain', v: raw } } };
      throw new Error(`Unexpected Home request: ${url.pathname}`);
    });
    await runWithServerHttpBaseUrl(home, async () => {
      if (owner === 'direct') {
        const operation = resolveDirectCliConnectedServiceBindings({ agentId: 'codex', credentials,
          accountSettings: snapshot.settings, authRaw: 'default', authJsonRaw: undefined });
        if (outcome === 'ready') await expect(operation).resolves.toBeNull();
        else await expect(operation).rejects.toMatchObject({ code: 'connected_services_default_unavailable' });
        expect(getActiveAccountSettingsSnapshot()?.connectedPurposeCatalog).toMatchObject(outcome === 'ready'
          ? { status: 'ready', revision: 4 } : { status: 'unavailable', reason: 'account-mode-mismatch' });
      } else {
        const operationContext = createInvocationSavedSecretOperationContextV1({ credentials, serverHttpBaseUrl: home,
          snapshot, isCurrent: async () => true });
        const deps = createCliActionDeps({ token: credentials.token, credentials,
          savedSecretOperationContext: operationContext, sessionId: 'purpose-inventory-session', mode: 'plain', ctx: null });
        const operation = createActionExecutor(deps).execute('sessions.spawn.connected_services.list',
          { agentId: 'codex', includeUnavailable: false }, { surface: 'cli' });
        if (outcome === 'ready') expect(await operation).toMatchObject({ ok: true });
        else expect(await operation).toMatchObject({ ok: false, errorCode: 'connected_services_default_unavailable' });
        expect(operationContext.readSnapshot()?.connectedPurposeCatalog).toMatchObject(outcome === 'ready'
          ? { status: 'ready', revision: 4 } : { status: 'unavailable', reason: 'account-mode-mismatch' });
        expect(getActiveAccountSettingsSnapshot()).toBe(incumbent);
      }
    });
  });
});
