import { expect } from 'vitest';
import { buildQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-identity';
import { SessionSpawnNewActionResultV1Schema } from '@happier-dev/protocol/sessions/creation/sessionSpawnNewResultV1';
import type { TeamSetupFFixture } from './teamSetupF';
import { attachMachineEventTrigger } from './automationsEverywhereGuardStop';
import { createConnectedServiceProfile, createQualifiedConnectedAccountGroup, readQualifiedConnectedServiceCredential,
  resolveQualifiedConnectedAccountServiceForLegacyServiceId } from './connectedServicesRecovery';
import { startFakeTokenServer } from './connectedServicesCodexDaemon';
import { waitFor } from './timing';

/** Only the external OAuth token endpoint is fake. Credential persistence,
 * native refresh, host publication, source admission and Run causes stay real. */
export async function assertCredentialAttentionLifecycle(fixture: TeamSetupFFixture) {
  const secret = 'F6_PRIVATE_REFRESH_TOKEN_NEVER_IN_EVENT_CAUSE';
  let utilization = 10;
  const resetsAt = new Date(Date.now() + 60 * 60_000).toISOString();
  const provider = await startFakeTokenServer({ respond: request => request.method === 'GET'
    ? { status: 200, body: { five_hour: { utilization, resets_at: resetsAt } } }
    : { status: 400, body: { error: 'invalid_grant', error_description: secret } } });
  try {
    const actor = await fixture.createAccount('credential-attention-owner');
    const machine = await fixture.enrollDaemon(actor, { env: {
      HAPPIER_FEATURE_AUTOMATIONS__ENABLED: '1',
      HAPPIER_E2E_PROVIDER_SKIP_CLI_SHARED_DEPS_BUILD: '1',
      HAPPIER_FEATURE_CONNECTED_SERVICES_QUOTAS__ENABLED: '1',
      HAPPIER_FEATURE_CONNECTED_SERVICES_ACCOUNT_GROUPS__ENABLED: '1',
      HAPPIER_FEATURE_CONNECTED_SERVICES_ACCOUNT_FALLBACK__ENABLED: '1',
      HAPPIER_CONNECTED_SERVICES_CLAUDE_SUBSCRIPTION_USAGE_URL: provider.tokenUrl,
      HAPPIER_CONNECTED_SERVICES_CLAUDE_SUBSCRIPTION_OAUTH_TOKEN_URL: provider.tokenUrl,
      HAPPIER_CONNECTED_SERVICES_CLAUDE_SUBSCRIPTION_OAUTH_CLIENT_ID: 'happier-e2e-claude-client',
    } });
    await fixture.assertKnownGoodSessionControl(actor, machine);
    const { saved, selected, readRuns } = await attachMachineEventTrigger(fixture, actor, machine,
      'connected-account-credential-attention');
    const credentialFixture = { serverBaseUrl: fixture.server.baseUrl, auth: actor.auth,
      accountSecret: actor.auth.accountSigningSeed, machineKey: actor.auth.accountMachineKey };
    const profileId = 'attention-profile';
    await createConnectedServiceProfile({ fixture: credentialFixture, serviceId: 'claude-subscription', profileId,
      providerEmail: 'fixture@example.invalid', qualifiedCredential: true,
      accessToken: 'F6_PRIVATE_ACCESS_TOKEN_NEVER_IN_EVENT_CAUSE', refreshToken: secret,
      idToken: null, expiresAt: Date.now() - 60_000 });
    const service = resolveQualifiedConnectedAccountServiceForLegacyServiceId('claude-subscription');
    const spawn = async (selection: { source: 'connected'; profileId: string } |
      { source: 'connected'; selection: 'group'; groupId: string } = { source: 'connected', profileId }) => {
      const updatedAtMs = Date.now();
      const result = await actor.execute('session.spawn_new', {
        executionTarget: machine.target, directory: { kind: 'path', path: machine.workspaceDir },
        agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.claude', localId: 'claude' } },
        permissionMode: 'read-only', approvalProfileId: null,
        configuration: { mode: { value: null, updatedAtMs }, model: { value: null, updatedAtMs, selectionSource: 'explicit' },
          permissionIntent: { value: 'read-only', updatedAtMs }, options: {} },
        connectedServices: { v: 2, bindingsByServiceId: {
          [buildQualifiedPluginContributionKey(service)]: selection,
        } }, terminal: { mode: 'plain' },
      });
      expect(result.ok, JSON.stringify(result)).toBe(true);
      if (!result.ok) throw new Error(`Credential spawn Action refused (${result.errorCode})`);
      const parsed = SessionSpawnNewActionResultV1Schema.parse(result.result);
      expect(parsed).toMatchObject('selection' in selection ? { type: 'success' } : { type: 'error', code: 'spawn_failed' });
      return parsed;
    };
    await spawn();
    await waitFor(async () => {
      const runs = await readRuns();
      expect(runs.length).toBeLessThanOrEqual(1);
      return runs.length === 1 && typeof runs[0]!.producedSessionId === 'string';
    }, { failFast: true, context: 'Persisted credential attention starts one ordinary Run' });
    const persisted = await readQualifiedConnectedServiceCredential({ fixture: credentialFixture,
      serviceId: 'claude-subscription', profileId });
    expect(persisted.health).toMatchObject({ status: 'needs_reauth', lastRefreshFailureKind: 'invalid_grant' });
    await spawn();
    const runs = await readRuns();
    expect(runs).toHaveLength(1);
    expect(runs[0]!.cause).toMatchObject({ kind: 'trigger', triggerId: saved.triggerId,
      triggerKind: 'pluginEvent', evidence: { eventRef: selected.event.identity } });
    expect(provider.requests().filter(request => request.method === 'POST')).toHaveLength(1);
    expect(JSON.stringify(runs[0]!.cause)).not.toContain(secret);
    expect(JSON.stringify(runs[0]!.cause)).not.toMatch(/F6_PRIVATE_ACCESS_TOKEN|error_description|providerErrorCode/);
    // Two real Sessions consume the same qualified group. Only one settled
    // lifecycle transition may start a Run, independent of notification fanout.
    const quota = await attachMachineEventTrigger(fixture, actor, machine, 'connected-account-quota-changed',
      { v: 1, all: [{ field: '/phase', op: 'eq', value: 'blocked' }] });
    const quotaProfileId = 'quota-profile';
    await createConnectedServiceProfile({ fixture: credentialFixture, serviceId: 'claude-subscription', profileId: quotaProfileId,
      providerEmail: 'quota@example.invalid', qualifiedCredential: true,
      accessToken: 'F6_PRIVATE_QUOTA_ACCESS_TOKEN', refreshToken: 'F6_PRIVATE_QUOTA_REFRESH_TOKEN',
      idToken: null, expiresAt: Date.now() + 60 * 60_000 });
    const groupId = 'f6-quota-group';
    await createQualifiedConnectedAccountGroup({ serverBaseUrl: fixture.server.baseUrl, authToken: actor.credentials.token,
      legacyServiceId: 'claude-subscription', groupId, activeConnectedAccountId: quotaProfileId,
      memberConnectedAccountIds: [quotaProfileId], preTurnProbeMode: 'never' });
    const groupSelection = { source: 'connected', selection: 'group', groupId } as const;
    await spawn(groupSelection);
    await spawn(groupSelection);
    const refreshQuota = async () => {
      const result = await actor.execute('connectedServices.quota.refresh', {
        account: { service, accountId: quotaProfileId }, machineId: machine.target.machineId,
      });
      expect(result.ok, JSON.stringify(result)).toBe(true);
    };
    await refreshQuota();
    // The owner retains its normal minute probe policy; no fixture-only owner
    // clock or runtime timer replaces it.
    const quotaWait = { timeoutMs: 90_000, intervalMs: 500, failFast: true } as const;
    await waitFor(async () => provider.requests().some(request => request.method === 'GET'),
      { ...quotaWait, context: 'Native quota owner observes healthy usage' });
    expect(await quota.readRuns()).toEqual([]);
    utilization = 100;
    const beforeBlocked = provider.requests().filter(request => request.method === 'GET').length;
    await refreshQuota();
    await waitFor(async () => {
      const observed = await quota.readRuns();
      expect(observed.length).toBeLessThanOrEqual(1);
      return observed.length === 1 && typeof observed[0]!.producedSessionId === 'string';
    }, { ...quotaWait, context: 'One native group quota edge starts one Run for two recipients' });
    expect(provider.requests().filter(request => request.method === 'GET').length).toBeGreaterThan(beforeBlocked);
    const beforeRepeated = provider.requests().filter(request => request.method === 'GET').length;
    await refreshQuota();
    await waitFor(async () => provider.requests().filter(request => request.method === 'GET').length > beforeRepeated,
      { ...quotaWait, context: 'The owner observes the repeated equal blocked quota' });
    const quotaRuns = await quota.readRuns();
    expect(quotaRuns).toHaveLength(1);
    expect(quotaRuns[0]!.cause).toMatchObject({ kind: 'trigger', triggerId: quota.saved.triggerId,
      triggerKind: 'pluginEvent', evidence: { eventRef: quota.selected.event.identity } });
    expect(JSON.stringify(quotaRuns[0]!.cause)).not.toMatch(/F6_PRIVATE|accessToken|refreshToken|stdout|stderr/);
  } finally { await provider.stop(); }
}
