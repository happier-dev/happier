import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createTempDir, removeTempDir } from '@/testkit/fs/tempDir';
import { bindInactiveSessionControlLaunchScope, type ResolveInactiveSessionControlLaunchScope } from '@/daemon/spawn/inactiveSessionControlLaunchScope';
import { prepareInactiveSessionControlLaunchScope } from '@/daemon/spawn/prepareInactiveSessionControlLaunchScope';
import { createCodexForegroundConnectedAccountFixture } from '@/daemon/agentRuntime/prepareForegroundAdmission.codexConnectedServices.testkit';
import { createAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { accountSettingsParse } from '@happier-dev/protocol/account/settings/accountSettings';
import { deriveSessionCreationTagV1, SessionCreationCorrespondenceV1Schema } from '@happier-dev/protocol';
import { readProfilesFromAccountSettings } from '@/settings/profiles/readProfilesFromAccountSettings';
import { generateConnectedServiceMaterializationIdentityV1 } from '@/daemon/connectedServices/materialization/identity';
import { listQualifiedConnectedAccountsV4 } from '@/api/client/qualifiedConnectedAccountApi';
import { createCodexNativeAppServerClient } from '../../../../../packages/plugins/codex/src/agent/runtime/appServer/client';
import { routeSessionGoalControl } from '@/session/goalControls/sessionGoalControlRouter';
import type { RawSessionRecord } from '@/session/transport/http/sessionsHttp';
import { createNativeInactiveGoalAdapter, createNativeInactiveCatalogAdapter, createNativeInactiveUsageAdapter } from './nativeInactiveSessionControlAdapters';
import { rawSession, metadata, commonRouteParams } from './nativeInactiveSessionControlAdapters.testkit';

type ScopedInactiveFixture = Readonly<{
  goal: ReturnType<typeof createNativeInactiveGoalAdapter>;
  catalog: ReturnType<typeof createNativeInactiveCatalogAdapter>;
  usage: ReturnType<typeof createNativeInactiveUsageAdapter>;
  inputFor(profile: string): import('@/session/goalControls/sessionGoalControlTypes').SessionGoalControlAdapterParams & Readonly<{ rawSession: RawSessionRecord }>;
  set(profile: string): Promise<unknown>;
  resumeGoal(profile: string): Promise<unknown>;
  homeFor(profile: string): string | undefined;
  retireAccountAfterNextAdmission(): void;
  retireAccountDuringNativePreparation(): void;
}>;

async function createScopedInactiveFixture(): Promise<ScopedInactiveFixture & Readonly<{ dispose(): Promise<void> }>> {
    const root = await createTempDir('inactive-daemon-goal-scope-');
    const hostHome = join(root, 'host-default');
    await mkdir(hostHome);
    const script = join(root, 'native.cjs');
    // Third-party native process boundary. All host admission, plugin activation,
    // invocation services, controls, RPC codecs, Exec and persistence stay real.
    await writeFile(script, `
      #!/usr/bin/env node
      const fs = require('node:fs'), path = require('node:path');
      if (process.argv.includes('--version')) { process.stdout.write('codex-cli 0.162.1\\n'); process.exit(0); }
      if (process.argv[2] === 'features') {
        if (fs.existsSync(${JSON.stringify(join(root, 'retire-after-probe'))}))
          fs.writeFileSync(${JSON.stringify(join(root, 'account-retired'))}, 'retired');
        process.exit(0);
      }
      if (process.argv[2] === 'login' && process.argv[3] === 'status') process.exit(0);
      const file = path.join(process.env.CODEX_HOME || ${JSON.stringify(hostHome)}, 'goal.json');
      require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
        const m = JSON.parse(line); if (m.id === undefined) return;
        let result = {};
        if (m.method === 'thread/goal/set') {
          const goal = { ...m.params, createdAt: 1776272400, updatedAt: 1776272460,
            tokenBudget: null, tokensUsed: 0, timeUsedSeconds: 0, scopeProfile: process.env.SCOPE_PROFILE };
          goal.sqlitePinned = process.argv.includes('sqlite_home="' + process.env.CODEX_SQLITE_HOME + '"');
          fs.writeFileSync(file, JSON.stringify(goal)); result = { goal };
        }
        if (m.method === 'thread/goal/get') result = { goal: fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null };
        if (m.method === 'plugin/list') result = [{ id: 'plugin://' + path.dirname(file), name: path.dirname(file), installed: true, enabled: true }];
        if (m.method === 'account/rateLimits/read') result = { primary: { usedPercent: fs.existsSync(file) ? 10 : 100 } };
        if (m.method === 'thread/goal/clear') fs.rmSync(file, { force: true });
        process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result }) + '\\n');
      });
    `.trimStart());
    await chmod(script, 0o755);
    vi.stubEnv('HAPPIER_CODEX_PATH', script);
    vi.stubEnv('HAPPIER_JS_RUNTIME_PATH', process.execPath);
    vi.stubEnv('HAPPIER_EXPERIMENTAL_CODEX_APP_SERVER', '1');
    const account = await createCodexForegroundConnectedAccountFixture(['a', 'b']);
    const admitted = await createAdmittedPluginRuntimeFixture({ controller: pluginReloadController, runtimeOptions: account.runtimeOptions });
    await account.dependenciesFor(admitted.registry, root);
    const homes = new Map<string, string>();
    const profiles = ['a', 'b'].map(id => ({ v: 2 as const, id: `launch-${id}`, name: `Launch ${id}`,
      extraEnvironmentVariables: [{ name: 'SCOPE_PROFILE', value: id }, { name: 'CODEX_SQLITE_HOME', value: join(root, `sqlite-${id}`) }],
      defaultPermissionModeByTargetKey: {}, defaultPersistenceModeByTargetKey: {}, compatibilityByTargetKey: {},
      createdAt: 1, updatedAt: 1 }));
    const snapshot = { source: 'network' as const, settings: { ...accountSettingsParse({
      connectedServicesProviderStateSharingSettingsV1: { v: 1,
        defaults: { configMode: 'isolated', stateMode: 'isolated' }, byAgentId: {}, acknowledgedRisksByAgentId: {} },
    }), profiles }, settingsVersion: 1, loadedAtMs: Date.now(), settingsSecretsReadKeys: [] };
    const correspondenceFor = (id: string) => SessionCreationCorrespondenceV1Schema.parse({
      v: 1, sessionCreationTag: deriveSessionCreationTagV1({ callerCreationNamespace: 'user', creationKey: `scope-${id}` }),
      recipe: { execution: { machineId: 'machine-local', directory: { kind: 'path', path: root } },
        organization: { folderId: null, tagIds: [] },
        agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } },
        modelSelection: null, profileId: `launch-${id}`, requestedPermissionMode: null,
        agentModeId: null, configuration: null, connectedServices: null, capabilitySelection: null, transcriptStorage: null,
        terminal: null, agentSessionStartupInstructionsMarkerV1: null, checkout: null },
    });
    const inputFor = (profile: string) => ({ ...commonRouteParams(profile), cwd: root, sessionMachineId: 'machine-local',
      token: account.credentials.token, credentials: account.credentials,
      rawSession: { ...rawSession(profile), path: root },
      metadata: { ...metadata(), path: root, sessionCreationCorrespondenceV1: correspondenceFor(profile),
        connectedServiceMaterializationIdentityV1: generateConnectedServiceMaterializationIdentityV1(),
        connectedServices: { v: 2, bindingsByServiceId: { 'happier.agent.codex/openai-codex': {
          source: 'connected', selection: 'profile', profileId: profile,
        } } },
      } });
    let admissionError: unknown;
    let accountCurrent = true;
    let retireAfterAdmission = false;
    let retireDuringNativePreparation = false;
    const resolveScope: ResolveInactiveSessionControlLaunchScope = async input => {
      try {
        const scope = await prepareInactiveSessionControlLaunchScope(input, {
          credentials: account.credentials, api: account.api, activeServerDir: join(root, 'server'),
          connectedServicesMaterializationBaseDir: join(root, 'materialized'),
          readAccountSettingsSnapshot: () => snapshot,
          readAccountLaunchProfiles: async () => ({ ...readProfilesFromAccountSettings(snapshot.settings), artifactsById: new Map() }),
          connectedServiceRefreshCoordinator: null, connectedAccountsOwner: account.owner,
          activatePurposeBindings: account.owner.activatePurposeBindings,
          qualifiedConnectedAccountApi: { listAccounts: request => listQualifiedConnectedAccountsV4({ token: account.credentials.token, ...request }),
            async readGroup() { throw new Error('No group selected'); } },
          processEnv: { ...process.env, CODEX_HOME: hostHome },
          connectedAccountRequestAuthRegistry: account.requestAuthRegistry, connectedAccountRequestAuthHttpPort: 43123,
          async assertCurrent() {
            if (!accountCurrent || existsSync(join(root, 'account-retired'))) throw new Error('requester_session_not_current');
          },
        });
        if (retireAfterAdmission) accountCurrent = false;
        if (retireDuringNativePreparation) await writeFile(join(root, 'retire-after-probe'), 'armed');
        homes.set(input.adapterParams.sessionId, scope.environment.CODEX_HOME!);
        return scope;
      } catch (error) { admissionError = error; throw error; }
    };
    const unbind = bindInactiveSessionControlLaunchScope(resolveScope);
    const dependencies = { acquireRuntimeRegistryLease: async () => {
      const lease = admitted.controller.tryAcquireRuntimeRegistry();
      if (!lease) throw new Error('Fixture runtime retired');
      return lease;
    } };
    const goal = createNativeInactiveGoalAdapter({ agentId: 'codex', native: { get: true, set: true, clear: true }, dependencies });
    return {
        goal, inputFor, homeFor: profile => homes.get(profile),
        retireAccountAfterNextAdmission() { retireAfterAdmission = true; },
        retireAccountDuringNativePreparation() { retireDuringNativePreparation = true; },
        catalog: createNativeInactiveCatalogAdapter({ agentId: 'codex', native: { vendorPlugins: true, skills: false }, dependencies }),
        usage: createNativeInactiveUsageAdapter({ agentId: 'codex', native: { checkNow: true, consumeResetCredit: false }, dependencies }),
        async set(profile) {
          admissionError = undefined;
          const result = await routeSessionGoalControl({ ...inputFor(profile), operation: 'set',
            request: { objective: `paused-${profile}`, status: 'paused' }, resumeInactiveWithInitialGoal: false,
            resolveAdapter: async () => goal });
          if (admissionError) throw admissionError;
          return result;
        },
        async resumeGoal(profile) {
          const signal = new AbortController();
          const scope = await resolveScope({ agentId: 'codex', runtimeRegistryLease: admitted.lease, adapterParams: inputFor(profile), signal: signal.signal });
          try {
            const actor = admitted.registry.agentRuntimesByAgentId.get('codex');
            if (!actor) throw new Error('Current native Agent unavailable');
            const services = await admitted.registry.createAgentInvocationServices({
              pluginId: actor.pluginId, pluginVersion: actor.pluginVersion, agentId: 'codex',
              occurrenceId: actor.occurrenceId, correlationId: `resume-${profile}`, cwd: root,
              ...scope, signal: signal.signal, isOccurrenceCurrent: actor.isCurrent,
            });
            const client = await createCodexNativeAppServerClient({ exec: services.exec, cwd: root, processEnv: scope.environment });
            try {
              await client.request('thread/resume', { threadId: 'thread-1' });
              return await client.request('thread/goal/get', { threadId: 'thread-1' });
            } finally { await client.dispose(); }
          } finally { signal.abort(); await scope.dispose(); }
        },
      async dispose() {
        unbind();
        try { await account.cleanup(); }
        finally {
          try { await admitted.dispose(); }
          finally { vi.restoreAllMocks(); vi.unstubAllEnvs(); await removeTempDir(root); }
        }
      },
    };
}

describe('admitted inactive daemon launch scope', () => {
  let fixture: Awaited<ReturnType<typeof createScopedInactiveFixture>> | undefined;
  beforeEach(async () => {
    fixture = await createScopedInactiveFixture();
    for (const profile of ['a', 'b']) {
      await expect(fixture.set(profile)).resolves.toMatchObject({ status: 'applied' });
    }
  });
  afterEach(async () => { await fixture?.dispose(); fixture = undefined; });

  it('uses admitted inactive daemon scope so same-thread Resume sees Set and two profiles remain isolated', async () => {
    if (!fixture) throw new Error('Scope fixture unavailable');
    for (const profile of ['a', 'b']) {
      await expect(fixture.resumeGoal(profile)).resolves.toMatchObject({ goal: { objective: `paused-${profile}`, scopeProfile: profile, sqlitePinned: true } });
    }
    expect(fixture.homeFor('a')).not.toBe(fixture.homeFor('b'));
    await expect(fixture.goal.getGoal!(fixture.inputFor('a'))).resolves.toMatchObject({ workState: { items: [{ title: 'paused-a' }] } });
  });

  it('uses the admitted inactive scope for catalog and usage facets', async () => {
    if (!fixture) throw new Error('Scope fixture unavailable');
    await expect(fixture.catalog.listVendorPlugins!(fixture.inputFor('b'))).resolves.toMatchObject({
      vendorPlugins: [{ name: fixture.homeFor('b') }],
    });
    await expect(fixture.usage.checkNow!(fixture.inputFor('b'))).resolves.toMatchObject({ status: 'ready' });
  });

  it('refuses native effects when the Account retires after scope preparation', async () => {
    if (!fixture) throw new Error('Scope fixture unavailable');
    const home = fixture.homeFor('a');
    if (!home) throw new Error('Admitted native home unavailable');
    const before = await readFile(join(home, 'goal.json'), 'utf8');
    fixture.retireAccountAfterNextAdmission();
    await expect(fixture.goal.setGoal!({ ...fixture.inputFor('a'),
      request: { objective: 'Must remain unlaunched after retirement', status: 'paused' },
    })).resolves.toMatchObject({ ok: false });
    expect(await readFile(join(home, 'goal.json'), 'utf8')).toBe(before);
  });

  it('rechecks Account authority after the native probe and before the unqualified control process launches', async () => {
    if (!fixture) throw new Error('Scope fixture unavailable');
    const home = fixture.homeFor('a');
    if (!home) throw new Error('Admitted native home unavailable');
    const before = await readFile(join(home, 'goal.json'), 'utf8');
    fixture.retireAccountDuringNativePreparation();
    await expect(fixture.goal.setGoal!({ ...fixture.inputFor('a'),
      request: { objective: 'Must remain unlaunched after native probe', status: 'paused' },
    })).resolves.toMatchObject({ ok: false });
    expect(await readFile(join(home, 'goal.json'), 'utf8')).toBe(before);
  });

  it('isolates inactive Clear across profiles and refuses an unadmitted stored binding', async () => {
    if (!fixture) throw new Error('Scope fixture unavailable');
    await expect(fixture.goal.clearGoal!(fixture.inputFor('a'))).resolves.toMatchObject({ status: 'applied' });
    await expect(fixture.resumeGoal('a')).resolves.toEqual({ goal: null });
    await expect(fixture.goal.getGoal!(fixture.inputFor('b'))).resolves.toMatchObject({ workState: { items: [{ title: 'paused-b' }] } });
    await expect(fixture.goal.getGoal!(fixture.inputFor('missing-profile'))).resolves.toMatchObject({
      ok: false, errorCode: 'inactive_agent_launch_scope_unavailable',
    });
    const corrupt = fixture.inputFor('a');
    await expect(fixture.goal.getGoal!({ ...corrupt, metadata: { ...corrupt.metadata, connectedServices: { v: 99 } } }))
      .resolves.toMatchObject({ ok: false, errorCode: 'inactive_agent_launch_scope_unavailable' });
  });
});
