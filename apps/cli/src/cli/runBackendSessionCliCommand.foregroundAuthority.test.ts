import { setStdioTtyForTest } from '@/testkit/process/stdio';
import { artifactListResponse } from '@/testkit/http/artifactHome';
import { absentAccountPluginAvailabilityHttpResponse } from '@/testkit/http/accountPluginAvailability';
import { handleConfiguredAcpCatalogCliCommand } from '@/agent/acp/catalog/configured/handleCatalogCliCommand';
import { dispatchCli } from './dispatch';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import fs from 'fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { accountSettingsParse, FeaturesResponseSchema } from '@happier-dev/protocol';
import { AcpCatalogRecordV1Schema } from '@happier-dev/protocol/acp/catalog/catalogRowsV1';
import { CUSTOM_ACP_AGENT_CONTRIBUTION_IDENTITY_V1 } from '@happier-dev/protocol/agents/executionTargetV1';
import { buildBackendTargetKeyV2 } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';
import { StoredSessionOwnerMetadataEnvelopeV1Schema } from '@happier-dev/protocol/sessions/metadata/sessionMetadataSchemasV1';
import { formatAccountApiTokenCredentialV1 } from '@happier-dev/protocol/auth/accountApiTokens';
import { encodeBase64 } from '@happier-dev/protocol/crypto/base64';

import { configuration, reloadConfiguration } from '@/configuration';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { acquireAuthoritativePluginRuntimeRegistryLease } from '@/plugins/runtime/reload/runtimeLease';
import { createAccountEncryptionCurrentnessFixture, createSessionRecordFixture } from '@/testkit/backends/sessionFixtures';
import { createAdmittedPluginRuntimeFixture, createAuthoredAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { createPluginManifestV2Fixture } from '@/plugins/testkit/manifestV2Fixture';
import { readStoredCredentials, writeCredentialsTokenOnly, writeDaemonState } from '@/persistence';
import { resetActiveAccountSettingsSnapshotForTests, setActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import { projectPath } from '@/projectPath';
import { resolveComparableCliVersion } from '@/daemon/resolveComparableCliVersion';
import { prepareForegroundAgentRuntimeBootstrapForLease } from '@/daemon/spawn/prepareAgentRuntimeSessionBridge';
import { HAPPIER_AGENT_RUNTIME_RUNNER_BOOTSTRAP_FILE_ENV_KEY } from '@/agent/runtime/session/process/agentRuntimeRunnerProtocol';
import { HAPPIER_AGENT_RUNTIME_DAEMON_SERVICE_AUTHORITY_FILE_ENV_KEY } from '@/daemon/agentRuntime/sessionBridgeAuthorization';
import { readRunnerAgentSessionBootstrap } from '@/agent/runtime/session/process/runnerAgentSessionBootstrap';
import { FOREGROUND_AGENT_RUNTIME_ADMISSION_PATH, FOREGROUND_AGENT_RUNTIME_RELEASE_PATH, FOREGROUND_AGENT_RUNTIME_SESSION_OPTIONS_PATH,
  ForegroundAgentRuntimeSessionOptionsRequestV1Schema, ForegroundAgentRuntimeAdmissionRequestV1Schema, ForegroundAgentRuntimeAdmissionResponseV1Schema } from '@/daemon/agentRuntime/foregroundAdmissionContract';
import { runBackendSessionCliCommand } from './runBackendSessionCliCommand';
import { SessionSpawnLaunchErrorV1Schema } from '@happier-dev/protocol/spawnSession';
import { AGENT_CLI_MISSING_PREVIEW } from '@/packagedRuntime/managedTools/agentCliNotFoundError';
import { runAddedHostedSession } from '@/agent/runtime/lifecycle/hostedSessionScope';
import { projectAgentCliSessionCommandCatalogEntry } from '@/plugins/projection/registry/agentCatalogEntryHooks';
import { PI_PLUGIN } from '@happier-dev/plugins-pi/manifest';
import { OH_MY_PI_PLUGIN } from '@happier-dev/plugins-ohmypi/manifest';
import { resolveSessionFileStoreDirsSync } from '@happier-dev/plugin-sdk/sessions/file-stores';
import { PI_SESSION_FILE_STORE_DESCRIPTOR_V1 } from '../../../../packages/plugins/pi/src/agent/sessionFileStoreDescriptor';
import { createPluginTestkit } from '@happier-dev/plugin-sdk/testing';
import { bindProcessLogger, Logger } from '@/ui/logger';
import { CliApiTokenChildContinuationError } from '@/auth/cliApiToken';
import { attemptNativeForkOpen } from '@/session/actions/lifecycle/fork/attemptNativeForkOpen';
import { buildHappySessionControlArgs } from '@/daemon/sessionSpawnArgs';
import { prepareForegroundAgentRuntimeAdmission } from '@/daemon/agentRuntime/prepareForegroundAdmission';
import { projectCurrentAgentSessionView } from '@happier-dev/agents';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { SessionSpawnNewInputV2Schema } from '@happier-dev/protocol/sessions/creation/sessionSpawnNewInputV2';
import { readSessionCreationTargetPreparationResultV1 } from '@happier-dev/protocol/sessions/creation/sessionCreationTargetPreparationV1';
import type { RpcHandler } from '@/api/rpc/types';
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { registerMachineTerminalRpcHandlers } from '@/api/machine/rpcHandlers.terminal';
import { registerSessionCreationDirectoryPreflightRpc } from '@/session/creation/registerSessionCreationTargetPreparationRpc';
import { createTerminalPtySessionManager } from '@/terminal/pty/sessions';
import { readDaemonTerminalPtyConfig } from '@/terminal/pty/config';
import type { PtySpawnParams } from '@/terminal/pty/provider';
import { resolveDefaultDirectoryForMachine } from '../../../ui/sources/utils/sessions/machineDefaultDirectory';

afterEach(() => { vi.restoreAllMocks(); reloadConfiguration(); });

type ForegroundAuthorityCase = Readonly<{
  prior: string | undefined; definitionId: string | undefined; missingCli: boolean; profileRouting?: boolean;
  disabled?: boolean; explicitProfile?: boolean; fileStoreAgent?: 'pi' | 'ohmypi'; hostedScope?: string;
  providerConnectionId?: string;
  policyHandoff?: boolean | 'approval' | 'attach' | 'missing-cli' | 'fresh-directory' | 'member-terminal' | 'member-attach';
  nativeForkPolicy?: 'directly' | 'sandbox';
  modelSelection?: 'native' | 'provider';
  diagnosticDebug?: Readonly<{ host: string | undefined; session: string | undefined }>;
}>;

describe('foreground CLI runner authority scope', () => {
  it.each<ForegroundAuthorityCase>([
    { prior: undefined, definitionId: undefined, missingCli: false, nativeForkPolicy: 'directly' },
    { prior: undefined, definitionId: undefined, missingCli: false, nativeForkPolicy: 'sandbox' },
    { prior: undefined, definitionId: undefined, missingCli: false, policyHandoff: true },
    { prior: undefined, definitionId: undefined, missingCli: false, policyHandoff: 'attach' },
    { prior: undefined, definitionId: undefined, missingCli: false, policyHandoff: 'member-attach' },
    { prior: undefined, definitionId: undefined, missingCli: false, policyHandoff: 'approval' },
    { prior: undefined, definitionId: undefined, missingCli: false, policyHandoff: 'missing-cli' },
    { prior: undefined, definitionId: undefined, missingCli: false, policyHandoff: 'fresh-directory' },
    { prior: undefined, definitionId: undefined, missingCli: false, policyHandoff: 'member-terminal' },
    { prior: undefined, definitionId: undefined, missingCli: false, profileRouting: false },
    { prior: '', definitionId: undefined, missingCli: false },
    { prior: 'previous-invocation', definitionId: undefined, missingCli: false },
    { prior: undefined, definitionId: 'definition-a', missingCli: false },
    { prior: undefined, definitionId: 'definition-b', missingCli: false },
    { prior: undefined, definitionId: undefined, missingCli: false, modelSelection: 'native' },
    { prior: undefined, definitionId: undefined, missingCli: false, modelSelection: 'provider', providerConnectionId: 'fixture-connection' },
    { prior: undefined, definitionId: undefined, missingCli: true },
    { prior: undefined, definitionId: undefined, missingCli: false, profileRouting: true },
    { prior: undefined, definitionId: 'profile-choice', missingCli: false, profileRouting: true },
    { prior: undefined, definitionId: 'profile-disabled', missingCli: false, profileRouting: true, disabled: true },
    { prior: undefined, definitionId: 'profile-explicit', missingCli: false, profileRouting: true, explicitProfile: true },
    { prior: undefined, definitionId: undefined, missingCli: false, profileRouting: true,
      diagnosticDebug: { host: undefined, session: '1' } },
    { prior: undefined, definitionId: undefined, missingCli: false, profileRouting: true,
      diagnosticDebug: { host: '1', session: undefined } },
    ...(['pi', 'ohmypi'] as const).flatMap(fileStoreAgent => ['first', 'second'].map(hostedScope => ({
      prior: undefined, definitionId: undefined, missingCli: false, fileStoreAgent, hostedScope,
    }))),
  ])('exposes foreground admission through the CLI sink and restores prior paths (%o)', async ({ prior, definitionId, missingCli, profileRouting, disabled, explicitProfile, fileStoreAgent, hostedScope, providerConnectionId, modelSelection, diagnosticDebug, policyHandoff, nativeForkPolicy }) => {
    const home = await mkdtemp(join(tmpdir(), 'happier-foreground-cli-authority-'));
    const fileStorePlugin = fileStoreAgent === 'pi' ? PI_PLUGIN : OH_MY_PI_PLUGIN;
    const fileStoreTestkit = fileStoreAgent ? await createPluginTestkit({
      manifest: fileStorePlugin.manifest, module: fileStorePlugin,
    }) : null;
    const implicitLocalTui = profileRouting && definitionId === undefined && !diagnosticDebug;
    // An unnamed profile launch is a person at a terminal; the root refuses it from a pipe.
    const restoreTty = profileRouting && !explicitProfile ? setStdioTtyForTest({ stdin: true, stdout: true }) : () => {};
    const env = createEnvKeyScope(['HAPPIER_HOME_DIR', 'HAPPIER_SERVER_URL', 'HAPPIER_LOCAL_SERVER_URL',
      'HAPPIER_PUBLIC_SERVER_URL', 'HAPPIER_ACTIVE_SERVER_ID', 'HAPPIER_SESSION_AUTOSTART_DAEMON',
      HAPPIER_AGENT_RUNTIME_RUNNER_BOOTSTRAP_FILE_ENV_KEY, HAPPIER_AGENT_RUNTIME_DAEMON_SERVICE_AUTHORITY_FILE_ENV_KEY,
      'DEBUG', 'HAPPIER_LOG_LEVEL']);
    const previous = { [HAPPIER_AGENT_RUNTIME_RUNNER_BOOTSTRAP_FILE_ENV_KEY]: prior && `${prior}.bootstrap`,
      [HAPPIER_AGENT_RUNTIME_DAEMON_SERVICE_AUTHORITY_FILE_ENV_KEY]: prior && `${prior}.authority` };
    env.patch({ HAPPIER_HOME_DIR: home, HAPPIER_ACTIVE_SERVER_ID: 'foreground-fixture',
      HAPPIER_SESSION_AUTOSTART_DAEMON: implicitLocalTui ? undefined : '0', ...previous,
      ...(diagnosticDebug ? { DEBUG: diagnosticDebug.host, HAPPIER_LOG_LEVEL: 'debug' } : {}) });
    const diagnosticLogPath = join(home, 'command-diagnostics.log');
    const diagnosticLogger = diagnosticDebug ? new Logger({ logFilePath: diagnosticLogPath,
      pruneCurrentProcessLogs: false, allowDangerousRemoteLogging: false }) : null;
    const restoreLogger = diagnosticLogger ? bindProcessLogger(diagnosticLogger) : null;
    const attachHandoff = policyHandoff === 'attach' || policyHandoff === 'member-attach';
    let agentId = attachHandoff ? 'codex' : 'acme.foreground/fixture';
    const agentTarget = definitionId === undefined ? undefined : {
      kind: 'agent' as const, identity: CUSTOM_ACP_AGENT_CONTRIBUTION_IDENTITY_V1, definitionId,
    };
    let fixture: Awaited<ReturnType<typeof createAdmittedPluginRuntimeFixture>> | undefined;
    const authorizations: NonNullable<Awaited<ReturnType<typeof prepareForegroundAgentRuntimeBootstrapForLease>>>[] = [];
    let sessionCreateEnvironment: Readonly<Record<string, string | undefined>> | null = null;
    let sessionCreateBootstrapAgent: string | null = null;
    let sessionCreateModelSelection: unknown = null;
    let releaseObserved = false;
    let sessionCreatePermissionMode: unknown = null;
    let admittedProfileId: unknown = null;
    let admittedModelSelection: unknown = null;
    let optionsEnvironment: Readonly<Record<string, string | undefined>> | null = null;
    let fileStoreEnvironment: unknown;
    const directory = join(home, hostedScope ?? 'workspace');
    const requests: string[] = [];
    const boundaryErrors: unknown[] = [];
    let policySpawnInput: unknown;
    let policySpawnTarget: unknown;
    const freshDirectory = policyHandoff === 'fresh-directory';
    const memberTerminal = policyHandoff === 'member-terminal' || policyHandoff === 'member-attach';
    const nativeHome = join(home, 'agent-home');
    const nativeRpc = new RpcHandlerManager({ scopePrefix: 'policy-machine', encryptionMode: 'plain', logger() {} });
    if (freshDirectory) registerSessionCreationDirectoryPreflightRpc({ rpcHandlerManager: nativeRpc });
    const preflight = async (path: string) => readSessionCreationTargetPreparationResultV1(
      await runAddedHostedSession({ environment: { ...process.env, HOME: nativeHome, USERPROFILE: nativeHome },
        workingDirectory: nativeHome, end() {} }, () => nativeRpc.invokeLocal(
        RPC_METHODS.DAEMON_SESSION_CREATION_DIRECTORY_PREFLIGHT, { directory: { kind: 'path', path } })),
    );
    // This is the daemon/Home HTTP boundary. CLI parsing, credentials, engine
    // resolution, physical Agent admission and Session construction stay real.
    const profile = { v: 2, id: 'profile-default', name: 'Profile Default',
      preferredAgentTargetKey: explicitProfile ? 'agent:happier.agent.codex/codex' : agentTarget ? buildBackendTargetKeyV2(agentTarget) : 'agent:acme.foreground/fixture',
      ...(explicitProfile ? { preferredModelSelection: { v: 1, updatedAt: 1, ref: { agentTargetKey: 'agent:happier.agent.codex/codex', providerConnectionId: null, modelId: 'different-agent-model' } } } : {}),
      extraEnvironmentVariables: [{ name: 'TEAM_FLAG', value: 'profile' }],
      defaultPermissionModeByTargetKey: { [agentTarget ? buildBackendTargetKeyV2(agentTarget) : 'agent:acme.foreground/fixture']: 'read-only' },
      createdAt: 1, updatedAt: 1 };
    const transferControl = { status: 'present', revision: 1, content: { t: 'plain', v: {
      v: 1, phase: 'active', sourceSettingsVersion: 1, migratedLogicalRevision: 1, inventory: [] } } };
    const server = createServer(async (request, response) => {
      const respond = (status: number, value: unknown) => {
        response.writeHead(status, { 'content-type': 'application/json' });
        response.end(JSON.stringify(value));
      };
      const path = request.url ?? '';
      requests.push(path);
      try {
        let text = '';
        for await (const chunk of request) text += String(chunk);
        const pluginAvailability = absentAccountPluginAvailabilityHttpResponse(
          `${origin}${path}`, text ? JSON.parse(text) : undefined,
        );
        if (pluginAvailability) return respond(pluginAvailability.status, pluginAvailability.data);
        if (path === '/v1/machines' && request.method === 'POST') return respond(200, { machine: {
          ...JSON.parse(text), daemonState: null, metadataVersion: 1, daemonStateVersion: 0 } });
        if (path.startsWith('/v1/artifacts')) return respond(200, artifactListResponse(path, []));
        if (path === '/v2/account/settings') return respond(200, { version: 1, content: { t: 'plain', v: { backendEnabledByTargetKey: {
          'agent:happier.agent.claude/claude': false,
          ...(disabled && agentTarget ? { [buildBackendTargetKeyV2(agentTarget)]: false } : {}),
        } } } });
        if (path === '/v1/account/entity-rows/profiles') return respond(200, { status: 'listed', complete: true,
          nextCursor: null, diagnostics: [], referenceGuardRevision: 1, transferControl, rows: [{ id: profile.id, revision: 1,
            content: { t: 'plain', v: { v: 1, id: profile.id, enabled: true, promptStack: [], secretBindings: {},
              definition: { kind: 'inline', profile } } } }] });
        if (path === '/v1/account/entity-rows/profiles/reference-guard') return respond(200, { status: 'ready', revision: 1 });
        if (path === '/v1/account/entity-rows/profiles/transfer') return respond(200, transferControl);
        if (path === '/v1/account/authoring-memory/lastUsedProfile') return respond(200, { status: 'present', revision: 1, content: { t: 'plain', v: null } });
        if (path === '/ping') return respond(200, { success: true });
        if (path === '/actions/root/execute') {
          const root = JSON.parse(text);
          if (root.actionId !== 'session.spawn_new') throw new Error('Expected canonical Session spawn');
          policySpawnInput = root.input;
          policySpawnTarget = root.target;
          if (policyHandoff === 'approval') return respond(200, { ok: true, result: {
            kind: 'approval_request_created', artifactId: 'foreground-spawn-approval', actionId: 'session.spawn_new',
          } });
          if (freshDirectory) {
            const spawn = SessionSpawnNewInputV2Schema.parse(root.input);
            if (spawn.directory.kind !== 'path') throw new Error('Expected an ordinary Session directory');
            const prepared = await preflight(spawn.directory.path);
            if (!prepared.ok) return respond(200, { ok: true, result: prepared.result });
            expect(prepared.preparedTarget.directory).toBe(nativeHome);
          }
          if (attachHandoff || freshDirectory) return respond(200, { ok: true, result: {
            type: 'success', disposition: 'created', sessionId: 'cforegroundpolicysession01',
            executionTarget: { serverId: 'foreground-fixture', machineId: memberTerminal ? 'signed-pty-machine' : 'policy-machine' },
            organizationPlacement: { sectionId: null, tagIds: [] }, initialInput: { status: 'notRequested' },
          } });
          if (policyHandoff === 'missing-cli') return respond(200, { ok: true, result: {
            type: 'error', code: 'agent_cli_missing', agentId: 'codex', retryable: false,
          } });
          return respond(200, { ok: false, errorCode: 'target_unavailable', error: 'policy-fixture-refusal' });
        }
        if (path === FOREGROUND_AGENT_RUNTIME_ADMISSION_PATH) {
          const admission = ForegroundAgentRuntimeAdmissionRequestV1Schema.parse(JSON.parse(text));
          if (nativeForkPolicy) expect(admission.nativeFork).toBe(true);
          if (nativeForkPolicy === 'sandbox') return respond(200, await prepareForegroundAgentRuntimeAdmission({ ...admission, machineId: 'policy-machine' }, {
            readMachineMetadataSnapshot: () => ({ status: 'ready', metadataVersion: 1, metadata: { isolationPolicyV1: {
              configuredSandboxes: { local: { provisioner: { pluginId: 'acme.sandbox', localId: 'sandbox' }, presetId: 'preset' } },
              workKinds: { sessions: { kind: 'sandbox', configuredSandboxId: 'local', lifecycle: 'fresh' },
                botsChannels: { kind: 'directly' }, automationsWorkflows: { kind: 'directly' } },
            } } }),
          }));
          admittedProfileId = admission.profileId;
          admittedModelSelection = admission.selection;
          if (policyHandoff) return respond(200, { ok: false,
            error: { kind: 'launch_error', code: 'target_unavailable', message: 'Canonical spawn required' },
            sessionSpawnRequired: { machineId: 'policy-machine' } });
          if (missingCli) return respond(200, { ok: false, error: SessionSpawnLaunchErrorV1Schema.parse({
            kind: 'launch_error', code: 'agent_cli_missing', message: AGENT_CLI_MISSING_PREVIEW,
          }) });
          if (!fixture) throw new Error('Physical Agent fixture unavailable');
          const bootstrap = await prepareForegroundAgentRuntimeBootstrapForLease({ target: admission.backendTarget, lease: fixture.lease,
            ...(admission.runtimeDescriptorV1 ? { launch: { runtimeDescriptorV1: admission.runtimeDescriptorV1 } } : {}) });
          if (!bootstrap) throw new Error('Physical Agent bootstrap unavailable');
          authorizations.push(bootstrap);
          return respond(200, ForegroundAgentRuntimeAdmissionResponseV1Schema.parse({ ok: true, capability: {
            attemptId: admission.attemptId, admissionFilePath: bootstrap.authorization.foregroundAdmissionFilePath,
            bootstrapFilePath: bootstrap.authorization.bootstrapFilePath, authorityFilePath: bootstrap.authorization.authorityFilePath,
            descriptor: bootstrap.authorization.descriptor,
          }, launchPolicy: { reservedEnvironmentVariableNames: [], profileSecretRequirementNamesMissingBinding: [] } }));
        }
        if (path === FOREGROUND_AGENT_RUNTIME_SESSION_OPTIONS_PATH) {
          const optionsRequest = ForegroundAgentRuntimeSessionOptionsRequestV1Schema.parse(JSON.parse(text));
          optionsEnvironment = optionsRequest.input.environment;
          if (fileStoreAgent) {
            const projected = projectAgentCliSessionCommandCatalogEntry({
              agentId,
              cliSessionCommand: fileStoreTestkit?.registration('agents', fileStoreAgent)?.cliSessionCommand,
              resolvePluginSettings: async () => ({ account: {
                [fileStoreAgent === 'pi' ? 'piAgentDir' : 'ohMyPiAgentDir']: 'agent-data',
              } }),
            });
            const options = await projected.resolveSessionRuntimePreferences!(optionsRequest.input);
            fileStoreEnvironment = options.environmentVariables;
            return respond(200, { ok: true, options });
          }
          return respond(200, { ok: true, options: {} });
        }
        if (path === FOREGROUND_AGENT_RUNTIME_RELEASE_PATH) { releaseObserved = true; return respond(200, { ok: true }); }
        if (path === '/v1/features') return respond(200, FeaturesResponseSchema.parse({ features: {},
          capabilities: { encryption: { storagePolicy: 'optional', allowAccountOptOut: true, defaultAccountMode: 'plain' } } }));
        if (path === '/v1/account/encryption') return respond(200, { mode: 'plain', updatedAt: 1 });
        if (path === '/v1/account/encryption/currentness') {
          return respond(200, createAccountEncryptionCurrentnessFixture());
        }
        if (attachHandoff && path === '/session-agent-terminal') {
          const { sessionId, op, request } = JSON.parse(text);
          expect(sessionId).toBe('cforegroundpolicysession01');
          if (op === 'open') return respond(200, { ok: true, terminalId: 'agent-terminal', byteOffset: 0 });
          expect(request.terminalId).toBe('agent-terminal');
          if (op === 'read') return respond(200, { ok: true, terminalId: 'agent-terminal', frames: [],
            nextByteOffset: 0, done: true });
          expect(['input', 'detach']).toContain(op);
          return respond(200, { ok: true });
        }
        if (attachHandoff && path.startsWith('/v2/sessions/cforegroundpolicysession01')) {
          return respond(200, { session: createSessionRecordFixture({
            id: 'cforegroundpolicysession01', active: true, encryptionMode: 'plain',
            metadata: JSON.stringify({ flavor: 'codex', startedBy: 'daemon', path: nativeHome,
              runtimeDescriptorV1: { v: 1, agentId: 'codex', agent: { backendMode: 'appServer',
                providerSessionId: 'foreground-native-thread', appServerEndpoint: 'unix:///tmp/agent-private/app-server.sock' } } }),
          }) });
        }
        if (freshDirectory && path.startsWith('/v2/sessions/cforegroundpolicysession01')) {
          return respond(503, { error: 'attach-fixture-unavailable' });
        }
        if (path === '/v1/sessions') {
          const owner = StoredSessionOwnerMetadataEnvelopeV1Schema.parse(JSON.parse(text).ownerMetadata);
          if (owner.t !== 'plain') throw new Error('Expected the plain fixture Account');
          sessionCreatePermissionMode = owner.v.runtime?.permissionMode;
          sessionCreateModelSelection = owner.v.runtime?.modelSelectionIntentV1?.selection ?? null;
          sessionCreateEnvironment = {
            [HAPPIER_AGENT_RUNTIME_RUNNER_BOOTSTRAP_FILE_ENV_KEY]: process.env[HAPPIER_AGENT_RUNTIME_RUNNER_BOOTSTRAP_FILE_ENV_KEY],
            [HAPPIER_AGENT_RUNTIME_DAEMON_SERVICE_AUTHORITY_FILE_ENV_KEY]: process.env[HAPPIER_AGENT_RUNTIME_DAEMON_SERVICE_AUTHORITY_FILE_ENV_KEY],
          };
          const bootstrapPath = process.env[HAPPIER_AGENT_RUNTIME_RUNNER_BOOTSTRAP_FILE_ENV_KEY];
          if (bootstrapPath && bootstrapPath !== previous[HAPPIER_AGENT_RUNTIME_RUNNER_BOOTSTRAP_FILE_ENV_KEY]) {
            sessionCreateBootstrapAgent = (await readRunnerAgentSessionBootstrap(bootstrapPath)).descriptor.agentId;
          }
          // A real Home refusal stops before realtime sockets or Agent effects.
          return respond(403, { error: 'foreground-fixture-refusal' });
        }
        return respond(404, { error: 'unexpected-fixture-request' });
      } catch (error) { boundaryErrors.push(error); respond(500, { error: 'fixture-boundary-failure' }); }
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('HTTP fixture did not bind');
    const origin = `http://127.0.0.1:${address.port}`;
    env.patch({ HAPPIER_SERVER_URL: origin, HAPPIER_LOCAL_SERVER_URL: undefined, HAPPIER_PUBLIC_SERVER_URL: origin });
    reloadConfiguration();
    try {
      await writeCredentialsTokenOnly({ token: 'foreground-fixture-token' });
      if (attachHandoff) await expect(acquireAuthoritativePluginRuntimeRegistryLease()).rejects.toMatchObject({
        code: 'PLUGIN_DAEMON_RUNTIME_UNAVAILABLE',
      });
      else fixture = agentTarget ? await createAdmittedPluginRuntimeFixture({ happyHomeDir: home,
        controller: pluginReloadController,
        runtimeOptions: { pluginIds: [agentTarget.identity.pluginId] } }) : await createAuthoredAdmittedPluginRuntimeFixture({ happyHomeDir: home,
 controller: pluginReloadController,
 plugins: [{
        manifest: createPluginManifestV2Fixture({ id: 'acme.foreground', contributes: { agents: [{
          id: 'fixture', title: 'Foreground CLI fixture',
          ...(implicitLocalTui ? { cli: { executable: { binaryName: 'unreachable-before-Home-refusal', sourcePreference: 'system-first' },
            install: { managed: null, manual: { kind: 'command' } }, auth: { support: 'status_only', loginLaunches: [] },
            commandPolicy: { daemonAutostartDefault: 'preferLocalTui' } } } : {}),
          runtime: { kind: 'custom' }, primary: 'sessions',
          capabilities: { sessions: { open: ['create'], delivery: ['newTurn'], cancel: true } },
        }] } }), files: {
          'runtime.mjs': 'export function createRuntime() { throw new Error("Home refusal must precede Agent effects"); }',
          'daemon.mjs': 'import { createRuntime } from "./runtime.mjs"; export function activate(api) { api.agents.register("fixture", createRuntime, { sessionRunnerFactory: { module: "./runtime.mjs", export: "createRuntime", runtimeApiVersion: 1 } }); }',
        },
      }] });
      if (agentTarget && fixture) {
        const contribution = [...fixture.registry.contributes.agentDefinitionsById.values()]
          .find(value => value.identity?.pluginId === agentTarget.identity.pluginId
            && value.identity.localId === agentTarget.identity.localId);
        if (!contribution) throw new Error('Actual configured Agent contribution missing');
        agentId = contribution.id;
        const credentials = await readStoredCredentials();
        if (!credentials) throw new Error('Installed fixture credentials missing');
        setActiveAccountSettingsSnapshot({ source: 'network', settings: accountSettingsParse(profileRouting ? { backendEnabledByTargetKey: {
          'agent:happier.agent.claude/claude': false, ...(disabled ? { [buildBackendTargetKeyV2(agentTarget)]: false } : {}),
        } } : {}), rawSettings: {},
          settingsVersion: 1, loadedAtMs: 1, settingsSecretsReadKeys: [], scopeKey: resolveAccountSettingsScopeKey(credentials),
          acpCatalog: { status: 'ready', revision: 1, record: AcpCatalogRecordV1Schema.parse({ v: 1, definitions: [{
            id: agentTarget.definitionId, name: agentTarget.definitionId, title: agentTarget.definitionId,
            launch: { kind: 'command', command: 'unreachable-before-home-refusal', args: [] }, env: {}, capabilities: {}, createdAt: 1, updatedAt: 1,
          }] }) } });
      }
      writeDaemonState({ pid: process.pid, httpPort: address.port, controlToken: 'fixture-control-token', startedAt: Date.now(),
        startedWithCliVersion: resolveComparableCliVersion({ fallbackVersion: configuration.currentCliVersion,
          projectRootPath: projectPath(), readFileSyncImpl: readFileSync }) });
      vi.spyOn(console, 'error').mockImplementation(() => {});
      const presentation = vi.spyOn(console, 'log').mockImplementation(() => {});
      let nativeForkArgs: string[] = [];
      if (nativeForkPolicy) {
        const runtimeDescriptor = { v: 1 as const, agentId, agent: { providerSessionId: 'native-parent' } };
        await attemptNativeForkOpen({ credentials: { token: 'foreground-fixture-token', encryption: null },
          parentSessionId: 'native-parent-session', parentMetadata: projectCurrentAgentSessionView({ runtimeDescriptorV1: runtimeDescriptor }, {
            agentId, runtimeDescriptor, nativeResumeIdentity: { v: 1, vendorResumeId: 'native-parent' },
          }), directory, forkPoint: { type: 'latest' }, targetSeqInclusive: 1, effectiveCutoffSeqInclusive: 1,
          spawnNonce: 'native-fork-foreground', forkBackendResolution: { ok: true, catalogAgentId: agentId,
            agentHintAgentId: agentId, backendTargetV2: { kind: 'backend', backendId: agentId, sourceKind: 'built_in' },
            backendTarget: { kind: 'builtInAgent', agentId }, replayFlavor: agentId, metadataOverlay: {} },
          inheritedForkOverrides: { spawn: {}, metadata: {} },
          spawnSession: async options => {
            nativeForkArgs = buildHappySessionControlArgs({ nativeForkSource: options.nativeForkSource });
            return { type: 'error', errorCode: 'INVALID_REQUEST', errorMessage: 'Captured native process launch' };
          }, stopSession: async () => true,
        });
        expect(nativeForkArgs).not.toEqual([]);
      }
      const processExit = vi.spyOn(process, 'exit').mockImplementation((() => {
        expect(process.env[HAPPIER_AGENT_RUNTIME_RUNNER_BOOTSTRAP_FILE_ENV_KEY]).toBe(previous[HAPPIER_AGENT_RUNTIME_RUNNER_BOOTSTRAP_FILE_ENV_KEY]);
        expect(process.env[HAPPIER_AGENT_RUNTIME_DAEMON_SERVICE_AUTHORITY_FILE_ENV_KEY]).toBe(previous[HAPPIER_AGENT_RUNTIME_DAEMON_SERVICE_AUTHORITY_FILE_ENV_KEY]);
        throw new Error('foreground-command-exit');
      }) as never);
      if (freshDirectory) {
        await Promise.all([mkdir(directory), mkdir(nativeHome)]);
        const access = fs.access.bind(fs);
        // The worker runs as the admitted Agent. Substitute only the native OS
        // traversal failure on the custodian's home.
        vi.spyOn(fs, 'access').mockImplementation(async (path, mode) => {
          if (path === directory) throw Object.assign(new Error('Permission denied'), { code: 'EACCES' });
          return access(path, mode);
        });
        const machineId = 'policy-machine';
        const appDefault = resolveDefaultDirectoryForMachine({ machineId, machines: [], recentPaths: [],
          ownStatus: { protection: 'setup_pending', status: { kind: 'member_not_prepared' } } });
        expect(await preflight(appDefault)).toMatchObject({ ok: true, preparedTarget: { directory: nativeHome } });

        const handlers = new Map<string, RpcHandler>();
        let launch: PtySpawnParams | undefined;
        const shellEnv = { ...process.env, HOME: directory, USERPROFILE: directory };
        const terminal = registerMachineTerminalRpcHandlers({
          rpcHandlerManager: { registerHandler(method, handler) { handlers.set(method, handler); } },
          deps: { env: shellEnv, resolveHostHomeServerIdentityId: async () => 'foreground-fixture', serverId: 'foreground-fixture',
            sessionManager: createTerminalPtySessionManager({ env: shellEnv, config: readDaemonTerminalPtyConfig(shellEnv).sessionManager,
              ptyProvider: { spawn(params) {
                launch = params;
                return { pid: 0, write() {}, resize() {}, kill() {},
                  onData: () => ({ dispose() {} }), onExit: () => ({ dispose() {} }) };
              } } }),
          },
        });
        try {
          for (const cwd of [undefined, directory]) {
            await expect(handlers.get(RPC_METHODS.DAEMON_TERMINAL_ENSURE)!({
              terminalKey: cwd === undefined ? 'fresh-default' : 'explicit-folder',
              ...(cwd === undefined ? {} : { cwd }), launch: { kind: 'happier_cli', args: ['codex'] }, cols: 100, rows: 30,
            }, { signal: new AbortController().signal, callerAuthority: 'present_user',
              machineAdmission: { actorAccountId: 'owner', custodianAccountId: 'owner', machineId,
                installationId: 'installation', role: 'manage', encryptionMode: 'plain' },
              verifyMachineAdmissionCurrent: async () => true,
            })).resolves.toMatchObject({ ok: true, reused: false });
            expect(launch?.options.cwd).toBe(directory);
            if (!launch?.options.env) throw new Error('Expected the owner terminal process environment');
            await runAddedHostedSession({ environment: { ...launch.options.env }, workingDirectory: directory, end() {} },
              () => runBackendSessionCliCommand({ resolveSessionRuntimePreferences: null,
                context: { args: [], rawArgv: [], terminalRuntime: null }, backendIdForSessionRuntime: agentId,
                runtimeAuthorityAgentId: agentId }));
            expect(boundaryErrors).toEqual([]);
            if (cwd === undefined) {
              expect(requests.some(path => path.startsWith('/v2/sessions/cforegroundpolicysession01')),
                JSON.stringify(vi.mocked(console.error).mock.calls)).toBe(true);
              requests.length = 0;
            } else {
              expect(policySpawnInput).toMatchObject({ directory: { kind: 'path', path: directory } });
              expect(requests).toContain('/actions/root/execute');
              expect(requests.some(path => path.startsWith('/v2/sessions/cforegroundpolicysession01'))).toBe(false);
            }
          }
        } finally { terminal.dispose(); }
        return;
      }
      const invoke = () => explicitProfile ? handleConfiguredAcpCatalogCliCommand({ args: ['acp-catalog', '--backend', definitionId!, '--profile', 'ignored-profile', '--profile', profile.id], rawArgv: [], terminalRuntime: null }) : profileRouting ? dispatchCli({ args: ['--profile', 'ignored-profile', '--profile', profile.id], rawArgv: diagnosticDebug ? ['happier', '--api-token', 'foreground-fixture-token', 'session-diagnostic-fixture'] : [], terminalRuntime: null }) : runBackendSessionCliCommand({ resolveSessionRuntimePreferences: null, context: { args: nativeForkPolicy ? nativeForkArgs : policyHandoff ? ['--native-flag', 'native value'] : agentTarget || modelSelection ? ['--model', 'fixture-native-model', ...(providerConnectionId ? ['--provider-connection', providerConnectionId] : [])] : [], rawArgv: [], terminalRuntime: null },
        backendIdForSessionRuntime: agentId, runtimeAuthorityAgentId: agentId,
        ...(fileStoreAgent ? { agentIdForAccountSettings: agentId } : {}),
        ...(agentTarget ? { resolveExtraOptions: () => ({ agentTarget,
          runtimeDescriptorV1: { v: 1 as const, agentId, agent: { definitionId: agentTarget.definitionId } } }) } : {}),
      });
      const endCodes: number[] = [];
      const hosted = Boolean(fileStoreAgent || diagnosticDebug || memberTerminal);
      const run = hosted ? runAddedHostedSession({ environment: { ...process.env, NODE_ENV: 'test',
        ...(memberTerminal ? {
          HAPPIER_TERMINAL_SESSION_EXECUTION_TARGET: JSON.stringify({ serverId: 'foreground-fixture', machineId: 'signed-pty-machine' }),
        } : {}),
        ...(diagnosticDebug ? { DEBUG: diagnosticDebug.session } : {}) },
        workingDirectory: directory, end: code => { endCodes.push(code); } }, invoke) : invoke();
      if (attachHandoff || hosted || policyHandoff === 'approval') await run;
      else await expect(run).rejects.toThrow('foreground-command-exit');
      expect(boundaryErrors).toEqual([]);
      if (attachHandoff) {
        expect(processExit).not.toHaveBeenCalled();
        expect(policySpawnInput).toMatchObject({ executionTarget: { machineId: memberTerminal ? 'signed-pty-machine' : 'policy-machine' },
          directory: { kind: 'path' }, agentArgs: ['--native-flag', 'native value'] });
        expect(requests.filter(path => path === '/actions/root/execute')).toHaveLength(1);
        expect(requests).toContain('/session-agent-terminal');
        expect(requests).not.toContain('/v1/sessions');
        return;
      }
      if (memberTerminal) {
        expect(policySpawnInput).toMatchObject({ executionTarget: { serverId: 'foreground-fixture', machineId: 'signed-pty-machine' },
          directory: { kind: 'path', path: directory }, agentArgs: ['--native-flag', 'native value'] });
        expect(policySpawnTarget).toEqual({ kind: 'machine', machineId: 'signed-pty-machine' });
        expect(requests).not.toContain(FOREGROUND_AGENT_RUNTIME_ADMISSION_PATH);
        expect(requests).not.toContain('/v1/sessions');
        expect(vi.mocked(console.error).mock.calls.flat().join(' ')).toContain('policy-fixture-refusal');
        return;
      }
      if (nativeForkPolicy === 'sandbox') {
        expect(vi.mocked(console.error).mock.calls.flat().join(' ')).toContain('target_unavailable');
        expect(requests).not.toContain('/actions/root/execute');
        expect(requests).not.toContain('/v1/sessions');
        expect(authorizations).toHaveLength(0);
        return;
      }
      if (policyHandoff) {
        expect(policySpawnInput, JSON.stringify(vi.mocked(console.error).mock.calls)).toMatchObject({ executionTarget: { machineId: 'policy-machine' },
          directory: { kind: 'path' }, agentArgs: ['--native-flag', 'native value'] });
        expect(requests).not.toContain('/v1/sessions');
        expect(authorizations).toHaveLength(0);
        if (policyHandoff === 'missing-cli') {
          expect(vi.mocked(console.error).mock.calls.flat().join(' ')).toContain(AGENT_CLI_MISSING_PREVIEW);
        }
        if (policyHandoff === 'approval') {
          expect(presentation.mock.calls.flat().join(' ')).toContain('foreground-spawn-approval');
          expect(processExit).not.toHaveBeenCalled();
        } else expect(processExit).toHaveBeenCalledWith(1);
        return;
      }
      if (diagnosticDebug) {
        const hasRawStack = vi.mocked(console.error).mock.calls.some(call =>
          call.some(value => typeof value === 'string' && /\n\s+at /.test(value)));
        expect.soft(hasRawStack).toBe(Boolean(diagnosticDebug.session));
        diagnosticLogger!.flushSync();
        const diagnosticLog = readFileSync(diagnosticLogPath, 'utf8');
        expect.soft(diagnosticLog.includes('session-diagnostic-fixture')).toBe(Boolean(diagnosticDebug.session));
        expect(diagnosticLog).not.toContain('foreground-fixture-token');
        vi.mocked(console.error).mockClear();
        const credential = formatAccountApiTokenCredentialV1({
          bearer: `hap_v1_22222222-2222-4222-a222-222222222222_${encodeBase64(new Uint8Array(32).fill(11), 'base64url')}`,
          wrappingSecret: encodeBase64(new Uint8Array(32).fill(7), 'base64url'),
          serverIdentityId: 'srv_foreground_diagnostics', accountId: 'foreground-diagnostics',
          contentPublicKey: encodeBase64(new Uint8Array(32).fill(9)),
        });
        // The real credential owner refuses continuation before tmux can spawn.
        await expect(runAddedHostedSession({ environment: { ...process.env, NODE_ENV: 'test', DEBUG: diagnosticDebug.session },
          workingDirectory: directory, end: () => {} }, () => dispatchCli({
          args: ['--api-token', credential, 'claude', '--tmux'],
          rawArgv: ['happier', '--api-token', credential, 'claude', '--tmux'], terminalRuntime: null,
        }))).rejects.toThrow('foreground-command-exit');
        expect.soft(vi.mocked(console.error).mock.calls.some(call =>
          call.some(value => value instanceof CliApiTokenChildContinuationError))).toBe(Boolean(diagnosticDebug.session));
      }
      if (disabled) {
        expect(vi.mocked(console.error).mock.calls.flat().join(' ')).toContain('disabled');
        expect(requests).not.toContain(FOREGROUND_AGENT_RUNTIME_ADMISSION_PATH);
        expect(requests).not.toContain('/v1/sessions');
        return;
      }
      if (missingCli) {
        const presentation = vi.mocked(console.error).mock.calls.flat().join('\n');
        expect(presentation).toContain('agent_cli_missing');
        expect(presentation).toContain(AGENT_CLI_MISSING_PREVIEW);
        expect(requests.filter(path => path === FOREGROUND_AGENT_RUNTIME_ADMISSION_PATH)).toHaveLength(1);
        expect(requests).not.toContain('/v1/sessions');
        expect(authorizations).toHaveLength(0);
        expect(processExit).toHaveBeenCalledWith(1);
        return;
      }
      expect(requests, vi.mocked(console.error).mock.calls.map(call => call.join(' ')).join('\n')).toContain('/v1/sessions');
      expect(authorizations).toHaveLength(1);
      if (hosted) expect(endCodes).toEqual([1]);
      if (fileStoreAgent) {
        expect(fileStoreEnvironment).toMatchObject({ PI_CODING_AGENT_DIR: join(directory, 'agent-data') });
        expect(resolveSessionFileStoreDirsSync({ product: PI_SESSION_FILE_STORE_DESCRIPTOR_V1,
          env: { PI_CODING_AGENT_DIR: 'agent-data' } }).agentDir).toBe(join(process.cwd(), 'agent-data'));
      } else if (!hosted) {
        expect(sessionCreateEnvironment).toEqual(authorizations[0]!.childEnv);
        expect(sessionCreateBootstrapAgent).toBe(agentId);
      }
      if (implicitLocalTui) {
        expect(process.env.HAPPIER_SESSION_AUTOSTART_DAEMON).toBe('0');
        expect(optionsEnvironment).toMatchObject({ TEAM_FLAG: 'profile' });
      }
      if (profileRouting) {
        expect(admittedProfileId).toBe(profile.id);
        expect(sessionCreatePermissionMode).toBe('read-only');
      }
      if (modelSelection) {
        const expectedRef = { agentTargetKey: buildBackendTargetKeyV2({ kind: 'backend', backendId: agentId, sourceKind: 'built_in' }),
          providerConnectionId: providerConnectionId ?? null, modelId: 'fixture-native-model' };
        expect(admittedModelSelection).toMatchObject({
          ref: expectedRef,
        });
        expect(sessionCreateModelSelection).toMatchObject(expectedRef);
      }
      if (agentTarget && !profileRouting) {
        expect(sessionCreateModelSelection).toMatchObject({
          agentTargetKey: buildBackendTargetKeyV2(agentTarget), modelId: 'fixture-native-model',
        });
        expect(authorizations[0]!.authorization.descriptor.backendId).toBe(agentId);
      }
      expect(releaseObserved).toBe(true);
      if (!hosted) expect(processExit).toHaveBeenCalledWith(1);
      expect(process.env[HAPPIER_AGENT_RUNTIME_RUNNER_BOOTSTRAP_FILE_ENV_KEY]).toBe(previous[HAPPIER_AGENT_RUNTIME_RUNNER_BOOTSTRAP_FILE_ENV_KEY]);
      expect(process.env[HAPPIER_AGENT_RUNTIME_DAEMON_SERVICE_AUTHORITY_FILE_ENV_KEY]).toBe(previous[HAPPIER_AGENT_RUNTIME_DAEMON_SERVICE_AUTHORITY_FILE_ENV_KEY]);
    } finally {
      restoreLogger?.();
      resetActiveAccountSettingsSnapshotForTests();
      for (const authorization of authorizations) await authorization.cleanupBootstrapFiles();
      await fixture?.dispose();
      await fileStoreTestkit?.dispose();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      restoreTty(); env.restore(); reloadConfiguration(); await rm(home, { recursive: true, force: true });
    }
  }, 120_000);
});
