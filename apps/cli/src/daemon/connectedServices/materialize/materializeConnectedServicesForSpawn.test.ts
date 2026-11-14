import { findCatalogEntry } from '@/agent/catalog/registry';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import * as filesystem from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { PassThrough, Readable } from 'node:stream';
import * as nativeProcess from '@happier-dev/cli-common/process';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// Observe directory reads at the OS boundary; all home/materializer logic stays real.
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, readdir: vi.fn(actual.readdir) };
});

// Isolate platform home lookup while preserving the real materializer and filesystem.
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, homedir: vi.fn(actual.homedir) };
});

import { AccountSettingsSchema, buildConnectedServiceCredentialRecord, buildQualifiedPluginContributionKey, QualifiedConnectedAccountListResponseV4Schema } from '@happier-dev/protocol';
import * as nativeFilesystem from '@happier-dev/plugin-sdk/fs';
import { resolveCodexRuntimeHomeEnvironment } from '../../../../../../packages/plugins/codex/src/agent/auth/services/state/sharing/files';
import { ApiClient } from '@/api/api';
import type { DaemonState } from '@/api/types';
import { createProviderAccountSettingsController } from '@/daemon/lifecycle/providerAccountSettings';
import { setActiveAccountSettingsSnapshot, resetActiveAccountSettingsSnapshotForTests } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { reloadConfiguration } from '@/configuration';
import { logger } from '@/utils/logger';
import { retainExecutionRunState } from '@/daemon/executionRunRegistry';
import { prepareDaemonConnectedServices } from '@/daemon/spawn/prepareDaemonConnectedServices';
import { resolveRunnerAgentSessionDescriptorForLease } from '@/daemon/spawn/prepareAgentRuntimeSessionBridge';
import { createRunnerAgentSessionBootstrapAuthorization } from '@/daemon/agentRuntime/sessionBridgeAuthorization';
import { readRunnerAgentSessionBootstrap } from '@/agent/runtime/session/process/runnerAgentSessionBootstrap';
import { resolveExecutionRunConnectedServicesEnv } from '@/agent/runtime/bridges/executionRun/runtime/connectedServicesEnv';
import { resolveRequesterSessionRuntimeDirectories } from '@/daemon/sessionEncryption/createRequesterSessionRuntimeContext';
import { buildInactiveSessionResumeSpawnOptions } from '@/daemon/sessions/runtimeSnapshot/buildInactiveSessionResumeSpawnOptions';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import type { AgentLaunchPayload } from '@/daemon/agentIsolation/agentLaunchFrame';
import { readAgentLaunchFrame } from '@/daemon/agentIsolation/agentLaunchFrame';
import { executeAgentLaunchPayload, publishAgentLaunchMaterials } from '@/daemon/agentIsolation/agentLaunchShim';
import { createUnixAgentIdentityLaunch } from '@/daemon/agentIsolation/unixAgentIdentityAdapter';
import { createAgentIsolationSessionContext } from '@/daemon/agentIsolation/agentIsolationSessionContext';
import { prepareSessionMcpLocalTransport } from '@/mcp/runtime/sessionMcpLocalTransport';
import { authorizeResolvedProjectExecLaunchForHost } from '@/plugins/runtime/invocation/services/exec';
import { createAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { createResolvedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import { loadEnabledBundledPluginLocatorResult } from '@/plugins/projection/registry/builtIn/locators';
import { projectLoadedPluginContributes } from '@/plugins/projection/registry/fullProjection';
import { projectBuiltInAgents } from '@/plugins/projection/registry/builtIn/agents';
import { BUNDLED_FIRST_PARTY_AGENT_REGISTRATION_BINDINGS } from '@/plugins/projection/registry/sources/generatedBundledPlugins';
import { createForegroundPurposeOwnerFixture } from '@/daemon/agentRuntime/prepareForegroundAdmission.connectedServices.testkit';
import {
  resolveQualifiedPurposeDeclarationSnapshotForAgentSpawn,
} from '../requestAuth/prepareConnectedAccountRequestAuthForSpawn';
import {
  resolveFirstPartyLegacyAgentConnectedAccountServiceId,
} from '@/plugins/projection/registry/connectedAccountPurposeCompatibility';
import {
  materializeConnectedServicesForSpawn as materializeConnectedServicesForSpawnProduction,
  runSerializedMaterialization,
} from './materializeConnectedServicesForSpawn';
import { resolveConnectedServiceMaterializedRootDir } from './resolveConnectedServiceMaterializedRootDir';
import { resolveConnectedServicesMaterializationBaseDir } from './resolveConnectedServicesMaterializationBaseDir';
import { createConnectedServiceMaterializedHomeCleanupScheduler } from './cleanup/createConnectedServiceMaterializedHomeCleanupScheduler';
import { resolveConnectedServiceHomeDir } from '../homes/resolveConnectedServiceHomeDir';
import { resolveConnectedServiceNativeHomeTargetRoot } from './resolveConnectedServiceNativeHomeTarget';
import { readConnectedServiceStateSharingManifest } from '../stateSharing/connectedServiceStateSharingManifest';
import { createConnectedAccountPurposeBindingOwner } from '../purposeBindings/ConnectedAccountPurposeBindingOwner';
import { validateExternalSessionObservationWatchFileChanges } from '@/session/external/observationFileSetPathValidation';
import { createExecutionRunConnectedServicesBridge } from '../runs/executionRunMaterialization';
import { createConnectedAccountRequestAuthSubjectRegistry } from '../requestAuth/ConnectedAccountRequestAuthSubjectRegistry';
import { writeConnectedAccountRequestAuthCapabilityFile, verifyConnectedAccountRequestAuthCapabilityFile } from '../requestAuth/capabilityFile';
import { ConnectedServiceRuntimeRegistry } from '../runtimeRegistry/registry';
import { verifyResumeReachableThroughCatalog } from '../catalogHooks';
import { resolveConnectedServiceAuthForSpawn } from '../resolveConnectedServiceAuthForSpawn';
import { materializeExactV021ConnectedServiceCredential } from '../compatibility/exactV021ConnectedServiceMaterialization';
import {
  HAPPIER_CONNECTED_SERVICE_TARGET_MATERIALIZED_ROOT_ENV_KEY,
} from '../connectedServiceChildEnvironment';

type MaterializeParams = Parameters<typeof materializeConnectedServicesForSpawnProduction>[0];

let retentionPolicyForTest: { mode: 'days'; days: number } | null = null;

let runtimeFixture: Awaited<ReturnType<typeof createAdmittedPluginRuntimeFixture>> | null = null;

function isMaterializationPhase(fields: unknown, materializationKey: string, phase: string, status: string): boolean {
  return typeof fields === 'object' && fields !== null
    && 'materializationKey' in fields && fields.materializationKey === materializationKey
    && 'phase' in fields && fields.phase === phase
    && 'status' in fields && fields.status === status;
}

it.each(['files', 'environment'] as const)('applies only the %s leaves produced for a selected Account credential mode', async mode => {
  const root = await mkdtemp(join(tmpdir(), 'happier-mode-materialization-'));
  let result: Awaited<ReturnType<typeof materializeConnectedServicesForSpawnProduction>> = null;
  let bindingLease: { dispose(): void } | undefined;
  try {
    const native = join(root, 'native');
    await mkdir(native);
    await writeFile(join(native, '.credentials.json'), 'unmanaged-account-A');
    const declaration = resolveQualifiedPurposeDeclarationSnapshotForAgentSpawn({
      agentId: 'claude', contributions: runtimeFixture!.registry.contributes,
    })!;
    const scope = declaration.fileMaterializationPurposes[0]!;
    const fixture = createForegroundPurposeOwnerFixture({
      consumer: scope.purpose.consumer, service: scope.serviceRefs[0]!, purpose: scope.purpose.purpose,
      // The Account-store boundary chooses the credential mode; host orchestration stays real.
      materializeAccount: async ({ request }) => request.kind === 'environment'
        ? { kind: 'environment', env: mode === 'environment' ? { TEST_SELECTED_API_KEY: 'selected-key-B' } : {} }
        : { kind: 'files', files: mode === 'files' ? { '.credentials.json': Buffer.from('{"token":"selected-B"}') } : {} },
    });
    bindingLease = fixture.owner.activateSessionPurposeBindings({
      sessionId: `mode-${mode}`, purposes: declaration.purposes, bindings: [fixture.binding],
    });
    result = await materializeConnectedServicesForSpawnProduction({
      agentId: 'claude', materializationKey: `mode-${mode}`, purposeBindingSessionId: `mode-${mode}`,
      activeServerDir: join(root, 'server'), baseDir: join(root, 'materialized'), recordsByServiceId: new Map(),
      connectedAccountsOwner: fixture.owner,
      connectedAccountMaterializationAuthority: { kind: 'qualified', purposeBindings: [fixture.binding], requestAuthPurposeBindings: [] },
      qualifiedPurposeBindingSnapshot: { ...declaration, bindings: [fixture.binding], environmentUses: [
        { purpose: scope.purpose, serviceRefs: scope.serviceRefs, environmentKey: 'TEST_SELECTED_API_KEY' },
      ], environmentUnsetUses: [
        { purpose: scope.purpose, serviceRefs: scope.serviceRefs, environmentKey: 'TEST_SELECTED_API_KEY' },
      ] },
      processEnv: { CLAUDE_CONFIG_DIR: native },
      accountSettings: { connectedServicesProviderStateSharingSettingsV1: {
        v: 1, defaults: { configMode: 'isolated', stateMode: 'isolated' }, byAgentId: {}, acknowledgedRisksByAgentId: {},
      } },
    });
    expect(result).not.toBeNull();
    if (mode === 'files') {
      expect(result?.unsetEnvKeys).toContain('TEST_SELECTED_API_KEY');
      expect(await readFile(join(result!.env.CLAUDE_CONFIG_DIR!, '.credentials.json'), 'utf8')).toBe('{"token":"selected-B"}');
      expect(result?.env.TEST_SELECTED_API_KEY).toBeUndefined();
    } else {
      expect(result?.unsetEnvKeys ?? []).not.toContain('TEST_SELECTED_API_KEY');
      expect(result?.env.TEST_SELECTED_API_KEY).toBe('selected-key-B');
      expect(result?.env.CLAUDE_CONFIG_DIR).toBeUndefined();
      expect(result?.env.HAPPIER_CLAUDE_NATIVE_CONFIG_DIR).toBeUndefined();
      const descriptor = await runtimeFixture!.registry.contributes.agentDefinitionsById.get('claude')!.catalogEntry
        .getConnectedServiceStateSharingDescriptor!();
      if (!descriptor?.nativeHome) throw new Error('Native-home declaration missing');
      const target = resolveConnectedServiceNativeHomeTargetRoot({ activeServerDir: join(root, 'server'),
        agentId: 'claude', nativeHome: descriptor.nativeHome, target: fixture.binding.target });
      await expect(lstat(target!)).rejects.toMatchObject({ code: 'ENOENT' });
    }
    expect(await readFile(join(native, '.credentials.json'), 'utf8')).toBe('unmanaged-account-A');
  } finally {
    bindingLease?.dispose();
    await result?.cleanupOnExit?.();
    await rm(root, { recursive: true, force: true });
  }
});

it.each([false, true])('refuses a selected Account with no usable leaves (unrelated usable Account=%s)', async withUnrelated => {
  const root = await mkdtemp(join(tmpdir(), 'happier-empty-mode-materialization-'));
  let bindingLease: { dispose(): void } | undefined;
  try {
    const declaration = resolveQualifiedPurposeDeclarationSnapshotForAgentSpawn({
      agentId: 'claude', contributions: runtimeFixture!.registry.contributes,
    })!;
    const scope = declaration.fileMaterializationPurposes[0]!;
    const otherPurpose = { consumer: scope.purpose.consumer, purpose: 'unrelated' };
    const fixture = createForegroundPurposeOwnerFixture({
      consumer: scope.purpose.consumer, service: scope.serviceRefs[0]!, purpose: scope.purpose.purpose,
      materializeAccount: async ({ account, request }) => request.kind === 'environment'
        ? { kind: 'environment', env: account.accountId === 'unrelated-account' ? { TEST_UNRELATED_API_KEY: 'unrelated-key' } : {} }
        : { kind: 'files', files: {} },
    });
    const bindings = [fixture.binding, ...(withUnrelated ? [{ purpose: otherPurpose, target: { kind: 'account' as const,
      account: { service: scope.serviceRefs[0]!, accountId: 'unrelated-account' } } }] : [])];
    await fixture.store.update(() => ({ v: 1, bindings }));
    bindingLease = fixture.owner.activateSessionPurposeBindings({
      sessionId: 'empty-mode', purposes: [...declaration.purposes, ...(withUnrelated ? [otherPurpose] : [])], bindings,
    });
    await expect(materializeConnectedServicesForSpawnProduction({
      agentId: 'claude', materializationKey: 'empty-mode', purposeBindingSessionId: 'empty-mode',
      activeServerDir: join(root, 'server'), baseDir: join(root, 'materialized'), recordsByServiceId: new Map(),
      connectedAccountsOwner: fixture.owner,
      connectedAccountMaterializationAuthority: { kind: 'qualified', purposeBindings: bindings, requestAuthPurposeBindings: [] },
      qualifiedPurposeBindingSnapshot: { ...declaration, bindings,
        purposes: [...declaration.purposes, ...(withUnrelated ? [otherPurpose] : [])], environmentUses: [
          { purpose: scope.purpose, serviceRefs: scope.serviceRefs, environmentKey: 'TEST_SELECTED_API_KEY' },
          ...(withUnrelated ? [{ purpose: otherPurpose, serviceRefs: scope.serviceRefs, environmentKey: 'TEST_UNRELATED_API_KEY' }] : []),
        ] },
      processEnv: { CLAUDE_CONFIG_DIR: join(root, 'native') },
    })).rejects.toThrow();
  } finally {
    bindingLease?.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

it('materializes native configuration from the supplied environment home', async () => {
  const root = await mkdtemp(join(tmpdir(), 'claude-environment-native-home-'));
  const actualOs = await vi.importActual<typeof import('node:os')>('node:os');
  let result: Awaited<ReturnType<typeof materializeConnectedServicesForSpawnProduction>> = null;
  let bindingLease: { dispose(): void } | undefined;
  try {
    const suppliedHome = join(root, 'supplied-home');
    const native = join(suppliedHome, '.claude');
    await mkdir(native, { recursive: true });
    await writeFile(join(native, 'settings.json'), JSON.stringify({ cleanupPeriodDays: 365, theme: 'light' }));
    vi.mocked(homedir).mockReturnValue(join(root, 'platform-home'));
    const declaration = resolveQualifiedPurposeDeclarationSnapshotForAgentSpawn({
      agentId: 'claude', contributions: runtimeFixture!.registry.contributes,
    })!;
    const scope = declaration.fileMaterializationPurposes[0]!;
    const fixture = createForegroundPurposeOwnerFixture({
      consumer: scope.purpose.consumer, service: scope.serviceRefs[0]!, purpose: scope.purpose.purpose,
      materializeAccount: async () => ({ kind: 'files', files: { '.credentials.json': Buffer.from('{"token":"selected"}') } }),
    });
    bindingLease = fixture.owner.activateSessionPurposeBindings({
      sessionId: 'environment-home', purposes: declaration.purposes, bindings: [fixture.binding],
    });
    result = await materializeConnectedServicesForSpawnProduction({
      agentId: 'claude', materializationKey: 'environment-home', purposeBindingSessionId: 'environment-home',
      connectedAccountsOwner: fixture.owner,
      connectedAccountMaterializationAuthority: { kind: 'qualified', purposeBindings: [fixture.binding], requestAuthPurposeBindings: [] },
      qualifiedPurposeBindingSnapshot: { ...declaration, bindings: [fixture.binding] },
      activeServerDir: root, baseDir: join(root, 'materialized'), recordsByServiceId: new Map(),
      processEnv: { HOME: suppliedHome, USERPROFILE: suppliedHome },
      accountSettings: { connectedServicesProviderStateSharingSettingsV1: {
        v: 1, defaults: { configMode: 'copied', stateMode: 'isolated' }, byAgentId: {}, acknowledgedRisksByAgentId: {},
      } },
    });
    expect(result?.env.HAPPIER_CLAUDE_NATIVE_CONFIG_DIR).toBe(native);
    expect(JSON.parse(await readFile(join(result!.env.CLAUDE_CONFIG_DIR!, 'settings.json'), 'utf8')))
      .toEqual({ cleanupPeriodDays: 365, theme: 'light' });
  } finally {
    vi.mocked(homedir).mockImplementation(actualOs.homedir);
    bindingLease?.dispose();
    await result?.cleanupOnExit?.();
    await rm(root, { recursive: true, force: true });
  }
});

it.each(['copied', 'isolated'] as const)('reapplies Agent Account settings after %s native configuration refresh', async configMode => {
  const root = await mkdtemp(join(tmpdir(), 'claude-account-retention-materialize-'));
  const materialized: Awaited<ReturnType<typeof materializeConnectedServicesForSpawnProduction>>[] = [];
  retentionPolicyForTest = { mode: 'days', days: 365 };
  let bindingLease: { dispose(): void } | undefined;
  try {
    const native = join(root, 'native');
    await mkdir(native);
    await writeFile(join(native, 'settings.json'), JSON.stringify({ cleanupPeriodDays: 7, theme: 'dark' }));
    const declaration = resolveQualifiedPurposeDeclarationSnapshotForAgentSpawn({
      agentId: 'claude', contributions: runtimeFixture!.registry.contributes,
    })!;
    const scope = declaration.fileMaterializationPurposes[0]!;
    const fixture = createForegroundPurposeOwnerFixture({
      consumer: scope.purpose.consumer, service: scope.serviceRefs[0]!, purpose: scope.purpose.purpose,
      materializeAccount: async () => ({ kind: 'files', files: { '.credentials.json': Buffer.from('{"token":"selected"}') } }),
    });
    bindingLease = fixture.owner.activateSessionPurposeBindings({
      sessionId: 'retention-profile', purposes: declaration.purposes, bindings: [fixture.binding],
    });
    const refresh = async () => {
      const result = await materializeConnectedServicesForSpawnProduction({
        agentId: 'claude', materializationKey: 'retention-profile', purposeBindingSessionId: 'retention-profile',
        connectedAccountsOwner: fixture.owner,
        connectedAccountMaterializationAuthority: {
          kind: 'qualified', purposeBindings: [fixture.binding], requestAuthPurposeBindings: [],
        },
        qualifiedPurposeBindingSnapshot: { ...declaration, bindings: [fixture.binding] },
        activeServerDir: root, baseDir: join(root, 'materialized'), recordsByServiceId: new Map(),
        processEnv: { CLAUDE_CONFIG_DIR: native },
        accountSettings: { connectedServicesProviderStateSharingSettingsV1: {
          v: 1, defaults: { configMode, stateMode: 'isolated' }, byAgentId: {}, acknowledgedRisksByAgentId: {},
        } },
      });
      materialized.push(result);
      expect(result?.env.CLAUDE_CONFIG_DIR).toBeTruthy();
      return JSON.parse(await readFile(join(result!.env.CLAUDE_CONFIG_DIR!, 'settings.json'), 'utf8'));
    };
    if (configMode === 'isolated') {
      // The Account database is the boundary. Bob's admitted scoped record
      // must win over Alice's daemon record without reaching Alice's home.
      const requester = await materializeConnectedServicesForSpawnProduction({
        agentId: 'claude', materializationKey: 'requester-retention',
        activeServerDir: join(root, 'requester'), baseDir: join(root, 'requester-materialized'),
        recordsByServiceId: new Map(), allowNativeAccountState: false,
        processEnv: { CLAUDE_CONFIG_DIR: native },
        accountPluginSettingsSource: {
          recordAdapter: { bindOperation: async () => ({
            readRecord: async () => ({ status: 'present', revision: 1,
              values: { claudeSessionRetentionV1: { mode: 'days', days: 120 } } }),
            writeRecord: async () => { throw new Error('Requester settings must be read-only'); },
          }) },
          readReleasedAccountSettings: () => null,
        },
      });
      materialized.push(requester);
      expect(JSON.parse(await readFile(join(requester!.env.CLAUDE_CONFIG_DIR!, 'settings.json'), 'utf8')))
        .toMatchObject({ cleanupPeriodDays: 120 });
      expect(JSON.parse(await readFile(join(native, 'settings.json'), 'utf8')))
        .toEqual({ cleanupPeriodDays: 7, theme: 'dark' });
    }
    expect(await refresh()).toMatchObject({ cleanupPeriodDays: 365 });
    await writeFile(join(native, 'settings.json'), JSON.stringify({ cleanupPeriodDays: 14, theme: 'light' }));
    expect(await refresh()).toMatchObject({ cleanupPeriodDays: 365 });
    expect(JSON.parse(await readFile(join(native, 'settings.json'), 'utf8'))).toEqual({ cleanupPeriodDays: 14, theme: 'light' });

  } finally {
    retentionPolicyForTest = null;
    bindingLease?.dispose();
    for (const result of materialized.reverse()) await result?.cleanupOnExit?.();
    await rm(root, { recursive: true, force: true });
  }
});

it.skipIf(process.platform !== 'linux')('persists the admitted Account policy in the actual member home without replacing member settings', async () => {
  const root = await mkdtemp(join(tmpdir(), 'claude-member-retention-'));
  const agentHome = join(root, 'member');
  const runtimeHome = join(agentHome, 'runtime', 'retained-session');
  const memberConfig = join(runtimeHome, 'native-home', 'settings.json');
  let result: Awaited<ReturnType<typeof materializeConnectedServicesForSpawnProduction>> = null;
  try {
    await mkdir(join(runtimeHome, 'native-home'), { recursive: true, mode: 0o700 });
    await writeFile(memberConfig, JSON.stringify({ cleanupPeriodDays: 14, theme: 'member' }), { mode: 0o600 });
    const materializeAndLaunch = async (policy: { mode: 'days'; days: number } | { mode: 'providerDefault' } | null,
      unavailable?: 'plugin' | 'version' | 'agent' | 'build') => {
      result = await materializeConnectedServicesForSpawnProduction({
        agentId: 'claude', materializationKey: 'member-retention',
        activeServerDir: join(root, 'requester'), baseDir: join(root, 'materialized'),
        recordsByServiceId: new Map(), allowNativeAccountState: false, processEnv: {},
        agentLaunchTarget: { runtimeHome },
        accountPluginSettingsSource: {
          recordAdapter: { bindOperation: async () => ({
            readRecord: async () => ({ status: 'present', revision: 1, values: { claudeSessionRetentionV1: policy, undeclaredPrivateValue: 'must-not-cross' } }),
            writeRecord: async () => { throw new Error('Launch must not rewrite Account preferences'); },
          }) },
          readReleasedAccountSettings: () => null,
        },
      });
      const material = result?.agentLaunchMaterials;
      if (!material) throw new Error('Member launch material unavailable');
      const launch = createUnixAgentIdentityLaunch({
        ...material, managedHappierBinaryPath: '/managed/happier', executable: process.execPath,
        args: ['-e', 'process.stdout.write(require("node:fs").readFileSync(process.env.CLAUDE_CONFIG_DIR+"/settings.json","utf8"))'],
        cwd: root, selectedEnvironmentKeys: ['CLAUDE_CONFIG_DIR'],
      });
      let frame = await readAgentLaunchFrame(Readable.from([launch.stdinPreamble], { objectMode: false }));
      const application = frame.accountSettingsApplication;
      expect(application?.account).toEqual({ claudeSessionRetentionV1: policy });
      if (application && unavailable) frame = { ...frame, accountSettingsApplication: { ...application,
        ...(unavailable === 'plugin' ? { pluginId: 'happier.agent.unavailable' } : {}),
        ...(unavailable === 'version' ? { pluginVersion: 'different-version' } : {}),
        ...(unavailable === 'agent' ? { localAgentId: 'different-agent' } : {}),
        ...(unavailable === 'build' ? { cliVersion: 'different-build' } : {}),
      } };
      const stdout = new PassThrough();
      const chunks: Buffer[] = [];
      stdout.on('data', chunk => { chunks.push(Buffer.from(chunk)); });
      expect(await executeAgentLaunchPayload(frame, { agentHome, input: Readable.from([]), stdout, stderr: new PassThrough() }))
        .toEqual({ code: 0, signal: null });
      const observed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      // Retained user configuration survives selected credential cleanup.
      expect(JSON.parse(await readFile(memberConfig, 'utf8'))).toEqual(observed);
      await result?.cleanupOnExit?.();
      result = null;
      return observed;
    };
    expect(await materializeAndLaunch({ mode: 'days', days: 365 })).toEqual({ cleanupPeriodDays: 365, theme: 'member' });
    expect(await materializeAndLaunch(null)).toEqual({ cleanupPeriodDays: 365, theme: 'member' });
    expect(await materializeAndLaunch({ mode: 'providerDefault' })).toEqual({ theme: 'member' });
    for (const unavailable of ['plugin', 'version', 'agent', 'build'] as const) {
      expect(await materializeAndLaunch({ mode: 'days', days: 36500 }, unavailable)).toEqual({ theme: 'member' });
    }
  } finally {
    await result?.cleanupOnExit?.();
    await rm(root, { recursive: true, force: true });
  }
});

it('reapplies the latest Account preference after a delayed materialization completes and excludes foreign scopes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'claude-retention-completion-'));
  const native = join(root, 'native');
  const results: Awaited<ReturnType<typeof materializeConnectedServicesForSpawnProduction>>[] = [];
  let releaseRead = () => {};
  let markReadStarted = () => {};
  const readGate = new Promise<void>(resolve => { releaseRead = resolve; });
  const readStarted = new Promise<void>(resolve => { markReadStarted = resolve; });
  let pending: Promise<Awaited<ReturnType<typeof materializeConnectedServicesForSpawnProduction>>> | undefined;
  let bindingLease: { dispose(): void } | undefined;
  let state: DaemonState = { status: 'running', startedAt: 101 };
  const errors: unknown[] = [];
  const controller = createProviderAccountSettingsController({
    scopeKey: 'completion-account', activeServerDir: root, materializationBaseDir: join(root, 'materialized'),
    processEnv: { CLAUDE_CONFIG_DIR: native },
    apiMachine: { updateDaemonState: async updater => {
      state = updater(state);
      return 'published';
    } },
    onError: error => { errors.push(error); },
  });
  const source = (days: number, delayed = false): NonNullable<MaterializeParams['accountPluginSettingsSource']> => ({
    recordAdapter: { bindOperation: async () => ({
      readRecord: async () => {
        // Delay only the Account database response; all admitted settings,
        // home materialization, editor and publication logic remain real.
        if (delayed) { markReadStarted(); await readGate; }
        return { status: 'present', revision: 1, values: { claudeSessionRetentionV1: { mode: 'days', days } } };
      },
      writeRecord: async () => { throw new Error('Materialization must not rewrite Account preferences'); },
    }) },
    readReleasedAccountSettings: () => null,
  });
  try {
    await mkdir(native);
    await writeFile(join(native, 'settings.json'), '{"cleanupPeriodDays":7}');
    const declaration = resolveQualifiedPurposeDeclarationSnapshotForAgentSpawn({
      agentId: 'claude', contributions: runtimeFixture!.registry.contributes,
    })!;
    const scope = declaration.fileMaterializationPurposes[0]!;
    const fixture = createForegroundPurposeOwnerFixture({
      consumer: scope.purpose.consumer, service: scope.serviceRefs[0]!, purpose: scope.purpose.purpose,
      materializeAccount: async () => ({ kind: 'files', files: { '.credentials.json': Buffer.from('{"token":"selected"}') } }),
    });
    bindingLease = fixture.owner.activateSessionPurposeBindings({
      sessionId: 'completion-profile', purposes: declaration.purposes, bindings: [fixture.binding],
    });
    const materialize = (activeServerDir: string, accountPluginSettingsSource: NonNullable<MaterializeParams['accountPluginSettingsSource']>) =>
      materializeConnectedServicesForSpawnProduction({
        agentId: 'claude', materializationKey: 'completion-profile', purposeBindingSessionId: 'completion-profile',
        connectedAccountsOwner: fixture.owner,
        connectedAccountMaterializationAuthority: { kind: 'qualified', purposeBindings: [fixture.binding], requestAuthPurposeBindings: [] },
        qualifiedPurposeBindingSnapshot: { ...declaration, bindings: [fixture.binding] },
        activeServerDir, baseDir: join(activeServerDir, 'materialized'), recordsByServiceId: new Map(),
        processEnv: { CLAUDE_CONFIG_DIR: native }, accountPluginSettingsSource,
        accountSettings: { connectedServicesProviderStateSharingSettingsV1: {
          v: 1, defaults: { configMode: 'isolated', stateMode: 'isolated' }, byAgentId: {}, acknowledgedRisksByAgentId: {},
        } },
      });
    retentionPolicyForTest = { mode: 'days', days: 365 };
    setActiveAccountSettingsSnapshot({ source: 'network', scopeKey: 'completion-account',
      settings: AccountSettingsSchema.parse({}), rawSettings: {}, settingsVersion: 1, loadedAtMs: 1, settingsSecretsReadKeys: [] });
    await controller.refresh();
    pending = materialize(root, source(365, true));
    await readStarted;
    retentionPolicyForTest = { mode: 'days', days: 36500 };
    await controller.refresh();
    releaseRead();
    const completed = await pending;
    results.push(completed);
    expect(JSON.parse(await readFile(join(completed!.env.CLAUDE_CONFIG_DIR!, 'settings.json'), 'utf8')).cleanupPeriodDays).toBe(36500);
    await writeFile(join(native, 'settings.json'), '{"cleanupPeriodDays":14}');
    const foreign = await materialize(join(root, 'foreign-account'), source(120));
    results.push(foreign);
    expect(JSON.parse(await readFile(join(foreign!.env.CLAUDE_CONFIG_DIR!, 'settings.json'), 'utf8')).cleanupPeriodDays).toBe(120);
    expect(JSON.parse(await readFile(join(native, 'settings.json'), 'utf8')).cleanupPeriodDays).toBe(14);
    expect(errors).toEqual([]);
  } finally {
    releaseRead();
    if (pending) await pending.catch(() => null);
    await controller.stop();
    resetActiveAccountSettingsSnapshotForTests();
    retentionPolicyForTest = null;
    bindingLease?.dispose();
    for (const result of results.reverse()) await result?.cleanupOnExit?.();
    await rm(root, { recursive: true, force: true });
  }
});

it('prepares an isolated requester Agent home without a Connected Account for Provider or API-key authentication', async () => {
  const baseDir = await mkdtemp(join(tmpdir(), 'requester-native-only-'));
  try {
    const aliceHome = join(baseDir, 'alice-native');
    await mkdir(aliceHome);
    await writeFile(join(aliceHome, 'auth.json'), JSON.stringify({ access_token: 'alice-login' }));
    let requesterVerifications = 0;
    const materialized = await materializeConnectedServicesForSpawnProduction({
      agentId: 'codex', materializationKey: 'bob-session', activeServerDir: baseDir,
      baseDir: join(baseDir, 'bob-materialized'), recordsByServiceId: new Map(), allowNativeAccountState: false,
      processEnv: { CODEX_HOME: aliceHome }, isAccountRuntimeCurrent: async () => {
        requesterVerifications++;
        return true;
      },
    });
    expect(materialized?.env.CODEX_HOME).toBe(materialized?.targetMaterializedRoot);
    expect(materialized?.env.CODEX_HOME).toBeTruthy();
    expect(materialized?.sessionConnectedAccounts).toBeUndefined();
    expect(existsSync(join(materialized!.env.CODEX_HOME!, 'auth.json'))).toBe(false);
    expect(await readFile(join(aliceHome, 'auth.json'), 'utf8')).toContain('alice-login');
    // Staging, native-home preparation, native credential publication (empty
    // here) and final publication each retain fresh entry/exit authority.
    // Final root preparation and promotion are one dependent filesystem effect.
    expect(requesterVerifications).toBe(8);
    await materialized?.cleanupOnExit?.();
  } finally { await rm(baseDir, { recursive: true, force: true }); }
});

it('publishes the selected member native home when a Provider needs no native credential file', async () => {
  const agentHome = await mkdtemp(join(tmpdir(), 'member-provider-home-'));
  let materialized: Awaited<ReturnType<typeof materializeConnectedServicesForSpawnProduction>> = null;
  try {
    materialized = await materializeConnectedServicesForSpawnProduction({
      agentId: 'codex', materializationKey: 'provider-only', activeServerDir: agentHome,
      baseDir: join(agentHome, 'daemon-staging'), recordsByServiceId: new Map(), allowNativeAccountState: false,
      processEnv: {}, agentLaunchTarget: { runtimeHome: join(agentHome, 'session', 'codex') },
      isAccountRuntimeCurrent: async () => true,
    });
    const material = materialized?.agentLaunchMaterials;
    expect(material).toBeDefined();
    if (!material) throw new Error('Expected member material');
    expect(material.selectedMaterials).toEqual([]);
    await publishAgentLaunchMaterials({ v: 1, executable: process.execPath, args: [], cwd: agentHome, ...material }, agentHome);
    const nativeHome = await lstat(material.environment.CODEX_HOME!);
    expect(nativeHome.isDirectory()).toBe(true);
    if (process.platform !== 'win32') expect(nativeHome.mode & 0o777).toBe(0o700);
  } finally {
    await materialized?.cleanupOnExit?.();
    await rm(agentHome, { recursive: true, force: true });
  }
});

it.each([
  ['revocation', 'native_home_state'], ['cancellation', 'native_home_state'],
  ['revocation', 'materialization_root_finalize'], ['cancellation', 'materialization_root_finalize'],
] as const)('refuses native-home publication after %s during %s', async (failure, phase) => {
  const baseDir = await mkdtemp(join(tmpdir(), 'requester-native-preparation-'));
  const materializationKey = 'refused-native-preparation';
  const materializedBase = join(baseDir, 'materialized');
  const rootDir = resolveConnectedServiceMaterializedRootDir({
    baseDir: materializedBase, agentId: 'codex', materializationKey,
  });
  let current = true;
  let interrupted = false;
  const cancellation = new AbortController();
  const originalLog = logger.infoFile.bind(logger);
  // File logging is the system boundary: retire authority after real native
  // state preparation, keeping the filesystem and materializer owners real.
  const log = vi.spyOn(logger, 'infoFile').mockImplementation((message, fields) => {
    originalLog(message, fields);
    if (message === '[CONNECTED ACCOUNT] Materialization phase'
      && isMaterializationPhase(fields, materializationKey, phase, 'completed')) {
      interrupted = true;
      if (failure === 'revocation') current = false;
      else cancellation.abort(new Error('fixture_materialization_cancelled'));
    }
  });
  try {
    await expect(materializeConnectedServicesForSpawnProduction({
      agentId: 'codex', materializationKey, activeServerDir: baseDir,
      baseDir: materializedBase, recordsByServiceId: new Map(), allowNativeAccountState: false,
      signal: cancellation.signal, isAccountRuntimeCurrent: async () => current,
    })).rejects.toThrow(failure === 'revocation'
      ? 'requester_account_context_unavailable' : 'fixture_materialization_cancelled');
    expect(interrupted).toBe(true);
    expect(existsSync(rootDir)).toBe(false);
  } finally {
    log.mockRestore();
    await rm(baseDir, { recursive: true, force: true });
  }
});

beforeAll(async () => {
  const agentIds = ['claude', 'codex', 'gemini', 'opencode', 'pi', 'antigravity', 'fx'] as const;
  const pluginIds = [...agentIds.map(localId => `happier.agent.${localId}`), 'happier.voice.openai'];
  const bundled = loadEnabledBundledPluginLocatorResult({ pluginIds });
  const projected = projectLoadedPluginContributes({
    loadResult: {
      loadedPlugins: bundled.loadedPlugins,
      diagnosticsByPluginId: Object.fromEntries(bundled.pluginFailures.map(failure => [failure.pluginId, [failure.diagnostic]])),
    },
    provenance: 'first_party',
    admittedGraph: bundled.admittedGraph,
  });
  const contributes = createResolvedContributionRegistry({
    ...projected,
    // These scenarios materialize already-resolved launches; dependency installation is outside this fixture.
    managedDependencies: [],
    agents: projectBuiltInAgents({
      manifestAgents: projected.agents ?? [],
      registrationBindings: BUNDLED_FIRST_PARTY_AGENT_REGISTRATION_BINDINGS,
    }),
  });
  runtimeFixture = await createAdmittedPluginRuntimeFixture({
    controller: pluginReloadController,
    runtimeOptions: {
      contributes,
      // The Account database is the only substituted boundary; Agent admission,
      // scoped settings validation, descriptor copies and the native editor stay real.
      accountSettingsRecordAdapter: {
        bindOperation: async () => ({
          readRecord: async model => ({ status: 'present', revision: 1,
            values: model.identity.pluginId === 'happier.agent.claude' && retentionPolicyForTest
              ? { claudeSessionRetentionV1: retentionPolicyForTest } : {} }),
          writeRecord: async () => { throw new Error('Materialization must not write Account preferences'); },
        }),
      },
      pluginIds,
    },
  });
});

afterAll(async () => {
  await runtimeFixture?.dispose();
  runtimeFixture = null;
});

async function materializeConnectedServicesForSpawn(
  params: MaterializeParams,
): ReturnType<typeof materializeConnectedServicesForSpawnProduction> {
  const declarationSnapshot =
    resolveQualifiedPurposeDeclarationSnapshotForAgentSpawn({
      agentId: params.agentId,
      contributions: runtimeFixture!.registry.contributes,
    });
  if (!declarationSnapshot) {
    throw new Error(`Missing Connected Account declaration snapshot for ${params.agentId}`);
  }
  const bindings = declarationSnapshot.authorizedPurposes.flatMap((scope) => {
    const service = scope.serviceRefs[0];
    if (!service) return [];
    const serviceId =
      resolveFirstPartyLegacyAgentConnectedAccountServiceId(service);
    if (!serviceId) return [];
    const record = params.recordsByServiceId.get(serviceId);
    if (!record) return [];
    const selection = params.selectionsByServiceId?.get(serviceId);
    return [{
      purpose: scope.purpose,
      target: selection?.kind === 'group'
        ? {
            kind: 'group' as const,
            service,
            groupId: selection.groupId,
          }
        : {
            kind: 'account' as const,
            account: { service, accountId: record.profileId },
          },
    }];
  });
  return await materializeConnectedServicesForSpawnProduction({
    ...params,
    connectedAccountMaterializationAuthority:
      LEGACY_UNFENCED_ONE_SHOT_MATERIALIZATION_AUTHORITY,
    qualifiedPurposeBindingSnapshot: {
      ...declarationSnapshot,
      bindings,
    },
  });
}

const LEGACY_UNFENCED_ONE_SHOT_MATERIALIZATION_AUTHORITY = {
  kind: 'legacy_unfenced_one_shot',
} as const satisfies MaterializeParams['connectedAccountMaterializationAuthority'];

describe('materializeConnectedServicesForSpawn', () => {
  it.each(['shared', 'isolated'] as const)('retains FX native v2 writes through %s home rematerialization', async stateMode => {
    // Read-only nl1 observation: .fx/sessions/v2/<id>/{log.jsonl,blobs},
    // while the native source ~/.fx/sessions is empty after the replay.
    const root = await mkdtemp(join(tmpdir(), 'happier-fx-retained-native-'));
    const results: Awaited<ReturnType<typeof materializeConnectedServicesForSpawnProduction>>[] = [];
    try {
      const native = join(root, 'native');
      await mkdir(native);
      const record = buildConnectedServiceCredentialRecord({
        now: Date.now(), serviceId: 'openai-codex', profileId: 'fx-connected', kind: 'oauth', expiresAt: Date.now() + 3600_000,
        oauth: { accessToken: 'fixture-access', refreshToken: 'fixture-refresh', idToken: null,
          scope: null, tokenType: null, providerAccountId: 'fixture-account', providerEmail: null },
      });
      const params: MaterializeParams = {
        agentId: 'fx', materializationKey: 'fx-connected-session', activeServerDir: join(root, 'server'),
        baseDir: join(root, 'materialized'), recordsByServiceId: new Map([['openai-codex', record]]),
        processEnv: { HOME: native }, accountSettings: { connectedServicesProviderStateSharingSettingsV1: {
          v: 1, defaults: { configMode: 'isolated', stateMode }, byAgentId: {}, acknowledgedRisksByAgentId: {},
        } },
      };
      const first = await materializeConnectedServicesForSpawn(params);
      results.push(first);
      const home = first!.env.HOME!;
      const session = join(home, '.fx/sessions/v2/VlwVgOggC_xR');
      await mkdir(join(session, 'blobs'), { recursive: true });
      await writeFile(join(session, 'log.jsonl'), 'native journal after first turn');
      await writeFile(join(session, 'blobs', 'snapshot'), 'native blob');
      await writeFile(join(home, '.fx/sessions/v2/index.jsonl'), 'native index');
      await first!.cleanupOnExit?.();
      const second = await materializeConnectedServicesForSpawn({ ...params, vendorResumeId: 'VlwVgOggC_xR' });
      results.push(second);
      expect(second!.env.HOME).toBe(home);
      expect(await readFile(join(session, 'log.jsonl'), 'utf8')).toBe('native journal after first turn');
      expect(await readFile(join(session, 'blobs', 'snapshot'), 'utf8')).toBe('native blob');
      expect(await readFile(join(home, '.fx/sessions/v2/index.jsonl'), 'utf8')).toBe('native index');
      expect((await lstat(join(home, '.fx/sessions'))).isSymbolicLink()).toBe(false);
      expect(await verifyResumeReachableThroughCatalog('fx', { targetMaterializedRoot: home, vendorResumeId: 'VlwVgOggC_xR' }))
        .toMatchObject({ ok: true });
      expect(existsSync(join(native, '.fx/sessions/v2/VlwVgOggC_xR'))).toBe(false);
    } finally {
      for (const result of results.reverse()) await result?.cleanupOnExit?.();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('retains Antigravity companion state while detaching a shared account home', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-antigravity-retained-companions-'));
    const results: Awaited<ReturnType<typeof materializeConnectedServicesForSpawnProduction>>[] = [];
    let bindingLease: { dispose(): void } | undefined;
    try {
      const id = 'retained-conversation';
      const nativeHome = join(root, 'native');
      const conversations = join(nativeHome, 'antigravity-acp', 'conversations');
      const brain = join(nativeHome, 'antigravity-acp', 'brain');
      await mkdir(conversations, { recursive: true });
      await mkdir(brain, { recursive: true });
      for (const session of [id, 'unrelated-conversation']) {
        await writeFile(join(conversations, `${session}.db`), `${session} trajectory`);
        await writeFile(join(conversations, `${session}.meta`), JSON.stringify({ id: session }));
        await mkdir(join(brain, session));
        await writeFile(join(brain, session, 'task.md'), `${session} task`);
      }
      const declaration = resolveQualifiedPurposeDeclarationSnapshotForAgentSpawn({
        agentId: 'antigravity', contributions: runtimeFixture!.registry.contributes,
      })!;
      const scope = declaration.fileMaterializationPurposes[0]!;
      const fixture = createForegroundPurposeOwnerFixture({
        consumer: scope.purpose.consumer, service: scope.serviceRefs[0]!, purpose: scope.purpose.purpose,
        accountId: 'retained-profile',
        materializeAccount: async ({ request }) => {
          if (request.kind === 'environment') return { kind: 'environment', env: { AGY_ACP_FORCE_FILE_STORAGE: '1' } };
          if (request.kind === 'files') return { kind: 'files', files: {
            'antigravity-acp/acp_token.json': Buffer.from('{"access_token":"fixture-access"}'),
          } };
          throw new Error('Unexpected Antigravity materialization request');
        },
      });
      bindingLease = fixture.owner.activateSessionPurposeBindings({
        sessionId: 'retained-companions', purposes: declaration.purposes, bindings: [fixture.binding],
      });
      const prepare = async (stateMode: 'shared' | 'isolated') => {
        const result = await materializeConnectedServicesForSpawnProduction({
          agentId: 'antigravity', materializationKey: 'retained-companions', vendorResumeId: id,
          purposeBindingSessionId: 'retained-companions', connectedAccountsOwner: fixture.owner,
          connectedAccountMaterializationAuthority: {
            kind: 'qualified', purposeBindings: [fixture.binding], requestAuthPurposeBindings: [],
          },
          qualifiedPurposeBindingSnapshot: { ...declaration, bindings: [fixture.binding] },
          activeServerDir: join(root, 'server'), baseDir: join(root, 'materialized'),
          recordsByServiceId: new Map(), processEnv: { GEMINI_HOME: nativeHome },
          accountSettings: { connectedServicesProviderStateSharingSettingsV1: {
            v: 1, defaults: { configMode: 'isolated', stateMode }, byAgentId: {}, acknowledgedRisksByAgentId: {},
          } },
        });
        results.push(result);
        if (!result?.env.GEMINI_HOME) throw new Error('Antigravity native home unavailable');
        return result.env.GEMINI_HOME;
      };
      const home = await prepare('shared');
      expect((await lstat(join(home, 'antigravity-acp', 'conversations'))).isSymbolicLink()).toBe(true);
      await results[0]?.cleanupOnExit?.();
      expect(await prepare('isolated')).toBe(home);
      expect((await lstat(join(home, 'antigravity-acp', 'conversations'))).isSymbolicLink()).toBe(false);
      expect(await readFile(join(home, 'antigravity-acp', 'conversations', `${id}.db`), 'utf8')).toBe(`${id} trajectory`);
      expect(JSON.parse(await readFile(join(home, 'antigravity-acp', 'conversations', `${id}.meta`), 'utf8'))).toEqual({ id });
      expect(await readFile(join(home, 'antigravity-acp', 'brain', id, 'task.md'), 'utf8')).toBe(`${id} task`);
      expect(existsSync(join(home, 'antigravity-acp', 'conversations', 'unrelated-conversation.db'))).toBe(false);
      expect(existsSync(join(home, 'antigravity-acp', 'brain', 'unrelated-conversation'))).toBe(false);
      expect(await verifyResumeReachableThroughCatalog('antigravity', { targetMaterializedRoot: home, vendorResumeId: id }))
        .toMatchObject({ ok: true, resolvedPath: join(home, 'antigravity-acp', 'conversations', `${id}.db`) });
    } finally {
      bindingLease?.dispose();
      for (const result of results.reverse()) await result?.cleanupOnExit?.();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('preserves the live OpenCode request-auth capability through credential rematerialization', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-opencode-request-auth-rematerialization-'));
    const declaration = resolveQualifiedPurposeDeclarationSnapshotForAgentSpawn({
      agentId: 'opencode', contributions: runtimeFixture!.registry.contributes,
    })!;
    const use = declaration.requestAuthUses![0]!;
    const scope = declaration.authorizedPurposes.find(candidate => candidate.purpose.purpose === use.purpose.purpose)!;
    const fixture = createForegroundPurposeOwnerFixture({
      consumer: use.purpose.consumer, purpose: use.purpose.purpose, service: scope.serviceRefs[0]!,
      materializeAccount: async () => { throw new Error('Request auth must not materialize OAuth credential bytes'); },
    });
    const sessionId = 'live-opencode-request-auth';
    const lease = fixture.owner.activateSessionPurposeBindings({
      sessionId, purposes: declaration.purposes, bindings: [fixture.binding],
    });
    try {
      const params: MaterializeParams = {
        agentId: 'opencode', materializationKey: sessionId, purposeBindingSessionId: sessionId,
        activeServerDir: join(root, 'server'), baseDir: join(root, 'materialized'),
        recordsByServiceId: new Map(), connectedAccountsOwner: fixture.owner, processEnv: {},
        connectedAccountMaterializationAuthority: {
          kind: 'qualified', purposeBindings: [fixture.binding], requestAuthPurposeBindings: [fixture.binding],
        },
        qualifiedPurposeBindingSnapshot: { ...declaration, bindings: [fixture.binding] },
      };
      const first = await materializeConnectedServicesForSpawnProduction(params);
      const materializedRootDir = first!.requestAuthMaterializedRoot!;
      const descriptor = await writeConnectedAccountRequestAuthCapabilityFile({
        rootDir: materializedRootDir, materializationId: sessionId,
        subjectScopeDigest: 'a'.repeat(64), httpPort: 43123,
      });
      const refreshed = await materializeConnectedServicesForSpawnProduction(params);
      expect(refreshed!.env.HAPPIER_CONNECTED_ACCOUNT_REQUEST_AUTH_CAPABILITY_PATH).toBe(descriptor.path);
      await expect(verifyConnectedAccountRequestAuthCapabilityFile({
        ...descriptor, materializedRootDir,
      })).resolves.toEqual(descriptor);
      await refreshed!.cleanupOnExit!();
      await expect(lstat(descriptor.path)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      lease.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each([
    { agentId: 'claude', environmentKey: 'CLAUDE_CONFIG_DIR', nativeFile: '.credentials.json', failsAccountSettingsRead: false },
    { agentId: 'claude', environmentKey: 'CLAUDE_CONFIG_DIR', nativeFile: '.credentials.json', failsAccountSettingsRead: true },
    { agentId: 'codex', environmentKey: 'CODEX_HOME', nativeFile: 'auth.json', failsAccountSettingsRead: false },
  ] as const)('projects selected $agentId native-home and file-environment bytes without optional Account settings (failed read: $failsAccountSettingsRead)', async ({
    agentId, environmentKey, nativeFile, failsAccountSettingsRead,
  }) => {
    const root = await mkdtemp(join(tmpdir(), 'happier-agent-selected-frame-'));
    let result: Awaited<ReturnType<typeof materializeConnectedServicesForSpawnProduction>> = null;
    let bindingLease: { dispose(): void } | undefined;
    try {
      const declaration = resolveQualifiedPurposeDeclarationSnapshotForAgentSpawn({
        agentId, contributions: runtimeFixture!.registry.contributes,
      })!;
      const scope = declaration.fileMaterializationPurposes[0]!;
      const selectedNative = Buffer.from('{"selected":"native-home"}');
      const selectedFile = Buffer.from([0, 255, 10, 128]);
      const fileId = 'selected-file-environment';
      const selectedEnvironmentKey = 'HAPPIER_TEST_SELECTED_ACCESS_TOKEN';
      const fixture = createForegroundPurposeOwnerFixture({
        consumer: scope.purpose.consumer, service: scope.serviceRefs[0]!,
        purpose: scope.purpose.purpose,
        // Genuine credential boundary; selection/currentness and both materializers stay real.
        materializeAccount: async ({ request }) => {
          if (request.kind === 'environment') return { kind: 'environment', env: {
            [selectedEnvironmentKey]: 'selected-access-token',
            HAPPIER_TEST_UNDECLARED_ACCESS_TOKEN: 'unselected-access-token',
          } };
          if (request.kind !== 'files') throw new Error('Unexpected selected Account materialization request');
          return { kind: 'files', files: Object.fromEntries((request.fileIds ?? [nativeFile])
            .filter(id => id === fileId || id === nativeFile).map(id => [
            id, id === fileId ? selectedFile : selectedNative,
          ])) };
        },
      });
      const sessionId = `selected-frame-${agentId}`;
      bindingLease = fixture.owner.activateSessionPurposeBindings({
        sessionId, purposes: declaration.purposes, bindings: [fixture.binding],
      });
      const daemonHome = join(root, 'daemon-private');
      await mkdir(daemonHome);
      await writeFile(join(daemonHome, 'unselected-sentinel'), 'never-selected');
      await writeFile(join(daemonHome, 'settings.json'), JSON.stringify({ cleanupPeriodDays: 365 }));
      // Prospective owner-local port: S0 supplies this only after launch admission.
      // Its existing frame/publisher owns publication, refresh and lease cleanup.
      const agentLaunchTarget: Pick<AgentLaunchPayload, 'runtimeHome'> = {
        runtimeHome: join(root, 'agent-home', 'runtime', sessionId),
      };
      const params = {
        agentId, materializationKey: sessionId, purposeBindingSessionId: sessionId,
        activeServerDir: daemonHome, baseDir: join(daemonHome, 'materialized'),
        recordsByServiceId: new Map(), connectedAccountsOwner: fixture.owner,
        connectedAccountMaterializationAuthority: {
          kind: 'qualified' as const, purposeBindings: [fixture.binding], requestAuthPurposeBindings: [],
        },
        qualifiedPurposeBindingSnapshot: {
          ...declaration, bindings: [fixture.binding],
          environmentUses: [{
            purpose: scope.purpose, serviceRefs: scope.serviceRefs,
            environmentKey: selectedEnvironmentKey,
          }],
          fileEnvironmentUses: [{
            purpose: scope.purpose, serviceRefs: scope.serviceRefs, fileId,
            environmentKey: 'SELECTED_AUTH_FILE',
          }],
        },
        allowNativeAccountState: false,
        ...(failsAccountSettingsRead ? { accountPluginSettingsSource: {
          // Account storage is a boundary; a failed optional read must neither
          // deny launch nor substitute the daemon Account's 365-day policy.
          recordAdapter: { bindOperation: async () => ({
            readRecord: async () => { throw new Error('Account storage unavailable'); },
            writeRecord: async () => { throw new Error('Launch materialization is read-only'); },
          }) },
          readReleasedAccountSettings: () => null,
        } } : {}),
        processEnv: { [environmentKey]: daemonHome, HAPPIER_HOME_DIR: daemonHome,
          HAPPIER_DAEMON_TOKEN: 'unselected-daemon-sentinel' },
        agentLaunchTarget,
      };
      result = await materializeConnectedServicesForSpawnProduction(params);
      expect(result).toMatchObject({
        agentLaunchMaterials: {
          runtimeHome: agentLaunchTarget.runtimeHome,
          environment: {
            [environmentKey]: join(agentLaunchTarget.runtimeHome, 'native-home'),
            SELECTED_AUTH_FILE: join(agentLaunchTarget.runtimeHome, 'files', '0'),
            [selectedEnvironmentKey]: 'selected-access-token',
          },
          selectedMaterials: expect.arrayContaining([
            { relativePath: `native-home/${nativeFile}`, contentBase64: selectedNative.toString('base64') },
            { relativePath: 'files/0', contentBase64: selectedFile.toString('base64') },
          ]),
        },
      });
      expect(JSON.stringify(result?.agentLaunchMaterials?.environment)).not.toContain(daemonHome);
      expect(result?.agentLaunchMaterials?.environment).not.toHaveProperty('HAPPIER_HOME_DIR');
      expect(result?.agentLaunchMaterials?.environment).not.toHaveProperty('HAPPIER_DAEMON_TOKEN');
      expect(result?.agentLaunchMaterials?.environment).not.toHaveProperty('HAPPIER_TEST_UNDECLARED_ACCESS_TOKEN');
      expect(JSON.stringify(result)).not.toContain('never-selected');
      expect(JSON.parse(await readFile(join(daemonHome, 'settings.json'), 'utf8'))).toEqual({ cleanupPeriodDays: 365 });
      const selectedHome = result?.env[environmentKey];
      if (!selectedHome) throw new Error('Selected materialized home unavailable');
      await expect(readFile(join(selectedHome, 'settings.json'))).rejects.toMatchObject({ code: 'ENOENT' });
      expect(result?.agentLaunchMaterials?.selectedMaterials).not.toContainEqual(expect.objectContaining({ relativePath: 'native-home/settings.json' }));
      // The host projects bytes; only the existing Agent shim may publish at this destination.
      expect(existsSync(agentLaunchTarget.runtimeHome)).toBe(false);
      if (process.platform === 'linux') {
        const material = result?.agentLaunchMaterials;
        if (!material) throw new Error('The actual materializer must produce the selected launch bytes');
        const registry = new ConnectedServiceRuntimeRegistry();
        registry.registerTarget({ pid: process.pid, sessionId, agentId, materializationKey: sessionId, agentLaunchMaterials: material });
        const transport = await prepareSessionMcpLocalTransport({ agentUid: process.getuid!() });
        // The OS identity's home exists before launch; the shim still owns its runtime child.
        await mkdir(join(root, 'agent-home'), { recursive: true });
        // OS identity is a boundary. This source test does not claim cross-UID
        // socket access, sudo readiness or a loaded native effective observation.
        const identity = vi.spyOn(nativeProcess, 'execFileWithDeadline').mockResolvedValue({
          stdout: `happier-agent:x:${process.getuid!() + 1}:1001::${join(root, 'agent-home')}:/usr/sbin/nologin\n`, stderr: '',
        });
        try {
          const context = createAgentIsolationSessionContext({
            machine: { read: () => ({ enabled: true,
              status: { kind: 'effective', platform: 'linux', agentUser: 'happier-agent' }, workspaceRoots: [root] }) },
            managedHappierBinaryPath: '/opt/happier/cli/current/happier',
            sessionRequester: { serverId: 'home', accountId: 'owner', machineId: 'machine', installationId: 'installation' },
            sessionRequesterHomeServerIdentityId: 'home', sessionCustodianAccountId: 'owner', hostHomeServerIdentityId: 'home',
            providerEnvironmentKeys: params.qualifiedPurposeBindingSnapshot.environmentUses.map(use => use.environmentKey),
            readMaterial: () => registry.getBySessionId(sessionId)?.agentLaunchMaterials,
          });
          const prepared = await context.prepareLaunch!({ requesterIdentity: context.requesterIdentity, sessionMcpContext: transport.localContext });
          const launch = await authorizeResolvedProjectExecLaunchForHost({
            launch: { command: '/agent', args: ['--stdio'], cwd: root, env: { HAPPIER_DAEMON_TOKEN: 'custodian-sentinel' } },
            agentIsolation: prepared, agentNativeLaunch: true, signal: new AbortController().signal, assertCurrent() {},
          });
          try {
            const payload = await readAgentLaunchFrame(Readable.from([Buffer.from(launch.stdinPreamble!)], { objectMode: false }));
            expect(payload.runtimeHome).toBe(material.runtimeHome);
            expect(payload.environment).toMatchObject(material.environment);
            expect(payload.selectedMaterials).toEqual(expect.arrayContaining([...material.selectedMaterials]));
            expect(JSON.stringify(payload)).not.toContain('custodian-sentinel');
            registry.unregisterPid(process.pid);
            await expect(authorizeResolvedProjectExecLaunchForHost({
              launch: { command: '/agent', args: [], cwd: root, env: {} }, agentIsolation: prepared,
              agentNativeLaunch: true, signal: new AbortController().signal, assertCurrent() {},
            })).rejects.toMatchObject({ code: 'agent_isolation_unavailable' });
          } finally { await launch.release(); }
        } finally { identity.mockRestore(); await transport.retire(); }
      }
    } finally {
      await result?.cleanupOnExit?.();
      bindingLease?.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('does not project a selected account without a materialized credential use', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-unmaterialized-account-'));
    const declaration = resolveQualifiedPurposeDeclarationSnapshotForAgentSpawn({
      agentId: 'codex', contributions: runtimeFixture!.registry.contributes,
    })!;
    const scope = declaration.fileMaterializationPurposes[0]!;
    const binding = { purpose: scope.purpose, target: { kind: 'account' as const,
      account: { service: scope.serviceRefs[0]!, accountId: 'selected-but-unused' } } };
    const unexpected = async (): Promise<never> => { throw new Error('Unused credential must not be materialized'); };
    const owner = createConnectedAccountPurposeBindingOwner({
      store: { read: unexpected, update: unexpected, subscribe: () => ({ dispose() {} }) },
      selectTarget: unexpected, resolveTarget: unexpected, projectTargetAccounts: unexpected,
      assertTargetAccountMaterializable: unexpected, materializeAccount: unexpected,
    });
    const lease = owner.activateSessionPurposeBindings({ sessionId: 'unused-account', purposes: declaration.purposes, bindings: [binding] });
    let result: Awaited<ReturnType<typeof materializeConnectedServicesForSpawnProduction>> = null;
    try {
      result = await materializeConnectedServicesForSpawnProduction({
        agentId: 'codex', materializationKey: 'unused-account', purposeBindingSessionId: 'unused-account',
        activeServerDir: join(root, 'server'), baseDir: join(root, 'materialized'), recordsByServiceId: new Map(),
        connectedAccountsOwner: owner, processEnv: { CODEX_HOME: join(root, 'native') },
        connectedAccountMaterializationAuthority: { kind: 'qualified', purposeBindings: [binding], requestAuthPurposeBindings: [] },
        qualifiedPurposeBindingSnapshot: { ...declaration, bindings: [binding], fileMaterializationPurposes: [],
          environmentUses: [], fileEnvironmentUses: [] },
      });
      expect(result).not.toBeNull();
      expect(result?.sessionConnectedAccounts).toBeUndefined();
    } finally {
      await result?.cleanupOnExit?.();
      lease.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each([false, true])('shares native Codex SQLite across pool homes while isolating credentials (explicit SQLite root: %s)', async explicitSqliteRoot => {
    const root = await mkdtemp(join(tmpdir(), 'happier-codex-shared-sqlite-'));
    const materialized: Array<NonNullable<Awaited<ReturnType<typeof materializeConnectedServicesForSpawn>>>> = [];
    const leases: Array<{ dispose(): void }> = [];
    try {
      const descriptor = await resolveRunnerAgentSessionDescriptorForLease({
        target: { kind: 'backend', backendId: 'codex' }, lease: runtimeFixture!.lease,
      });
      if (!descriptor) throw new Error('Admitted Codex runner descriptor unavailable');
      const nativeHome = join(root, 'native');
      const sqliteHome = explicitSqliteRoot ? join(root, 'native-sqlite') : nativeHome;
      const sourceEnvironment = { CODEX_HOME: nativeHome, ...(explicitSqliteRoot ? { CODEX_SQLITE_HOME: 'native-sqlite' } : {}) };
      const reopen = async (codexHome: string) => await resolveCodexRuntimeHomeEnvironment({
        env: sourceEnvironment, codexHome, cwd: root, expandHomePath: path => path,
      });
      await mkdir(sqliteHome, { recursive: true });
      for (const entry of ['sessions', 'archived_sessions']) {
        await mkdir(join(nativeHome, entry), { recursive: true });
        await writeFile(join(nativeHome, entry, 'rollout.jsonl'), `${entry}-history`);
      }
      await writeFile(join(nativeHome, 'auth.json'), 'native-account-credential');
      const databases = ['state_5.sqlite', 'logs_2.sqlite', 'queue_1.sqlite'];
      for (const database of databases) {
        for (const suffix of ['', '-wal', '-shm']) await writeFile(join(sqliteHome, `${database}${suffix}`), 'native-db');
      }
      const launch = async (pool: string, stateMode: 'shared' | 'isolated', probePurpose?: 'probe') => {
        const record = buildConnectedServiceCredentialRecord({
          now: 10, serviceId: 'openai-codex', profileId: pool, kind: 'oauth', expiresAt: null,
          oauth: { accessToken: `access-${pool}`, refreshToken: `refresh-${pool}`, idToken: null,
            scope: null, tokenType: null, providerAccountId: pool, providerEmail: null },
        });
        const declaration = resolveQualifiedPurposeDeclarationSnapshotForAgentSpawn({
          agentId: 'codex', contributions: runtimeFixture!.registry.contributes,
        })!;
        const scope = declaration.fileMaterializationPurposes[0]!;
        const account = { service: scope.serviceRefs[0]!, accountId: pool };
        const binding = { purpose: scope.purpose, target: { kind: 'group' as const, service: account.service, groupId: `group-${pool}` } };
        const unusedAccountBoundary = async (): Promise<never> => { throw new Error('Unexpected account inventory I/O'); };
        const owner = createConnectedAccountPurposeBindingOwner({
          store: { read: unusedAccountBoundary, update: unusedAccountBoundary, subscribe: () => ({ dispose() {} }) },
          selectTarget: unusedAccountBoundary, resolveTarget: async () => ({ displayName: pool, account }),
          projectTargetAccounts: unusedAccountBoundary, assertTargetAccountMaterializable: unusedAccountBoundary,
          materializeAccount: async input => await materializeExactV021ConnectedServiceCredential({
            registry: runtimeFixture!.registry, serviceId: 'openai-codex', account: input.account,
            record, request: input.request, signal: input.signal,
          }),
        });
        const sessionId = `${pool}-${stateMode}-${probePurpose ?? 'session'}`;
        leases.push(owner.activateSessionPurposeBindings({ sessionId, purposes: declaration.purposes, bindings: [binding] }));
        const result = await materializeConnectedServicesForSpawnProduction({
          agentId: 'codex', materializationKey: sessionId, purposeBindingSessionId: sessionId,
          activeServerDir: join(root, 'server'), baseDir: join(root, 'materialized'),
          recordsByServiceId: new Map(), connectedAccountsOwner: owner,
          connectedAccountMaterializationAuthority: { kind: 'qualified', purposeBindings: [binding], requestAuthPurposeBindings: [] },
          qualifiedPurposeBindingSnapshot: { ...declaration, bindings: [binding] },
          processEnv: sourceEnvironment,
          sessionDirectory: root,
          ...(probePurpose ? { probePurpose } : {}),
          accountSettings: { connectedServicesProviderStateSharingSettingsV1: {
            v: 1, defaults: { configMode: 'isolated', stateMode }, byAgentId: {}, acknowledgedRisksByAgentId: {},
          } },
        });
        expect(result).not.toBeNull();
        expect(result?.sessionConnectedAccounts).toEqual([{ purpose: scope.purpose.purpose, account }]);
        materialized.push(result!);
        const launch = { runtimeDescriptorV1: { v: 1 as const, agentId: 'codex', agent: {} },
          ...(result!.sessionConnectedAccounts ? { sessionConnectedAccounts: [...result!.sessionConnectedAccounts] } : {}) };
        const bootstrap = await createRunnerAgentSessionBootstrapAuthorization({
          happyHomeDir: root, publicReleaseRing: 'stable', descriptor, launch,
        });
        try {
          expect((await readRunnerAgentSessionBootstrap(bootstrap.authorization.bootstrapFilePath)).launch)
            .toMatchObject({ sessionConnectedAccounts: result!.sessionConnectedAccounts });
        } finally { await bootstrap.cleanupBootstrapFile(); }
        return result!;
      };
      const first = await launch('pool-a', 'shared');
      const second = await launch('pool-b', 'shared');
      expect(first.env.CODEX_HOME).not.toBe(second.env.CODEX_HOME);
      for (const [index, result] of [first, second].entries()) {
        expect(result.env.CODEX_SQLITE_HOME).toBe(sqliteHome);
        const home = result.env.CODEX_HOME!;
        expect((await reopen(home)).CODEX_SQLITE_HOME).toBe(sqliteHome);
        expect(home).not.toBe(nativeHome);
        expect(await readFile(join(home, 'auth.json'), 'utf8')).toContain(`access-pool-${index === 0 ? 'a' : 'b'}`);
        for (const entry of ['sessions', 'archived_sessions']) {
          expect(await realpath(join(home, entry))).toBe(await realpath(join(nativeHome, entry)));
          expect(await readFile(join(home, entry, 'rollout.jsonl'), 'utf8')).toBe(`${entry}-history`);
        }
        for (const database of databases) {
          for (const suffix of ['', '-wal', '-shm']) expect(existsSync(join(home, `${database}${suffix}`))).toBe(false);
        }
      }
      // Native Codex installs local plugins beside its shared history links. A home
      // refresh must import declared state without inspecting that unrelated tree.
      const pluginsRoot = join(first.env.CODEX_HOME!, 'plugins');
      await mkdir(join(pluginsRoot, 'installed'), { recursive: true });
      await writeFile(join(pluginsRoot, 'installed', 'plugin.json'), '{}');
      const directoryReads = vi.mocked(filesystem.readdir);
      directoryReads.mockClear();
      try {
        await launch('pool-a', 'shared');
        expect(directoryReads.mock.calls.filter(([path]) => String(path).startsWith(pluginsRoot))).toHaveLength(0);
      } finally { directoryReads.mockClear(); }
      const isolated = await launch('pool-isolated', 'isolated');
      const probe = await launch('pool-probe', 'shared', 'probe');
      for (const result of [isolated, probe]) {
        expect(result.env.CODEX_SQLITE_HOME).toBe(result.env.CODEX_HOME);
        expect((await reopen(result.env.CODEX_HOME!)).CODEX_SQLITE_HOME).toBe(result.env.CODEX_HOME);
        expect(existsSync(join(result.env.CODEX_HOME!, 'sessions', 'rollout.jsonl'))).toBe(false);
      }
      // This SDK adapter only calls the OS symlink API. Keep the sharing policy,
      // preflight, degradation and materializer real when the OS refuses links.
      const symlinkFailure = vi.spyOn(nativeFilesystem, 'createAbsolutePathSymlink')
        .mockRejectedValue(Object.assign(new Error('Fixture symlinks unavailable'), { code: 'EPERM' }));
      try {
        const degraded = await launch('pool-degraded', 'shared');
        expect(degraded.diagnostics).toEqual(expect.arrayContaining([
          expect.objectContaining({ code: 'state_symlink_unavailable', effectiveStateMode: 'isolated' }),
        ]));
        expect(degraded.env.CODEX_SQLITE_HOME).toBe(degraded.env.CODEX_HOME);
        expect((await reopen(degraded.env.CODEX_HOME!)).CODEX_SQLITE_HOME).toBe(degraded.env.CODEX_HOME);
        expect(existsSync(join(degraded.env.CODEX_HOME!, 'sessions', 'rollout.jsonl'))).toBe(false);
      } finally { symlinkFailure.mockRestore(); }
      expect(await readFile(join(nativeHome, 'auth.json'), 'utf8')).toBe('native-account-credential');
    } finally {
      for (const result of materialized) await result.cleanupOnExit?.();
      for (const lease of leases) lease.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('keeps qualified account native state separate from each Session request-auth capability root', async () => {
    // File logging is the diagnostic boundary; binding, plugin serialization, queues and disk stay real.
    const log = vi.spyOn(logger, 'infoFile');
    const root = await mkdtemp(join(tmpdir(), 'happier-qualified-native-home-'));
    const declaration = resolveQualifiedPurposeDeclarationSnapshotForAgentSpawn({
      agentId: 'codex', contributions: runtimeFixture!.registry.contributes,
    })!;
    const scope = declaration.fileMaterializationPurposes[0]!;
    const account = { service: scope.serviceRefs[0]!, accountId: 'work' };
    const binding = { purpose: scope.purpose, target: { kind: 'account' as const, account } };
    let record = buildConnectedServiceCredentialRecord({
      now: 10, serviceId: 'openai-codex', profileId: account.accountId, kind: 'oauth', expiresAt: 100000,
      oauth: { accessToken: 'fixture-access', refreshToken: 'fixture-refresh', idToken: 'fixture-id',
        scope: null, tokenType: null, providerAccountId: 'fixture-account', providerEmail: null },
    });
    const unusedAccountBoundary = async (): Promise<never> => { throw new Error('Unexpected account inventory I/O'); };
    let capturedAccount: (() => void) | null = null;
    // The real binding owner resolves synthetic account metadata and invokes the admitted
    // plugin credential serializer; no internal account/materialization logic is mocked.
    const owner = createConnectedAccountPurposeBindingOwner({
      store: { read: unusedAccountBoundary, update: unusedAccountBoundary, subscribe: () => ({ dispose() {} }) },
      selectTarget: unusedAccountBoundary,
      resolveTarget: async target => {
        capturedAccount?.();
        capturedAccount = null;
        return target.kind === 'account'
          ? { displayName: target.account.accountId, account: target.account } : null;
      },
      projectTargetAccounts: unusedAccountBoundary,
      assertTargetAccountMaterializable: async input => {
        if (input.account.accountId !== account.accountId) throw new Error('Fixture account admission refused');
      },
      materializeAccount: async input => await materializeExactV021ConnectedServiceCredential({
        registry: runtimeFixture!.registry, serviceId: 'openai-codex', account: input.account,
        record, request: input.request, signal: input.signal,
      }),
    });
    const leases = ['qualified-first', 'qualified-second', 'qualified-after-rotation', 'qualified-refused'].map(sessionId => owner.activateSessionPurposeBindings({
      sessionId, purposes: declaration.purposes, bindings: [binding],
    }));
    try {
      const params: MaterializeParams = {
        agentId: 'codex', materializationKey: 'qualified-first', purposeBindingSessionId: 'qualified-first',
        activeServerDir: join(root, 'server'), baseDir: join(root, 'materialized'), recordsByServiceId: new Map(),
        connectedAccountsOwner: owner, processEnv: {},
        connectedAccountMaterializationAuthority: {
          kind: 'qualified', purposeBindings: [binding], requestAuthPurposeBindings: [binding],
        },
        qualifiedPurposeBindingSnapshot: { ...declaration, bindings: [binding] },
      };
      const first = await materializeConnectedServicesForSpawnProduction(params);
      const second = await materializeConnectedServicesForSpawnProduction({
        ...params, materializationKey: 'qualified-second', purposeBindingSessionId: 'qualified-second',
      });
      expect(first?.sessionConnectedAccounts).toEqual([{ purpose: scope.purpose.purpose, account }]);
      expect(second?.sessionConnectedAccounts).toEqual(first?.sessionConnectedAccounts);
      expect(first!.env.CODEX_HOME).toBe(second!.env.CODEX_HOME);
      expect(first!.requestAuthMaterializedRoot).not.toBe(first!.targetMaterializedRoot);
      expect(first!.requestAuthMaterializedRoot).not.toBe(second!.requestAuthMaterializedRoot);
      await first!.cleanupOnExit!();
      expect(existsSync(first!.requestAuthMaterializedRoot!)).toBe(false);
      expect(await readFile(join(second!.env.CODEX_HOME!, 'auth.json'), 'utf8')).toContain('fixture-access');
      // Credential reads are owned by the qualified purpose materializer, not
      // the refresh caller's captured record. Queue behind the actual home
      // lock, replace that external credential, then prove current bytes win.
      let releaseHome!: () => void;
      let enteredHome!: () => void;
      const homeEntered = new Promise<void>(resolve => { enteredHome = resolve; });
      const homeReleased = new Promise<void>(resolve => { releaseHome = resolve; });
      const heldHome = runSerializedMaterialization(second!.env.CODEX_HOME!, async () => {
        enteredHome();
        await homeReleased;
      });
      await homeEntered;
      const accountCaptured = new Promise<void>(resolve => { capturedAccount = resolve; });
      const capturedRecord = record;
      let measuredTime = 0;
      const clock = vi.spyOn(performance, 'now').mockImplementation(() => measuredTime);
      const queued = materializeConnectedServicesForSpawnProduction({
        ...params, materializationKey: 'qualified-after-rotation', purposeBindingSessionId: 'qualified-after-rotation',
        recordsByServiceId: new Map([['openai-codex', capturedRecord]]),
      });
      try {
        await accountCaptured;
        await vi.waitFor(() => expect(log).toHaveBeenCalledWith(
          '[CONNECTED ACCOUNT] Materialization phase',
          expect.objectContaining({ materializationKey: 'qualified-after-rotation', phase: 'native_home_queue', status: 'started' }),
        ));
        expect(log.mock.calls.some(([message, fields]) => message === '[CONNECTED ACCOUNT] Materialization phase'
          && isMaterializationPhase(fields, 'qualified-after-rotation', 'native_home_queue', 'completed'))).toBe(false);
        record = buildConnectedServiceCredentialRecord({
          now: 20, serviceId: 'openai-codex', profileId: account.accountId, kind: 'oauth', expiresAt: 100000,
          oauth: { accessToken: 'newest-access', refreshToken: 'newest-refresh', idToken: 'newest-id',
            scope: null, tokenType: null, providerAccountId: 'fixture-account', providerEmail: null },
        });
      } finally {
        measuredTime = 250_000;
        releaseHome();
        // An assertion failure must still settle the live writer before retiring its fixture authority.
        try {
          await heldHome;
          await queued;
        } finally {
          clock.mockRestore();
        }
      }
      await heldHome;
      const rotated = await queued;
      expect(rotated!.env.CODEX_HOME).toBe(second!.env.CODEX_HOME);
      expect(await readFile(join(rotated!.env.CODEX_HOME!, 'auth.json'), 'utf8')).toContain('newest-access');
      expect(await readFile(join(rotated!.env.CODEX_HOME!, 'auth.json'), 'utf8')).not.toContain('fixture-access');
      for (const phase of ['native_home_queue', 'native_home_state', 'native_home_credentials']) {
        expect(log).toHaveBeenCalledWith('[CONNECTED ACCOUNT] Materialization phase', expect.objectContaining({
          materializationKey: 'qualified-after-rotation', phase, status: 'completed',
          durationMs: phase === 'native_home_queue' ? 250_000 : 0,
        }));
      }
      const credentialReadError = new Error('fixture-private-credential-error');
      capturedAccount = () => { throw credentialReadError; };
      await expect(materializeConnectedServicesForSpawnProduction({
        ...params, materializationKey: 'qualified-refused', purposeBindingSessionId: 'qualified-refused',
      })).rejects.toBe(credentialReadError);
      expect(log).toHaveBeenCalledWith('[CONNECTED ACCOUNT] Materialization phase', expect.objectContaining({
        materializationKey: 'qualified-refused', phase: 'binding_read', status: 'failed', durationMs: expect.any(Number),
      }));
      const diagnostics = log.mock.calls.filter(([message]) => message === '[CONNECTED ACCOUNT] Materialization phase');
      expect(diagnostics.length).toBeGreaterThan(0);
      expect(diagnostics).toContainEqual(['[CONNECTED ACCOUNT] Materialization phase', expect.objectContaining({
        materializationKey: 'qualified-after-rotation', phase: 'native_home_credentials', status: 'completed',
        service: account.service,
      })]);
      for (const [, fields] of diagnostics) {
        expect(Object.keys(fields!).sort()).toEqual(
          ['agentId', 'durationMs', 'materializationKey', 'phase', 'phaseId', 'status',
            ...(Object.hasOwn(fields!, 'service') ? ['service'] : []),
            ...(Object.hasOwn(fields!, 'parentPhaseId') ? ['parentPhaseId'] : [])].sort(),
        );
      }
      expect(JSON.stringify(diagnostics)).not.toMatch(/fixture-access|fixture-refresh|newest-access|newest-refresh|fixture-private-credential-error/);
      await rotated!.cleanupOnExit!();
      await second!.cleanupOnExit!();
    } finally {
      log.mockRestore();
      for (const lease of leases) lease.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each(['shared', 'isolated'] as const)('projects Codex SQLite into the selected native home in %s state mode', async stateMode => {
    const root = await mkdtemp(join(tmpdir(), 'happier-native-sqlite-'));
    let result: Awaited<ReturnType<typeof materializeConnectedServicesForSpawn>> = null;
    try {
      const sourceHome = join(root, 'controller', '.codex');
      await mkdir(sourceHome, { recursive: true });
      const record = buildConnectedServiceCredentialRecord({
        now: 10, serviceId: 'openai-codex', profileId: 'work', kind: 'oauth', expiresAt: 100000,
        oauth: { accessToken: 'fixture-access', refreshToken: 'fixture-refresh', idToken: 'fixture-id',
          scope: null, tokenType: null, providerAccountId: 'fixture-account', providerEmail: null },
      });
      const runtimeHome = join(root, 'selected-uid', 'codex');
      result = await materializeConnectedServicesForSpawn({
        agentId: 'codex', materializationKey: 'shared-uid-sqlite', activeServerDir: join(root, 'server'),
        baseDir: join(root, 'materialized'), recordsByServiceId: new Map([['openai-codex', record]]),
        processEnv: { HOME: join(root, 'controller'), CODEX_HOME: sourceHome, CODEX_SQLITE_HOME: sourceHome },
        agentLaunchTarget: { runtimeHome },
        accountSettings: { connectedServicesProviderStateSharingSettingsV1: {
          v: 1, defaults: { configMode: 'isolated', stateMode }, byAgentId: {}, acknowledgedRisksByAgentId: {},
        } },
      });
      const nativeHome = join(runtimeHome, 'native-home');
      expect(result?.agentLaunchMaterials?.environment).toMatchObject({
        CODEX_HOME: nativeHome, CODEX_SQLITE_HOME: nativeHome,
      });
      // The same-UID projection retains the selected sharing policy.
      expect(result?.env.CODEX_SQLITE_HOME).toBe(stateMode === 'shared' ? sourceHome : result?.env.CODEX_HOME);
    } finally {
      await result?.cleanupOnExit?.();
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each([
    { agentId: 'codex', serviceId: 'openai-codex', environmentKey: 'CODEX_HOME', stateEntry: 'sessions' },
    { agentId: 'claude', serviceId: 'claude-subscription', environmentKey: 'CLAUDE_CONFIG_DIR', stateEntry: 'projects' },
  ] as const)('reuses the $agentId account home across Session identities without retiring native state', async ({
    agentId, serviceId, environmentKey, stateEntry,
  }) => {
    const root = await mkdtemp(join(tmpdir(), 'happier-stable-account-home-'));
    try {
      const record = buildConnectedServiceCredentialRecord({
        now: 10, serviceId, profileId: 'work', kind: 'oauth', expiresAt: 100000,
        oauth: { accessToken: 'fixture-access', refreshToken: 'fixture-refresh', idToken: 'fixture-id',
          scope: null, tokenType: null, providerAccountId: 'fixture-account', providerEmail: null },
      });
      const params: MaterializeParams = {
        agentId, materializationKey: 'first-session', activeServerDir: join(root, 'server'),
        baseDir: join(root, 'materialized'), recordsByServiceId: new Map([[serviceId, record]]),
        processEnv: {}, accountSettings: { connectedServicesProviderStateSharingSettingsV1: {
          v: 1, defaults: { configMode: 'isolated', stateMode: 'isolated' }, byAgentId: {}, acknowledgedRisksByAgentId: {},
        } },
      };
      const oldHome = resolveConnectedServiceMaterializedRootDir({
        baseDir: params.baseDir, agentId, materializationKey: params.materializationKey,
      });
      const oldTranscript = join(oldHome, stateEntry, 'legacy-session.jsonl');
      await mkdir(join(oldHome, stateEntry), { recursive: true });
      await writeFile(oldTranscript, '{"sessionId":"legacy-session"}\n');
      const first = await materializeConnectedServicesForSpawn(params);
      const home = first!.env[environmentKey]!;
      expect(home).toBe(join(resolveConnectedServiceHomeDir({
        activeServerDir: params.activeServerDir, serviceId, profileId: record.profileId, agentId,
      }), agentId === 'codex' ? 'codex-home' : 'claude-config'));
      expect(home).not.toBe(oldHome);
      expect(await readFile(join(home, stateEntry, 'legacy-session.jsonl'), 'utf8')).toContain('legacy-session');
      expect(await readFile(oldTranscript, 'utf8')).toContain('legacy-session');
      const transcript = join(home, stateEntry, 'fixture-session.jsonl');
      await mkdir(join(home, stateEntry), { recursive: true });
      await writeFile(transcript, '{"sessionId":"fixture-session"}\n');
      await first!.cleanupOnExit!();
      expect(await readFile(oldTranscript, 'utf8')).toContain('legacy-session');
      const second = await materializeConnectedServicesForSpawn({ ...params, materializationKey: 'second-session' });
      expect(second!.env[environmentKey]).toBe(home);
      expect(await readFile(transcript, 'utf8')).toContain('fixture-session');
      await second!.cleanupOnExit!();
      expect(await readFile(transcript, 'utf8')).toContain('fixture-session');
      if (agentId === 'claude' && record.kind === 'oauth') {
        const approvalConfig = join(home, '.claude.json');
        const privateMemory = join(home, stateEntry, 'memory', 'private.md');
        const retainedConfig = {
          approvalMarker: 'retain-native-approval',
          projects: { '/workspace': { hasTrustDialogAccepted: true, allowedTools: ['Read'] } },
          privatePreference: { theme: 'dark' },
          oauthAccount: { accountUuid: 'fixture-account', emailAddress: 'previous@example.test' },
        };
        await writeFile(approvalConfig, JSON.stringify(retainedConfig));
        await mkdir(join(home, stateEntry, 'memory'), { recursive: true });
        await writeFile(privateMemory, 'retain-native-memory');
        const refreshed = await materializeConnectedServicesForSpawn({
          ...params, materializationKey: 'refreshed-session',
          recordsByServiceId: new Map([[serviceId, {
            ...record, oauth: { ...record.oauth, accessToken: 'fixture-refreshed-access' },
          }]]),
        });
        expect(refreshed!.env[environmentKey]).toBe(home);
        expect(await readFile(join(home, '.credentials.json'), 'utf8')).toContain('fixture-refreshed-access');
        expect(await readFile(approvalConfig, 'utf8')).toContain('retain-native-approval');
        expect(await readFile(privateMemory, 'utf8')).toBe('retain-native-memory');
        expect(await readFile(transcript, 'utf8')).toContain('fixture-session');
        await refreshed!.cleanupOnExit!();
        const changedAccount = await materializeConnectedServicesForSpawn({
          ...params, materializationKey: 'changed-account-session',
          recordsByServiceId: new Map([[serviceId, {
            ...record, oauth: { ...record.oauth, accessToken: 'fixture-replacement-access',
              providerAccountId: 'replacement-account', providerEmail: 'replacement@example.test' },
          }]]),
        });
        expect(changedAccount!.env[environmentKey]).toBe(home);
        expect(JSON.parse(await readFile(approvalConfig, 'utf8'))).toMatchObject({
          ...retainedConfig,
          oauthAccount: { accountUuid: 'replacement-account', emailAddress: 'replacement@example.test' },
        });
        expect(await readFile(privateMemory, 'utf8')).toBe('retain-native-memory');
        expect(await readFile(transcript, 'utf8')).toContain('fixture-session');
        await changedAccount!.cleanupOnExit!();
      }
      const sharedSource = join(root, 'native');
      await mkdir(join(sharedSource, stateEntry), { recursive: true });
      await writeFile(join(sharedSource, stateEntry, 'native-session.jsonl'), '{"sessionId":"native-session"}\n');
      if (agentId === 'codex') {
        await writeFile(join(sharedSource, 'history.jsonl'), '{"session_id":"native-session","text":"native"}\n');
        await writeFile(join(home, 'history.jsonl'), '{"session_id":"fixture-session","text":"private"}\n');
        await writeFile(join(sharedSource, 'session_index.jsonl'), '{"id":"native-session","updated_at":"2026-09-01T00:00:00.000Z"}\n');
        await writeFile(join(home, 'session_index.jsonl'), '{"id":"fixture-session","updated_at":"2026-09-02T00:00:00.000Z"}\n');
      }
      const shared = await materializeConnectedServicesForSpawn({
        ...params, materializationKey: 'shared-session', processEnv: { [environmentKey]: sharedSource },
        accountSettings: { connectedServicesProviderStateSharingSettingsV1: {
          v: 1, defaults: { configMode: 'isolated', stateMode: 'shared' }, byAgentId: {}, acknowledgedRisksByAgentId: {},
        } },
      });
      expect(shared!.env[environmentKey]).toBe(home);
      expect(await readFile(join(sharedSource, stateEntry, 'fixture-session.jsonl'), 'utf8')).toContain('fixture-session');
      expect(await readFile(transcript, 'utf8')).toContain('fixture-session');
      if (agentId === 'codex') {
        expect(await readFile(join(home, 'history.jsonl'), 'utf8')).toContain('fixture-session');
        expect(await readFile(join(home, 'history.jsonl'), 'utf8')).toContain('native-session');
        expect(await readFile(join(home, 'session_index.jsonl'), 'utf8')).toContain('fixture-session');
        expect(await readFile(join(home, 'session_index.jsonl'), 'utf8')).toContain('native-session');
      }
      await shared!.cleanupOnExit!();
      const probeParams = { ...params, materializationKey: 'probe-fixture', probePurpose: 'probe' as const };
      const probe = await materializeConnectedServicesForSpawn(probeParams);
      const probeHome = probe!.env[environmentKey]!;
      expect(probeHome).not.toBe(home);
      await expect(lstat(join(probeHome, stateEntry))).rejects.toMatchObject({ code: 'ENOENT' });
      await mkdir(join(probeHome, stateEntry), { recursive: true });
      await writeFile(join(probeHome, stateEntry, 'probe-session.jsonl'), '{"sessionId":"probe-session"}\n');
      await probe!.cleanupOnExit!();
      expect(existsSync(probeHome)).toBe(false);
      expect(await readFile(transcript, 'utf8')).toContain('fixture-session');
      const groupParams = { ...params, selectionsByServiceId: new Map([[serviceId, {
        kind: 'group' as const, serviceId, groupId: 'pool', activeProfileId: record.profileId,
        fallbackProfileId: record.profileId, generation: 1, policy: {},
      }]]) };
      const groupFirst = await materializeConnectedServicesForSpawn({ ...groupParams, materializationKey: 'group-first' });
      const groupSecond = await materializeConnectedServicesForSpawn({ ...groupParams, materializationKey: 'group-second' });
      expect(groupFirst!.env[environmentKey]).not.toBe(home);
      expect(groupSecond!.env[environmentKey]).toBe(groupFirst!.env[environmentKey]);
      await groupFirst!.cleanupOnExit!();
      await groupSecond!.cleanupOnExit!();
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it.each(['physical', 'aliased'] as const)('adopts only the resumed conversation across account selection with a %s base without trusting user or foreign homes', async base => {
    const root = await mkdtemp(join(tmpdir(), 'happier-prior-connected-home-'));
    try {
      const physicalServerDir = join(root, 'server');
      const activeServerDir = base === 'aliased' ? join(root, 'server-alias') : physicalServerDir;
      if (base === 'aliased') {
        await mkdir(physicalServerDir);
        await symlink(physicalServerDir, activeServerDir, process.platform === 'win32' ? 'junction' : 'dir');
      }
      const priorHome = join(resolveConnectedServiceHomeDir({
        activeServerDir, serviceId: 'openai-codex', profileId: 'account-a', agentId: 'codex',
      }), 'codex-home');
      await mkdir(join(priorHome, 'sessions'), { recursive: true });
      const vendorResumeId = '11111111-2222-4333-8444-555555555555';
      const rolloutName = `rollout-2026-10-12T10-00-00-${vendorResumeId}.jsonl`;
      await writeFile(join(priorHome, 'sessions', rolloutName), '{"sessionId":"retained-session"}\n');
      await writeFile(join(priorHome, 'sessions', 'unrelated-session.jsonl'), 'unrelated-private-session');
      await mkdir(join(priorHome, 'archived_sessions'), { recursive: true });
      await writeFile(join(priorHome, 'archived_sessions', 'private.jsonl'), 'unrelated-private-archive');
      await mkdir(join(priorHome, 'memories'), { recursive: true });
      await writeFile(join(priorHome, 'memories', 'private.md'), 'unrelated-private-memory');
      await writeFile(join(priorHome, 'history.jsonl'), '{"session_id":"unrelated-account-history"}\n');
      const record = buildConnectedServiceCredentialRecord({
        now: 10, serviceId: 'openai-codex', profileId: 'account-b', kind: 'oauth', expiresAt: 100000,
        oauth: { accessToken: 'account-b-access', refreshToken: 'fixture-refresh', idToken: 'fixture-id',
          scope: null, tokenType: null, providerAccountId: 'account-b', providerEmail: null },
      });
      const params: MaterializeParams = {
        agentId: 'codex', materializationKey: 'resumed-session', activeServerDir,
        baseDir: join(root, 'materialized'), recordsByServiceId: new Map([['openai-codex', record]]),
        processEnv: {}, allowNativeAccountState: false,
        accountSettings: { connectedServicesProviderStateSharingSettingsV1: {
          v: 1, defaults: { configMode: 'isolated', stateMode: 'isolated' }, byAgentId: {}, acknowledgedRisksByAgentId: {},
        } },
      };
      // Persisted binding IDs may already identify B while the last process still used A.
      const descriptor = {
        v: 1 as const, agentId: 'codex', agent: {
          backendMode: 'appServer', home: 'connectedService', homePath: priorHome,
          connectedServiceId: 'openai-codex', connectedServiceProfileId: record.profileId,
        },
      };
      const resumedParams = { ...params, runtimeDescriptorV1: descriptor, vendorResumeId };
      const resumed = await materializeConnectedServicesForSpawn(resumedParams);
      const nextHome = resumed!.env.CODEX_HOME!;
      expect(nextHome).not.toBe(priorHome);
      expect(await readFile(join(nextHome, 'sessions', rolloutName), 'utf8')).toContain('retained-session');
      expect(await readFile(join(priorHome, 'sessions', rolloutName), 'utf8')).toContain('retained-session');
      const unrelatedPaths = ['sessions/unrelated-session.jsonl', 'archived_sessions/private.jsonl', 'memories/private.md', 'history.jsonl'];
      for (const path of unrelatedPaths) {
        await expect(lstat(join(nextHome, path))).rejects.toMatchObject({ code: 'ENOENT' });
        expect(await readFile(join(priorHome, path), 'utf8')).toContain('unrelated');
      }
      expect(await readFile(join(nextHome, 'auth.json'), 'utf8')).toContain('account-b-access');
      await resumed!.cleanupOnExit!();
      const freshRecord = { ...record, profileId: 'fresh-account' };
      const fresh = await materializeConnectedServicesForSpawn({
        ...params, materializationKey: 'fresh-session', runtimeDescriptorV1: descriptor,
        recordsByServiceId: new Map([['openai-codex', freshRecord]]),
      });
      for (const path of [`sessions/${rolloutName}`, ...unrelatedPaths]) {
        await expect(lstat(join(fresh!.env.CODEX_HOME!, path))).rejects.toMatchObject({ code: 'ENOENT' });
      }
      await fresh!.cleanupOnExit!();
      const foreignHome = join(root, 'foreign-home');
      await mkdir(foreignHome);
      const redirectedHome = join(activeServerDir, 'daemon', 'connected-services', 'homes', 'redirected-home');
      await symlink(foreignHome, redirectedHome, process.platform === 'win32' ? 'junction' : 'dir');
      for (const [home, source] of [
        ['user', priorHome], ['connectedService', foreignHome], ['connectedService', redirectedHome],
      ] as const) {
        await mkdir(join(source, 'sessions'), { recursive: true });
        await writeFile(join(source, 'sessions', 'untrusted-session.jsonl'), 'untrusted-history');
        const candidateParams = {
          ...params, materializationKey: `untrusted-${home}`,
          runtimeDescriptorV1: { ...descriptor, agent: { ...descriptor.agent, home, homePath: source } },
        };
        const candidate = await materializeConnectedServicesForSpawn(candidateParams);
        expect(existsSync(join(candidate!.env.CODEX_HOME!, 'sessions', 'untrusted-session.jsonl'))).toBe(false);
        await candidate!.cleanupOnExit!();
      }
      const redirectedServer = join(root, 'redirected-server');
      await mkdir(join(redirectedServer, 'daemon', 'connected-services'), { recursive: true });
      await symlink(foreignHome, join(redirectedServer, 'daemon', 'connected-services', 'homes'),
        process.platform === 'win32' ? 'junction' : 'dir');
      await expect(materializeConnectedServicesForSpawn({
        ...params, activeServerDir: redirectedServer, materializationKey: 'redirected-server-session',
      })).rejects.toThrow('connected_service_materialization_root_unsafe');
      expect(existsSync(join(foreignHome, 'openai-codex', record.profileId, 'codex', 'codex-home', 'auth.json'))).toBe(false);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it.each([
    { agentId: 'claude', environmentKey: 'CLAUDE_CONFIG_DIR', stateEntry: 'projects', sourcePresent: false },
    { agentId: 'claude', environmentKey: 'CLAUDE_CONFIG_DIR', stateEntry: 'projects', sourcePresent: true },
    { agentId: 'codex', environmentKey: 'CODEX_HOME', stateEntry: 'sessions', sourcePresent: false },
    { agentId: 'codex', environmentKey: 'CODEX_HOME', stateEntry: 'sessions', sourcePresent: true },
    { agentId: 'pi', environmentKey: 'PI_CODING_AGENT_DIR', stateEntry: 'sessions', sourcePresent: false },
    { agentId: 'pi', environmentKey: 'PI_CODING_AGENT_DIR', stateEntry: 'sessions', sourcePresent: true },
  ] as const)('preserves $agentId state through live rematerialization with native source present=$sourcePresent', async ({
    agentId, environmentKey, stateEntry, sourcePresent,
  }) => {
    const root = await mkdtemp(join(tmpdir(), 'happier-linked-native-state-'));
    try {
      const nativeHome = join(root, 'native');
      await mkdir(nativeHome);
      if (sourcePresent) await mkdir(join(nativeHome, stateEntry));
      const declaration = resolveQualifiedPurposeDeclarationSnapshotForAgentSpawn({
        agentId, contributions: runtimeFixture!.registry.contributes,
      });
      expect(declaration).not.toBeNull();
      const catalogEntry = await runtimeFixture!.registry.acquireAgentCatalogEntry!(agentId);
      const descriptor = await catalogEntry?.getConnectedServiceStateSharingDescriptor?.();
      if (!descriptor) throw new Error('Expected declared native state sharing');
      const linkedEntries = descriptor.state.entries.filter(entry =>
        (entry.mode === 'linked' || entry.mode === 'linked_or_copied')
        && (entry.createIfMissing === 'directory' || (entry.path === stateEntry && sourcePresent)));
      const stateLinked = linkedEntries.some(entry => entry.path === stateEntry);
      // Keep the real account owner; this state-only fixture admits no account I/O.
      const unavailableAccountBoundary = async (): Promise<never> => {
        throw new Error('Credential-free state fixture must not access accounts');
      };
      const connectedAccountsOwner = createConnectedAccountPurposeBindingOwner({
        store: {
          read: unavailableAccountBoundary, update: unavailableAccountBoundary,
          subscribe: () => ({ dispose() {} }),
        },
        selectTarget: unavailableAccountBoundary,
        resolveTarget: unavailableAccountBoundary,
        materializeAccount: unavailableAccountBoundary,
        projectTargetAccounts: unavailableAccountBoundary,
        assertTargetAccountMaterializable: unavailableAccountBoundary,
      });
      const params: MaterializeParams = {
        agentId, nativeHomeOnly: true, materializationKey: 'csm_linked-native-state', activeServerDir: root,
        baseDir: join(root, 'materialized'), recordsByServiceId: new Map(),
        connectedAccountMaterializationAuthority: {
          kind: 'qualified', purposeBindings: [], requestAuthPurposeBindings: [],
        },
        qualifiedPurposeBindingSnapshot: { ...declaration!, bindings: [] },
        exactPurposeBindingSubjectId: 'linked-native-state-fixture',
        connectedAccountsOwner,
        processEnv: { [environmentKey]: nativeHome },
        accountSettings: { connectedServicesProviderStateSharingSettingsV1: {
          v: 1, defaults: { configMode: 'isolated', stateMode: 'shared' }, byAgentId: {}, acknowledgedRisksByAgentId: {},
        } },
      };
      const first = await materializeConnectedServicesForSpawnProduction(params);
      expect(first).not.toBeNull();
      const home = first!.env[environmentKey]!;
      const expectedBinding = linkedEntries.length > 0 ? {
        agentId, pluginId: `happier.agent.${agentId}`,
        sourceCustody: runtimeFixture!.registry.readPluginSourceCustody!(`happier.agent.${agentId}`),
        nativeHomeRoot: await realpath(home),
        entries: await Promise.all(linkedEntries.map(async entry => ({
          entryPath: entry.path, sourceEntryRoot: await realpath(join(nativeHome, entry.path)),
          materializedEntryPath: join(await realpath(home), entry.path),
        }))),
      } : undefined;
      expect(first!.materializedStateObservationBinding).toEqual(expectedBinding);
      const transcript = join(home, stateEntry, '-tmp', 's.jsonl');
      await mkdir(join(home, stateEntry, '-tmp'), { recursive: true });
      await writeFile(transcript, '{"sessionId":"s"}\n');
      const observation = (file: string) => validateExternalSessionObservationWatchFileChanges({
        requested: { files: [file] },
        linkedSource: { source: { root: home }, remoteSessionId: 's', linkData: {} },
        filesystemReadAllowedPaths: new Set([home]),
        materializedStateObservationBinding: first!.materializedStateObservationBinding,
      });
      expect(observation(transcript)?.files).toEqual([await realpath(transcript)]);
      if (!sourcePresent) {
        const foreignState = join(root, 'foreign-state');
        await mkdir(foreignState);
        await writeFile(join(foreignState, 'other.jsonl'), 'another account');
        await symlink(foreignState, join(home, stateEntry, 'foreign'), 'dir');
        expect(observation(join(home, stateEntry, 'foreign', 'other.jsonl'))).toBeNull();
      }

      // The first launch remains live: refresh uses this same staged replacement owner.
      const refreshed = await materializeConnectedServicesForSpawnProduction(params);
      expect(refreshed!.env[environmentKey]).toBe(home);
      expect(refreshed!.materializedStateObservationBinding).toEqual(expectedBinding);
      expect(await readFile(transcript, 'utf8')).toBe('{"sessionId":"s"}\n');
      expect((await lstat(join(home, stateEntry))).isSymbolicLink()).toBe(stateLinked);
      const manifest = await readConnectedServiceStateSharingManifest(home);
      expect(manifest.stateEntries.includes(stateEntry)).toBe(stateLinked);
      if (stateLinked) {
        expect(await realpath(join(home, stateEntry))).toBe(await realpath(join(nativeHome, stateEntry)));
        await writeFile(join(nativeHome, stateEntry, '-tmp', 's.jsonl'), '{"sessionId":"s","turn":2}\n');
      } else {
        await expect(lstat(join(nativeHome, stateEntry))).rejects.toMatchObject({ code: 'ENOENT' });
        await expect(lstat(join(home, stateEntry, 'foreign'))).rejects.toMatchObject({ code: 'ENOENT' });
        await writeFile(transcript, '{"sessionId":"s","turn":2}\n');
      }
      const nextRefresh = await materializeConnectedServicesForSpawnProduction(params);
      expect(await readFile(transcript, 'utf8')).toBe('{"sessionId":"s","turn":2}\n');
      await nextRefresh!.cleanupOnExit!();
      await refreshed!.cleanupOnExit!();
      await first!.cleanupOnExit!();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('does not rediscover an isolated conversation already in the durable native home', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-unchanged-native-state-'));
    try {
      const record = buildConnectedServiceCredentialRecord({ now: 10,
        serviceId: 'openai-codex', profileId: 'work', kind: 'oauth', expiresAt: 100000,
        oauth: { accessToken: 'fixture-access', refreshToken: 'fixture-refresh', idToken: null,
          scope: null, tokenType: null, providerAccountId: null, providerEmail: null },
      });
      const params: MaterializeParams = { agentId: 'codex', materializationKey: 'unchanged-state',
        activeServerDir: join(root, 'server'), baseDir: join(root, 'materialized'),
        recordsByServiceId: new Map([['openai-codex', record]]), processEnv: {},
        accountSettings: { connectedServicesProviderStateSharingSettingsV1: { v: 1,
          defaults: { configMode: 'isolated', stateMode: 'isolated' }, byAgentId: {}, acknowledgedRisksByAgentId: {},
        } },
      };
      const first = await materializeConnectedServicesForSpawn(params);
      const home = first!.env.CODEX_HOME!;
      const vendorResumeId = '019fea40-8040-7d00-9b7e-9b8f3b5cfca8';
      const rollout = join(home, 'sessions', `rollout-2026-09-07T12-00-00-${vendorResumeId}.jsonl`);
      await mkdir(join(home, 'sessions'), { recursive: true });
      await writeFile(rollout, JSON.stringify({ type: 'session_meta', payload: { id: vendorResumeId } }) + '\n');
      vi.mocked(filesystem.readdir).mockClear();
      const resumed = await materializeConnectedServicesForSpawn({ ...params, vendorResumeId });
      expect(filesystem.readdir).not.toHaveBeenCalledWith(join(home, 'sessions'), expect.anything());
      expect(await readFile(rollout, 'utf8')).toContain(vendorResumeId);
      await resumed!.cleanupOnExit!();
      await first!.cleanupOnExit!();
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('refuses to import local state through an aliased previous materialized home', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-aliased-run-native-state-'));
    const envScope = createEnvKeyScope(['HAPPIER_HOME_DIR']);
    try {
      envScope.patch({ HAPPIER_HOME_DIR: join(root, 'cli') });
      reloadConfiguration();
      const params: MaterializeParams = {
        agentId: 'codex', materializationKey: 'aliased-run-native-state', activeServerDir: root,
        baseDir: join(root, 'materialized'), recordsByServiceId: new Map(), allowNativeAccountState: false,
        isAccountRuntimeCurrent: async () => true,
      };
      const first = await materializeConnectedServicesForSpawnProduction(params);
      const home = first!.env.CODEX_HOME!;
      await rm(home, { recursive: true, force: true });
      const outside = join(root, 'outside');
      await mkdir(join(outside, 'sessions'), { recursive: true });
      await writeFile(join(outside, 'sessions', 'rollout.jsonl'), 'another native home');
      await symlink(outside, home, 'dir');
      await expect(materializeConnectedServicesForSpawnProduction(params)).rejects.toThrow('connected_service_materialization_root_unsafe');
      expect((await lstat(home)).isSymbolicLink()).toBe(true);
      expect(await readFile(join(outside, 'sessions', 'rollout.jsonl'), 'utf8')).toBe('another native home');
    } finally {
      envScope.restore(); reloadConfiguration(); await rm(root, { recursive: true, force: true });
    }
  });

  it('preserves isolated declared native state after Run custody ends and through rematerialization', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-ended-run-native-state-'));
    const envScope = createEnvKeyScope(['HAPPIER_HOME_DIR']);
    try {
      envScope.patch({ HAPPIER_HOME_DIR: join(root, 'cli') });
      reloadConfiguration();
      const params: MaterializeParams = {
        agentId: 'codex', materializationKey: 'ended-run-native-state', activeServerDir: root,
        baseDir: join(root, 'materialized'), recordsByServiceId: new Map(), allowNativeAccountState: false,
        isAccountRuntimeCurrent: async () => true,
      };
      const first = await materializeConnectedServicesForSpawnProduction(params);
      const home = first!.env.CODEX_HOME!;
      const archive = join(home, 'archived_sessions', 'rollout.jsonl');
      await mkdir(join(home, 'archived_sessions'), { recursive: true });
      await writeFile(archive, '{"nativeSession":"archived-thread"}\n');
      await first!.cleanupOnExit!();
      expect(await readFile(archive, 'utf8')).toContain('archived-thread');
      const second = await materializeConnectedServicesForSpawnProduction(params);
      await second!.cleanupOnExit!();
      expect(await readFile(archive, 'utf8')).toContain('archived-thread');
    } finally {
      envScope.restore(); reloadConfiguration(); await rm(root, { recursive: true, force: true });
    }
  });

  it.each([
    { displacedPrefix: false, missingState: false, siblingSessionId: 'parent' },
    { displacedPrefix: true, missingState: false, siblingSessionId: 'parent' },
    { displacedPrefix: false, missingState: true, siblingSessionId: 'parent' },
    { displacedPrefix: false, missingState: false, siblingSessionId: 'other-owned-session' },
    { displacedPrefix: false, missingState: false, siblingSessionId: 'other-owned-session', freshSessionFirst: true },
    { displacedPrefix: true, missingState: false, siblingSessionId: 'parent', freshSessionFirst: true },
    { displacedPrefix: false, missingState: false, siblingSessionId: 'parent', freshSessionFirst: true, missingRequester: true },
  ])('prepares the retained thread after Stop and resume ($displacedPrefix prefix, $missingState missing, $siblingSessionId sibling, ordinary Session=$freshSessionFirst, missing requester=$missingRequester)', async ({ displacedPrefix, missingState, siblingSessionId, freshSessionFirst = false, missingRequester = false }) => {
    const root = await mkdtemp(join(tmpdir(), 'happier-retained-run-link-'));
    const envScope = createEnvKeyScope(['HAPPIER_HOME_DIR']);
    try {
      envScope.patch({ HAPPIER_HOME_DIR: join(root, 'cli') });
      reloadConfiguration();
      const vendorResumeId = '019fea40-8040-7d00-9b7e-9b8f3b5cfca8';
      const rolloutName = `rollout-2026-09-07T12-00-00-${vendorResumeId}.jsonl`;
      const nativeHome = join(root, 'native');
      await mkdir(join(nativeHome, 'sessions'), { recursive: true });
      const record = buildConnectedServiceCredentialRecord({
        now: 10, serviceId: 'openai-codex', profileId: 'retained-account', kind: 'oauth', expiresAt: 100000,
        oauth: { accessToken: 'fixture-access', refreshToken: 'fixture-refresh', idToken: null,
          scope: null, tokenType: null, providerAccountId: null, providerEmail: null },
      });
      const bindings = { v: 2 as const, bindingsByServiceId: {
        'happier.agent.codex/openai-codex': { source: 'connected' as const, selection: 'profile' as const, profileId: record.profileId },
      } };
      const requesterWorkAttributionV1 = { serverId: 'home', accountId: 'owner', machineId: 'machine', installationId: 'installation' };
      const params: MaterializeParams = {
        agentId: 'codex', materializationKey: 'retained-review-run', activeServerDir: join(root, 'server'),
        baseDir: join(root, 'materialized'), recordsByServiceId: new Map([['openai-codex', record]]),
        processEnv: { CODEX_HOME: nativeHome },
        accountSettings: { connectedServicesProviderStateSharingSettingsV1: {
          v: 1, defaults: { configMode: 'isolated', stateMode: 'shared' }, byAgentId: {}, acknowledgedRisksByAgentId: {},
        } },
      };
      const published = await materializeConnectedServicesForSpawn(params);
      const home = published!.env.CODEX_HOME!;
      // The native process publishes its history through the shared entry.
      const metadata = `${JSON.stringify({ type: 'session_meta', payload: { id: vendorResumeId } })}\n`;
      const publishedHistory = `${metadata}${JSON.stringify({ type: 'event_msg', payload: { type: 'task_complete', last_agent_message: 'Retained review' } })}\n`;
      await writeFile(join(home, 'sessions', rolloutName), publishedHistory);
      if (displacedPrefix) {
        const displaced = join(home, 'sessions.local-1700000000000');
        await mkdir(displaced);
        await writeFile(join(displaced, rolloutName), metadata);
      }
      await writeFile(join(nativeHome, 'sessions', 'unrelated-session.jsonl'), 'other conversation\n');
      await retainExecutionRunState({
        runId: params.materializationKey, callId: 'call', sidechainId: 'side', sessionId: 'parent', depth: 0,
        intent: 'review', backendTarget: { kind: 'builtInAgent', agentId: 'codex' }, backendId: 'codex',
        instructions: '', permissionMode: 'read_only', retentionPolicy: 'resumable', runClass: 'long_lived',
        ioMode: 'streaming', status: 'succeeded', startedAtMs: 1, finishedAtMs: 2,
        launch: { connectedServicesSelection: bindings },
        requesterWorkAttributionV1,
        resumeHandle: { kind: 'provider_session.v1', backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' }, providerSessionId: vendorResumeId },
      });
      const siblingRunId = 'retained-sibling-review-run';
      const siblingVendorResumeId = '019fea40-8040-7d00-9b7e-9b8f3b5cfca9';
      const siblingRolloutName = `rollout-2026-09-07T12-00-00-${siblingVendorResumeId}.jsonl`;
      const siblingMetadata = `${JSON.stringify({ type: 'session_meta', payload: { id: siblingVendorResumeId } })}\n`;
      const siblingHistory = `${siblingMetadata}${JSON.stringify({ type: 'event_msg', payload: { type: 'task_complete', last_agent_message: 'Sibling retained review' } })}\n`;
      if (!missingState) {
        await writeFile(join(nativeHome, 'sessions', siblingRolloutName), siblingHistory);
        if (displacedPrefix) {
          await writeFile(join(home, 'sessions.local-1700000000000', siblingRolloutName), siblingMetadata);
        }
        await retainExecutionRunState({
          runId: siblingRunId, callId: 'sibling-call', sidechainId: 'sibling-side', sessionId: siblingSessionId, depth: 0,
          intent: 'review', backendTarget: { kind: 'builtInAgent', agentId: 'codex' }, backendId: 'codex',
          instructions: '', permissionMode: 'read_only', retentionPolicy: 'resumable', runClass: 'long_lived',
          ioMode: 'streaming', status: 'succeeded', startedAtMs: 1, finishedAtMs: 2,
          launch: { connectedServicesSelection: bindings },
          requesterWorkAttributionV1,
          resumeHandle: { kind: 'provider_session.v1', backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' }, providerSessionId: siblingVendorResumeId },
        });
        // Valid histories behind the borrowed link still require the exact
        // requester Home, Account and Connected Account destination.
        for (const excluded of [
          { runId: 'foreign-run', accountId: 'another-owner', serverId: 'home', profileId: record.profileId,
            providerSessionId: '019fea40-8040-7d00-9b7e-9b8f3b5cfcb0' },
          { runId: 'foreign-home-run', accountId: 'owner', serverId: 'another-home', profileId: record.profileId,
            providerSessionId: '019fea40-8040-7d00-9b7e-9b8f3b5cfcb1' },
          { runId: 'other-connected-account-run', accountId: 'owner', serverId: 'home', profileId: 'other-connected-account',
            providerSessionId: '019fea40-8040-7d00-9b7e-9b8f3b5cfcb2' },
        ]) {
          await retainExecutionRunState({
            runId: excluded.runId, callId: 'foreign-call', sidechainId: 'foreign-side', sessionId: excluded.runId, depth: 0,
            intent: 'review', backendTarget: { kind: 'builtInAgent', agentId: 'codex' }, backendId: 'codex',
            instructions: '', permissionMode: 'read_only', retentionPolicy: 'resumable', runClass: 'long_lived',
            ioMode: 'streaming', status: 'succeeded', startedAtMs: 1, finishedAtMs: 2,
            launch: { connectedServicesSelection: { v: 2, bindingsByServiceId: {
              'happier.agent.codex/openai-codex': { source: 'connected', selection: 'profile', profileId: excluded.profileId },
            } } },
            requesterWorkAttributionV1: { ...requesterWorkAttributionV1, accountId: excluded.accountId, serverId: excluded.serverId },
            resumeHandle: { kind: 'provider_session.v1', backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' }, providerSessionId: excluded.providerSessionId },
          });
          await writeFile(join(nativeHome, 'sessions', `rollout-2026-09-07T12-00-00-${excluded.providerSessionId}.jsonl`),
            `${JSON.stringify({ type: 'session_meta', payload: { id: excluded.providerSessionId } })}\n`);
        }
      }
      await published!.cleanupOnExit!();
      if (missingState) await rm(join(nativeHome, 'sessions', rolloutName));
      const registry = new ConnectedServiceRuntimeRegistry();
      const { owner: purposeOwner } = createForegroundPurposeOwnerFixture({
        consumer: { pluginId: 'happier.agent.codex', localId: 'codex' },
        service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' }, accountId: record.profileId,
        materializeAccount: async input => await materializeExactV021ConnectedServiceCredential({
          registry: runtimeFixture!.registry, serviceId: 'openai-codex', account: input.account,
          record, request: input.request, signal: input.signal,
        }),
      });
      const credentials = { token: 'fixture-token', encryption: { type: 'legacy' as const, secret: new Uint8Array(32).fill(7) } };
      const api = await ApiClient.create(credentials);
      const service = { pluginId: 'happier.agent.codex', localId: 'openai-codex' };
      const accounts = QualifiedConnectedAccountListResponseV4Schema.parse({ service, accounts: [{
        ref: { service, accountId: record.profileId }, status: 'connected', authenticationModeId: 'oauth',
        revisionSemantics: 'revisioned', credentialRevision: 'csr_aaaaaaaaaaaaaaaaaaaaaa',
        configurationReady: true, configurationRevision: null, kind: 'oauth', expiresAt: null, scopes: [],
      }] });
      if (freshSessionFirst) {
        // Ordinary Session preparation has no sealed Run at its materialization key.
        // Keep the real spawn/auth/home/registry path; only Account I/O is supplied.
        const fresh = await prepareDaemonConnectedServices({
          options: { directory: root, connectedServices: bindings,
            ...(!missingRequester ? { requesterWorkAttributionV1 } : {}) },
          normalizedExistingSessionId: '', requestedSessionId: 'ordinary-session', effectiveResume: '',
          catalogAgentId: 'codex', credentials, api, activeServerDir: params.activeServerDir,
          connectedServicesMaterializationBaseDir: params.baseDir,
          connectedServiceRefreshCoordinator: null, connectedAccountsOwner: purposeOwner,
          isAccountRuntimeCurrent: async () => true, processEnv: params.processEnv!,
          pluginRuntimeRegistry: runtimeFixture!.registry,
          activatePurposeBindings: input => purposeOwner.activatePurposeBindings(input),
          qualifiedConnectedAccountApi: { listAccounts: async () => accounts,
            readGroup: async () => { throw new Error('A profile-bound Session must not read a group'); } },
          accountSettingsSnapshot: { source: 'network', settingsVersion: 1, loadedAtMs: 1,
            settingsSecretsReadKeys: [], settings: AccountSettingsSchema.parse({
              connectedServicesProviderStateSharingSettingsV1: { v: 1,
                defaults: { configMode: 'isolated', stateMode: 'isolated' },
                byAgentId: {}, acknowledgedRisksByAgentId: {} },
            }) },
        });
        if (missingRequester) {
          expect(fresh).toMatchObject({ ok: false, result: { errorCode: 'SPAWN_VALIDATION_FAILED' } });
          expect((await lstat(join(home, 'sessions'))).isSymbolicLink()).toBe(true);
          expect(await readFile(join(home, 'sessions', siblingRolloutName), 'utf8')).toBe(siblingHistory);
        } else {
          expect(fresh).toMatchObject({ ok: true, auth: { env: { CODEX_HOME: home } } });
          if (!fresh.ok) throw new Error('Ordinary Session preparation refused');
          expect(fresh.sessionConnectedAccounts).toEqual([{
            purpose: 'primary', account: { service, accountId: record.profileId },
          }]);
          expect(existsSync(join(home, 'sessions', 'unrelated-session.jsonl'))).toBe(false);
          expect(existsSync(join(home, 'sessions', 'rollout-2026-09-07T12-00-00-019fea40-8040-7d00-9b7e-9b8f3b5cfcb0.jsonl'))).toBe(false);
          await fresh.auth?.cleanupOnExit?.();
        }
      }
      const bridge = createExecutionRunConnectedServicesBridge({
        // Account credential retrieval is the external boundary; retain the
        // spawn auth gate, home, catalog, purpose owner and Run registry.
        resolveAuthForSpawn: input => resolveConnectedServiceAuthForSpawn({
          ...input, activeServerDir: params.activeServerDir, baseDir: params.baseDir,
          accountSettings: params.accountSettings, processEnv: params.processEnv,
          allowNativeAccountState: false, connectedAccountsOwner: purposeOwner, credentials, api,
          qualifiedConnectedAccountApi: {
            listAccounts: async () => accounts,
            readGroup: async () => { throw new Error('A profile-bound Run must not read a group'); },
          },
        }),
        registerRunTargets: registration => { registry.registerRunTarget({ ...registration, pid: registration.runnerPid,
          connectedServicesBindingsRaw: registration.connectedServicesBindingsRaw }); },
        unregisterRunTargets: runKey => { registry.unregisterRunKey(runKey); },
        resolveRunMaterializedRoot: () => home,
        createAdoptedRootCleanup: () => null,
        captureRunnerIdentity: ({ runId }) => ({ identity: params,
          parentSessionId: runId === siblingRunId ? siblingSessionId : 'parent', isCurrent: () => true }),
        acquireAgentPurposeContributions: async () => ({
          contributions: runtimeFixture!.registry.contributes,
          catalogEntry: await runtimeFixture!.registry.acquireAgentCatalogEntry?.('codex'),
          resolveAgentContributionIdentity: async () => ({ pluginId: 'happier.agent.codex', localId: 'codex',
            sourceCustody: runtimeFixture!.registry.readPluginSourceCustody!('happier.agent.codex')! }),
          isCurrent: () => true, release: async () => undefined,
        }),
        purposeBindingOwner: { activatePurposeBindings: input => ({ lease: purposeOwner.activatePurposeBindings(input) }) },
        requestAuthRegistry: createConnectedAccountRequestAuthSubjectRegistry(),
        resolveRequestAuthHttpPort: () => 42427,
        createRedactionLease: () => ({ add() {}, close() {} }),
        clearTerminalCleanupReceipt: async () => undefined,
      });
      if (freshSessionFirst) {
        const siblingActivationId = randomUUID();
        const sibling = await bridge.materialize({ activationId: siblingActivationId,
          runId: siblingRunId, runnerPid: process.pid, agentId: 'codex', connectedServices: bindings, cwd: root });
        expect(sibling).toMatchObject({ ok: true, env: { CODEX_HOME: home } });
        expect(await readFile(join(home, 'sessions', siblingRolloutName), 'utf8')).toBe(siblingHistory);
        await bridge.release({ activationId: siblingActivationId, runId: siblingRunId, runnerPid: process.pid });
      }
      const activationId = randomUUID();
      const resumed = await bridge.materialize({ activationId, runId: params.materializationKey,
        runnerPid: process.pid, agentId: 'codex', connectedServices: bindings, cwd: root });
      if (missingState) {
        expect(resumed).toMatchObject({ ok: false, errorCode: 'provider_session_state_unavailable_for_resume' });
        if (resumed.ok) throw new Error('Missing conversation unexpectedly materialized');
        await expect(resolveExecutionRunConnectedServicesEnv({
          runId: params.materializationKey, backendId: 'codex', agentCatalogEntry: findCatalogEntry('codex'), backendSourceKind: 'built_in', cwd: root,
          resolvedSelection: { bindings, source: 'explicit', hadCredentials: true },
          deps: { runnerPid: process.pid, requestMaterialization: async () => resumed,
            release: async () => ({ ok: true, released: true }), readCredentials: async () => credentials,
            resolveSessionSpawnDefaults: async () => null },
        })).rejects.toMatchObject({ code: 'AGENT_RESUME_PROVIDER_STATE_MISSING',
          executionRunErrorCode: 'provider_session_state_unavailable_for_resume' });
        expect(existsSync(join(nativeHome, 'sessions', 'unrelated-session.jsonl'))).toBe(true);
        return;
      }
      expect(resumed).toMatchObject({ ok: true, env: { CODEX_HOME: home } });
      expect((await lstat(join(home, 'sessions'))).isSymbolicLink()).toBe(false);
      expect(await readFile(join(home, 'sessions', rolloutName), 'utf8')).toBe(publishedHistory);
      expect(await verifyResumeReachableThroughCatalog('codex', { targetMaterializedRoot: home, vendorResumeId }))
        .toMatchObject({ ok: true });
      expect(existsSync(join(home, 'sessions', 'unrelated-session.jsonl'))).toBe(false);
      expect(existsSync(join(home, 'sessions', 'rollout-2026-09-07T12-00-00-019fea40-8040-7d00-9b7e-9b8f3b5cfcb0.jsonl'))).toBe(false);
      expect(existsSync(join(home, 'sessions', 'rollout-2026-09-07T12-00-00-019fea40-8040-7d00-9b7e-9b8f3b5cfcb1.jsonl'))).toBe(false);
      expect(existsSync(join(home, 'sessions', 'rollout-2026-09-07T12-00-00-019fea40-8040-7d00-9b7e-9b8f3b5cfcb2.jsonl'))).toBe(false);
      // The source remains available to its original owner.
      expect(await readFile(join(nativeHome, 'sessions', rolloutName), 'utf8')).toContain(vendorResumeId);
      expect(await readFile(join(nativeHome, 'sessions', siblingRolloutName), 'utf8')).toBe(siblingHistory);
      const siblingActivationId = randomUUID();
      const sibling = await bridge.materialize({ activationId: siblingActivationId,
        runId: siblingRunId, runnerPid: process.pid, agentId: 'codex', connectedServices: bindings, cwd: root });
      expect(sibling).toMatchObject({ ok: true, env: { CODEX_HOME: home } });
      expect(await readFile(join(home, 'sessions', siblingRolloutName), 'utf8')).toBe(siblingHistory);
      expect(await readFile(join(home, 'sessions', rolloutName), 'utf8')).toBe(publishedHistory);
      await bridge.release({ activationId: siblingActivationId, runId: siblingRunId, runnerPid: process.pid });
      await bridge.release({ activationId, runId: params.materializationKey, runnerPid: process.pid });
    } finally { envScope.restore(); reloadConfiguration(); await rm(root, { recursive: true, force: true }); }
  });

  it('preserves a requester Session home through daemon startup sweep and pending-resume rematerialization', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-session-native-home-'));
    const envScope = createEnvKeyScope(['HAPPIER_HOME_DIR']);
    try {
      envScope.patch({ HAPPIER_HOME_DIR: join(root, 'cli') });
      reloadConfiguration();
      const materializationIdentity = { v: 1 as const, id: 'csm_retained-session', createdAt: 1_000 };
      const baseDir = resolveConnectedServicesMaterializationBaseDir(join(root, 'cli'));
      const directories = resolveRequesterSessionRuntimeDirectories({
        activeServerDir: join(root, 'server'), connectedServicesMaterializationBaseDir: baseDir,
        attribution: { accountId: 'requester-A' },
      });
      const params: MaterializeParams = {
        agentId: 'codex', materializationKey: materializationIdentity.id, activeServerDir: directories.activeServerDir,
        baseDir: directories.connectedServicesMaterializationBaseDir, recordsByServiceId: new Map(), allowNativeAccountState: false,
        isAccountRuntimeCurrent: async () => true,
      };
      const first = await materializeConnectedServicesForSpawnProduction(params);
      const home = first!.env.CODEX_HOME!;
      // Immediate cleanup cannot establish absence of a server Session reference.
      await first!.cleanupOnExit!();
      expect(existsSync(home)).toBe(true);
      await mkdir(join(home, 'sessions'), { recursive: true });
      await writeFile(join(home, 'sessions', 'rollout.jsonl'), '{"nativeSession":"session-thread"}\n');
      const shared = join(root, 'shared-native-sessions');
      await mkdir(shared);
      await writeFile(join(shared, 'another-session.jsonl'), 'another account');
      await symlink(shared, join(home, 'sessions', 'shared'), 'dir');
      // Restart loses all tracked processes. The custodian's complete Session
      // scan cannot reference a foreign requester's Session. Age the namespace
      // beyond the production orphan TTL, independently of the rollout's age.
      await utimes(join(baseDir, 'requester-accounts'), new Date(1_000), new Date(1_000));
      const restartedCleanup = createConnectedServiceMaterializedHomeCleanupScheduler({
        baseDir, trackedSessionsByKey: new Map(), nowMs: () => 8 * 24 * 60 * 60_000,
        orphanTtlMs: 7 * 24 * 60 * 60_000, getRetainedMaterializationKeys: async () => [],
      });
      await restartedCleanup.reconcile();
      expect(await readFile(join(home, 'sessions', 'rollout.jsonl'), 'utf8')).toContain('session-thread');
      const resumedOptions = buildInactiveSessionResumeSpawnOptions({
        sessionId: 'session', rawSession: { path: root, machineId: 'machine' },
        metadata: { path: root, machineId: 'machine', flavor: 'codex', codexSessionId: 'session-thread',
          connectedServiceMaterializationIdentityV1: materializationIdentity },
      });
      expect(resumedOptions?.connectedServiceMaterializationIdentityV1).toEqual(materializationIdentity);
      const resumedDirectories = resolveRequesterSessionRuntimeDirectories({
        activeServerDir: join(root, 'server'), connectedServicesMaterializationBaseDir: baseDir,
        attribution: { accountId: 'requester-A' },
      });
      const second = await materializeConnectedServicesForSpawnProduction({ ...params,
        materializationKey: resumedOptions!.connectedServiceMaterializationIdentityV1!.id,
        activeServerDir: resumedDirectories.activeServerDir, baseDir: resumedDirectories.connectedServicesMaterializationBaseDir });
      expect(second!.env.CODEX_HOME).toBe(home);
      await second!.cleanupOnExit!();
      expect(await readFile(join(home, 'sessions', 'rollout.jsonl'), 'utf8')).toContain('session-thread');
      await expect(lstat(join(home, 'sessions', 'shared'))).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      envScope.restore(); reloadConfiguration(); await rm(root, { recursive: true, force: true });
    }
  });

  it('keeps isolated native rollout state on exit while its retained Run can resume', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-retained-run-native-home-'));
    const envScope = createEnvKeyScope(['HAPPIER_HOME_DIR']);
    try {
      envScope.patch({ HAPPIER_HOME_DIR: join(root, 'cli') });
      reloadConfiguration();
      const runId = 'retained-isolated-run';
      const materialized = await materializeConnectedServicesForSpawnProduction({
        agentId: 'codex', materializationKey: runId, activeServerDir: root,
        baseDir: join(root, 'materialized'), recordsByServiceId: new Map(), allowNativeAccountState: false,
        isAccountRuntimeCurrent: async () => true,
      });
      const rollout = join(materialized!.env.CODEX_HOME!, 'sessions', 'rollout.jsonl');
      await mkdir(join(materialized!.env.CODEX_HOME!, 'sessions'), { recursive: true });
      await writeFile(rollout, '{"nativeSession":"thread"}\n');
      await retainExecutionRunState({
        runId, callId: 'call', sidechainId: 'side', sessionId: null, depth: 0,
        intent: 'review', backendTarget: { kind: 'builtInAgent', agentId: 'codex' }, backendId: 'codex',
        instructions: '', permissionMode: 'read_only', retentionPolicy: 'resumable',
        runClass: 'bounded', ioMode: 'request_response', status: 'succeeded', startedAtMs: 1, finishedAtMs: 2,
        resumeHandle: { kind: 'provider_session.v1', backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' }, providerSessionId: 'thread' },
      });
      await materialized!.cleanupOnExit!();
      expect(await readFile(rollout, 'utf8')).toContain('thread');
      const resumed = await materializeConnectedServicesForSpawnProduction({
        agentId: 'codex', materializationKey: runId, activeServerDir: root,
        baseDir: join(root, 'materialized'), recordsByServiceId: new Map(), allowNativeAccountState: false,
        isAccountRuntimeCurrent: async () => true,
      });
      expect(await readFile(rollout, 'utf8')).toContain('thread');
      await resumed!.cleanupOnExit!();
    } finally {
      envScope.restore(); reloadConfiguration(); await rm(root, { recursive: true, force: true });
    }
  });

  it('materializes requester credentials without importing custodian native configuration or sessions', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-requester-native-isolation-'));
    const nativeHome = join(root, 'alice-codex');
    await mkdir(join(nativeHome, 'sessions'), { recursive: true });
    await writeFile(join(nativeHome, 'config.toml'), 'model = "alice-private-model"\n');
    await writeFile(join(nativeHome, 'sessions', 'alice.jsonl'), '{"private":"Alice"}\n');
    const record = buildConnectedServiceCredentialRecord({ now: 10, serviceId: 'openai-codex', profileId: 'bob',
      kind: 'oauth', expiresAt: 123, oauth: { accessToken: 'bob-access', refreshToken: 'bob-refresh', idToken: 'bob-id',
        scope: 'openid profile', tokenType: 'Bearer', providerAccountId: 'bob', providerEmail: null } });
    let result: Awaited<ReturnType<typeof materializeConnectedServicesForSpawn>> = null;
    try {
      const deniedRoot = resolveConnectedServiceMaterializedRootDir({ baseDir: join(root, 'denied-materialized'),
        agentId: 'codex', materializationKey: 'denied-bob-session' });
      await expect(materializeConnectedServicesForSpawn({ agentId: 'codex', materializationKey: 'denied-bob-session',
        activeServerDir: join(root, 'server'), baseDir: join(root, 'denied-materialized'),
        connectedAccountMaterializationAuthority: LEGACY_UNFENCED_ONE_SHOT_MATERIALIZATION_AUTHORITY,
        recordsByServiceId: new Map([['openai-codex', record]]), allowNativeAccountState: false,
        isAccountRuntimeCurrent: async () => false,
      })).rejects.toThrow('requester_account_context_unavailable');
      expect(existsSync(deniedRoot)).toBe(false);
      result = await materializeConnectedServicesForSpawn({ agentId: 'codex', materializationKey: 'bob-session',
        activeServerDir: join(root, 'server'), baseDir: join(root, 'bob-materialized'),
        connectedAccountMaterializationAuthority: LEGACY_UNFENCED_ONE_SHOT_MATERIALIZATION_AUTHORITY,
        recordsByServiceId: new Map([['openai-codex', record]]), allowNativeAccountState: false,
        accountSettings: { connectedServicesProviderStateSharingSettingsV1: {
          v: 1, defaults: { configMode: 'linked', stateMode: 'shared' }, byAgentId: {}, acknowledgedRisksByAgentId: {},
        } }, processEnv: { CODEX_HOME: nativeHome, HOME: root },
      });
      expect(result).not.toBeNull();
      const home = result!.env.CODEX_HOME!;
      expect(home).not.toBe(nativeHome);
      expect(await readFile(join(home, 'auth.json'), 'utf8')).toContain('bob-access');
      await expect(lstat(join(home, 'config.toml'))).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(lstat(join(home, 'sessions'))).rejects.toMatchObject({ code: 'ENOENT' });
      expect(await readFile(join(nativeHome, 'config.toml'), 'utf8')).toContain('alice-private-model');
    } finally {
      await result?.cleanupOnExit?.();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('persists the shared target materialized root for OpenCode continuity recovery', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-test-'));
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-server-test-'));
    const materializedRoot = resolveConnectedServiceMaterializedRootDir({
      baseDir,
      agentId: 'opencode',
      materializationKey: 'session-opencode',
    });
    const record = buildConnectedServiceCredentialRecord({
      now: 10,
      serviceId: 'openai-codex',
      profileId: 'work',
      kind: 'oauth',
      expiresAt: 123,
      oauth: {
        accessToken: 'access',
        refreshToken: 'refresh',
        idToken: 'id',
        scope: 'openid profile',
        tokenType: 'Bearer',
        providerAccountId: 'acct',
        providerEmail: null,
      },
    });

    const result = await materializeConnectedServicesForSpawn({
      agentId: 'opencode',
      materializationKey: 'session-opencode',
      activeServerDir,
      baseDir,
      recordsByServiceId: new Map([['openai-codex', record]]),
      connectedAccountMaterializationAuthority: LEGACY_UNFENCED_ONE_SHOT_MATERIALIZATION_AUTHORITY,
    });

    expect(result).not.toBeNull();
    expect(result!.env[HAPPIER_CONNECTED_SERVICE_TARGET_MATERIALIZED_ROOT_ENV_KEY]).toBe(
      materializedRoot,
    );
    expect(result!.requestAuthMaterializedRoot).toBeNull();
    expect(result!.env).not.toHaveProperty(
      'HAPPIER_CONNECTED_ACCOUNT_REQUEST_AUTH_CAPABILITY_PATH',
    );
    if (process.platform !== 'win32') {
      expect((await lstat(materializedRoot)).mode & 0o777).toBe(0o700);
    }
  });

  it('awaits promoted-root absence before the promoted spawn cleanup resolves', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-test-'));
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-server-test-'));
    const materializedRoot = resolveConnectedServiceMaterializedRootDir({
      baseDir,
      agentId: 'opencode',
      materializationKey: 'session-cleanup-receipt',
    });
    const record = buildConnectedServiceCredentialRecord({
      now: 10,
      serviceId: 'openai-codex',
      profileId: 'work',
      kind: 'oauth',
      expiresAt: 123,
      oauth: {
        accessToken: 'access',
        refreshToken: 'refresh',
        idToken: 'id',
        scope: 'openid profile',
        tokenType: 'Bearer',
        providerAccountId: 'acct',
        providerEmail: null,
      },
    });

    const result = await materializeConnectedServicesForSpawn({
      agentId: 'opencode',
      materializationKey: 'session-cleanup-receipt',
      activeServerDir,
      baseDir,
      recordsByServiceId: new Map([['openai-codex', record]]),
      connectedAccountMaterializationAuthority: LEGACY_UNFENCED_ONE_SHOT_MATERIALIZATION_AUTHORITY,
    });

    expect(result).not.toBeNull();
    expect(result!.cleanupOnExit).not.toBeNull();
    expect(existsSync(materializedRoot)).toBe(true);

    await result!.cleanupOnExit!();
    expect(existsSync(materializedRoot)).toBe(false);
    await expect(result!.cleanupOnExit!()).resolves.toBeUndefined();
  });

  it('retains destination Codex hook preferences when prior account context differs without linking hook definitions', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-codex-hooks-rematerialize-'));
    try {
      const sourceCodexHome = join(root, 'native');
      await mkdir(sourceCodexHome, { recursive: true });
      const hooks = '{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"echo fixture"}]}]}}\n';
      await writeFile(join(sourceCodexHome, 'hooks.json'), hooks);
      await writeFile(join(sourceCodexHome, 'config.toml'), 'model_context_window = 9223372036854775807\n');
      const record = buildConnectedServiceCredentialRecord({
        now: 10, serviceId: 'openai-codex', profileId: 'work', kind: 'oauth', expiresAt: null,
        oauth: { accessToken: 'fixture-access', refreshToken: 'fixture-refresh', idToken: 'fixture-id',
          scope: null, tokenType: null, providerAccountId: 'fixture-account', providerEmail: null },
      });
      const params: MaterializeParams = {
        agentId: 'codex', materializationKey: 'hook-profile', activeServerDir: join(root, 'server'), baseDir: join(root, 'profiles'),
        connectedAccountMaterializationAuthority: LEGACY_UNFENCED_ONE_SHOT_MATERIALIZATION_AUTHORITY,
        recordsByServiceId: new Map([['openai-codex', record]]),
        accountSettings: { connectedServicesProviderStateSharingSettingsV1: {
          v: 1, defaults: { configMode: 'linked', stateMode: 'isolated' }, byAgentId: {}, acknowledgedRisksByAgentId: {},
        } },
        processEnv: { CODEX_HOME: sourceCodexHome, HOME: root },
      };
      const first = await materializeConnectedServicesForSpawn(params);
      expect(first).not.toBeNull();
      const home = first!.env.CODEX_HOME!;
      const hookId = `${join(home, 'hooks.json')}:stop:0:0`;
      expect((await lstat(join(home, 'hooks.json'))).isSymbolicLink()).toBe(false);
      await writeFile(join(home, 'config.toml'),
        (await readFile(join(home, 'config.toml'), 'utf8')) + `\n[hooks.state.'${hookId}']\nenabled = false\ntrusted_hash = 'sha256:reviewed'\n`);
      const priorHome = join(resolveConnectedServiceHomeDir({
        activeServerDir: params.activeServerDir, serviceId: 'openai-codex', profileId: 'another-account', agentId: 'codex',
      }), 'codex-home');
      await mkdir(priorHome, { recursive: true });
      const priorHookId = `${join(priorHome, 'hooks.json')}:stop:0:0`;
      await writeFile(join(priorHome, 'config.toml'), `[hooks.state.'${priorHookId}']\nenabled = true\ntrusted_hash = 'sha256:other-account'\n`);
      const nativeHookId = `${join(sourceCodexHome, 'hooks.json')}:stop:0:0`;
      await writeFile(join(sourceCodexHome, 'config.toml'),
        `model_context_window = 9223372036854775807\n[hooks.state.'${nativeHookId}']\nenabled = true\ntrusted_hash = 'sha256:native'\n`);
      await writeFile(join(sourceCodexHome, 'hooks.json'), '{"hooks":{"Stop":[]}}\n');
      await expect(readFile(join(home, 'hooks.json'), 'utf8')).resolves.toBe(hooks);
      const second = await materializeConnectedServicesForSpawn({ ...params, runtimeDescriptorV1: {
        v: 1, agentId: 'codex', agent: {
          backendMode: 'appServer', home: 'connectedService', homePath: priorHome,
          connectedServiceId: 'openai-codex', connectedServiceProfileId: 'another-account',
        },
      } });
      expect(second!.env.CODEX_HOME).toBe(home);
      const retained = await readFile(join(home, 'config.toml'), 'utf8');
      expect(retained).toContain(hookId);
      expect(retained).toContain('enabled = false');
      expect(retained).toContain('sha256:reviewed');
      expect(retained).not.toContain(priorHookId);
      expect(retained).not.toContain('sha256:other-account');
      expect(retained).not.toContain(nativeHookId);
      expect(retained).toContain('9223372036854775807');
      expect(retained).not.toContain('.stage-');
      await expect(readFile(join(home, 'hooks.json'), 'utf8')).resolves.toBe('{"hooks":{"Stop":[]}}\n');
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('removes managed Codex home shares when settings are isolated', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-test-'));
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-server-test-'));
    const sourceCodexHome = await mkdtemp(join(tmpdir(), 'happier-source-codex-home-test-'));
    await writeFile(join(sourceCodexHome, 'config.toml'), 'model = "gpt-5.2-codex"\n');
    await mkdir(join(sourceCodexHome, 'prompts'), { recursive: true });
    await writeFile(join(sourceCodexHome, 'prompts', 'review.md'), 'Review prompt\n');
    await mkdir(join(sourceCodexHome, 'sessions'), { recursive: true });
    await writeFile(join(sourceCodexHome, 'sessions', 'rollout-shared.jsonl'), '{"id":"shared"}\n');
    const record = buildConnectedServiceCredentialRecord({
      now: 10,
      serviceId: 'openai-codex',
      profileId: 'work',
      kind: 'oauth',
      expiresAt: null,
      oauth: {
        accessToken: 'access',
        refreshToken: 'refresh',
        idToken: 'id',
        scope: 'user:inference user:profile user:sessions:claude_code',
        tokenType: null,
        providerAccountId: 'acct',
        providerEmail: null,
      },
    });

    const first = await materializeConnectedServicesForSpawn({
      agentId: 'codex',
      materializationKey: 'session-1',
      activeServerDir,
      baseDir,
      connectedAccountMaterializationAuthority: LEGACY_UNFENCED_ONE_SHOT_MATERIALIZATION_AUTHORITY,
      recordsByServiceId: new Map([['openai-codex', record]]),
      accountSettings: {
        connectedServicesProviderStateSharingSettingsV1: {
          v: 1,
          defaults: {
            configMode: 'linked',
            stateMode: 'isolated',
          },
          byAgentId: {
            codex: {
              configMode: 'linked',
              stateMode: 'shared',
            },
          },
          acknowledgedRisksByAgentId: {},
        },
      },
      processEnv: {
        CODEX_HOME: sourceCodexHome,
        HOME: tmpdir(),
      },
    });

    expect(first).not.toBeNull();
    const firstAuth = JSON.parse(await readFile(join(first!.env.CODEX_HOME!, 'auth.json'), 'utf8'));
    expect(firstAuth).toMatchObject({
      auth_mode: 'chatgptAuthTokens',
      access_token: 'access',
      refresh_token: '',
      tokens: { access_token: 'access', refresh_token: '' },
    });
    const copiedConfig = await readFile(join(first!.env.CODEX_HOME!, 'config.toml'), 'utf8');
    expect(copiedConfig).toContain('model = "gpt-5.2-codex"');
    expect(copiedConfig).toContain('cli_auth_credentials_store = "file"');
    await expect(readFile(join(first!.env.CODEX_HOME!, 'prompts', 'review.md'), 'utf8')).resolves.toBe('Review prompt\n');
    await expect(readFile(join(first!.env.CODEX_HOME!, 'sessions', 'rollout-shared.jsonl'), 'utf8')).resolves.toBe('{"id":"shared"}\n');

    const isolatedRecord = buildConnectedServiceCredentialRecord({
      now: 20,
      serviceId: 'openai-codex',
      profileId: 'work',
      kind: 'oauth',
      expiresAt: null,
      oauth: {
        accessToken: 'isolated-access',
        refreshToken: 'isolated-refresh',
        idToken: 'isolated-id',
        scope: 'user:inference user:profile user:sessions:claude_code',
        tokenType: null,
        providerAccountId: 'acct',
        providerEmail: null,
      },
    });

    // Simulate a predecessor-created materialized home before resume/replacement.
    await writeFile(join(first!.env.CODEX_HOME!, 'auth.json'), JSON.stringify({
      auth_mode: 'chatgpt',
      tokens: { access_token: 'historical-access', refresh_token: 'historical-refresh' },
    }));
    await mkdir(join(first!.env.CODEX_HOME!, 'accounts'), { recursive: true });
    await writeFile(join(first!.env.CODEX_HOME!, 'accounts', 'old.json'), '{"refresh_token":"historical-refresh"}');

    const second = await materializeConnectedServicesForSpawn({
      agentId: 'codex',
      materializationKey: 'session-1',
      activeServerDir,
      baseDir,
      connectedAccountMaterializationAuthority: LEGACY_UNFENCED_ONE_SHOT_MATERIALIZATION_AUTHORITY,
      recordsByServiceId: new Map([['openai-codex', isolatedRecord]]),
      accountSettings: {
        connectedServicesProviderStateSharingSettingsV1: {
          v: 1,
          defaults: {
            configMode: 'linked',
            stateMode: 'isolated',
          },
          byAgentId: {
            codex: {
              configMode: 'isolated',
              stateMode: 'isolated',
            },
          },
          acknowledgedRisksByAgentId: {},
        },
      },
      processEnv: {
        CODEX_HOME: sourceCodexHome,
        HOME: tmpdir(),
      },
    });

    expect(second).not.toBeNull();
    const auth = JSON.parse(await readFile(join(second!.env.CODEX_HOME!, 'auth.json'), 'utf8'));
    expect(auth.access_token).toBe('isolated-access');
    expect(auth).toMatchObject({
      auth_mode: 'chatgptAuthTokens',
      refresh_token: '',
      tokens: { access_token: 'isolated-access', refresh_token: '' },
    });
    // The rust-v0.162.1 file-auth backend owns auth.json, not this account-local
    // directory. The descriptor excludes it from sharing; a partial credential
    // projection must not turn that exclusion into ownership of private state.
    expect((await lstat(join(second!.env.CODEX_HOME!, 'accounts'))).isSymbolicLink()).toBe(false);
    expect(await readFile(join(second!.env.CODEX_HOME!, 'accounts', 'old.json'), 'utf8'))
      .toBe('{"refresh_token":"historical-refresh"}');
    await expect(lstat(join(second!.env.CODEX_HOME!, 'config.toml'))).rejects.toThrow();
    await expect(lstat(join(second!.env.CODEX_HOME!, 'prompts'))).rejects.toThrow();
    await expect(lstat(join(second!.env.CODEX_HOME!, 'sessions'))).rejects.toThrow();
  });

  it('materializes the exact-v0.2.1 OpenCode XDG auth file without probing the refresh token', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-test-'));
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-server-test-'));
    const codex = buildConnectedServiceCredentialRecord({
      now: 10,
      serviceId: 'openai-codex',
      profileId: 'work',
      kind: 'oauth',
      expiresAt: 123,
      oauth: {
        accessToken: 'access',
        refreshToken: 'refresh',
        idToken: null,
        scope: null,
        tokenType: null,
        providerAccountId: 'acct',
        providerEmail: null,
      },
    });
    const claude = buildConnectedServiceCredentialRecord({
      now: 10,
      serviceId: 'anthropic',
      profileId: 'personal',
      kind: 'token',
      token: { token: 'sk-ant-123', providerAccountId: null, providerEmail: 'user@example.com' },
    });
    const fetchMock = vi.fn(async () => {
      throw new Error('OAuth refresh must not be probed during materialization');
    });
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    const result = await materializeConnectedServicesForSpawn({
      agentId: 'opencode',
      materializationKey: 'session-2',
      activeServerDir,
      baseDir,
      recordsByServiceId: new Map([
        ['openai-codex', codex],
        ['anthropic', claude],
      ]),
      connectedAccountMaterializationAuthority: LEGACY_UNFENCED_ONE_SHOT_MATERIALIZATION_AUTHORITY,
    });

    expect(result).not.toBeNull();
    expect(result!.env.HOME).toBeTruthy();
    expect(result!.env.XDG_DATA_HOME).toBeTruthy();
    expect(result!.env.OPENCODE_TEST_HOME).toBe(result!.env.HOME);
    const auth = JSON.parse(await readFile(
      join(result!.env.XDG_DATA_HOME, 'opencode', 'auth.json'),
      'utf8',
    ));
    expect(auth).toEqual({
      openai: {
        type: 'oauth',
        refresh: 'refresh',
        access: 'access',
        expires: 123,
        accountId: 'acct',
      },
      anthropic: { type: 'api', key: 'sk-ant-123' },
    });
    expect(result!.env).not.toHaveProperty('HAPPIER_CONNECTED_ACCOUNT_REQUEST_AUTH_CAPABILITY_PATH');
    expect(fetchMock).not.toHaveBeenCalled();

    result!.cleanupOnFailure?.();
    result!.cleanupOnExit?.();
    vi.unstubAllGlobals();
  });

  it('materializes the exact-v0.2.1 OpenCode XDG auth file with OpenAI API key credentials', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-test-'));
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-server-test-'));
    const openai = buildConnectedServiceCredentialRecord({
      now: 10,
      serviceId: 'openai',
      profileId: 'work',
      kind: 'token',
      token: {
        token: 'sk-openai-test',
        providerAccountId: null,
        providerEmail: null,
      },
    });

    const result = await materializeConnectedServicesForSpawn({
      agentId: 'opencode',
      materializationKey: 'session-2-openai',
      activeServerDir,
      baseDir,
      connectedAccountMaterializationAuthority: LEGACY_UNFENCED_ONE_SHOT_MATERIALIZATION_AUTHORITY,
      recordsByServiceId: new Map([
        ['openai', openai],
      ]),
    });

    expect(result).not.toBeNull();
    expect(result!.env.HOME).toBeTruthy();
    expect(result!.env.XDG_DATA_HOME).toBeTruthy();
    const auth = JSON.parse(await readFile(
      join(result!.env.XDG_DATA_HOME, 'opencode', 'auth.json'),
      'utf8',
    ));
    expect(auth).toEqual({
      openai: {
        type: 'api',
        key: 'sk-openai-test',
      },
    });
  });

  it('keeps OpenCode oauth materialization local when the network would reject the refresh token', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-test-'));
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-server-test-'));
    const codex = buildConnectedServiceCredentialRecord({
      now: 10,
      serviceId: 'openai-codex',
      profileId: 'work',
      kind: 'oauth',
      expiresAt: 123,
      oauth: {
        accessToken: 'access',
        refreshToken: 'stale-refresh',
        idToken: null,
        scope: null,
        tokenType: null,
        providerAccountId: 'acct',
        providerEmail: null,
      },
    });
    const fetchMock = vi.fn(async () => ({
      ok: false,
      status: 401,
      statusText: 'Unauthorized',
      text: async () => JSON.stringify({
        error: {
          message: 'Your refresh token has already been used to generate a new access token. Please try signing in again.',
          type: 'invalid_request_error',
        },
      }),
    }));
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    const result = await materializeConnectedServicesForSpawn({
      agentId: 'opencode',
      materializationKey: 'session-2-stale',
      activeServerDir,
      baseDir,
      recordsByServiceId: new Map([
        ['openai-codex', codex],
      ]),
      connectedAccountMaterializationAuthority: LEGACY_UNFENCED_ONE_SHOT_MATERIALIZATION_AUTHORITY,
    });

    expect(await readFile(
      join(result!.env.XDG_DATA_HOME, 'opencode', 'auth.json'),
      'utf8',
    )).toContain('stale-refresh');
    expect(fetchMock).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('materializes exact-v0.2.1 Pi raw auth and Anthropic environment', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-test-'));
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-server-test-'));
    const codex = buildConnectedServiceCredentialRecord({
      now: 10,
      serviceId: 'openai-codex',
      profileId: 'work',
      kind: 'oauth',
      expiresAt: 123,
      oauth: {
        accessToken: 'access',
        refreshToken: 'refresh',
        idToken: null,
        scope: null,
        tokenType: null,
        providerAccountId: 'acct',
        providerEmail: null,
      },
    });
    const claudeSetup = buildConnectedServiceCredentialRecord({
      now: 10,
      serviceId: 'anthropic',
      profileId: 'work',
      kind: 'token',
      token: { token: 'sk-ant-123', providerAccountId: null, providerEmail: null },
    });

    const result = await materializeConnectedServicesForSpawn({
      agentId: 'pi',
      materializationKey: 'session-3',
      activeServerDir,
      baseDir,
      recordsByServiceId: new Map([
        ['openai-codex', codex],
        ['anthropic', claudeSetup],
      ]),
      connectedAccountMaterializationAuthority: LEGACY_UNFENCED_ONE_SHOT_MATERIALIZATION_AUTHORITY,
    });

    expect(result).not.toBeNull();
    expect(result!.env.PI_CODING_AGENT_DIR).toBe(
      join(resolveConnectedServiceMaterializedRootDir({
        baseDir,
        agentId: 'pi',
        materializationKey: 'session-3',
      }), 'pi-agent-dir'),
    );
    if (process.platform !== 'win32') {
      expect((await lstat(resolveConnectedServiceMaterializedRootDir({
        baseDir,
        agentId: 'pi',
        materializationKey: 'session-3',
      }))).mode & 0o777).toBe(0o700);
    }
    expect(result!.env.ANTHROPIC_API_KEY).toBe('sk-ant-123');

    const authPath = join(result!.env.PI_CODING_AGENT_DIR, 'auth.json');
    const auth = JSON.parse(await readFile(authPath, 'utf8'));
    expect(auth).toEqual({
      'openai-codex': {
        type: 'oauth',
        refresh: 'refresh',
        access: 'access',
        expires: 123,
        accountId: 'acct',
      },
    });
    expect(result!.env).not.toHaveProperty('HAPPIER_CONNECTED_ACCOUNT_REQUEST_AUTH_CAPABILITY_PATH');

    result!.cleanupOnFailure?.();
    result!.cleanupOnExit?.();
  });

  it('materializes Pi auth.json with OpenAI API key credentials', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-test-'));
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-server-test-'));
    const openai = buildConnectedServiceCredentialRecord({
      now: 10,
      serviceId: 'openai',
      profileId: 'work',
      kind: 'token',
      token: {
        token: 'sk-openai-test',
        providerAccountId: null,
        providerEmail: null,
      },
    });

    const result = await materializeConnectedServicesForSpawn({
      agentId: 'pi',
      materializationKey: 'session-3-openai',
      activeServerDir,
      baseDir,
      connectedAccountMaterializationAuthority: LEGACY_UNFENCED_ONE_SHOT_MATERIALIZATION_AUTHORITY,
      recordsByServiceId: new Map([
        ['openai', openai],
      ]),
    });

    expect(result).not.toBeNull();
    expect(result!.env.PI_CODING_AGENT_DIR).toBe(
      join(resolveConnectedServiceMaterializedRootDir({
        baseDir,
        agentId: 'pi',
        materializationKey: 'session-3-openai',
      }), 'pi-agent-dir'),
    );

    const authPath = join(result!.env.PI_CODING_AGENT_DIR, 'auth.json');
    const auth = JSON.parse(await readFile(authPath, 'utf8'));
    expect(auth).toEqual({
      openai: {
        type: 'api_key',
        key: 'sk-openai-test',
      },
    });
  });

  it('does not export PI_CODING_AGENT_SESSION_DIR when Pi state sharing is enabled', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-test-'));
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-server-test-'));
    const openai = buildConnectedServiceCredentialRecord({
      now: 10,
      serviceId: 'openai',
      profileId: 'work',
      kind: 'token',
      token: {
        token: 'sk-openai-test',
        providerAccountId: null,
        providerEmail: null,
      },
    });

    const result = await materializeConnectedServicesForSpawn({
      agentId: 'pi',
      materializationKey: 'session-3-openai',
      activeServerDir,
      baseDir,
      connectedAccountMaterializationAuthority: LEGACY_UNFENCED_ONE_SHOT_MATERIALIZATION_AUTHORITY,
      recordsByServiceId: new Map([
        ['openai', openai],
      ]),
      accountSettings: {
        connectedServicesProviderStateSharingSettingsV1: {
          v: 1,
          defaults: {
            configMode: 'linked',
            stateMode: 'isolated',
          },
          byAgentId: {
            pi: {
              stateMode: 'shared',
            },
          },
          acknowledgedRisksByAgentId: {},
        },
      },
    });

    expect(result).not.toBeNull();
    expect(result!.env).not.toHaveProperty('PI_CODING_AGENT_SESSION_DIR');
  });

  it('keeps Claude credentials isolated while reconciling configuration sharing independently of unchanged credentials', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-test-'));
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-server-test-'));
    const sourceClaudeConfigDir = await mkdtemp(join(tmpdir(), 'happier-source-claude-config-test-'));
    const setup = buildConnectedServiceCredentialRecord({
      now: 10,
      serviceId: 'claude-subscription',
      profileId: 'work',
      kind: 'token',
      token: { token: 'sk-ant-oat01-123', providerAccountId: null, providerEmail: null },
    });
    await writeFile(join(sourceClaudeConfigDir, 'settings.json'), '{"permissions":{"allow":["Bash(*)"]}}\n');

    const params = {
      agentId: 'claude',
      materializationKey: 'session-6a',
      activeServerDir,
      baseDir,
      connectedAccountMaterializationAuthority: LEGACY_UNFENCED_ONE_SHOT_MATERIALIZATION_AUTHORITY,
      recordsByServiceId: new Map([['claude-subscription', setup]]),
      processEnv: {
        ...process.env,
        CLAUDE_CONFIG_DIR: sourceClaudeConfigDir,
      },
    } satisfies MaterializeParams;
    const result = await materializeConnectedServicesForSpawn(params);
    expect(result).not.toBeNull();
    expect(JSON.parse(await readFile(join(result!.env.CLAUDE_CONFIG_DIR, '.credentials.json'), 'utf8'))).toEqual({
      claudeAiOauth: {
        accessToken: 'sk-ant-oat01-123',
        scopes: ['user:inference'],
      },
    });
    expect(result!.env).not.toHaveProperty('CLAUDE_CODE_OAUTH_TOKEN');
    expect(result!.env).not.toHaveProperty('CLAUDE_CODE_SETUP_TOKEN');
    const target = result!.env.CLAUDE_CONFIG_DIR;
    expect((await lstat(join(target, 'settings.json'))).isSymbolicLink()).toBe(true);
    expect((await lstat(join(target, '.credentials.json'))).isSymbolicLink()).toBe(false);
    await writeFile(join(sourceClaudeConfigDir, 'settings.json'), '{"theme":"updated"}\n');
    expect(JSON.parse(await readFile(join(target, 'settings.json'), 'utf8'))).toEqual({ theme: 'updated' });

    const copiedParams = {
      ...params,
      accountSettings: { connectedServicesProviderStateSharingSettingsV1: {
        v: 1, defaults: { configMode: 'copied', stateMode: 'isolated' },
      } },
    } satisfies MaterializeParams;
    await materializeConnectedServicesForSpawn(copiedParams);
    expect((await lstat(join(target, 'settings.json'))).isSymbolicLink()).toBe(false);
    const copiedSettingsIdentity = await lstat(join(target, 'settings.json'));
    await writeFile(join(sourceClaudeConfigDir, 'settings.json'), '{"theme":"refreshed"}\n');
    await materializeConnectedServicesForSpawn(copiedParams);
    if (process.platform !== 'win32') {
      expect((await lstat(join(target, 'settings.json'))).ino).toBe(copiedSettingsIdentity.ino);
    }
    expect(JSON.parse(await readFile(join(target, 'settings.json'), 'utf8'))).toEqual({ theme: 'refreshed' });

    await materializeConnectedServicesForSpawn({
      ...params,
      accountSettings: { connectedServicesProviderStateSharingSettingsV1: {
        v: 1, defaults: { configMode: 'isolated', stateMode: 'isolated' },
      } },
    });
    await expect(lstat(join(target, 'settings.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(JSON.parse(await readFile(join(target, '.credentials.json'), 'utf8')).claudeAiOauth.accessToken)
      .toBe('sk-ant-oat01-123');
  });
});
