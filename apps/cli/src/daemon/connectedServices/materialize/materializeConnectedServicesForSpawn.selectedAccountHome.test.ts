import { existsSync } from 'node:fs';
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

import { afterAll, beforeAll, expect, it } from 'vitest';
import type { ConnectedAccountRuntimeConfiguration } from '@happier-dev/plugin-sdk/connected-accounts';
import { buildQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-identity';

import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { createAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { createConnectedAccountPurposeBindingOwner } from '../purposeBindings/ConnectedAccountPurposeBindingOwner';
import { resolveQualifiedPurposeDeclarationSnapshotForAgentSpawn } from '../requestAuth/prepareConnectedAccountRequestAuthForSpawn';
import { resolveConnectedServiceHomeDir } from '../homes/resolveConnectedServiceHomeDir';
import { materializeConnectedServicesForSpawn } from './materializeConnectedServicesForSpawn';
import { resolveSpawnChildEnvironment } from '@/daemon/spawn/resolveSpawnChildEnvironment';
import { buildScopedProcessEnv } from '@/utils/processEnv/buildScopedProcessEnv';

let runtime: Awaited<ReturnType<typeof createAdmittedPluginRuntimeFixture>>;
beforeAll(async () => {
  runtime = await createAdmittedPluginRuntimeFixture({
    controller: pluginReloadController,
    runtimeOptions: { pluginIds: ['happier.agent.antigravity'] },
  });
});
afterAll(async () => { await runtime?.dispose(); });

it('preserves a retired exact-subject refusal through real native-home materialization', async () => {
  const root = await mkdtemp(join(tmpdir(), 'happier-retired-native-home-'));
  const agentId = 'antigravity';
  const declaration = resolveQualifiedPurposeDeclarationSnapshotForAgentSpawn({ agentId, contributions: runtime.registry.contributes })!;
  const scope = declaration.fileMaterializationPurposes[0]!;
  const binding = { purpose: scope.purpose, target: { kind: 'account' as const,
    account: { service: scope.serviceRefs[0]!, accountId: 'selected-account' } } };
  const unexpected = async (): Promise<never> => { throw new Error('Retired launch must not read another selection or credential'); };
  const owner = createConnectedAccountPurposeBindingOwner({
    store: { read: unexpected, update: unexpected, subscribe: () => ({ dispose() {} }) },
    selectTarget: unexpected, resolveTarget: unexpected, projectTargetAccounts: unexpected,
    assertTargetAccountMaterializable: unexpected, materializeAccount: unexpected,
  });
  const lease = owner.activatePurposeBindings({ subject: { kind: 'execution_run', runId: 'retired-run', runnerPid: 123,
    agentId, isCurrent: () => false }, purposes: declaration.purposes, bindings: [binding] });
  try {
    await expect(materializeConnectedServicesForSpawn({ agentId, materializationKey: 'retired-run',
      activeServerDir: join(root, 'server'), baseDir: join(root, 'materialized'), recordsByServiceId: new Map(),
      exactPurposeBindingSubjectId: lease.subjectId, connectedAccountsOwner: owner,
      connectedAccountMaterializationAuthority: { kind: 'qualified', purposeBindings: [binding], requestAuthPurposeBindings: [] },
      qualifiedPurposeBindingSnapshot: { ...declaration, bindings: [binding] },
    })).rejects.toMatchObject({ code: 'plugin_connected_account_binding_unavailable', details: { reasonCode: 'subject_retired' } });
  } finally { lease.dispose(); await rm(root, { recursive: true, force: true }); }
});

it('prepares selected Antigravity account homes and preserves copied config and isolated history through restart and sharing', async () => {
  const root = await mkdtemp(join(tmpdir(), 'happier-selected-account-home-'));
  const leases: Array<{ dispose(): void }> = [];
  try {
    const agentId = 'antigravity';
    const declaration = resolveQualifiedPurposeDeclarationSnapshotForAgentSpawn({
      agentId, contributions: runtime.registry.contributes,
    })!;
    const scope = declaration.fileMaterializationPurposes[0]!;
    const service = scope.serviceRefs[0]!;
    const binding = { purpose: scope.purpose, target: { kind: 'group' as const, service, groupId: 'pool' } };
    const catalog = await runtime.registry.acquireAgentCatalogEntry!(agentId);
    const nativeHome = (await catalog!.getConnectedServiceStateSharingDescriptor!())!.nativeHome!;
    expect(nativeHome.groupHome, 'The actual Agent declaration opts into selected-account homes').toBe('selectedAccount');
    let selectedAccountId = 'account-a';
    const unusedStorageBoundary = async (): Promise<never> => { throw new Error('Unexpected account inventory I/O'); };
    const owner = createConnectedAccountPurposeBindingOwner({
      store: { read: unusedStorageBoundary, update: unusedStorageBoundary, subscribe: () => ({ dispose() {} }) },
      selectTarget: unusedStorageBoundary,
      // The external account inventory selects the group member. The real purpose owner
      // and admitted credential runtime keep selection and materialization authoritative.
      resolveTarget: async target => ({ displayName: selectedAccountId,
        account: target.kind === 'account' ? target.account : { service: target.service, accountId: selectedAccountId } }),
      projectTargetAccounts: unusedStorageBoundary,
      assertTargetAccountMaterializable: unusedStorageBoundary,
      materializeAccount: async input => {
        const accountRuntime = await runtime.registry.resolveConnectedAccountRuntime!(input.account.service);
        if (!accountRuntime) throw new Error('Admitted account runtime unavailable');
        const configuration: ConnectedAccountRuntimeConfiguration = {
          target: { kind: 'account', account: input.account, modeId: 'oauth-personal' },
          revision: 'fixture-configuration', values: {}, getSecret: async () => null,
        };
        const values: Readonly<Record<string, string>> = {
          accessToken: `access-${input.account.accountId}`, refreshToken: `refresh-${input.account.accountId}`,
          projectId: 'fixture-project', scopes: '[]',
        };
        return await runtime.registry.connectedAccountRuntimeInvoker!.invokeEstablished({
          target: { account: input.account, expectedCredentialRevision: 'fixture-credential',
            expectedRuntimeConfigurationRevision: configuration.revision },
          operation: { kind: 'materialize', request: input.request },
          context: { account: input.account, configuration, credentials: { get: async key => values[key] ?? null } },
          isConfigurationCurrent: async candidate => candidate === configuration && accountRuntime.isCurrent(),
          isCredentialRevisionCurrent: async () => accountRuntime.isCurrent(),
          signal: input.signal,
        });
      },
    });
    const launch = async (key: string, connected = true, stateMode: 'isolated' | 'shared' = 'isolated') => {
      const bindings = connected ? [binding] : [];
      leases.push(owner.activateSessionPurposeBindings({ sessionId: key, purposes: declaration.purposes, bindings }));
      return await materializeConnectedServicesForSpawn({
        agentId, materializationKey: key, purposeBindingSessionId: key,
        activeServerDir: join(root, 'server'), baseDir: join(root, 'materialized'), recordsByServiceId: new Map(),
        connectedAccountsOwner: owner, processEnv: { [nativeHome.environmentKey]: join(root, 'native') },
        connectedAccountMaterializationAuthority: { kind: 'qualified', purposeBindings: bindings, requestAuthPurposeBindings: [] },
        qualifiedPurposeBindingSnapshot: { ...declaration, bindings },
        accountSettings: { connectedServicesProviderStateSharingSettingsV1: {
          v: 1, defaults: { configMode: 'copied', stateMode }, byAgentId: {}, acknowledgedRisksByAgentId: {},
        } },
      });
    };
    const inherited = Object.freeze({
      GOOGLE_APPLICATION_CREDENTIALS: 'user-google', XDG_CACHE_HOME: 'user-cache',
    });
    const readChild = async (materialized: Awaited<ReturnType<typeof launch>>) => {
      if (!materialized) throw new Error('Actual Agent materialization unavailable');
      const environment = await resolveSpawnChildEnvironment({
        options: { directory: root }, profileEnvironmentVariables: inherited,
        daemonSpawnHooks: null, processEnv: inherited, logDebug() {}, logInfo() {}, logWarn() {},
        connectedServiceAuth: { env: materialized.env, unsetEnvKeys: materialized.unsetEnvKeys,
          cleanupOnFailure: null, cleanupOnExit: null },
      });
      if (!environment.ok) throw new Error(environment.errorCode);
      const output = execFileSync(process.execPath, ['-e',
        'process.stdout.write(JSON.stringify({ fileTokens: process.env.AGY_CLI_FORCE_FILE_TOKEN_STORAGE ?? null, google: process.env.GOOGLE_APPLICATION_CREDENTIALS, cache: process.env.XDG_CACHE_HOME }))',
      ], { env: buildScopedProcessEnv({ baseEnv: inherited, explicitEnv: environment.extraEnvForChild,
        unsetEnvKeys: environment.unsetEnvKeys }), encoding: 'utf8' });
      return JSON.parse(output) as Record<string, string | null>;
    };
    const nativeRoot = join(root, 'native');
    await mkdir(join(nativeRoot, 'config', 'skills'), { recursive: true });
    await mkdir(join(nativeRoot, 'antigravity-cli'), { recursive: true });
    await writeFile(join(nativeRoot, 'config', 'skills', 'SKILL.md'), 'native skill');
    await writeFile(join(nativeRoot, 'antigravity-cli', 'settings.json'), '{"trustedWorkspaces":[]}');
    await writeFile(join(nativeRoot, 'antigravity-cli', 'antigravity-oauth-token'), 'native credential');
    const first = await launch('launch-a');
    expect(await readChild(first)).toEqual({ fileTokens: '1', google: 'user-google', cache: 'user-cache' });
    expect(await readFile(join(first!.targetMaterializedRoot!, 'antigravity-cli', 'settings.json'), 'utf8')).toBe('{"trustedWorkspaces":[]}');
    const accountAHome = join(resolveConnectedServiceHomeDir({ activeServerDir: join(root, 'server'),
      serviceId: buildQualifiedPluginContributionKey(service), profileId: selectedAccountId, agentId }), nativeHome.materializedDirectoryName!);
    expect(first!.targetMaterializedRoot).toBe(accountAHome);
    await mkdir(join(accountAHome, 'antigravity-cli', 'conversations'), { recursive: true });
    const conversation = join(accountAHome, 'antigravity-cli', 'conversations', 'private-a.db');
    await writeFile(conversation, 'account-a-conversation');
    const privateFiles = [
      ['conversations/private-a.db-wal', new Uint8Array([0, 255, 128])],
      ['conversations/private-a.meta', new TextEncoder().encode('{"id":"private-a"}')],
      ['brain/private-a/artifact.md', new TextEncoder().encode('private artifact')],
    ] as const;
    await mkdir(join(accountAHome, 'antigravity-cli', 'brain', 'private-a'), { recursive: true });
    for (const [path, bytes] of privateFiles) await writeFile(join(accountAHome, 'antigravity-cli', path), bytes);
    await writeFile(join(accountAHome, 'antigravity-cli', 'unknown-private.json'), 'account-local');
    const copiedSkill = join(accountAHome, 'config', 'skills', 'SKILL.md');
    await utimes(copiedSkill, 1234, 1234);
    const copiedIdentity = await lstat(copiedSkill);
    await first!.cleanupOnExit!();
    selectedAccountId = 'account-b';
    const second = await launch('launch-b');
    expect(second!.targetMaterializedRoot).not.toBe(accountAHome);
    expect(existsSync(join(second!.targetMaterializedRoot!, 'antigravity-cli', 'conversations', 'private-a.db'))).toBe(false);
    expect(existsSync(join(second!.targetMaterializedRoot!, 'antigravity-cli', 'brain', 'private-a', 'artifact.md'))).toBe(false);
    expect(existsSync(join(nativeRoot, 'antigravity-cli', 'conversations', 'private-a.db'))).toBe(false);
    expect(existsSync(join(nativeRoot, 'antigravity-cli', 'brain', 'private-a', 'artifact.md'))).toBe(false);
    expect(await readFile(join(second!.targetMaterializedRoot!, 'antigravity-cli', 'antigravity-oauth-token'), 'utf8')).toContain('access-account-b');
    await second!.cleanupOnExit!();
    selectedAccountId = 'account-a';
    const resumed = await launch('launch-a-again');
    expect(resumed!.targetMaterializedRoot).toBe(accountAHome);
    expect(await readFile(conversation, 'utf8')).toBe('account-a-conversation');
    expect((await readdir(join(accountAHome, 'config'))).filter(name => name.includes('.local-'))).toEqual([]);
    expect((await readdir(join(accountAHome, 'antigravity-cli'))).filter(name => name.includes('.local-'))).toEqual([]);
    expect((await lstat(copiedSkill)).ino).toBe(copiedIdentity.ino);
    expect((await lstat(copiedSkill)).mtimeMs).toBe(copiedIdentity.mtimeMs);
    await resumed!.cleanupOnExit!();
    const shared = await launch('launch-a-shared', true, 'shared');
    expect(shared!.targetMaterializedRoot).toBe(accountAHome);
    expect(await readFile(conversation, 'utf8')).toBe('account-a-conversation');
    expect(await readFile(join(nativeRoot, 'antigravity-cli', 'conversations', 'private-a.db'), 'utf8')).toBe('account-a-conversation');
    for (const [path, bytes] of privateFiles) {
      expect(new Uint8Array(await readFile(join(accountAHome, 'antigravity-cli', path)))).toEqual(bytes);
      expect(new Uint8Array(await readFile(join(nativeRoot, 'antigravity-cli', path)))).toEqual(bytes);
    }
    expect(await realpath(join(accountAHome, 'antigravity-cli', 'conversations'))).toBe(await realpath(join(nativeRoot, 'antigravity-cli', 'conversations')));
    expect(await realpath(join(accountAHome, 'antigravity-cli', 'brain'))).toBe(await realpath(join(nativeRoot, 'antigravity-cli', 'brain')));
    expect(await readFile(join(nativeRoot, 'antigravity-cli', 'antigravity-oauth-token'), 'utf8')).toBe('native credential');
    expect(existsSync(join(nativeRoot, 'antigravity-cli', 'unknown-private.json'))).toBe(false);
    expect(await readFile(join(accountAHome, 'antigravity-cli', 'antigravity-oauth-token'), 'utf8')).toContain('access-account-a');
    await shared!.cleanupOnExit!();
    const native = await launch('launch-native', false);
    expect(await readChild(native)).toEqual({ fileTokens: null, google: 'user-google', cache: 'user-cache' });
    await native!.cleanupOnExit!();
  } finally {
    for (const lease of leases) lease.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

it('disposes an explicit probe home even when the probe writes declared native history', async () => {
  const root = await mkdtemp(join(tmpdir(), 'happier-probe-history-'));
  try {
    const nativeHome = join(root, 'custodian-native');
    const durableConversation = join(nativeHome, 'antigravity-cli', 'conversations', 'durable.db');
    await mkdir(join(nativeHome, 'antigravity-cli', 'conversations'), { recursive: true });
    await writeFile(durableConversation, 'durable-account-history');
    const probe = await materializeConnectedServicesForSpawn({
      agentId: 'antigravity', materializationKey: 'probe-history', probePurpose: 'probe',
      activeServerDir: join(root, 'server'), baseDir: join(root, 'materialized'),
      recordsByServiceId: new Map(), allowNativeAccountState: false, processEnv: { GEMINI_HOME: nativeHome },
    });
    const probeHome = probe!.targetMaterializedRoot!;
    expect(probeHome).not.toBe(nativeHome);
    const probeConversation = join(probeHome, 'antigravity-cli', 'conversations', 'probe.db');
    await mkdir(join(probeHome, 'antigravity-cli', 'conversations'), { recursive: true });
    await writeFile(probeConversation, 'probe-only-history');
    await probe!.cleanupOnExit!();
    expect(existsSync(probeHome)).toBe(false);
    expect(await readFile(durableConversation, 'utf8')).toBe('durable-account-history');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
