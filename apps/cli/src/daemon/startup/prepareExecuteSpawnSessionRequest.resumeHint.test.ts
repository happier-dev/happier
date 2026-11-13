import fileSystem, { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import type { ConnectedServiceBindingsV2 } from '@happier-dev/protocol';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join, relative, isAbsolute } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { accountSettingsParse, QualifiedConnectedAccountListResponseV4Schema } from '@happier-dev/protocol';
import {
  createPlainSessionOwnerMetadataEnvelopeV1, createSessionOwnerMetadataV1, projectSessionSharedMetadataV1,
} from '@happier-dev/protocol/sessions/metadata/sessionMetadataSchemasV1';
import { writeProviderSessionIdSessionState } from '../../../../../packages/agents/src/session/state/bindings/providerSessionId';
import { captureSessionLaunchControlMetadata, createSessionMetadata } from '@/agent/runtime/createSessionMetadata';
import type { ApiClient } from '@/api/api';
import { createForegroundPurposeOwnerFixture } from '@/daemon/agentRuntime/prepareForegroundAdmission.connectedServices.testkit';
import { prepareDaemonConnectedServices } from '@/daemon/spawn/prepareDaemonConnectedServices';
import { resolveInactiveConnectedServiceSessionContext } from '@/daemon/connectedServices/sessionAuthSwitch/persistedState';
import { resolveTrackedConnectedServiceSwitchContinuityContext } from '@/daemon/connectedServices/sessionAuthSwitch/resolveTrackedConnectedServiceSwitchContinuityContext';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { createAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { validateEnvVarRecordStrict } from '@/terminal/runtime/envVarSanitization';
import { prepareExecuteSpawnSessionRequest } from './prepareExecuteSpawnSessionRequest';

// Observe the real filesystem boundary, including SDK imports loaded before spies.
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual,
    open: (...args: Parameters<typeof actual.open>) => actual.open(...args),
    readdir: (...args: Parameters<typeof actual.readdir>) => actual.readdir(...args),
  };
});
const home = vi.hoisted(() => ({ session: vi.fn(), encryption: vi.fn() }));
vi.mock('@/session/transport/http/sessionsHttp', async importOriginal => ({
  ...await importOriginal<typeof import('@/session/transport/http/sessionsHttp')>(),
  fetchSessionByIdCompat: home.session,
}));
vi.mock('@/api/client/connectedServiceCredentialApi', async importOriginal => ({
  ...await importOriginal<typeof import('@/api/client/connectedServiceCredentialApi')>(),
  fetchAccountEncryptionCurrentness: home.encryption,
}));

describe('persisted Claude resume → connected-service target reachability', () => {
  let runtime: Awaited<ReturnType<typeof createAdmittedPluginRuntimeFixture>>;
  beforeAll(async () => {
    runtime = await createAdmittedPluginRuntimeFixture({ controller: pluginReloadController,
      runtimeOptions: { pluginIds: ['happier.agent.claude'] } });
  });
  afterAll(async () => { await runtime?.dispose(); await pluginReloadController.shutdown(); });

  it.each(['flat', 'owner'] as const)('reads one hinted transcript and traverses zero candidates in a store of 4,097 sessions (%s metadata)', async layout => {
    const root = await mkdtemp(join(tmpdir(), 'resume-hint-spawn-'));
    const native = join(root, 'native');
    const projects = join(native, 'projects');
    const store = join(projects, '-project');
    const id = '019e7327-46cc-7dca-bb14-8473727db321';
    const transcript = join(store, `${id}.jsonl`);
    const service = { pluginId: 'happier.agent.claude', localId: 'claude-subscription' };
    const bindings: ConnectedServiceBindingsV2 = { v: 2, bindingsByServiceId: {
      'happier.agent.claude/claude-subscription': { source: 'connected', selection: 'profile', profileId: 'work' },
    } };
    const identity = { v: 1, id: 'csm_resume_hint_fixture', createdAt: 1, source: 'first_spawn' } as const;
    const credentials = { token: 'synthetic-owner', encryption: null };
    const { owner } = createForegroundPurposeOwnerFixture({ consumer: { pluginId: service.pluginId, localId: 'claude' },
      service, accountId: 'work',
      materializeAccount: async () => ({ kind: 'files', files: { '.credentials.json': Buffer.from('{"token":"fixture"}') } }),
    });
    let result: Awaited<ReturnType<typeof prepareDaemonConnectedServices>> | undefined;
    try {
      await mkdir(store, { recursive: true });
      await Promise.all(Array.from({ length: 4096 }, (_, index) => writeFile(join(store, `000-unrelated-${index}.jsonl`), '{}\n')));
      await writeFile(transcript, `{"sessionId":"${id}"}\n`);
      const { metadata: initial } = createSessionMetadata({ flavor: 'claude', directory: '/project',
        machineId: 'machine-resume-hint', startedBy: 'daemon', runtimeDescriptorV1: { v: 1, agentId: 'claude', agent: {} },
        launchControlMetadata: captureSessionLaunchControlMetadata({ processEnvironment: {} }) });
      const metadata = writeProviderSessionIdSessionState({ ...initial, connectedServices: bindings,
        connectedServiceMaterializationIdentityV1: identity },
      { metadataKey: 'claudeSessionId', value: id, nativeSessionLogPath: transcript });
      const envelope = createSessionOwnerMetadataV1({ metadata });
      if (!envelope.ok) throw new Error('Invalid resume owner metadata');
      home.encryption.mockResolvedValue({ mode: 'plain', version: 1, signingKeyFingerprint: null,
        contentKeyFingerprint: null, updatedAt: 1 });
      home.session.mockResolvedValue({ id: 'resume-hint-session', seq: 1, active: false, encryptionMode: 'plain',
        metadataVersion: 1, agentStateVersion: 0, agentState: null, dataEncryptionKey: null,
        ...(layout === 'owner' ? { metadataLayoutVersion: 1,
          metadata: JSON.stringify(projectSessionSharedMetadataV1({ metadata })),
          ownerMetadata: createPlainSessionOwnerMetadataEnvelopeV1(envelope.ownerMetadata),
        } : { metadata: JSON.stringify(metadata) }) });
      const prepared = await prepareExecuteSpawnSessionRequest({ request: { credentials,
        options: { directory: '/project', existingSessionId: 'resume-hint-session' } }, validateEnvVarRecordStrict });
      if ('type' in prepared) throw new Error(`Resume preparation failed: ${prepared.type}`);
      const accounts = QualifiedConnectedAccountListResponseV4Schema.parse({ service, accounts: [{
        ref: { service, accountId: 'work' }, status: 'connected', authenticationModeId: 'oauth',
        revisionSemantics: 'revisioned', credentialRevision: 'csr_aaaaaaaaaaaaaaaaaaaaaa',
        configurationReady: true, configurationRevision: null, kind: 'oauth', expiresAt: null, scopes: [],
      }] });
      const settings = accountSettingsParse({ connectedServicesProviderStateSharingSettingsV1: {
        v: 1, defaults: { configMode: 'isolated', stateMode: 'isolated' },
        byAgentId: { claude: { stateMode: 'shared' } }, acknowledgedRisksByAgentId: { claude: true },
      } });
      const opens = vi.spyOn(fileSystem, 'open');
      const reads = vi.spyOn(fileSystem, 'readdir');
      syncBuiltinESMExports();
      try {
        result = await prepareDaemonConnectedServices({ options: { ...prepared, directory: prepared.directory },
          normalizedExistingSessionId: prepared.normalizedExistingSessionId, requestedSessionId: 'resume-hint-session',
          effectiveResume: prepared.effectiveResume, catalogAgentId: prepared.catalogAgentId,
          candidatePersistedSessionFile: prepared.candidatePersistedSessionFile,
          credentials,
          // Home credential bytes are the external boundary; this path uses the qualified owner below.
          api: {} as ApiClient, connectedAccountsOwner: owner, qualifiedConnectedAccountApi: {
            listAccounts: async () => accounts, readGroup: async () => { throw new Error('Unexpected group read'); },
          }, activatePurposeBindings: owner.activatePurposeBindings,
          accountSettingsSnapshot: { source: 'network', settings, settingsVersion: 1, loadedAtMs: 1, settingsSecretsReadKeys: [] },
          connectedServiceRefreshCoordinator: null, activeServerDir: join(root, 'server'),
          connectedServicesMaterializationBaseDir: join(root, 'materialized'),
          processEnv: { HOME: root, USERPROFILE: root, CLAUDE_CONFIG_DIR: native },
          pluginRuntimeRegistry: runtime.registry,
        });
        expect(result).toMatchObject({ ok: true, auth: { env: { CLAUDE_CONFIG_DIR: expect.any(String) } } });
        const beneathProjects = (path: unknown) => {
          if (typeof path !== 'string') return false;
          const rel = relative(projects, path);
          return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
        };
        const transcriptOpens = opens.mock.calls.filter(([path]) => beneathProjects(path));
        expect(transcriptOpens).toHaveLength(1);
        expect(transcriptOpens.map(([path]) => path)).toEqual([transcript]);
        expect(reads.mock.calls.filter(([path]) => beneathProjects(path))).toHaveLength(0);
      } finally { opens.mockRestore(); reads.mockRestore(); syncBuiltinESMExports(); }
      const inactive = await resolveInactiveConnectedServiceSessionContext({ token: credentials.token,
        credentials, sessionId: 'resume-hint-session', currentMachineId: 'machine-resume-hint' });
      expect(inactive).toMatchObject({ vendorResumeId: id, candidatePersistedSessionFile: transcript });
      for (const tracked of [null, { spawnOptions: { directory: '/project' }, vendorResumeId: id, happySessionMetadataFromLocalWebhook: metadata }]) {
        expect(resolveTrackedConnectedServiceSwitchContinuityContext({ agentId: 'claude',
          baseDir: join(root, 'materialized'), tracked, persistedSessionMetadata: metadata,
        })).toMatchObject({ vendorResumeId: id, candidatePersistedSessionFile: transcript });
      }
    } finally {
      if (result?.ok) { await result.auth?.materializationPurposeLease?.dispose(); await result.auth?.cleanupOnExit?.(); }
      await rm(root, { recursive: true, force: true });
    }
  });
});
