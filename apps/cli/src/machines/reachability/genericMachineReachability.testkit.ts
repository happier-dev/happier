import { randomUUID } from 'node:crypto';
import type { ChildProcess } from 'node:child_process';
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { chmod, lstat, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { networkInterfaces, tmpdir, userInfo } from 'node:os';
import { PassThrough, Writable } from 'node:stream';
import axios, { type AxiosRequestConfig } from 'axios';
import { z } from 'zod/mini';
import * as syncClient from '@happier-dev/sync-client';
import nacl from 'tweetnacl';
import { createExternalActionHomeProcessForTests } from '../../../../server/sources/testkit/externalActionExecution.testkit.mjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { definePlugin, type MachineRecipeV1 } from '@happier-dev/plugin-sdk';
import { ActionIdSchema, getActionSpec, isApprovalRequiredByActionsSettings, createActionExecutor, createEmptyMachineSetupDesiredV1, getMachineAdminAccessV1, sealSavedSecretResourceStoredContentV1,
  verifyMachineInstallationProof, ActionsSettingsV1Schema, setActionApprovalOverride,
  type ActionExecutorContext, type ActionExecutorDeps } from '@happier-dev/protocol';
import { decodeBase64, encodeBase64 } from '@happier-dev/protocol/crypto/base64';
import { readAuthTokenProvenance, AuthTokenProvenanceSchema } from '@happier-dev/protocol/auth/authToken';
import { ApprovalRequestSchema, ApprovalStaleFailureDetailsSchema, type ApprovalRequest } from '@happier-dev/protocol/approvals/approvalRequestV1';
import { readApprovalExecutionFailure } from '@happier-dev/protocol/approvals/approvalExecutionFailure';
import { decideApprovalRequestTransition } from '@happier-dev/protocol/approvals/approvalRequestTransition';
import { ManagedMachineActionInputSchemasV1, ManagedMachineActionOutputSchemasV1, managedMachineActionEndpointPathV1 } from '@happier-dev/protocol/machines/managed/actionsV1';
import { MachineReachabilityInspectResultV1Schema, MachineReachabilityConfigureResultV1Schema,
  MachineReachabilityInspectInputV1Schema, MachineReachabilityConfigureInputV1Schema,
  MachineReachabilityPlanBasisV1Schema } from '@happier-dev/protocol';
import { computeEnvironmentSecretLaunchAdmissionDigestV1, MachineConnectorSecretGrantInputV1Schema, type MachineConnectorSecretGrantSubjectV1 } from '@happier-dev/deployment-protocol';
import type { MachineMetadataFieldPortV1 } from '@happier-dev/protocol/machines/machineMetadataFieldV1';
import type { MachineSetupEffectError, MachineSetupNativeCommand, MachineSetupNativeCommandResult } from '@happier-dev/cli-common/machineSetup';
import { runMachineSetupEffectInternal } from '@/machines/setup/effectInternal';
import { MachineEffectInternalRequestSchema, MachineEffectInternalRecordSchema } from '@/machines/setup/effectInternalProtocol';
import type { MachineElevationSpawn } from '@/machines/adminAccess/runElevatedEffect';
import { resolveInstalledMachineEffectCli } from '@/machines/adminAccess/runElevatedEffect';
import { observeMachineAdminAccess, type MachineAdminAccessNativeDependencies } from '@/machines/adminAccess/observeMachineAdminAccess';
import { buildManagedSudoersSteps, MANAGED_SUDOERS_PATH } from '@/machines/adminAccess/managedSudoers';
import { machineNativeEffectAdmission } from '@/daemon/local/services/launch/machineNativeEffectAdmission';
import type { MachineSetupNativeEffectsInput } from '@/machines/setup/machineSetupNativeEffects';
import { createHostActionOperationRuntime } from '@/daemon/actionOperations/createHostActionOperationRuntime';
import { createUnavailableActionTransportDeps } from '@/testkit/actionTransportDeps';
import { inspectMachineReachability, executeMachineReachabilityTransition,
  type MachineReachabilityHostDependencies } from '@/machines/reachability/machineReachabilityHost';
import { projectMachineReachabilityObservation } from '@/machines/reachability/readMachineReachability';
import { executeContributedAction } from '@/plugins/runtime/invocation/actions/executeContributedAction';
import { buildQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-identity';
import { formatQualifiedPluginActionId } from '@happier-dev/protocol/plugins/actions/qualifiedActionId';
import { retireAdmittedPluginRuntimeRegistry } from '@/plugins/testkit/admittedRuntime';
import { createReachabilityProviderHost } from '@/machines/reachability/reachabilityProviderHost';
import { reachabilityConnectorSubject, withReachabilityJoinCredential } from '@/machines/reachability/prepareReachabilityJoinCredential';
import { ApiMachineClient } from '@/api/apiMachine';
import { ApiClient } from '@/api/api';
import type { Machine } from '@/api/types';
import { configuration, reloadConfiguration } from '@/configuration';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { decodeStoredCredentials, writeStoredCredentialsForServerId, readStoredCredentialsForServerId, hasStoredSessionCredentialProvenance, sameStoredCredentials, updateSettings, writeDaemonState } from '@/persistence';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { createApiSessionSocketStub, resolveApiSessionSocketDefaultAck } from '@/testkit/backends/apiSessionSocketHarness';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { createDaemonMachineAdminAccessRoutes } from '@/machines/adminAccess/createDaemonMachineAdminAccessRoutes';
import { createDaemonMachineReachabilityRoutes } from '@/machines/reachability/createDaemonMachineReachabilityRoutes';
import { startDaemonSessionControlRuntime } from '@/daemon/startup/startDaemonSessionControlRuntime';
import { createActionSettingsProvider } from '@/settings/actionsSettingsProvider';
import { bootstrapAccountSettingsContext, resetInMemoryAccountSettingsContextForTests } from '@/settings/accountSettings/bootstrapAccountSettingsContext';
import { readCarrierMutation } from '@/api/artifacts/accountArtifactStore.testkit';
import { createCliApprovalsArtifactStore } from '@/session/actions/approvals/artifactStore';
import { decodePlainArtifactStoredContent } from '@happier-dev/protocol/storage/artifactStoredContent';
import { approvalArtifactBodyMatchesHeaderV1 } from '@happier-dev/protocol/approvals/approvalArtifactHeaderV1';
import { describeApprovalActionFields } from '@happier-dev/protocol/actions/actionApprovalPresentation';
import { HomeConnectionDescriptorV1Schema, FeaturesResponseSchema, MachineAgentIsolationPolicyV1Schema, MachineAgentIsolationStatusV1Schema } from '@happier-dev/protocol';
import { StoredMachinePublishedMetadataV1Schema, StoredMachinePublishedDaemonStateV1Schema } from '@happier-dev/protocol/machines/machinePublishedContentV1';
import { AccountSecurityGetResponseV1Schema } from '@happier-dev/protocol/auth/accountSecurity';
import { fetchServerFeaturesSnapshot } from '@/features/serverFeaturesClient';
import { readAccountIdFromToken, decodeJwtPayload } from '@/cloud/decodeJwtPayload';
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { readInstallationIdentityIfExistsSync } from '@/daemon/identity/store';
import { MachineInstallationProofV1Schema, MachineInstallationProofPayloadV1Schema, signMachineInstallationProof } from '@happier-dev/protocol/machines/identity/installationIdentity';
import { resolveInvocationAuthority } from '@happier-dev/protocol/actions/invocationAuthority';
import { SocketRpcMachineAdmissionContextV1Schema, MachineAdmissionVerifyResponseV1Schema } from '@happier-dev/protocol/machines/machineAccessV1';
import { SOCKET_RPC_EVENTS, SocketRpcRequestIdSchema, SocketRpcCancellationPayloadSchema, type SocketRpcRequestPayload } from '@happier-dev/protocol/socketRpc';
import { createCurrentMachineExecutionOriginContextResolver } from '@/api/machine/resolveCurrentMachineExecutionOriginContext';
import { createCliActionExecutorFromCredentials } from '@/session/actions/createCliActionExecutorFromCredentials';
import { confirmCliRequesterCredentialDisclosure } from '@/cli/actions/executeCommand';
import { MachineUpdateOperationProtocolCapabilitiesRequestV1Schema, MachineUpdateOperationProtocolCapabilitiesResponseV1Schema } from '@happier-dev/protocol/machines/operationProtocolCapabilitiesV1';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { RPC_ERROR_CODES } from '@happier-dev/protocol/rpcErrors';
import { ExternalActionMachineBootstrapV1Schema, ExternalActionExecutionAuthorizationV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { MACHINE_PLAIN_DATA_KEY_MARKER, encodePlainMachineStoredContent } from '@happier-dev/protocol/machines/machineStoredContent';
import { ActionApprovalRequestCreatedResultSchema, ActionExecuteResultSchema } from '@happier-dev/protocol/actions/actionExecutionResult';
import { readActionFailureEnvelope } from '@happier-dev/protocol/actions/executor/actionFailureEnvelope';
import { ACTION_OPERATION_RPC_METHODS_V2, ActionOperationListV1ResponseSchema } from '@happier-dev/protocol/actions/operations/v1';
import type { AccessProviderSelectionV1 } from '@happier-dev/plugin-sdk/access-providers';
import { createAdmittedPluginRuntimeFixture, createAuthoredAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { loadInstalledPlugins } from '@/plugins/discovery/load/installed';
import { projectLoadedPluginContributes } from '@/plugins/projection/registry/fullProjection';
import { createResolvedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import { PluginAvailabilityActionHttpPathsV1, PluginAvailabilityIntentReadActionInputV1Schema,
  PluginAvailabilityIntentReadActionOutputV1Schema } from '@happier-dev/protocol/plugins/availability/actions';

import { defineAccessProviderSchemas } from '@happier-dev/plugin-sdk/access-providers';
import { defineProtocolObject, defineProtocolString } from '@happier-dev/plugin-sdk/protocol';

// The VM's named builtin imports must enter the same OS boundary as the
// interpreter. Native plugin modules contain no private filesystem authority.
const fixtureOs = vi.hoisted(() => ({
  promises: null as typeof import('node:fs/promises') | null,
  sync: null as typeof import('node:fs') | null,
  promiseRoute: null as ((method: string, args: unknown[]) => unknown) | null,
  syncRoute: null as ((method: string, args: unknown[]) => unknown) | null,
  initialRoots: new Set<string>(),
}));

vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  fixtureOs.promises = actual;
  const path = await import('node:path');
  const os = await import('node:os');
  const repo = path.resolve(new URL('../../../../../', import.meta.url).pathname);
  const functions: Record<string, unknown> = { ...actual };
  for (const [method, value] of Object.entries(actual)) {
    if (typeof value !== 'function') continue;
    functions[method] = async (...args: unknown[]) => {
      if (fixtureOs.promiseRoute) return fixtureOs.promiseRoute(method, args);
      const target = typeof args[0] === 'string' ? path.resolve(args[0]) : '';
      if (method === 'mkdtemp' && path.dirname(target) === os.tmpdir()
        && path.basename(target) === 'happier-generic-composed-') {
        const root = await actual.mkdtemp(target); fixtureOs.initialRoots.add(root); return root;
      }
      if (method === 'rm' && fixtureOs.initialRoots.has(target)) return Reflect.apply(value, actual, args);
      if (['readFile', 'lstat', 'stat', 'readdir', 'realpath', 'readlink', 'access'].includes(method)
        && (target === repo || target.startsWith(repo + path.sep))) return Reflect.apply(value, actual, args);
      throw Object.assign(new Error('Unconfined fixture filesystem operation'), { code: 'generic_fixture_os_refused' });
    };
  }
  return { ...functions, default: functions };
});

vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs')>(); fixtureOs.sync = actual;
  const path = await import('node:path');
  const repo = path.resolve(new URL('../../../../../', import.meta.url).pathname);
  // This exact disposable root is installed by the canonical Vitest
  // createTestHomeEnvironment owner BEFORE Configuration is imported.
  const testRoot = process.env.HAPPIER_TEST_HOME_ROOT;
  const bootstrapHome = process.env.HAPPIER_HOME_DIR;
  const bootstrap = testRoot && bootstrapHome && path.isAbsolute(testRoot)
    && path.resolve(bootstrapHome) === path.join(path.resolve(testRoot), 'cli')
      ? path.resolve(bootstrapHome) : null;
  const inBootstrap = (target: string) => bootstrap !== null
    && (target === bootstrap || target.startsWith(bootstrap + path.sep));
  const functions: Record<string, unknown> = { ...actual };
  for (const method of ['existsSync', 'lstatSync', 'statSync', 'readFileSync', 'accessSync', 'realpathSync', 'readlinkSync', 'readdirSync',
    'readFile', 'lstat', 'stat', 'access', 'realpath', 'readlink', 'readdir', 'createReadStream']) {
    functions[method] = (...args: unknown[]) => {
      if (fixtureOs.syncRoute) return fixtureOs.syncRoute(method, args);
      const target = typeof args[0] === 'string' ? path.resolve(args[0]) : '';
      if (target === repo || target.startsWith(repo + path.sep) || method === 'existsSync' && inBootstrap(target)) {
        const original: unknown = Reflect.get(actual, method);
        if (typeof original === 'function') return Reflect.apply(original, actual, args);
      }
      throw Object.assign(new Error('Fixture filesystem is not admitted'), { code: 'generic_fixture_os_refused' });
    };
  }
  for (const [method, value] of Object.entries(actual)) {
    if (typeof value === 'function' && !['Dirent', 'Stats'].includes(method)
      && !['existsSync', 'lstatSync', 'statSync', 'readFileSync', 'accessSync', 'realpathSync', 'readlinkSync', 'readdirSync',
        'readFile', 'lstat', 'stat', 'access', 'realpath', 'readlink', 'readdir', 'createReadStream'].includes(method)) {
      functions[method] = (...args: unknown[]) => {
        if (fixtureOs.syncRoute && ['mkdirSync', 'chmodSync', 'writeFileSync', 'renameSync', 'unlinkSync'].includes(method)) return fixtureOs.syncRoute(method, args);
        const target = typeof args[0] === 'string' ? path.resolve(args[0]) : '';
        if (!fixtureOs.syncRoute && ['mkdirSync', 'chmodSync'].includes(method) && inBootstrap(target)) {
          return Reflect.apply(value, actual, args);
        }
        throw Object.assign(new Error('Unused fixture filesystem operation'), { code: 'generic_fixture_os_refused' });
      };
    }
  }
  return { ...functions, promises: await import('node:fs/promises'), default: { ...functions, promises: await import('node:fs/promises') } };
});

vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  const native = (await import('node:module')).createRequire(import.meta.url)('node:child_process') as typeof import('node:child_process');
  const denied = () => { throw Object.assign(new Error('Unapproved fixture process'), { code: 'generic_fixture_os_refused' }); };
  const defaults: Record<string, unknown> = { ...actual };
  for (const [method, value] of Object.entries(actual)) {
    if (typeof value === 'function' && method !== 'ChildProcess') defaults[method] = denied;
  }
  const originals = { spawn: actual.spawn, execFile: actual.execFile };
  const forward = (method: 'spawn' | 'execFile', args: unknown[]) => {
    const current = native[method];
    const finiteNode = args[0] === process.execPath && Array.isArray(args[1]) && args[1][0] === '-e';
    if (current === originals[method] && !finiteNode && args[0] !== 'ps') return denied();
    return Reflect.apply(current, native, args);
  };
  const forwarded = { ...defaults, ChildProcess: actual.ChildProcess, spawn: (...args: unknown[]) => forward('spawn', args),
    execFile: (...args: unknown[]) => forward('execFile', args),
    exec: denied, execSync: denied, execFileSync: denied, spawnSync: denied, fork: denied };
  return { ...forwarded, default: forwarded };
});

// Mutable child-process exports are behind the hoisted named-export adapter.
const childProcess = createRequire(import.meta.url)('node:child_process') as typeof import('node:child_process');

export const machineId = 'generic-machine';
export const installationId = 'generic-installation';
const supportedPlainMachineRpcMethods = [
  getActionSpec('machines.reachability.inspect').bindings?.rpcMethod,
  getActionSpec('machines.reachability.configure').bindings?.rpcMethod,
  RPC_METHODS.APPROVAL_REQUEST_DECIDE, RPC_METHODS.APPROVAL_REQUEST_REPLAY_APPROVED,
].filter((method): method is string => typeof method === 'string').map(method => `${machineId}:${method}`);
const fixtureConfig = defineProtocolObject({
  managementUrl: defineProtocolString({ minLength: 1 }),
  profileName: defineProtocolString({ minLength: 1 }),
}, { policy: 'closed' });
const ROLE_SCHEMAS = defineAccessProviderSchemas({ config: fixtureConfig });
const GENERIC_ACCESS_PROVIDER = {
  title: 'Authored private network', icon: 'network', schemaVersion: 1 as const,
  targets: ['machine'] as const, capabilities: ['management', 'privateNetwork'] as const,
  exposure: 'privateNetwork' as const, configSchema: fixtureConfig.jsonSchema, inboundPorts: [],
  credentialPurposes: [{ purpose: 'network.join', required: true }],
  actions: { inspect: 'inspect', join: 'join', leave: 'leave' },
};
export const selection = {
  provider: { pluginId: 'com.example.docker-network', localId: 'docker-network' },
  config: { managementUrl: 'https://network.example.test', profileName: 'Happier managed' },
  credentialRefs: [{ purpose: 'network.join', credentialRef: {
    kind: 'savedSecret', ref: 'happier:shared-secret:v1:generic-join-resource', resourceRevision: 1,
  } }],
} satisfies AccessProviderSelectionV1;

/** The only substituted state owner is the Machine metadata transport/CAS. */
export function createMachineMetadataBoundary(managementProviders: AccessProviderSelectionV1[] = []) {
  let metadata: Record<string, unknown> = {
    reachabilityPosture: { revision: 0, management: { providers: managementProviders,
      publicSsh: { kind: 'open', port: 22, sourceCidrs: ['0.0.0.0/0'] } }, defaultServiceIngress: { kind: 'none' } },
    accessProviderSelections: [], adminAccess: { version: 1, mode: 'preauthorized' },
    setup: createEmptyMachineSetupDesiredV1(),
  };
  let metadataVersion = 1;
  let onWrite: (() => void) | undefined;
  let readFailure: Error | undefined, readCount = 0;
  const writes: Record<string, unknown>[] = [];
  const port: MachineMetadataFieldPortV1 = {
    async read() {
      readCount += 1;
      if (readFailure) throw readFailure;
      return { status: 'ready', metadata, metadataVersion };
    },
    async compareAndSwap(input) {
      if (input.expectedMetadataVersion !== metadataVersion) return { status: 'conflict', metadata, metadataVersion };
      metadata = input.metadata; metadataVersion += 1; writes.push(metadata);
      onWrite?.();
      return { status: 'applied', metadata, metadataVersion };
    },
  };
  return { port, writes, read: () => ({ metadata, metadataVersion }),
    setOnWrite(callback: typeof onWrite) { onWrite = callback; },
    setReadFailure(error: Error) { readFailure = error; }, readCount: () => readCount };
}

/** Real Saved Secret envelope and K4 request producer, fake Home HTTP/row IO. */
export function installReachabilityHomeHttpBoundary(params: Readonly<{
  installationPublicKey: Uint8Array;
  privateSetupKey: string;
  connectorSubject: MachineConnectorSecretGrantSubjectV1;
  onGrantRead?(): void;
}>) {
  const serverIdentityId = 'srv_generic_fixture';
  let signedActions: Pick<Awaited<ReturnType<typeof createExternalActionHomeProcessForTests>>,
    'token' | 'request' | 'readConnectorGrantCount' | 'removeConnectorGrant' | 'manageGrantee'> | undefined;
  // Private error redaction only; never storage, admission or grant observation.
  const connectorGrantRedactions = new Set<string>();
  const artifacts = new Map<string, Readonly<Record<string, unknown>>>();
  const artifactWaiters = new Set<(artifactId: string) => void>();
  const artifactCas: Readonly<{ operation: 'create' | 'update'; attemptedStatus?: string; existingStatus?: string;
    expectedHeaderVersion?: number; expectedBodyVersion?: number; existingHeaderVersion?: number; existingBodyVersion?: number;
    acknowledgedHeaderVersion?: number; acknowledgedBodyVersion?: number;
    outcome: 'committed' | 'version_mismatch' | 'not_found' }>[] = [];
  const recordArtifactCas = (input: Record<string, unknown>, previous: Readonly<Record<string, unknown>> | undefined,
    outcome: 'committed' | 'version_mismatch' | 'not_found', acknowledged?: Readonly<{ headerVersion: number; bodyVersion: number }>) => {
    const status = (carrier: Readonly<Record<string, unknown>> | undefined): string | undefined => {
      try {
        if (!carrier || typeof carrier.header !== 'string' || typeof carrier.body !== 'string') return undefined;
        const header = decodePlainArtifactStoredContent(carrier.header), body = decodePlainArtifactStoredContent(carrier.body);
        if (!header || typeof header !== 'object' || Array.isArray(header)
          || !body || typeof body !== 'object' || !('body' in body) || typeof body.body !== 'string') return undefined;
        const request = approvalArtifactBodyMatchesHeaderV1(header as Record<string, unknown>, body.body);
        return request?.family === 'built_in' ? request.request.status : undefined;
      } catch { return undefined; } // Diagnostics must not change a transport outcome.
    };
    const version = (value: unknown) => typeof value === 'number' ? value : undefined;
    artifactCas.push({ operation: typeof input.id === 'string' ? 'create' : 'update',
      attemptedStatus: status(input), existingStatus: status(previous), outcome,
      expectedHeaderVersion: version(input.expectedHeaderVersion), expectedBodyVersion: version(input.expectedBodyVersion),
      existingHeaderVersion: version(previous?.headerVersion), existingBodyVersion: version(previous?.bodyVersion),
      acknowledgedHeaderVersion: acknowledged?.headerVersion, acknowledgedBodyVersion: acknowledged?.bodyVersion });
  };
  const requests: Readonly<{ path: string; method: 'GET' | 'POST' }>[] = [];
  const authorizationMintResponses: Readonly<{
    routePattern: '/v1/actions/:actionId/execution-authorization';
    status: number;
    authorizationSchemaSuccess: boolean;
  }>[] = [];
  const unsupportedHttp: Readonly<{ method: string; routePattern: string }>[] = [];
  const recordUnsupported = (method: string, path: string) => {
    // Record only the canonical route shape, never selectors or request data.
    const routePattern = /^\/v1\/actions\/[^/]+\/execution-authorization$/.test(path)
      ? '/v1/actions/:actionId/execution-authorization'
      : /^\/v1\/actions\/[^/]+$/.test(path) ? '/v1/actions/:actionId'
      : /^\/v1\/machines\/[^/]+$/.test(path) ? '/v1/machines/:machineId'
      : '[unrecognized-route]';
    unsupportedHttp.push({ method, routePattern });
  };
  let revoked = false;
  let refuseAdmissionAfterExecutionClaim = false;
  const admissionEnvelope = z.strictObject({ v: z.literal(1), context: SocketRpcMachineAdmissionContextV1Schema,
    method: z.string().check(z.minLength(1)), proof: MachineInstallationProofV1Schema });
  const admissionProofChecks: Readonly<{ signatureValid: boolean; accepted: boolean }>[] = [];
  let publishedMachine: (() => Machine & { kind: 'persistent' | 'ephemeral_session_runner' }) | undefined;
  const machinePublication = () => {
    if (!publishedMachine) throw new Error('The actual Machine publication is unavailable');
    const machine = publishedMachine();
    const bootstrap = ExternalActionMachineBootstrapV1Schema.parse({ id: machine.id, kind: machine.kind,
      active: machine.active, installationId: machine.installationId, dataEncryptionKey: machine.dataEncryptionKey,
      revokedAt: machine.revokedAt, replacedByMachineId: machine.replacedByMachineId, access: machine.access });
    return { ...bootstrap, storageMode: machine.encryptionMode,
      metadata: machine.metadata === null ? null : encodePlainMachineStoredContent(StoredMachinePublishedMetadataV1Schema.parse(machine.metadata)),
      metadataVersion: machine.metadataVersion,
      daemonState: machine.daemonState === null ? null : encodePlainMachineStoredContent(StoredMachinePublishedDaemonStateV1Schema.parse(machine.daemonState)),
      daemonStateVersion: machine.daemonStateVersion, installationPublicKey: encodeBase64(params.installationPublicKey, 'base64') };
  };
  let accountActionsSettings = ActionsSettingsV1Schema.parse({ v: 1 });
  const accountActionPolicies = new Map<string, typeof accountActionsSettings>();
  const storedContent = sealSavedSecretResourceStoredContentV1({ resourceId: 'generic-join-resource', mode: 'plain',
    content: { v: 1, name: 'Generic setup key', kind: 'token', value: params.privateSetupKey } });
  const secretMaterialReads: Readonly<{ accountId: string; resourceId: string }>[] = [];
  const connectorSetRequesterProofs: boolean[] = [];
  const requestHeaders = (headers: AxiosRequestConfig['headers']) => axios.AxiosHeaders.from(
    Object.fromEntries(Object.entries(headers ?? {}).filter(([, value]) => value !== undefined)));
  const requestAccountId = (headers: AxiosRequestConfig['headers']): string => {
    if (!signedActions?.manageGrantee) return 'generic-owner';
    const authorization = requestHeaders(headers).get('Authorization');
    if (authorization === `Bearer ${signedActions.manageGrantee.token}`) return signedActions.manageGrantee.accountId;
    if (authorization === `Bearer ${signedActions.token}`) return 'generic-owner';
    throw new Error('Fixture Account HTTP authentication is unavailable');
  };
  const get = vi.spyOn(axios, 'get').mockImplementation(async (url, options) => {
    const path = new URL(String(url)).pathname;
    requests.push({ path, method: 'GET' });
    const accountId = requestAccountId(options?.headers);
    if (path === `/v1/machines/${machineId}`) return { status: 200, data: { machine: machinePublication() } };
    if (path === '/v1/machines') return { status: 200, data: [machinePublication()] };
    if (path === '/v1/account/profile') return { status: 200, data: { id: accountId } };
    if (path === '/v1/account/encryption') return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
    if (path === '/v1/account/security') return { status: 200, data: AccountSecurityGetResponseV1Schema.parse({
      v: 1, encryptionMode: 'plain', nativeEmail: null,
      password: { status: 'not_enrolled', revision: null },
    }) };
    if (path === '/v2/changes') return { status: 200, data: { changes: [], nextCursor: 0 } };
    if (path === '/v1/account/authoring-memory') return { status: 200, data: { rows: [] } };
    if (path === '/v1/artifacts') return { status: 200, data: [...artifacts.values()] };
    if (path.startsWith('/v1/artifacts/')) {
      const artifact = artifacts.get(path.slice('/v1/artifacts/'.length));
      return artifact ? { status: 200, data: artifact } : { status: 404, data: { error: 'not_found' } };
    }
    if (path === '/v1/account/encryption/currentness') return { status: 200, data: {
      mode: 'plain', version: 1, settingsVersion: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1,
    } };
    if (path === '/v2/account/settings') return { status: 200, data: { content: { t: 'plain', v: {
      actionsSettingsV1: accountActionPolicies.get(accountId) ?? accountActionsSettings,
    } }, version: 1 } };
    if (path === '/v1/account/saved-secrets/resources/materials') {
      const secretOwner = signedActions?.manageGrantee?.accountId ?? 'generic-owner';
      const readable = !revoked && accountId === secretOwner;
      if (readable) secretMaterialReads.push({ accountId, resourceId: 'generic-join-resource' });
      return { status: 200, data: { resources: readable ? [{
      resourceId: 'generic-join-resource', encryptionMode: 'plain', storedContent, recipientEnvelope: null,
      entry: { ref: selection.credentialRefs[0].credentialRef.ref, source: 'shared_resource', relationship: 'owner',
        name: 'Generic setup key', kind: 'token', ownerAccountId: secretOwner, revision: 1, materialStatus: 'ready',
        capabilities: { use: true, rename: true, rotate: true, manageAccess: true, delete: true } },
      }] : [] } };
    }
    recordUnsupported('GET', path);
    throw new Error(`Unexpected fixture Home GET ${path}`);
  });
  const forwardHomeHttp = async (path: string, body: unknown, options?: Pick<AxiosRequestConfig, 'headers' | 'signal'>) => {
    if (!signedActions) throw new Error('The genuine fixture Home ingress is unavailable');
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(requestHeaders(options?.headers).toJSON(true))) {
      if (typeof value !== 'string') throw new Error('The fixture Home HTTP header is not serializable');
      headers[name] = value;
    }
    const signal = options?.signal;
    if (signal && !(signal instanceof AbortSignal)) {
      throw new Error('The fixture Home HTTP cancellation owner is unavailable');
    }
    // Both canonical callers select validateStatus: () => true. Forward the
    // actual response, signed headers and body without granting local custody.
    const response = await signedActions.request('POST', path, body, headers, signal);
    if (/^\/v1\/actions\/[^/]+\/execution-authorization$/.test(path)) {
      authorizationMintResponses.push({ routePattern: '/v1/actions/:actionId/execution-authorization',
        status: response.status,
        authorizationSchemaSuccess: ExternalActionExecutionAuthorizationV1Schema.safeParse(response.data).success });
    }
    return response;
  };
  const request = vi.spyOn(axios, 'request').mockImplementation(async config => {
    const path = new URL(String(config.url)).pathname;
    requests.push({ path, method: 'POST' });
    if (String(config.method).toUpperCase() === 'POST'
      && path === managedMachineActionEndpointPathV1('machines.managed.list')) {
      ManagedMachineActionInputSchemasV1['machines.managed.list'].parse(config.data);
      // This enrolled Machine has no provisioner-owned row in the fresh Home.
      return { status: 200, data: ManagedMachineActionOutputSchemasV1['machines.managed.list'].parse({ machines: [] }) };
    }
    if (String(config.method).toUpperCase() !== 'POST'
      || path !== '/v1/deployments/machines/' + machineId + '/connector-secret-grant') {
      recordUnsupported(String(config.method), path);
      throw new Error('Unsupported fixture connector HTTP transport');
    }
    const parsed = MachineConnectorSecretGrantInputV1Schema.safeParse(config.data);
    if (parsed.success && parsed.data.operation === 'set') connectorGrantRedactions.add(parsed.data.grant.sealedContent);
    if (parsed.success && parsed.data.operation === 'set' && signedActions?.manageGrantee) {
      const { proof, ...body } = parsed.data;
      // Call-through cryptographic observation of the actual outgoing request,
      // never a substitute for the real Home route's authorization decision.
      connectorSetRequesterProofs.push(verifyMachineInstallationProof({ payload: { version: 1,
        accountId: signedActions.manageGrantee.accountId, machineId: parsed.data.hostMachineId,
        installationId: parsed.data.hostInstallationId,
        deploymentSecretLaunch: { requestBodyDigest: computeEnvironmentSecretLaunchAdmissionDigestV1(body) } },
        proof, publicKey: params.installationPublicKey }));
    }
    const response = await forwardHomeHttp(path, config.data, config);
    if (parsed.success && parsed.data.operation === 'read') params.onGrantRead?.();
    return response;
  });
  const post = vi.spyOn(axios, 'post').mockImplementation(async (url, body, options) => {
    const path = new URL(String(url)).pathname;
    requests.push({ path, method: 'POST' });
    if (path.startsWith('/v1/actions/')) return forwardHomeHttp(path, body, options);
    if (path === PluginAvailabilityActionHttpPathsV1['account.plugins.availability.intent.read']) {
      if (options?.signal?.aborted) throw new axios.CanceledError();
      const input = PluginAvailabilityIntentReadActionInputV1Schema.parse(body);
      const current = await readStoredCredentialsForServerId('generic-home');
      if (options?.signal?.aborted) throw new axios.CanceledError();
      const requesterToken = signedActions?.manageGrantee?.token;
      if (!current || readAccountIdFromToken(current.token) !== 'generic-owner'
        || (options?.headers?.Authorization !== `Bearer ${current.token}`
          && (!requesterToken || options?.headers?.Authorization !== `Bearer ${requesterToken}`))) {
        throw new Error('Fixture Home availability authentication is unavailable');
      }
      // This fixture models the ordinary Account placement read, not removal
      // preflight or managed-resource disposition. Those remain unsupported.
      if (input.includeManagedResources !== undefined) {
        recordUnsupported('POST', path);
        throw new Error('Fixture Home managed-resource availability is unavailable');
      }
      // The real authored fixture commits only a local-path Machine install.
      // This fresh Home has accepted no Account intent/release writes: null
      // is the server owner's absent-row projection, not an executable grant.
      // The real Account selector therefore falls through to the independently
      // admitted physical Machine catalog; it cannot manufacture an Account release.
      return { status: 200, data: PluginAvailabilityIntentReadActionOutputV1Schema.parse({
        availabilityCursor: 0, hostingCapability: { enabled: false },
        intent: null, release: null, uiArtifacts: [], packageAssets: [],
      }) };
    }
    if (path === `/v1/machines/${machineId}/admission/verify`) {
      // The new cross-person case spends the real Home's grant and installed
      // signature owner; the existing owner-only fault fixture stays intact.
      if (signedActions?.manageGrantee) return forwardHomeHttp(path, body, options);
      // Supported subset of the server-owned strict HTTP envelope. Routing,
      // requester-purpose and signed external Action operands remain refused.
      const parsed = admissionEnvelope.safeParse(body);
      const current = await readStoredCredentialsForServerId('generic-home');
      const machine = publishedMachine?.();
      const requestToken = options?.headers?.Authorization;
      const context = parsed.success ? parsed.data.context : undefined;
      const accountId = current ? readAccountIdFromToken(current.token) : null;
      const bound = !!parsed.success && !!current && requestToken === `Bearer ${current.token}`
        && accountId !== null && context?.actorAccountId === accountId && context.custodianAccountId === accountId
        && !!machine && machine.kind === 'persistent' && machine.active === true
        && machine.revokedAt === null && machine.replacedByMachineId === null
        && machine.encryptionMode === 'plain' && machine.installationId === installationId
        && context.machineId === machine.id && context.installationId === machine.installationId
        && context.role === 'manage' && context.encryptionMode === 'plain'
        && machine.access?.custodian.accountId === accountId && machine.access.role === 'manage'
        && machine.access.accessState === 'ready' && machine.access.resourceMode === 'plain'
        && supportedPlainMachineRpcMethods.includes(parsed.data.method);
      const payload = bound && parsed.success && machine ? MachineInstallationProofPayloadV1Schema.parse({
        version: 1, machineId: machine.id, installationId: machine.installationId,
        accountId, rpcAdmission: { context: parsed.data.context, method: parsed.data.method },
      }) : null;
      const signatureValid = payload !== null && parsed.success && verifyMachineInstallationProof({
        payload, proof: parsed.data.proof, publicKey: params.installationPublicKey,
      });
      // Genuine Home HTTP refusal after the retained Artifact's real claim.
      const claimCommitted = artifactCas.some(change => change.operation === 'update'
        && change.attemptedStatus === 'executing' && change.outcome === 'committed');
      const accepted = bound && signatureValid && !(refuseAdmissionAfterExecutionClaim && claimCommitted);
      admissionProofChecks.push({ signatureValid, accepted });
      return accepted ? { status: 200, data: MachineAdmissionVerifyResponseV1Schema.parse({ v: 1, ok: true }) }
        : { status: 403, data: { error: 'access_denied' } };
    }
    if (path === '/v1/artifacts') {
      const input = readCarrierMutation(body);
      if (typeof input.id !== 'string') throw new Error('The Artifact producer omitted its public id');
      const artifact = { ...input, ownerAccountId: requestAccountId(options?.headers), access: 'owner', encryptionMode: 'plain',
        publicAudience: 'none', headerVersion: 1, bodyVersion: 1, seq: artifacts.size + 1, createdAt: 1, updatedAt: 1 };
      artifacts.set(input.id, artifact);
      console.info('Generic approval transport observation', readFixtureApprovalFact(artifact));
      recordArtifactCas(input, undefined, 'committed', { headerVersion: 1, bodyVersion: 1 });
      for (const waiter of artifactWaiters) waiter(input.id);
      artifactWaiters.clear();
      return { status: 200, data: { id: input.id, headerVersion: 1, bodyVersion: 1 } };
    }
    if (path.startsWith('/v1/artifacts/')) {
      const artifactId = path.slice('/v1/artifacts/'.length), previous = artifacts.get(artifactId);
      const input = readCarrierMutation(body);
      if (!previous) { recordArtifactCas(input, previous, 'not_found');
        return { status: 404, data: { success: false, error: 'not_found' } }; }
      if (input.expectedHeaderVersion !== previous.headerVersion || input.expectedBodyVersion !== previous.bodyVersion) {
        recordArtifactCas(input, previous, 'version_mismatch');
        return { status: 409, data: { success: false, error: 'version-mismatch' } };
      }
      const headerVersion = Number(previous.headerVersion) + 1, bodyVersion = Number(previous.bodyVersion) + 1;
      artifacts.set(artifactId, { ...previous, ...input, headerVersion, bodyVersion });
      recordArtifactCas(input, previous, 'committed', { headerVersion, bodyVersion });
      return { status: 200, data: { success: true, headerVersion, bodyVersion } };
    }
    recordUnsupported('POST', path);
    throw new Error(`Unexpected fixture Home POST ${path}`);
  });
  const originalFetch = globalThis.fetch;
  const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, options) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? String(input) : input.url);
    if (url.origin !== 'https://home.generic.test') return originalFetch(input, options);
    if (!['/v1/features', '/v1/features/authenticated'].includes(url.pathname)) {
      recordUnsupported('GET', url.pathname);
      throw new Error(`Unexpected fixture Home fetch ${url.pathname}`);
    }
    return new Response(JSON.stringify(FeaturesResponseSchema.parse({ features: {},
      capabilities: { serverIdentity: { serverIdentityId } },
    })), { status: 200,
      headers: { 'content-type': 'application/json' } });
  });
  return { serverIdentityId, requests, authorizationMintResponses, unsupportedHttp, admissionProofChecks, artifactCas,
    secretMaterialReads, connectorSetRequesterProofs,
    connectorGrantRedactions: () => connectorGrantRedactions.values(),
    async readConnectorGrantCount() {
      if (!signedActions) throw new Error('The genuine fixture Home connector owner is unavailable');
      return signedActions.readConnectorGrantCount(params.connectorSubject);
    },
    async revoke() {
      if (!signedActions) throw new Error('The genuine fixture Home connector owner is unavailable');
      await signedActions.removeConnectorGrant(params.connectorSubject);
      revoked = true;
    },
    bindSignedActions(value: NonNullable<typeof signedActions>) { signedActions = value; },
    refuseAdmissionAfterClaim() { refuseAdmissionAfterExecutionClaim = true; },
    bindMachine(read: NonNullable<typeof publishedMachine>) { publishedMachine = read; },
    artifacts,
    readApprovalFacts() { return [...artifacts.values()].map(readFixtureApprovalFact); },
    waitForArtifactCreate() { return artifacts.size ? Promise.resolve(artifacts.keys().next().value!)
      : new Promise<string>(resolve => { artifactWaiters.add(resolve); }); },
    approvalRequests() {
      return [...artifacts.values()].map(artifact => {
        if (typeof artifact.header !== 'string' || typeof artifact.body !== 'string') throw new Error('Expected actual plain Artifact byte carriers');
        const header = decodePlainArtifactStoredContent(artifact.header), body = decodePlainArtifactStoredContent(artifact.body);
        if (!header || typeof header !== 'object' || Array.isArray(header)
          || !body || typeof body !== 'object' || !('body' in body) || typeof body.body !== 'string') throw new Error('Invalid actual approval Artifact');
        const parsed = approvalArtifactBodyMatchesHeaderV1(header as Record<string, unknown>, body.body);
        if (parsed?.family !== 'built_in') throw new Error('Expected a genuine built-in Action approval');
        return parsed.request;
      });
    },
    setActionsSettings(value: typeof accountActionsSettings) { accountActionsSettings = value; },
    setActionsSettingsForAccount(accountId: string, value: typeof accountActionsSettings) { accountActionPolicies.set(accountId, value); },
    dispose() { fetch.mockRestore(); post.mockRestore(); request.mockRestore(); get.mockRestore(); } };
}

type AuthoredFiles = Parameters<typeof createAuthoredAdmittedPluginRuntimeFixture>[0]['plugins'][number]['files'];
export type AuthoredProvider = Readonly<{ pluginId: string; plugin: Parameters<typeof createAuthoredAdmittedPluginRuntimeFixture>[0]['plugins'][number] }>;
type RuntimeOptions = NonNullable<Parameters<typeof createAdmittedPluginRuntimeFixture>[0]>['runtimeOptions'];

export async function createPublicGenericRuntime(params: Readonly<{
  occurrence: 'external'; authoredProvider: AuthoredProvider; happyHomeDir?: string;
  controller?: NonNullable<Parameters<typeof createAdmittedPluginRuntimeFixture>[0]>['controller'];
}>) {
  return createAuthoredAdmittedPluginRuntimeFixture({ happyHomeDir: params.happyHomeDir, controller: params.controller,
    plugins: [params.authoredProvider.plugin],
    async resolveContributes(happyHomeDir) {
      const loaded = await loadInstalledPlugins({ happyHomeDir });
      expect(loaded.loadedPlugins.map(plugin => plugin.pluginId)).toEqual([params.authoredProvider.pluginId]);
      return createResolvedContributionRegistry(projectLoadedPluginContributes({ loadResult: loaded, provenance: 'external' }));
    },
    runtimeOptions: { resolveCurrentMachineId: () => machineId,
      resolveCurrentMachineExecutionOriginContext: async () => ({ serverIdentityId: 'generic-home', machineId }) },
  });
}

/** Only the OS process boundary is substituted; SDK lookup and supervision stay real. */
export async function installGenericOsBoundary(params: Readonly<{
  directory: string; filesystem: Awaited<ReturnType<typeof installGenericRootFileSystemBoundary>>;
}>) {
  const bin = join(params.directory, 'native-bin');
  await mkdir(bin, { recursive: true });
  const probePaths = ['systemctl', 'docker'].map(name => join(bin, name));
  const priorPath = process.env.PATH;
  vi.stubEnv('PATH', bin);
  const originalSpawn = childProcess.spawn, originalExecFile = childProcess.execFile;
  const execFile = vi.spyOn(childProcess, 'execFile').mockImplementation((...args: Parameters<typeof childProcess.execFile>) => {
    if ((args[0] === process.execPath && Array.isArray(args[1]) && args[1][0] === '-e') || args[0] === 'ps') {
      return Reflect.apply(originalExecFile, childProcess, args);
    }
    const refusal = Object.assign(new Error('Unapproved fixture process'), { code: 'generic_fixture_os_refused' }); inspectFixtureDiagnostic('generic_execFile_refused', refusal); throw refusal;
  });
  const genericTool = join(bin, 'network-client');
  const builtinTailscaleTool = join(bin, 'tailscale');
  let genericNative: ((command: MachineSetupNativeCommand) => Promise<MachineSetupNativeCommandResult>) | undefined;
  const spawn = vi.spyOn(childProcess, 'spawn').mockImplementation((...invocation: Parameters<typeof childProcess.spawn>) => {
    const [command, candidateArgs] = invocation;
    if ((command === genericTool || command === params.filesystem.resolvePath('/usr/bin/network-client')) && genericNative) {
      // Exec.run owns stdin and closes its default empty input. Keep the
      // fixture's OS response on a separate pipe, not the tool's stdin.
      const child = originalSpawn(process.execPath, ['-e', "let b='';const reply=require('node:fs').createReadStream(null,{fd:3});reply.on('data',c=>b+=c);reply.on('end',()=>{const r=JSON.parse(b);process.stdout.write(r.stdout);process.stderr.write(r.stderr);process.exitCode=r.code;});"], {
        ...invocation[2], stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
      });
      const reply = child.stdio[3];
      if (!(reply instanceof Writable)) throw new Error('Fixture native reply pipe is unavailable');
      // Cancellation is observed by the real supervisor; its closed child may
      // reject a late OS-adapter response without creating an unhandled EPIPE.
      reply.on('error', () => {});
      void genericNative({ executable: '/usr/bin/network-client', args: Array.isArray(candidateArgs) ? candidateArgs : [] })
        .then(result => reply.end(JSON.stringify(result)), () => reply.end(JSON.stringify({ code: 1, stdout: '', stderr: '' })));
      return child;
    }
    if (command === process.execPath && Array.isArray(candidateArgs) && candidateArgs[0] === '-e' || command === 'ps') {
      return Reflect.apply(originalSpawn, childProcess, invocation);
    }
    const refusal = Object.assign(new Error('Unapproved fixture native process'), { code: 'generic_fixture_os_refused' }); inspectFixtureDiagnostic('generic_spawn_refused', refusal); throw refusal;
  });
  return { probePaths,
    builtinTailscaleTool,
    async installBuiltinTailscaleTool() {
      await mkdir('/usr/bin', { recursive: true });
      await writeFile('/usr/bin/tailscale', 'fixture native executable', { mode: 0o755 });
      await symlink(params.filesystem.resolvePath('/usr/bin/tailscale'), builtinTailscaleTool);
    },
    async installGenericNetworkTool(run: NonNullable<typeof genericNative>, available = true) {
      genericNative = run;
      await mkdir('/usr/bin', { recursive: true });
      const nativePath = params.filesystem.resolvePath('/usr/bin/network-client');
      await symlink(nativePath, genericTool);
      if (available) await writeFile('/usr/bin/network-client', 'fixture native executable', { mode: 0o755 });
    },
    async installEngineProbeTools() { for (const path of probePaths) await writeFile(path, '', { mode: 0o755 }); },
    dispose() {
      spawn.mockRestore(); execFile.mockRestore();
      if (priorPath === undefined) delete process.env.PATH; else process.env.PATH = priorPath;
    },
  };
}

export async function installGenericRootFileSystemBoundary(directory: string) {
  const fs = fixtureOs.promises, sync = fixtureOs.sync;
  if (!fs || !sync) throw new Error('The genuine filesystem boundary is unavailable');
  const root = resolve(directory), rootfs = join(root, 'rootfs');
  // The real file inspector walks the established temp root's ancestors.
  // Admit only their directory metadata, never content or mutation access.
  const ancestorMetadata = new Set<string>();
  for (let ancestor = dirname(root); ; ancestor = dirname(ancestor)) {
    ancestorMetadata.add(ancestor);
    if (dirname(ancestor) === ancestor) break;
  }
  const repo = fileURLToPath(new URL('../../../../../', import.meta.url));
  const inside = (base: string, path: string) => path === base || path.startsWith(base + sep);
  const privilegedRoots = ['/etc', '/run', '/usr', '/var'];
  const pathname = (value: unknown) => value instanceof URL ? fileURLToPath(value)
    : typeof value === 'string' ? value : Buffer.isBuffer(value) ? value.toString() : null;
  const refused = (): never => { throw Object.assign(new Error('Unconfined fixture filesystem operation'), { code: 'generic_fixture_os_refused' }); };
  const mapped = (value: unknown, writing: boolean) => {
    const path = pathname(value);
    if (!path || !isAbsolute(path)) return refused();
    const resolved = resolve(path);
    if (inside(root, resolved)) return resolved;
    if (!writing && resolved === `/proc/${process.pid}/stat`) return resolved;
    if (privilegedRoots.some(base => inside(base, resolved))) return join(rootfs, resolved);
    if (!writing && inside(resolve(repo), resolved)) return resolved;
    const basename = resolved.split(sep).at(-1) ?? '';
    if (writing && resolve(resolved, '..') === resolve(tmpdir())
      && ['happier-setup-key-', 'happier-admitted-plugin-runtime-', 'happier-authored-plugin-runtime-'].some(prefix => basename.startsWith(prefix))) {
      return join(root, basename);
    }
    return refused();
  };
  for (const path of ['etc/apt/sources.list.d', 'etc/systemd/system', 'run', 'usr/share/keyrings', 'var/lib']) {
    await fs.mkdir(join(rootfs, path), { recursive: true, mode: 0o755 });
  }
  const ownership = new Map<string, Readonly<{ uid: number; gid: number }>>();
  const dockerFd = join(root, 'native-docker-fd');
  await fs.mkdir(dockerFd);
  await fs.symlink('socket:[123]', join(dockerFd, '3'));
  let dockerProcessAvailable = false;
  let sshProcessAvailable = false;
  const dockerFactReads: ('identity' | 'descriptors' | 'listeners')[] = [];
  const mutations: Readonly<{ method: string; paths: readonly string[] }>[] = [];
  const reads = new Set(['lstat', 'stat', 'readFile', 'readdir', 'realpath', 'readlink', 'access', 'opendir']);
  const writes = new Set(['mkdir', 'writeFile', 'chmod', 'chown', 'rename', 'unlink', 'rm', 'mkdtemp', 'copyFile', 'link', 'rmdir', 'symlink']);
  const ownedStat = (result: unknown, path: string) => {
    if (!result || typeof result !== 'object') return result;
    const owner = ownership.get(path) ?? (inside(rootfs, path) ? { uid: 0, gid: 0 } : undefined);
    return owner ? new Proxy(result, { get(target, key, receiver) {
      return key === 'uid' ? owner.uid : key === 'gid' ? owner.gid : Reflect.get(target, key, receiver);
    } }) : result;
  };
  fixtureOs.promiseRoute = async (method, args) => {
    const input = pathname(args[0]);
    // Exact procfs/OS facts only. The production local-engine binding parser,
    // socket correlation and explicit Engine API probe remain untouched.
    if (sshProcessAvailable && method === 'readlink' && input === '/proc/412/exe') return '/usr/sbin/sshd';
    if (sshProcessAvailable && method === 'readlink' && input === '/proc/1/exe') return '/usr/lib/systemd/systemd';
    if (dockerProcessAvailable) {
      const links: Readonly<Record<string, string>> = { '/proc/42/exe': '/usr/bin/dockerd', '/proc/42/root': '/',
        '/proc/42/ns/mnt': 'mnt:[1]', '/proc/self/ns/mnt': 'mnt:[1]',
        '/proc/42/ns/net': 'net:[2]', '/proc/self/ns/net': 'net:[2]', '/proc/42/fd/3': 'socket:[123]' };
      if (method === 'readlink' && input && Object.hasOwn(links, input)) { dockerFactReads.push('identity'); return links[input]; }
      if (method === 'readdir' && input === '/proc/42/fd') { dockerFactReads.push('descriptors'); return Reflect.apply(fs.readdir, fs, [dockerFd, ...args.slice(1)]); }
      if (method === 'readFile' && input === '/proc/42/net/unix') {
        dockerFactReads.push('listeners');
        const bytes = 'Num RefCount Protocol Flags Type St Inode Path\n0000: 00000002 00000000 00010000 0001 01 123 /run/actual-engine.sock\n';
        return args[1] === 'utf8' ? bytes : Buffer.from(bytes);
      }
    }
    if (method === 'lstat' && input !== null && ancestorMetadata.has(input)) return fs.lstat(input);
    if (method === 'opendir' && (input === null || !isAbsolute(input) || !inside(root, resolve(input)))) return refused();
    if (method === 'readFile' && input === '/proc/1/comm') return typeof args[1] === 'string' ? 'systemd\n' : Buffer.from('systemd\n');
    const opening = method === 'open';
    if (!reads.has(method) && !writes.has(method) && !opening) return refused();
    const flags = opening ? args[1] : undefined;
    if (opening && (typeof flags !== 'string' || !['r', 'rs', 'w', 'wx', 'a', 'ax', 'r+'].includes(flags))) return refused();
    const reading = reads.has(method) || opening && (flags === 'r' || flags === 'rs');
    const paths = [mapped(args[0], method === 'copyFile' ? false : !reading)];
    const mappedArgs = [...args]; mappedArgs[0] = paths[0];
    if (method === 'symlink') { paths.push(mapped(args[1], true)); mappedArgs[1] = paths[1]; }
    if (method === 'rename' || method === 'copyFile' || method === 'link') {
      paths[0] = mapped(args[0], method !== 'copyFile'); mappedArgs[0] = paths[0];
      paths.push(mapped(args[1], true)); mappedArgs[1] = paths[1];
    }
    if (!reading) mutations.push({ method, paths });
    if (method === 'chown') {
      if (typeof args[1] !== 'number' || typeof args[2] !== 'number') return refused();
      ownership.set(paths[0]!, { uid: args[1], gid: args[2] }); return;
    }
    const original: unknown = Reflect.get(fs, method);
    if (typeof original !== 'function') return refused();
    const rootWriter = process.getuid?.() === 0;
    const created = rootWriter && (method === 'writeFile' || method === 'mkdir' || opening && !reading)
      && await fs.lstat(paths[0]!).then(() => false, error => {
        if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return true;
        throw error;
      });
    const result: unknown = await Reflect.apply(original, fs, mappedArgs);
    if (created) ownership.set(paths[0]!, { uid: 0, gid: 0 });
    if (rootWriter && method === 'mkdtemp' && typeof result === 'string') ownership.set(result, { uid: 0, gid: 0 });
    if (method === 'rename') {
      const owner = ownership.get(paths[0]!);
      if (owner) { ownership.set(paths[1]!, owner); ownership.delete(paths[0]!); }
    }
    if (method === 'lstat' || method === 'stat') return ownedStat(result, paths[0]!);
    if (method === 'unlink' || method === 'rm') {
      for (const path of ownership.keys()) if (inside(paths[0]!, path)) ownership.delete(path);
    }
    // The filesystem projects privileged paths into rootfs internally. Preserve
    // the requested namespace when the OS returns a newly created directory.
    if (method === 'mkdtemp' && typeof result === 'string' && input !== null
      && privilegedRoots.some(base => inside(base, resolve(input)))) {
      return resolve(input) + result.slice(paths[0]!.length);
    }
    return result;
  };
  fixtureOs.syncRoute = (method, args) => {
    // The canonical settings lock observes only this runner's real procfs
    // identity. Other runtime paths still require scratch confinement.
    const writing = ['mkdirSync', 'chmodSync', 'writeFileSync', 'renameSync', 'unlinkSync'].includes(method);
    const paths = [mapped(args[0], writing)];
    const mappedArgs = [paths[0], ...args.slice(1)];
    if (method === 'renameSync') { paths.push(mapped(args[1], true)); mappedArgs[1] = paths[1]; }
    if (writing) mutations.push({ method, paths });
    const original: unknown = Reflect.get(sync, method);
    if (typeof original !== 'function') return refused();
    const result: unknown = Reflect.apply(original, sync, mappedArgs);
    return method === 'lstatSync' || method === 'statSync' ? ownedStat(result, paths[0]!) : result;
  };
  // Prove the named VM imports enter the fail-closed adapter BEFORE any
  // sudoers seeding. Unknown reads, writes, normalized escapes and unused
  // mutators are refused without calling the real host filesystem.
  for (const path of ['/opt/generic-fixture-forbidden', '/etc/../opt/generic-fixture-forbidden']) {
    await expect(writeFile(path, 'not-written')).rejects.toMatchObject({ code: 'generic_fixture_os_refused' });
    await expect(readFile(path)).rejects.toMatchObject({ code: 'generic_fixture_os_refused' });
  }
  await expect(rename(join(root, 'unused-source'), '/opt/generic-fixture-forbidden')).rejects.toMatchObject({ code: 'generic_fixture_os_refused' });
  expect(() => readFileSync('/opt/generic-fixture-forbidden')).toThrow();
  expect(() => lstatSync('/opt/generic-fixture-forbidden')).toThrow();
  const namedFs = await import('node:fs/promises');
  await expect(namedFs.appendFile('/opt/generic-fixture-forbidden', 'not-written')).rejects.toMatchObject({ code: 'generic_fixture_os_refused' });
  return { rootfs, ownership, mutations, dockerFactReads, resolvePath: (path: string) => mapped(path, false),
    setDockerProcessAvailable(value: boolean) { dockerProcessAvailable = value; },
    setSshProcessAvailable(value: boolean) { sshProcessAvailable = value; },
    dispose() { fixtureOs.promiseRoute = null; fixtureOs.syncRoute = null; },
  };
}

/** The sudo process is substituted; its installed fixed root entry stays real. */
export function createElevationProcessBoundary(runNative: (command: MachineSetupNativeCommand) => Promise<MachineSetupNativeCommandResult>) {
  const launches: Parameters<MachineElevationSpawn>[0][] = [];
  const active = new Set<ReturnType<MachineElevationSpawn>>();
  let disposed = false;
  type Record = ReturnType<typeof MachineEffectInternalRecordSchema.parse>;
  type Result = Extract<Record, { type: 'result' }>['result'];
  const nativeEffectReason = (value: unknown): MachineSetupEffectError['reasonCode'] | undefined => {
    switch (value) {
      case 'foreign_effect_conflict': case 'validation_failed': case 'native_effect_failed':
      case 'package_manager_busy': case 'required_fact_unavailable': case 'needs_admin_to_check': return value;
      default: return undefined;
    }
  };
  const diagnostics: {
    requests: { mode: 'check' | 'apply'; plans: { basisKind: string; stepIds: string[] }[] }[];
    records: { type: Record['type']; atMs: number; resultStatus?: Result['status']; progressStatus?: string; phase?: 'check' | 'apply' | 'verify';
      stepId?: string; planIndex?: number; completedStepIds?: readonly string[]; reasonPresent?: boolean;
      nativeReason?: MachineSetupEffectError['reasonCode'] }[];
    exitCode?: number;
  }[] = [];
  let onSettled: ((code: number) => void) | undefined;
  let nextSpawnFailure: (() => never) | undefined;
  const spawn: MachineElevationSpawn = invocation => {
    if (disposed) throw Object.assign(new Error('Fixture elevation process boundary is closed'), { code: 'generic_fixture_os_refused' });
    launches.push(invocation);
    if (nextSpawnFailure) {
      const fail = nextSpawnFailure; nextSpawnFailure = undefined; fail();
    }
    const diagnostic: typeof diagnostics[number] = { requests: [], records: [] };
    diagnostics.push(diagnostic);
    console.info('Generic public journey stage', JSON.stringify({ stage: 'p20_spawn', atMs: Date.now() }));
    // The existing writers each emit one complete frame. Observe writes without
    // consuming a pipe or retaining content, grant frames, digests or open text.
    const stdin = new PassThrough({ transform(chunk: Buffer, _encoding, callback) {
      try {
        const parsed = MachineEffectInternalRequestSchema.safeParse(JSON.parse(chunk.toString('utf8')));
        if (parsed.success) {
          const request = parsed.data;
          // A firewall intent has no expanded native program on this frame.
          const plans = 'plans' in request ? request.plans.map(entry => entry.plan)
            : 'intent' in request ? [request.intent] : 'steps' in request ? [request] : [];
          diagnostic.requests.push({ mode: request.mode,
            plans: plans.map(plan => ({ basisKind: plan.basis.kind, stepIds: plan.steps.map(step => step.id) })) });
          console.info('Generic public journey stage', JSON.stringify({ stage: 'p20_request', atMs: Date.now(), mode: request.mode }));
        }
      } catch { /* Non-request frames remain private and pass through unchanged. */ }
      callback(null, chunk);
    } });
    const stdout = new PassThrough({ transform(chunk: Buffer, _encoding, callback) {
      try {
        const parsed = MachineEffectInternalRecordSchema.safeParse(JSON.parse(chunk.toString('utf8')));
        if (parsed.success) {
          const record = parsed.data;
          if (record.type === 'result' && record.result.status === 'checked') {
            const plans = 'plan' in record.result ? [record.result.plan] : record.result.plans.map(entry => entry.plan);
            console.info('Generic fixture boundary observation', { boundary: 'native_check',
              observations: plans.flatMap(plan => plan.nativeFacts).map(fact => ({
                step: fact.stepId === 'access-provider-setup-key' ? 'setup_key'
                  : fact.stepId === 'access-provider-credential-directory' ? 'credential_directory' : 'other',
                status: fact.status, reason: projectGenericFixtureCode(fact.reason),
                present: typeof fact.facts.present === 'boolean' ? fact.facts.present : undefined,
                uid: typeof fact.facts.uid === 'number' ? fact.facts.uid : undefined,
                gid: typeof fact.facts.gid === 'number' ? fact.facts.gid : undefined,
                mode: typeof fact.facts.mode === 'number' ? fact.facts.mode : undefined,
              })) });
          }
          if (record.type === 'ready') diagnostic.records.push({ type: record.type, atMs: Date.now() });
          else if (record.type === 'progress') diagnostic.records.push({ type: record.type,
            atMs: Date.now(), progressStatus: record.status,
            phase: record.phase, stepId: record.stepId, planIndex: record.planIndex, reasonPresent: record.reason !== undefined });
          else if (record.type === 'result') diagnostic.records.push({ type: record.type, atMs: Date.now(), resultStatus: record.result.status,
            ...(record.result.status === 'checked' ? {} : { stepId: record.result.stepId,
              completedStepIds: record.result.completedStepIds, reasonPresent: record.result.reason !== undefined,
              nativeReason: nativeEffectReason(record.result.reason) }) });
          else diagnostic.records.push({ type: record.type, atMs: Date.now() });
        }
      } catch { /* Secret controls and invalid records are not diagnostic payloads. */ }
      callback(null, chunk);
    } }), stderr = new PassThrough();
    const controller = new AbortController();
    // Root identity is the OS boundary of this in-process sudo fixture, using
    // exactly the same real installed entry as the canonical K4 composed test.
    const rootIdentity = (() => {
      try {
        const previous = Object.getOwnPropertyDescriptor(process, 'getuid');
        Object.defineProperty(process, 'getuid', { configurable: true, value: () => 0 });
        return { mockRestore() {
          if (previous) Object.defineProperty(process, 'getuid', previous);
          else delete process.getuid;
        } };
      }
      catch (error) { inspectFixtureDiagnostic('p20_identity_boundary_refused', error); throw error; }
    })();
    const running = runMachineSetupEffectInternal(invocation.args.slice(invocation.args.indexOf('effect-internal') + 1), {
      stdin, stdout, signal: controller.signal, runNative,
    });
    const settled = running.catch(error => {
      inspectFixtureDiagnostic('p20_entry_rejected', error);
      throw error;
    }).then(code => {
      diagnostic.exitCode = code;
      console.info('Generic public journey stage', JSON.stringify({ stage: 'p20_terminal', atMs: Date.now(), exitCode: code,
        requests: diagnostic.requests,
        progress: diagnostic.records.filter(record => record.type === 'progress'),
        results: diagnostic.records.filter(record => record.type === 'result').map(record => ({
          status: record.resultStatus, stepId: record.stepId,
          completedStepIds: record.completedStepIds, reasonPresent: record.reasonPresent, nativeReason: record.nativeReason,
        })) }));
      onSettled?.(code); return { code, signal: null };
    }).finally(() => {
      rootIdentity.mockRestore(); stdout.end(); stderr.end();
    });
    const child = { stdin, stdout, stderr, settled, async terminate() { controller.abort(); stdin.end(); await settled; } };
    active.add(child);
    void settled.then(() => active.delete(child), () => active.delete(child));
    return child;
  };
  return { spawn, launches, diagnostics, setOnSettled(callback: typeof onSettled) { onSettled = callback; },
    failNextSpawn(callback: () => never) { nextSpawnFailure = callback; },
    async dispose() {
      disposed = true;
      const results = await Promise.allSettled([...active].map(child => child.terminate()));
      const failed = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
      if (failed.length) throw new AggregateError(failed.map(result => result.reason), 'Fixture elevation processes did not settle');
    },
  };
}

/**
 * execFile's OS callback/stream boundary, following the testkit's ChildProcess
 * fixture shape. Starting a fresh Node row-printer for every identity recheck
 * cost 20.9s across 314 launches; no subprocess behavior was under test there.
 * execFileWithDeadline and the native identity/policy parsers remain real.
 */
function replyToGenericFixtureExecFile(invocation: Parameters<typeof childProcess.execFile>,
  response: Promise<MachineSetupNativeCommandResult>): ChildProcess {
  const callback = invocation.at(-1);
  if (typeof callback !== 'function') throw new Error('Expected the native execFile callback');
  const options = invocation[2];
  const signal = options && typeof options === 'object' ? options.signal : undefined;
  const bufferOutput = options && typeof options === 'object' && options.encoding === null;
  const child = new childProcess.ChildProcess();
  const stdin = new PassThrough(), stdout = new PassThrough(), stderr = new PassThrough();
  let completed = false;
  let exitCode: number | null = null;
  let terminalSignal: NodeJS.Signals | null = null;
  let killed = false;
  Object.defineProperties(child, {
    exitCode: { get: () => exitCode }, signalCode: { get: () => terminalSignal }, killed: { get: () => killed },
  });
  const finish = (result: MachineSetupNativeCommandResult, error?: Error, signalCode: NodeJS.Signals | null = null) => {
    if (completed) return;
    completed = true;
    signal?.removeEventListener('abort', abort);
    exitCode = signalCode ? null : result.code;
    terminalSignal = signalCode;
    stdin.end(); stdout.end(result.stdout); stderr.end(result.stderr);
    callback(error ?? (result.code !== 0 ? Object.assign(new Error('Fixture native command failed'), { code: result.code }) : null),
      bufferOutput ? Buffer.from(result.stdout) : result.stdout, bufferOutput ? Buffer.from(result.stderr) : result.stderr);
    child.emit('exit', child.exitCode, child.signalCode);
    child.emit('close', child.exitCode, child.signalCode);
  };
  const abort = () => finish({ code: 1, stdout: '', stderr: '' },
    Object.assign(new Error('The fixture native command was aborted'), { name: 'AbortError', code: 'ABORT_ERR' }), 'SIGTERM');
  Object.assign(child, { stdin, stdout, stderr, kill(requested?: NodeJS.Signals | number) {
    if (completed) return false;
    killed = true;
    queueMicrotask(() => finish({ code: 1, stdout: '', stderr: '' },
      Object.assign(new Error('The fixture native command was terminated'), { killed: true }),
      typeof requested === 'string' ? requested : 'SIGTERM'));
    return true;
  } });
  signal?.addEventListener('abort', abort, { once: true });
  void response.then(result => signal?.aborted ? abort() : finish(result), error =>
    finish({ code: 1, stdout: '', stderr: '' }, error instanceof Error ? error : new Error('Fixture native command refused')));
  return child;
}

/** Default-factory OS adapters; sudo runs the actual installed P20 interpreter. */
export function installGenericDefaultHostProcessBoundary(params: Readonly<{
  hostNative: ReturnType<typeof createGenericHostNativeBoundary>;
  elevation: ReturnType<typeof createElevationProcessBoundary>;
  os: Awaited<ReturnType<typeof installGenericOsBoundary>>;
}>) {
  const originalExecFile = childProcess.execFile;
  const originalSpawn = childProcess.spawn;
  const failures: unknown[] = [];
  const probeLaunches: ('systemctl' | 'docker')[] = [];
  const probeDispatchFailures: ('native_process_refused' | 'range' | 'other')[] = [];
  const probeTerminals: { tool: 'systemctl' | 'docker'; exitCode: number | null; stderrBytes: number }[] = [];
  const probePreparation: { toolExists: boolean; pathPresent: boolean; pathMatches: boolean }[] = [];
  const timing = { launched: 0, completed: 0, totalMs: 0, maxMs: 0 };
  const tools = new Set(['getent', 'id', 'dpkg', 'dpkg-query', 'lslocks', 'apt-cache', 'apt-get', 'curl', 'gpg', 'systemctl', '/usr/bin/systemctl', 'sudo', 'docker']);
  const execFile = vi.spyOn(childProcess, 'execFile').mockImplementation((...invocation: Parameters<typeof childProcess.execFile>) => {
    const [command, candidateArgs] = invocation;
    const isMembershipStatus = command === '/usr/bin/network-client' && Array.isArray(candidateArgs)
      && candidateArgs.length === 1 && candidateArgs[0] === 'status';
    const isBuiltinTailscale = command === 'tailscale' || command === '/usr/bin/tailscale'
      || command === params.os.builtinTailscaleTool;
    if ((!tools.has(command) && !isMembershipStatus && !isBuiltinTailscale) || !Array.isArray(candidateArgs)
      || candidateArgs.includes('happier-agent')) return Reflect.apply(originalExecFile, childProcess, invocation);
    const startedAt = Date.now(); timing.launched++;
    const child = replyToGenericFixtureExecFile(invocation,
      params.hostNative.runNative({ executable: command, args: candidateArgs }).catch(error => {
        failures.push(error); throw error;
      }));
    child.once('close', () => { const elapsed = Date.now() - startedAt;
      timing.completed++; timing.totalMs += elapsed; timing.maxMs = Math.max(timing.maxMs, elapsed); });
    return child;
  });
  const spawn = vi.spyOn(childProcess, 'spawn').mockImplementation((...invocation: Parameters<typeof childProcess.spawn>) => {
    const [command, candidateArgs] = invocation;
    // spawn itself resolves literal commands through PATH. Native host IO
    // legitimately uses that OS contract instead of an SDK resolved path.
    const probe = command === 'systemctl' ? 0 : command === 'docker' ? 1 : params.os.probePaths.indexOf(command);
    if (probe !== -1 && Array.isArray(candidateArgs)) {
      probeLaunches.push(probe === 0 ? 'systemctl' : 'docker');
      probePreparation.push({ toolExists: existsSync(params.os.probePaths[probe]!),
        pathPresent: typeof invocation[2]?.env?.PATH === 'string', pathMatches: invocation[2]?.env?.PATH === process.env.PATH });
      expect(existsSync(params.os.probePaths[probe]!)).toBe(true);
      expect(invocation[2]?.env?.PATH).toBe(process.env.PATH);
      const script = `let input='';process.stdin.setEncoding('utf8');process.stdin.on('data',chunk=>input+=chunk);`
        + `process.stdin.on('end',()=>{const result=JSON.parse(input);process.stdout.write(result.stdout);`
        + `process.stderr.write(result.stderr);process.exitCode=result.code??1;});`;
      let child: ChildProcess;
      try { child = Reflect.apply(originalSpawn, childProcess, [process.execPath, ['-e', script], ...invocation.slice(2)]); }
      catch (error) {
        probeDispatchFailures.push(error instanceof RangeError ? 'range'
          : error && typeof error === 'object' && 'code' in error && error.code === 'generic_fixture_os_refused'
            ? 'native_process_refused' : 'other');
        throw error;
      }
      let stderrBytes = 0;
      child.stderr?.on('data', (chunk: Buffer | string) => { stderrBytes += Buffer.byteLength(chunk); });
      child.once('close', exitCode => probeTerminals.push({ tool: probe === 0 ? 'systemctl' : 'docker', exitCode, stderrBytes }));
      void params.hostNative.runNative({ executable: probe === 0 ? 'systemctl' : 'docker', args: candidateArgs,
        env: Object.fromEntries(Object.entries(invocation[2]?.env ?? {})
          .filter((entry): entry is [string, string] => typeof entry[1] === 'string')) }).then(result => child.stdin?.end(JSON.stringify(result)), error => {
        failures.push(error); child.stdin?.end(JSON.stringify({ code: 1, stdout: '', stderr: '' }));
      });
      return child;
    }
    if (command !== 'sudo') return Reflect.apply(originalSpawn, childProcess, invocation);
    if (!Array.isArray(candidateArgs) || !candidateArgs.includes('effect-internal')
      || candidateArgs.slice(0, 4).join('\0') !== '-n\0-u\0root\0--') {
      throw Object.assign(new Error('Unapproved fixture sudo invocation'), { code: 'generic_fixture_os_refused' });
    }
    const elevatedProcess = params.elevation.spawn({ executable: command, args: candidateArgs });
    // This kernel-process fixture exposes only spawn's pipes/terminal events;
    // the source interpreter and its actual private IO remain unmodified.
    const child = new childProcess.ChildProcess();
    Object.assign(child, { stdin: elevatedProcess.stdin, stdout: elevatedProcess.stdout, stderr: elevatedProcess.stderr,
      kill() { void elevatedProcess.terminate(); return true; } });
    void elevatedProcess.settled.then(result => { child.emit('close', result.code, result.signal); }, error => {
      failures.push(error); child.emit('error', error);
    });
    return child;
  });
  return { failures, timing, probeLaunches, probeDispatchFailures, probeTerminals, probePreparation, dispose() { spawn.mockRestore(); execFile.mockRestore(); } };
}

export function createGenericHostNativeBoundary(params: Readonly<{
  filesystem: Awaited<ReturnType<typeof installGenericRootFileSystemBoundary>>;
  daemonPrimaryGroup: string;
  dockerUnitsAvailable?: boolean;
  dockerInventoryAvailable?: boolean;
}>) {
  const daemon = userInfo();
  const calls: MachineSetupNativeCommand[] = [];
  const dockerUnitMutations: string[] = [];
  const installed = new Set<string>();
  let serviceRunning = false, serviceEnabled = false;
  let dockerEnabled = true;
  let networkJoined = false, networkMutations = 0;
  let onNetworkMutation: (() => void | Promise<void>) | undefined;
  let onDockerUnitMutation: ((operation: 'disable' | 'enable') => void | Promise<void>) | undefined;
  let networkProfile = 'Happier managed';
  let tailscaleState = 'Running';
  let tailscaleProfileId = 'observed-native-profile';
  let tailscaleOperator = daemon.username;
  const tailscaleMutations: string[][] = [];
  const engineId = 'fixture-observed-engine';
  let nativeSshPort: number | null | undefined;
  let socketActivatedSsh = false;
  let firewallTable: string | undefined;
  let firewallActive = false, firewallEnabled = false;
  const firewallStages: string[] = [];
  let onFirewallMutation: (() => void | Promise<void>) | undefined;
  const externalInterface = Object.entries(networkInterfaces()).find(([, entries]) => entries?.some(entry => !entry.internal))?.[0];
  const ok = (stdout = '') => ({ code: 0, stdout, stderr: '' });
  const runNative = async (command: MachineSetupNativeCommand): Promise<MachineSetupNativeCommandResult> => {
    calls.push(command);
    const args = command.args;
    if (nativeSshPort !== undefined) {
      if (command.executable === '/usr/sbin/nft') {
        if (args.join(' ') === '--version') return ok('nftables v1.0.0');
        if (args.includes('-c')) return ok();
        if (args.includes('tables')) return ok(JSON.stringify({ nftables: firewallTable
          ? [{ table: { family: 'inet', name: 'happier' } }] : [] }));
        if (args.includes('list')) return { code: firewallTable ? 0 : 1, stdout: firewallTable ?? '', stderr: '' };
        if (args.includes('-f')) {
          firewallTable = await readFile(args[args.indexOf('-f') + 1]!, 'utf8');
          firewallStages.push(firewallTable);
          await onFirewallMutation?.();
          return ok();
        }
        if (args[0] === 'delete') { firewallTable = undefined; return ok(); }
        throw new Error('Unexpected nft OS boundary command');
      }
      if (command.executable === 'ip') {
        expect(args).toEqual(['-j', expect.stringMatching(/^-([46])$/u), 'route', 'show', 'default']);
        return ok(JSON.stringify([{ dst: 'default', dev: externalInterface }]));
      }
      if (command.executable === 'ss') {
        expect(args).toEqual([expect.stringMatching(/^-([46])$/u), '-H', '-ltnp']);
        if (nativeSshPort === null) return ok();
        const address = args[0] === '-4' ? '0.0.0.0' : '[::]';
        return ok(`LISTEN 0 128 ${address}:${nativeSshPort} *:* users(("${socketActivatedSsh ? 'systemd' : 'sshd'}",pid=${socketActivatedSsh ? 1 : 412},fd=3))\n`);
      }
      if (command.executable === 'systemctl' && args[0] === 'list-sockets') return ok(
        `0.0.0.0:${nativeSshPort} remote-login.socket remote-login.service\n[::]:${nativeSshPort} remote-login.socket remote-login.service\n`);
      if (command.executable === 'systemctl' && args.includes('--property=ExecStart')) return ok(
        'ExecStart={ path=/usr/sbin/sshd ; argv[]=/usr/sbin/sshd -D ; ignore_errors=no ; pid=0 ; code=(null) ; status=0/0 }\n');
    }
    if (command.executable.replace(/\\/gu, '/').split('/').at(-1) === 'tailscale') {
      if (args[0] === 'status') return ok(JSON.stringify({ BackendState: tailscaleState, HaveNodeKey: true, TUN: true,
        TailscaleIPs: ['100.92.0.7'], Self: { DNSName: 'host.example.ts.net.' },
        CurrentTailnet: { Name: 'example.ts.net', MagicDNSEnabled: true } }));
      if (args[0] === 'switch') {
        expect(args).toEqual(['switch', '--list', '--json']);
        return ok(JSON.stringify([{ id: tailscaleProfileId, selected: true, nickname: 'Observed profile',
          tailnet: 'example.ts.net', account: 'fixture@example.test' }]));
      }
      if (args[0] === 'debug') return ok(JSON.stringify({ OperatorUser: tailscaleOperator }));
      tailscaleMutations.push([...args]); networkMutations++;
      if (args[0] === 'down') tailscaleState = 'Stopped';
      else if (args[0] === 'up') {
        const file = args.find(arg => arg.startsWith('--auth-key=file:'));
        if (file) {
          const path = file.slice('--auth-key=file:'.length);
          const stat = await lstat(path);
          expect({ uid: stat.uid, gid: stat.gid, mode: stat.mode & 0o777 }).toEqual({ uid: 0, gid: 0, mode: 0o600 });
          expect((await readFile(path)).byteLength).toBeGreaterThan(0);
          expect(args).toContain('--force-reauth');
        }
        // Reauthentication may retain the same native profile id. Never fake a
        // profile change merely to make the consumer's success check pass.
        tailscaleState = 'Running';
      } else if (args[0] === 'set') tailscaleOperator = args[1]!.slice('--operator='.length);
      else throw new Error('Unexpected builtin Tailscale mutation');
      return ok();
    }
    if (command.executable === '/usr/bin/network-client') {
      if (!existsSync('/usr/bin/network-client')) return { code: 127, stdout: '', stderr: 'Fixture client is not installed' };
      if (args[0] === 'status') return ok(JSON.stringify({ joined: networkJoined, profileName: networkProfile }));
      if (args[0] === 'join') {
        expect(args).toHaveLength(2);
        const path = args[1]!;
        expect(path).toBe(`/run/happier-machine-credentials/${encodeURIComponent(installationId)}.setup-key`);
        const stat = await lstat(path);
        expect({ uid: stat.uid, gid: stat.gid, mode: stat.mode & 0o777 }).toEqual({ uid: 0, gid: 0, mode: 0o600 });
        expect((await readFile(path)).byteLength).toBeGreaterThan(0);
        networkJoined = true; networkMutations += 1; await onNetworkMutation?.(); return ok();
      }
      if (args[0] === 'leave') { networkJoined = false; networkMutations += 1; return ok(); }
      throw new Error('Unexpected generic network fixture command');
    }
    if (command.executable === 'docker') {
      if (args[0] === 'container' && args[1] === 'ls') {
        expect(args).toEqual(['container', 'ls', '--all', '--no-trunc', '--filter',
          'label=dev.happier.machine-setup.recipe=caddy@1', '--format', '{{json .ID}}']);
        return ok(); // This OS fixture has no owned Caddy container.
      }
      if (params.dockerInventoryAvailable === false && args[0] === 'info') {
        expect(args).toEqual(['info', '--format', '{{json .}}']);
        return { code: 1, stdout: '', stderr: 'Cannot connect to fixture Docker' };
      }
      expect(args).toEqual(['info', '--format', '{{json .}}']);
      return ok(JSON.stringify({ ID: engineId, OperatingSystem: 'Linux' }));
    }
    if (command.executable === 'sudo') {
      if (args.join('\0') !== '-n\0-u\0root\0true') throw Object.assign(new Error('Unapproved fixture sudo check'), { code: 'generic_fixture_os_refused' });
      return ok();
    }
    if (command.executable === 'getent') {
      const name = args.at(-1)!;
      if (args.includes('passwd')) return ok(`${name}:x:${name === 'root' ? 0 : daemon.uid}:${name === 'root' ? 0 : daemon.gid}::/home/test:/bin/sh\n`);
      return ok(`${name}:x:${name === 'root' ? 0 : daemon.gid}:\n`);
    }
    if (command.executable === 'id') return ok(args.includes('-gn') ? `${params.daemonPrimaryGroup}\n`
      : `${args.includes('-u') ? daemon.uid : daemon.gid}\n`);
    if (command.executable === 'dpkg') return ok('amd64\n');
    if (command.executable === 'lslocks') return ok('{"locks":[]}');
    if (command.executable === 'dpkg-query') {
      const names = args.slice(args.indexOf('--') + 1);
      const rows = names.filter(name => installed.has(name)).map(name =>
        `${name}\tinstall ok installed\t${name === 'generic' ? '0.81.5' : '6.1.0'}\tamd64\n`).join('');
      return { code: names.every(name => installed.has(name)) ? 0 : 1, stdout: rows, stderr: '' };
    }
    if (command.executable === 'systemctl' || command.executable === '/usr/bin/systemctl') {
      if (args.includes('happier-firewall.service')) {
        if (args[0] === 'show') return ok(`LoadState=${existsSync('/etc/systemd/system/happier-firewall.service') ? 'loaded' : 'not-found'}\nUnitFileState=${firewallEnabled ? 'enabled' : 'disabled'}\nActiveState=${firewallActive ? 'active' : 'inactive'}\n`);
        if (args[0] === 'enable') firewallEnabled = true;
        else if (args[0] === 'disable') firewallEnabled = false;
        else if (args[0] === 'start') firewallActive = true;
        else if (args[0] === 'stop') firewallActive = false;
        else throw new Error('Unexpected firewall service OS boundary command');
        return ok();
      }
      if (args[0] === '--system') {
        expect(args).toEqual(['--system', 'show', '--property=ActiveState', '--property=MainPID', '--', 'docker.service']);
        return ok('ActiveState=active\nMainPID=42\n');
      }
      if (args[0] === 'show' && params.dockerUnitsAvailable
        && (args.includes('docker.service') || args.includes('containerd.service'))) {
        return ok(`LoadState=loaded\nUnitFileState=${dockerEnabled ? 'enabled' : 'disabled'}\nActiveState=active\n`);
      }
      if (args.includes('docker.service')) {
        if (args[0] === 'is-enabled') return { code: dockerEnabled ? 0 : 1, stdout: '', stderr: '' };
        if (args[0] === 'disable') { dockerUnitMutations.push('disable'); dockerEnabled = false; await onDockerUnitMutation?.('disable'); return ok(); }
        if (args[0] === 'enable') { dockerUnitMutations.push('enable'); dockerEnabled = true; await onDockerUnitMutation?.('enable'); return ok(); }
        throw new Error('Unexpected fixture Docker unit mutation');
      }
      if (args[0] === 'show') return ok('LoadState=not-found\n');
      if (args[0] === 'start') serviceRunning = true;
      else if (args[0] === 'stop') serviceRunning = false;
      else if (args[0] === 'enable') serviceEnabled = true;
      else if (args[0] === 'disable') serviceEnabled = false;
      else if (args[0] !== 'daemon-reload') throw new Error(`Unexpected systemctl boundary command ${args[0]}`);
      return ok();
    }
    throw new Error(`Unexpected P20 native process ${command.executable}`);
  };
  return { calls, runNative, installed, engineId, dockerUnitMutations, firewallStages,
    setOnFirewallMutation(callback: () => void | Promise<void>) { onFirewallMutation = callback; },
    async setNativeSshPort(port: number | null, socketActivated = false) {
      if (!externalInterface) throw new Error('The OS fixture requires an external interface');
      await mkdir('/usr/sbin', { recursive: true, mode: 0o755 });
      // Supply protected OS ancestors, independent of the test host's umask.
      for (const path of ['/usr', '/usr/sbin', '/etc', '/etc/systemd', '/etc/systemd/system']) await chmod(path, 0o755);
      for (const path of ['/usr/sbin/nft', '/usr/sbin/sshd']) await writeFile(path, 'fixture executable', { mode: 0o755 });
      if (socketActivated) {
        await mkdir('/usr/lib/systemd', { recursive: true, mode: 0o755 });
        for (const path of ['/usr/lib', '/usr/lib/systemd']) await chmod(path, 0o755);
        await writeFile('/usr/lib/systemd/systemd', 'fixture executable', { mode: 0o755 });
      }
      params.filesystem.setSshProcessAvailable(true);
      nativeSshPort = port; socketActivatedSsh = socketActivated;
    },
    tailscaleMutations, tailscaleState: () => tailscaleState,
    setTailscaleProfileId(value: string) { tailscaleProfileId = value; },
    setTailscaleOperator(value: string) { tailscaleOperator = value; },
    networkJoined: () => networkJoined, networkMutations: () => networkMutations,
    setNetworkJoined(value: boolean) { networkJoined = value; },
    setOnNetworkMutation(callback: (() => void | Promise<void>) | undefined) { onNetworkMutation = callback; },
    setOnDockerUnitMutation(callback: ((operation: 'disable' | 'enable') => void | Promise<void>) | undefined) { onDockerUnitMutation = callback; },
    setNetworkProfile(value: string) { networkProfile = value; },
    engineReads: () => calls.filter(call => call.executable === 'docker').length };
}

export async function installGenericNativeIdentityBoundary() {
  const daemon = userInfo();
  const daemonPrimaryGroup = 'generic-daemon-group';
  const agentUid = daemon.uid + 10_000;
  let agentGroupIds = [agentUid];
  const timing = { launched: 0, completed: 0, totalMs: 0, maxMs: 0 };
  const original = childProcess.execFile;
  const execFile = vi.spyOn(childProcess, 'execFile').mockImplementation((...args: Parameters<typeof childProcess.execFile>) => {
    const [command, nativeArgs] = args;
    if (!Array.isArray(nativeArgs)) { const refusal = Object.assign(new Error('Unapproved fixture identity process'), { code: 'generic_fixture_os_refused' }); inspectFixtureDiagnostic('identity_execFile_refused', refusal); throw refusal; }
    const key = [command, ...nativeArgs].join('\0');
    const row = key === 'getent\0--service=files\0passwd\0happier-agent'
      ? `happier-agent:x:${agentUid}:${agentUid}::/home/happier-agent:/usr/sbin/nologin\n`
      : key === 'id\0-G\0happier-agent' ? `${agentGroupIds.join(' ')}\n`
      : key === `getent\0--\0group\0${daemonPrimaryGroup}` || key === `getent\0--service=files\0group\0${daemonPrimaryGroup}`
        ? `${daemonPrimaryGroup}:x:${daemon.gid}:\n` : null;
    if (row === null) {
      if (command === process.execPath && nativeArgs[0] === '-e' || command === 'ps') return Reflect.apply(original, childProcess, args);
      { const refusal = Object.assign(new Error('Unapproved fixture identity process'), { code: 'generic_fixture_os_refused' }); inspectFixtureDiagnostic('identity_execFile_refused', refusal); throw refusal; }
    }
    const startedAt = Date.now(); timing.launched++;
    const child = replyToGenericFixtureExecFile(args, Promise.resolve({ code: 0, stdout: row, stderr: '' }));
    child.once('close', () => { const elapsed = Date.now() - startedAt;
      timing.completed++; timing.totalMs += elapsed; timing.maxMs = Math.max(timing.maxMs, elapsed); });
    return child;
  });
  await mkdir('/etc/sudoers.d', { recursive: true, mode: 0o755 });
  const step = buildManagedSudoersSteps({ daemonUsername: daemon.username, previousPolicy: { version: 1, mode: 'none' },
    policy: { version: 1, mode: 'preauthorized' } })[0];
  if (step?.content?.kind !== 'literal') throw new Error('Expected the actual admitted sudoers producer');
  await writeFile(MANAGED_SUDOERS_PATH, step.content.value, { mode: 0o440 });
  const nativeDependencies = {
    platform: 'linux',
    async execFile(command, args) {
      if (command === 'id') return { stdout: args[0] === '-u' ? `${daemon.uid}\n`
        : args[0] === '-un' ? `${daemon.username}\n` : `${daemonPrimaryGroup}\n` };
      if (command === 'sudo' && args.join('\0') === '-n\0-u\0root\0true') return { stdout: '' };
      throw Object.assign(new Error('Native tool is absent'), { code: 'ENOENT' });
    },
  } satisfies MachineAdminAccessNativeDependencies;
  return { daemon, daemonPrimaryGroup, agentUid, nativeDependencies, timing,
    setAgentGroupIds(value: number[]) { agentGroupIds = value; },
    observe: () => observeMachineAdminAccess(nativeDependencies),
    dispose() { execFile.mockRestore(); },
  };
}

export async function createGenericComposedJourney(occurrence: 'external', managementProviders: AccessProviderSelectionV1[] = [selection],
  options: Readonly<{ authoredProvider: AuthoredProvider; nativeClientInitiallyAvailable?: boolean;
    providerSelection?: AccessProviderSelectionV1; nativeEffects?: MachineSetupNativeEffectsInput; dockerUnitsAvailable?: boolean;
    dockerInventoryAvailable?: boolean;
    builtinTailscale?: boolean;
    dockerProcessAvailable?: boolean }>) {
  console.info('Generic public journey stage', { stage: 'fixture_started', atMs: Date.now() });
  const directory = await mkdtemp(join(tmpdir(), 'happier-generic-composed-'));
  const disposals: (() => void | Promise<void>)[] = [];
  const configurationEnv = createEnvKeyScope(['HAPPIER_HOME_DIR', 'HAPPIER_SERVER_URL', 'HAPPIER_LOCAL_SERVER_URL',
    'HAPPIER_PUBLIC_SERVER_URL', 'HAPPIER_WEBAPP_URL', 'HAPPIER_ACTIVE_SERVER_ID', 'HAPPIER_DAEMON_LIFECYCLE_SCOPE_ID']);
  // Restore only after the runtime and confined filesystem have been disposed;
  // Configuration's constructor then uses the canonical Vitest bootstrap root.
  disposals.push(() => { configurationEnv.restore(); reloadConfiguration(); });
  const disposeAll = async () => {
    const errors: unknown[] = [];
    for (const dispose of disposals.splice(0).reverse()) { try { await dispose(); } catch (error) { errors.push(error); } }
    try { await rm(directory, { recursive: true, force: true }); } catch (error) { errors.push(error); }
    if (errors.length) throw new AggregateError(errors, 'Generic fixture cleanup failed');
  };
  const filesystem = await installGenericRootFileSystemBoundary(directory);
  disposals.push(() => filesystem.dispose());
  try {
    const os = await installGenericOsBoundary({ directory, filesystem });
    disposals.push(() => os.dispose());
    if (options.dockerUnitsAvailable) await os.installEngineProbeTools();
    filesystem.setDockerProcessAvailable(options.dockerProcessAvailable === true);
    expect(() => childProcess.spawn('sudo', ['-u', 'root', 'not-admitted'])).toThrow();
    expect(() => childProcess.execFile('/opt/generic-fixture-forbidden', [])).toThrow();
    const identity = await installGenericNativeIdentityBoundary();
    disposals.push(() => identity.dispose());
    const hostNative = createGenericHostNativeBoundary({ filesystem, daemonPrimaryGroup: identity.daemonPrimaryGroup,
      dockerUnitsAvailable: options.dockerUnitsAvailable,
      dockerInventoryAvailable: options.dockerInventoryAvailable });
    await os.installGenericNetworkTool(hostNative.runNative, options.nativeClientInitiallyAvailable !== false);
    if (options.builtinTailscale) await os.installBuiltinTailscaleTool();
    const elevation = createElevationProcessBoundary(hostNative.runNative);
    disposals.push(() => elevation.dispose());
    const happyHomeDir = join(directory, 'private-home');
    await mkdir(happyHomeDir, { mode: 0o700 });
    configurationEnv.patch({ HAPPIER_HOME_DIR: happyHomeDir, HAPPIER_SERVER_URL: 'https://home.generic.test',
      HAPPIER_LOCAL_SERVER_URL: undefined, HAPPIER_PUBLIC_SERVER_URL: undefined,
      HAPPIER_WEBAPP_URL: 'https://home.generic.test', HAPPIER_ACTIVE_SERVER_ID: 'generic-home',
      HAPPIER_DAEMON_LIFECYCLE_SCOPE_ID: undefined });
    reloadConfiguration();
    expect(configuration.happyHomeDir).toBe(happyHomeDir);
    expect(configuration.activeServerId).toBe('generic-home');
    const keys = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(61));
    const installationIdentityFile = configuration.installationIdentityFile;
    await writeFile(installationIdentityFile, JSON.stringify({ version: 1, createdAt: 1, installationId,
      publicKey: encodeBase64(keys.publicKey, 'base64url'), privateKey: encodeBase64(keys.secretKey, 'base64url') }), { mode: 0o600 });
    const privateSetupKey = '\uFEFFsynthetic-generic-setup-key';
    const home = installReachabilityHomeHttpBoundary({ installationPublicKey: keys.publicKey, privateSetupKey,
      connectorSubject: reachabilityConnectorSubject(options.providerSelection ?? selection, { machineId, installationId }) });
    disposals.push(() => home.dispose());
    const runtime = await createPublicGenericRuntime({ occurrence, authoredProvider: options.authoredProvider });
    disposals.push(() => runtime.dispose());
    const metadata = createMachineMetadataBoundary(managementProviders);
    let targetCurrent = true, credentialCurrent = true, requestNumber = 0, operationNumber = 0;
    let observation: Parameters<typeof projectMachineReachabilityObservation>[0];
    const publications: NonNullable<typeof observation>[] = [];
    const approvalRows = new Map<string, ApprovalRequest>();
    const approvalCreates: ApprovalRequest[] = [];
    const operationSnapshots: Parameters<NonNullable<Parameters<typeof createHostActionOperationRuntime>[0]['publishSnapshot']>>[0][] = [];
    const operations = createHostActionOperationRuntime({ serverId: 'generic-home', machineId,
      custodyBinding: { serverId: 'generic-home', installationId }, resolveAccountId: async () => 'generic-owner',
      generateOperationId: () => `generic-operation-${++operationNumber}`,
      publishSnapshot: snapshot => { operationSnapshots.push(snapshot); },
    });
    const token = `header.${encodeBase64(new TextEncoder().encode(JSON.stringify({ sub: 'generic-owner', tokenEpoch: 1,
      provenance: AuthTokenProvenanceSchema.parse({ v: 1, kind: 'terminal', authority: 'account_automation' }) })), 'base64url')}.signature`;
    const accountRuntime = { serverId: 'generic-home', machineId, accountId: 'generic-owner',
      credentials: { token, encryption: null }, serverHttpBaseUrl: 'https://home.generic.test',
      isCurrent: async () => credentialCurrent, isCustodyCurrent: async () => credentialCurrent,
    } satisfies NonNullable<MachineReachabilityHostDependencies['runtime']>;
    const dependencies = (context: ActionExecutorContext): MachineReachabilityHostDependencies => ({
      target: { serverId: 'generic-home', machineId, installationId, custodianAccountId: 'generic-owner' },
      port: metadata.port, runtimeRegistry: runtime.registry, context, isCurrent: async () => targetCurrent,
      nativeEffects: options.nativeEffects ?? { userHomeDirectory: directory, environmentIo: {
        async run(command) {
          const result = await hostNative.runNative({ executable: command.command, args: command.args, env: command.env });
          return { exitCode: result.code ?? 1, stdout: result.stdout, stderr: result.stderr };
        },
      } },
      agentIsolation: { read: () => ({ enabled: true, status: { kind: 'effective', platform: 'linux', agentUser: 'happier-agent' }, workspaceRoots: [] }) },
      happyHomeDir, runtime: accountRuntime, machineAdmission: { actorAccountId: 'generic-owner', custodianAccountId: 'generic-owner' },
      installationPublicKey: keys.publicKey, installationIdentityFile, runNative: hostNative.runNative,
      elevation: { installationId, installedCli: join(directory, 'installed-happier'),
        readPolicy: async () => {
          const read = await getMachineAdminAccessV1(metadata.port);
          if (read.status !== 'ready') throw new Error('Machine policy unavailable');
          return read.policy;
        }, observe: identity.observe, spawn: elevation.spawn },
      async publish(candidate) {
        const projected = projectMachineReachabilityObservation(observation, candidate);
        if (projected !== observation) { observation = projected; publications.push(projected); }
        return projected;
      },
    });
    const executor = createActionExecutor({ ...createUnavailableActionTransportDeps(),
      runActionOperation: operations.runActionOperation,
      isApprovalExecutionOriginCurrent: async () => targetCurrent,
      approvalsCreate: async ({ request }) => {
        const parsed = ApprovalRequestSchema.parse(request), artifactId = `generic-approval-${approvalCreates.length + 1}`;
        approvalCreates.push(parsed); approvalRows.set(artifactId, parsed); return { artifactId };
      },
      approvalsGet: async ({ artifactId }) => approvalRows.get(artifactId) ?? null,
      approvalsUpdate: async ({ artifactId, request }) => {
        const previous = approvalRows.get(artifactId);
        if (!previous) throw new Error('Missing fixture Artifact row');
        const parsed = ApprovalRequestSchema.parse(request);
        const transition = decideApprovalRequestTransition(previous, parsed);
        if (!transition.ok) return transition;
        approvalRows.set(artifactId, parsed); return { ok: true };
      },
      approvalsWaitForDecision: async ({ request }) => ({ decision: 'approve', request, decisionAuthority: 'present_user' }),
      machineReachabilityAction: async ({ actionId, input, context }) => {
        const result = actionId === 'machines.reachability.inspect'
          ? await inspectMachineReachability(MachineReachabilityInspectInputV1Schema.parse(input), dependencies(context))
          : await executeMachineReachabilityTransition(MachineReachabilityConfigureInputV1Schema.parse(input), dependencies(context));
        return readActionFailureEnvelope(result) ?? (actionId === 'machines.reachability.inspect'
          ? parseReachabilityInspectResult(result) : MachineReachabilityConfigureResultV1Schema.parse(result));
      },
    } satisfies ActionExecutorDeps);
    let settings = ActionsSettingsV1Schema.parse({ v: 1 });
    const context = (): ActionExecutorContext => ({ surface: 'cli', authority: 'present_user', actionCaller: { kind: 'host' },
      serverId: 'generic-home', serverIdentityId: 'generic-home', runtimeAccountId: 'generic-owner', defaultSessionMachineId: machineId,
      actionRequestId: `generic-request-${++requestNumber}`, actionsSettings: settings, signal: new AbortController().signal });
    const inspect = async (intent?: 'join' | 'leave') => {
      const result = await executor.execute('machines.reachability.inspect', { serverId: 'generic-home', machineId,
        ...(intent ? { change: { kind: 'privateNetwork', intent, selection: options.providerSelection ?? selection } } : {}) }, context());
      if (!result.ok) throw Object.assign(new Error(result.error), { code: result.errorCode });
      return parseReachabilityInspectResult(result.result);
    };
    const configureInput = (review: Awaited<ReturnType<typeof inspect>>) => {
      if (!review.plan) throw new Error('Expected the real host-produced review');
      return { serverId: 'generic-home', machineId,
        change: review.plan.basis.change, reviewedPlanDigest: review.plan.reviewedPlanDigest, reviewedPlanBasis: review.plan.basis };
    };
    const configure = async (review: Awaited<ReturnType<typeof inspect>>, transform: (input: ReturnType<typeof configureInput>) => ReturnType<typeof configureInput> = input => input) => {
      // Owner-level fault cases retain the supported Agent blocking Ask waiter.
      // Ordinary CLI deferred approval/replay is exercised by the default API journey.
      const result = await executor.execute('machines.reachability.configure', transform(configureInput(review)), { ...context(), surface: 'agent',
        authority: resolveInvocationAuthority({ credential: 'agent', surface: 'agent' }) });
      const configured = result.ok ? MachineReachabilityConfigureResultV1Schema.safeParse(result.result) : undefined;
      console.info('Generic fixture boundary observation', { boundary: 'owner_configure_returned', ok: result.ok,
        code: projectGenericFixtureCode(result.ok ? undefined : result.errorCode),
        status: configured?.success ? configured.data.status : 'not_configure_output' });
      return result;
    };
    console.info('Generic public journey stage', { stage: 'fixture_ready', atMs: Date.now() });
    return { occurrence, directory, filesystem, hostNative, elevation, identity, home, metadata, runtime, publications, os,
      authoredProvider: options.authoredProvider,
      approvalCreates, approvalRows, operationSnapshots, context, dependencies, inspect, configure, configureInput,
      privateSetupKey, happyHomeDir, accountRuntime, installationIdentityFile, installationPublicKey: keys.publicKey,
      allowConfigure() { settings = setActionApprovalOverride({ settings, actionId: 'machines.reachability.configure', surface: 'agent', approvalRequired: false }); },
      retireTarget() { targetCurrent = false; }, retireCredential() { credentialCurrent = false; },
      addDisposal(dispose: () => void | Promise<void>) { disposals.push(dispose); },
      dispose: disposeAll,
    };
  } catch (error) {
    try { await disposeAll(); } catch (cleanupError) { throw new AggregateError([error, cleanupError], 'Generic fixture preparation and cleanup failed'); }
    throw error;
  }
}

const journeys: Awaited<ReturnType<typeof createGenericComposedJourney>>[] = [];
afterEach(async () => {
  for (const journey of journeys.splice(0).reverse()) await journey.dispose();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});
export async function journey(occurrence: 'external', managementProviders: AccessProviderSelectionV1[],
  options: Parameters<typeof createGenericComposedJourney>[2]) {
  const fixture = await createGenericComposedJourney(occurrence, managementProviders, options); journeys.push(fixture); return fixture;
}

export async function createGenericDefaultFactoryJourney(fixture: Awaited<ReturnType<typeof journey>>,
  options: Readonly<{ manageGranteeAccountId?: string }> = {}) {
  let requesterCredentials: ReturnType<typeof decodeStoredCredentials> = null;
  // The public constructor's existing in-hand credential reader models the
  // standalone requester, without aliasing the Home or replacing daemon disk.
  const readCallerCredentials = async () => requesterCredentials ?? await readStoredCredentialsForServerId('generic-home');
  let client: ApiMachineClient | undefined;
  let runtime: Awaited<ReturnType<typeof createPublicGenericRuntime>> | undefined;
  let daemonRuntime: Awaited<ReturnType<typeof startDaemonSessionControlRuntime>> | undefined;
  let signedHome: Awaited<ReturnType<typeof createExternalActionHomeProcessForTests>> | undefined;
  const processBoundary = installGenericDefaultHostProcessBoundary(fixture);
  const sockets: ReturnType<typeof createApiSessionSocketStub>[] = [];
  const pendingRpc = new Set<Promise<unknown>>();
  const lifetime = new AbortController();
  let receivingRpc: RpcHandlerManager | undefined;
  let receivingSocket: ReturnType<typeof createApiSessionSocketStub> | undefined;
  let machineTransportConnected = false;
  type RelayCancellation = { targetRequestId: string; cancelled: boolean; dispatched: boolean };
  let originalConfigureRequestId: string | undefined;
  type RelayPhase = 'credential_read' | 'security_read' | 'receiver';
  const relayAwaits = new Map<Promise<unknown>, RelayPhase>();
  const receiverObservation = () => ({
    inFlight: receivingRpc?.getInFlightRequestCount(),
    active: receivingRpc?.getActiveHandlerExecutions().map(execution => ({
      method: execution.method === getActionSpec('machines.reachability.configure').bindings?.rpcMethod ? 'reachability_configure'
        : execution.method === getActionSpec('machines.reachability.inspect').bindings?.rpcMethod ? 'reachability_inspect' : 'other',
      activeForMs: execution.activeForMs,
    })),
  });
  const observeRelayAwait = async <T>(phase: RelayPhase, work: () => Promise<T>): Promise<T> => {
    const pending = work();
    relayAwaits.set(pending, phase);
    console.info('Generic fixture boundary observation', { boundary: 'home_rpc', phase, transition: 'entered' });
    try { return await pending; }
    catch (error) {
      const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
      console.info('Generic fixture boundary observation', { boundary: 'home_rpc', phase,
        transition: 'rejected', code: projectGenericFixtureCode(code) });
      throw error;
    } finally {
      relayAwaits.delete(pending);
      console.info('Generic fixture boundary observation', { boundary: 'home_rpc', phase, transition: 'settled' });
    }
  };
  const unsupportedSocket: string[] = [];
  let replayAdmissionFault: 'absent' | 'stale' | 'mismatched_target' | undefined;
  const socketOutcomes: Readonly<{ resultKind: string; actionResultValid: boolean; decisionOutputValid: boolean;
    ok?: boolean; errorCode?: string; reasonCode?: string; decisionStatus?: string;
    safeInspect: boolean; callerAuthority: ActionExecutorContext['authority'] }>[] = [];
  let relayInstalledRpc: ((connection: Parameters<typeof syncClient.createHappierSocket>[0], payload: unknown,
    cancellation?: RelayCancellation) => Promise<unknown>) | undefined;
  const originalCreateSocket = syncClient.createHappierSocket;
  const homeSockets = vi.spyOn(syncClient, 'createHappierSocket').mockImplementation(params => {
    if (params.endpoint !== fixture.accountRuntime.serverHttpBaseUrl) return originalCreateSocket(params);
    if (params.clientType === 'machine-scoped' && receivingSocket) {
      machineTransportConnected = true;
      const transportSocket = receivingSocket as unknown as ReturnType<typeof originalCreateSocket>['socket'];
      return { socket: transportSocket, transport: syncClient.createSocketTransportAdapter(transportSocket,
        { connectTimeoutMs: params.connectTimeoutMs }) };
    }
    // Home correlations belong to each authenticated calling socket. Different
    // callers may use the same local id without sharing cancellation authority.
    const activeCancellations = new Map<string, RelayCancellation>();
    const cancel = (active: RelayCancellation) => {
      if (active.cancelled) return;
      active.cancelled = true;
      if (active.dispatched) receivingSocket?.trigger(SOCKET_RPC_EVENTS.CANCEL, { requestId: active.targetRequestId });
    };
    const socket = createApiSessionSocketStub({ disconnectReason: 'io client disconnect',
      emit(event, args) {
        if (event !== SOCKET_RPC_EVENTS.CANCEL) return;
        const parsed = SocketRpcCancellationPayloadSchema.safeParse(args[0]);
        const active = parsed.success ? activeCancellations.get(parsed.data.requestId) : undefined;
        if (active) cancel(active);
      },
      emitWithAck: async (event, payload) => {
      if (event !== SOCKET_RPC_EVENTS.CALL) return resolveApiSessionSocketDefaultAck(event, payload);
      if (!relayInstalledRpc) throw new Error('The installed fixture RPC receiver is unavailable');
      const rawRequestId = payload && typeof payload === 'object' ? Reflect.get(payload, 'requestId') : undefined;
      const parsedRequestId = rawRequestId === undefined ? undefined : SocketRpcRequestIdSchema.safeParse(rawRequestId);
      if (parsedRequestId && !parsedRequestId.success) return { ok: false, error: 'Invalid RPC request correlation' };
      const callerRequestId = parsedRequestId?.success ? parsedRequestId.data : undefined;
      if (callerRequestId && activeCancellations.has(callerRequestId)) {
        return { ok: false, error: 'RPC request correlation is already active' };
      }
      const cancellation: RelayCancellation | undefined = callerRequestId
        ? { targetRequestId: 'rpc_' + randomUUID(), cancelled: false, dispatched: false } : undefined;
      if (callerRequestId && cancellation) activeCancellations.set(callerRequestId, cancellation);
      const pending = relayInstalledRpc(params, payload, cancellation);
      pendingRpc.add(pending);
      try { return await pending; }
      finally {
        pendingRpc.delete(pending);
        if (callerRequestId && activeCancellations.get(callerRequestId) === cancellation) activeCancellations.delete(callerRequestId);
      }
    } }); sockets.push(socket);
    const retireCaller = () => {
      for (const active of activeCancellations.values()) cancel(active);
      activeCancellations.clear();
    };
    socket.on('disconnect', retireCaller);
    // The client adapter destroys its local listeners before closing; Home's
    // separate socket still observes that close and retires the caller's work.
    for (const close of [socket.disconnect, socket.close]) {
      const originalClose = close.getMockImplementation();
      close.mockImplementation(() => { retireCaller(); return originalClose?.() ?? socket; });
    }
    // Genuine Socket.IO transport boundary; the Account change observer and
    // shared blocking approval coordinator beneath it remain real.
    const transportSocket = socket as unknown as ReturnType<typeof originalCreateSocket>['socket'];
    return { socket: transportSocket, transport: syncClient.createSocketTransportAdapter(transportSocket,
      { connectTimeoutMs: params.connectTimeoutMs }) };
  });
  let disposing: Promise<void> | undefined;
  const dispose = () => disposing ??= (async () => {
    console.info('Generic public journey stage', { stage: 'runtime_disposing', atMs: Date.now(), pending: pendingRpc.size,
      approvalFacts: fixture.home.readApprovalFacts(), nativeMutations: fixture.hostNative.networkMutations(),
      rootLaunches: fixture.elevation.launches.length,
      relayAwaits: [...relayAwaits.values()], receiver: receiverObservation() });
    lifetime.abort();
    // Retire caller-owned relay mappings before waiting for their target ACKs.
    sockets.forEach(socket => socket.disconnect());
    // This receiver belongs only to this disposable fixture. Retire its own
    // transport requests while reply sockets and OS adapters are still live.
    receivingRpc?.cancelTransportRequests();
    const elevation = await Promise.allSettled([fixture.elevation.dispose()]);
    const results = [...elevation, ...await Promise.allSettled([client?.shutdown(), daemonRuntime?.stopControlServer()])];
    try { await runtime?.dispose(); }
    finally {
      await Promise.allSettled([...pendingRpc]);
      results.push(...await Promise.allSettled([signedHome?.close()]));
      console.info('Generic public journey stage', { stage: 'public_tasks_drained', atMs: Date.now(), pending: pendingRpc.size,
        nativeHostProcesses: processBoundary.timing, nativeIdentityProcesses: fixture.identity.timing });
      sockets.forEach(socket => { socket.disconnect(); socket.removeAllListeners(); }); homeSockets.mockRestore();
      processBoundary.dispose(); resetInMemoryAccountSettingsContextForTests();
    }
    const failed = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
    if (failed.length) throw new AggregateError(failed.map(result => result.reason), 'Installed Generic runtime shutdown failed');
  })();
  fixture.addDisposal(dispose);
  try {
    signedHome = await createExternalActionHomeProcessForTests({
      serverIdentityId: fixture.home.serverIdentityId, accountId: fixture.accountRuntime.accountId,
      ...(options.manageGranteeAccountId ? { manageGranteeAccountId: options.manageGranteeAccountId } : {}),
      machineId, installationId, installationPublicKey: fixture.installationPublicKey,
      dispatch: async (packet, { signal }) => {
        signal.throwIfAborted();
        lifetime.signal.throwIfAborted();
        const receiver = receivingRpc;
        if (!receiver) throw new Error('The actual installed Action receiver is unavailable');
        const cancel = () => {
          if (packet.requestId) receivingSocket?.trigger(SOCKET_RPC_EVENTS.CANCEL, { requestId: packet.requestId });
        };
        signal.addEventListener('abort', cancel, { once: true });
        lifetime.signal.addEventListener('abort', cancel, { once: true });
        // Deliver the Home-produced reserved packet unchanged. The installed
        // receiver opens requester custody and restores the signed CLI origin.
        const pending = receiver.handleRequest(packet);
        pendingRpc.add(pending);
        try { return await pending; }
        finally {
          pendingRpc.delete(pending);
          signal.removeEventListener('abort', cancel);
          lifetime.signal.removeEventListener('abort', cancel);
        }
      },
    });
    console.info('Generic public journey stage', { stage: 'home_acquired' });
    if (signedHome.manageGrantee) {
      // Real Home persisted this Account as plain; token-only access.key is
      // decoded by the ordinary codec without fabricating encryption material.
      requesterCredentials = decodeStoredCredentials({ token: signedHome.manageGrantee.token });
      if (!requesterCredentials) throw new Error('The genuine requester terminal credentials are unavailable');
    }
    fixture.home.bindSignedActions(signedHome);
    fixture.accountRuntime.credentials.token = signedHome.token;
    await updateSettings(settings => ({ ...settings, activeServerId: 'generic-home', servers: {
      'generic-home': { id: 'generic-home', name: 'Generic fixture Home', serverUrl: 'https://home.generic.test',
        webappUrl: 'https://home.generic.test', createdAt: 1, updatedAt: 1, lastUsedAt: 1 },
    } }));
    await writeStoredCredentialsForServerId('generic-home', fixture.accountRuntime.credentials);
    // Positive host journeys supply the real managed executable prerequisite;
    // the sudo/child-process adapter below remains the genuine OS boundary.
    const managedCli = resolveInstalledMachineEffectCli();
    await mkdir(dirname(managedCli), { recursive: true });
    await writeFile(managedCli, 'managed executable OS fixture', { mode: 0o755 });
    const daemonCredentials = await readStoredCredentialsForServerId('generic-home');
    if (!daemonCredentials) throw new Error('The stored daemon credentials are unavailable');
    const homeSnapshot = await fetchServerFeaturesSnapshot({
      serverUrl: fixture.accountRuntime.serverHttpBaseUrl, token: daemonCredentials.token,
    });
    if (homeSnapshot.status !== 'ready' || homeSnapshot.provenance !== 'authenticated'
      || !homeSnapshot.features.capabilities.serverIdentity.serverIdentityId) {
      throw new Error('The authenticated fixture Home identity is unavailable');
    }
    const homeIdentity = homeSnapshot.features.capabilities.serverIdentity.serverIdentityId;
    await updateSettings(settings => ({ ...settings, servers: { ...settings.servers,
      'generic-home': { ...settings.servers!['generic-home'], homeConnectionDescriptorAuthority: 'exact',
        homeConnectionDescriptor: HomeConnectionDescriptorV1Schema.parse({ v: 1, homeServerIdentityId: homeIdentity,
          canonicalServerUrl: fixture.accountRuntime.serverHttpBaseUrl, revision: 1,
          endpoints: [{ kind: 'https', url: fixture.accountRuntime.serverHttpBaseUrl }] }) },
    } }));
    runtime = await createPublicGenericRuntime({ occurrence: fixture.occurrence,
      authoredProvider: fixture.authoredProvider, happyHomeDir: fixture.happyHomeDir, controller: pluginReloadController });
    const runtimeId = 'generic-reachability-fixture-runtime';
    const machineBootstrap = ExternalActionMachineBootstrapV1Schema.parse({ id: machineId, kind: 'persistent', active: true,
      installationId, dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER, revokedAt: null, replacedByMachineId: null,
      access: { custodian: { accountId: fixture.accountRuntime.accountId, displayName: 'Generic fixture Account' },
        role: 'manage', resourceMode: 'plain', accessState: 'ready' } });
    const machine = { ...machineBootstrap, encryptionMode: 'plain' as const, metadataVersion: 1, daemonStateVersion: 0,
      daemonState: StoredMachinePublishedDaemonStateV1Schema.parse({ status: 'running', runtimeId,
        agentIsolation: MachineAgentIsolationStatusV1Schema.parse({ kind: 'effective', platform: 'linux', agentUser: 'happier-agent' }) }),
      metadata: StoredMachinePublishedMetadataV1Schema.parse({ ...fixture.metadata.read().metadata,
        agentIsolation: MachineAgentIsolationPolicyV1Schema.parse({ enabled: true }),
        host: 'generic-fixture', platform: 'linux', happyCliVersion: 'dev', homeDir: fixture.directory,
        happyHomeDir: fixture.happyHomeDir }) } satisfies Machine;
    fixture.home.bindMachine(() => machine);
    const statePublications: unknown[] = [], metadataPublications: unknown[] = [];
    let rejectStatePublication = false;
    const statePublicationRejections: Readonly<{ nativeMutations: number; keyPresent: boolean; setupInstalled: boolean }>[] = [];
    client = runWithServerHttpBaseUrl(fixture.accountRuntime.serverHttpBaseUrl,
      () => new ApiMachineClient(daemonCredentials.token, machine, { runtimeId }));
    const socket = createApiSessionSocketStub({ connected: true,
      emit(event, args, transport) {
        if (machineTransportConnected && event === SOCKET_RPC_EVENTS.REGISTER) {
          queueMicrotask(() => transport.trigger(SOCKET_RPC_EVENTS.REGISTERED, args[0]));
        }
      }, emitWithAck: async (event, raw) => {
      // Socket.IO is the untyped transport boundary; preserve the exact codec's
      // emitted content and let the actual ApiMachine publisher consume its ack.
      const request = raw as Readonly<{ expectedVersion: number; metadata: string; daemonState: string }>;
      if (event === 'machine-update-operation-protocol-capabilities') {
        MachineUpdateOperationProtocolCapabilitiesRequestV1Schema.parse(raw);
        return MachineUpdateOperationProtocolCapabilitiesResponseV1Schema.parse({ v: 1, result: 'success', revision: 1 });
      }
      if (event === 'machine-update-state') {
        statePublications.push(raw);
        if (rejectStatePublication) {
          statePublicationRejections.push({ nativeMutations: fixture.hostNative.networkMutations(),
            keyPresent: existsSync(join(fixture.happyHomeDir, 'access-provider.setup-key')),
            setupInstalled: fixture.hostNative.dockerUnitMutations.length > 0 });
          throw Object.assign(new Error('Synthetic Machine state Socket transport refusal'), { code: 'ECONNRESET' });
        }
        return { result: 'success', version: request.expectedVersion + 1, daemonState: request.daemonState };
      }
      if (event === 'machine-update-metadata') {
        metadataPublications.push(raw); return { result: 'success', version: request.expectedVersion + 1, metadata: request.metadata };
      }
      if (event === SOCKET_RPC_EVENTS.CALL && raw && typeof raw === 'object'
        && Reflect.get(raw, 'method') === `${machine.id}:${RPC_METHODS.CAPABILITIES_DESCRIBE}`) {
        // Home's exact self-observation route returns the real installed handler's
        // ACK, rather than substituting a proof or granting mutation authority.
        const access = machine.access;
        if (!access) throw new Error('The installed Machine fixture has no access context');
        const packet = raw as SocketRpcRequestPayload;
        const result = await receivingRpc!.handleRequest({ method: packet.method, params: packet.params,
          requestId: packet.requestId, timeoutMs: packet.timeoutMs,
          transportResponseEnvelopeVersion: packet.transportResponseEnvelopeVersion,
          machineAdmission: SocketRpcMachineAdmissionContextV1Schema.parse({ actorAccountId: fixture.accountRuntime.accountId,
            custodianAccountId: access.custodian.accountId, machineId: machine.id,
            installationId: machine.installationId, role: access.role, encryptionMode: 'plain' }) });
        return { ok: true, result };
      }
      return resolveApiSessionSocketDefaultAck(event, raw);
    } });
    Reflect.set(client, 'socket', socket);
    const installed = client;
    const installedRpc: unknown = Reflect.get(installed, 'rpcHandlerManager');
    if (!(installedRpc instanceof RpcHandlerManager)) throw new Error('The actual installed RPC receiver is unavailable');
    receivingRpc = installedRpc;
    receivingSocket = socket;
    // The fixture bypasses ApiMachine.connect: attach its real target receiver
    // so translated cancellation uses the production controller listener.
    installedRpc.onSocketConnect(socket as unknown as Parameters<RpcHandlerManager['onSocketConnect']>[0]);
    relayInstalledRpc = async (connection, payload, cancellation) => {
      const refuse = (phase: string): never => { unsupportedSocket.push(phase);
        throw Object.assign(new Error('Unsupported fixture Home RPC transport'), { code: 'generic_fixture_transport_refused' }); };
      if (connection.clientType !== 'user-scoped') return refuse('client_type');
      if (connection.authExtras?.authorityCeiling !== undefined
        && connection.authExtras.authorityCeiling !== 'account_automation') return refuse('authority_ceiling');
      if (machine.encryptionMode !== 'plain') return refuse('content_mode');
      if (!payload || typeof payload !== 'object') return refuse('frame_shape');
      // Socket.IO is an untyped boundary; the actual receiver retains its own
      // codec, admission, signature and currentness parsing below this relay.
      const packet = payload as SocketRpcRequestPayload;
      if ('machineAdmission' in packet || packet.externalActionExecution || packet.authorization || packet.originalActionEnvelope
        || packet.workspaceSyncSourceRouting || packet.workspaceSyncTargetRouting || packet.workspaceSyncSourceWriterTargetRouting
        || packet.workspaceSyncSourceExecution || packet.workspaceSyncSeedRouting || packet.transferRouting || packet.answeringClient
        || !supportedPlainMachineRpcMethods.includes(packet.method)) return refuse('routed_or_unsupported_method');
      const current = await observeRelayAwait('credential_read', readCallerCredentials);
      const accountId = readAccountIdFromToken(connection.token);
      const provenance = readAuthTokenProvenance(decodeJwtPayload(connection.token), { allowLegacyHome: true });
      if (!current || (!requesterCredentials && !sameStoredCredentials(daemonCredentials, current)) || connection.token !== current.token
        || provenance?.provenance.kind !== 'terminal' || accountId !== (signedHome?.manageGrantee?.accountId ?? machine.access?.custodian.accountId)
        || !machine.active || machine.revokedAt !== null || machine.replacedByMachineId !== null
        || machine.installationId !== installationId || machine.access?.accessState !== 'ready') return refuse('credential_or_machine_binding');
      const machineAdmission = signedHome?.manageGrantee?.machineAdmission ?? SocketRpcMachineAdmissionContextV1Schema.parse({ actorAccountId: accountId,
        custodianAccountId: machine.access.custodian.accountId, machineId: machine.id,
        installationId: machine.installationId, role: machine.access.role, encryptionMode: machine.access.resourceMode });
      const replayFault = packet.method === `${machine.id}:${RPC_METHODS.APPROVAL_REQUEST_REPLAY_APPROVED}`
        ? replayAdmissionFault : undefined;
      // Deliberately invalid Home wire deliveries, never a valid forged ingress
      // or a substitute verifier. The real installed receiver must refuse them.
      const deliveredAdmission = replayFault === 'absent' ? undefined
        : replayFault === 'mismatched_target'
          ? SocketRpcMachineAdmissionContextV1Schema.parse({ ...machineAdmission, machineId: 'generic-other-machine' })
          : machineAdmission;
      if (replayFault === 'stale') fixture.home.refuseAdmissionAfterClaim();
      // This genuine Home boundary models only the verified terminal subset.
      // Its sole supported ceiling can lower authority, never raise it.
      const callerAuthority = connection.authExtras?.authorityCeiling === 'account_automation'
        ? 'account_automation' as const
        : resolveInvocationAuthority({ credential: 'terminal', surface: 'rpc' });
      console.info('Generic fixture boundary observation', { boundary: 'home_rpc_correlation',
        originalConfigure: originalConfigureRequestId === undefined ? 'absent'
          : packet.requestId === originalConfigureRequestId ? 'exact'
            : packet.requestId === 'rpc_' + originalConfigureRequestId ? 'rpc_prefix' : 'different',
        targetCorrelation: cancellation ? cancellation.targetRequestId === packet.requestId ? 'caller_local' : 'home_scoped' : 'absent' });
      // A cancelled admission must never begin a later target effect. Once
      // dispatched, the real receiver owns cooperative cancellation and its ACK.
      if (cancellation?.cancelled || lifetime.signal.aborted) throw Object.assign(new Error('RPC request cancelled'), { name: 'AbortError', code: 'cancelled' });
      if (cancellation) cancellation.dispatched = true;
      const result = await observeRelayAwait('receiver', () => installedRpc.handleRequest({ method: packet.method, params: packet.params,
        ...(cancellation ? { requestId: cancellation.targetRequestId } : {}), traceId: packet.traceId, timeoutMs: packet.timeoutMs,
        waitForResultOnCancel: packet.waitForResultOnCancel,
        transportResponseEnvelopeVersion: packet.transportResponseEnvelopeVersion,
        callerAuthority,
        ...(deliveredAdmission ? { machineAdmission: deliveredAdmission } : {}) }));
      const failure = readActionFailureEnvelope(result, { treatReturnedErrorEnvelopeAsFailure: true });
      const actionResult = ActionExecuteResultSchema.safeParse(result);
      const decisionOutput = getActionSpec('approval.request.decide').outputSchema?.safeParse(result);
      const decision = decisionOutput?.success ? decisionOutput.data : undefined;
      const details = failure?.details;
      socketOutcomes.push({ resultKind: result === null ? 'null' : Array.isArray(result) ? 'array' : typeof result,
        safeInspect: packet.method === `${machine.id}:${getActionSpec('machines.reachability.inspect').bindings!.rpcMethod!}`,
        callerAuthority,
        actionResultValid: actionResult.success, decisionOutputValid: decisionOutput?.success === true,
        ok: actionResult.success ? actionResult.data.ok : failure ? false : undefined,
        errorCode: failure?.errorCode,
        reasonCode: details && typeof details === 'object' && 'reasonCode' in details
          && typeof details.reasonCode === 'string' ? details.reasonCode : undefined,
        decisionStatus: decision && typeof decision === 'object' && 'status' in decision
          && typeof decision.status === 'string' ? decision.status : undefined });
      // Plain transport only. The real receiver supplies the codec result; the
      // Home relay owns this outer ACK (same incumbent filesystem fixture).
      return { ok: true, result };
    };
    await runWithServerHttpBaseUrl(fixture.accountRuntime.serverHttpBaseUrl, () => bootstrapAccountSettingsContext({
      credentials: daemonCredentials, mode: 'blocking', refresh: 'force', honorAccountSettingsModeEnv: false,
    }));
    const api = await runWithServerHttpBaseUrl(fixture.accountRuntime.serverHttpBaseUrl,
      () => ApiClient.create(daemonCredentials));
    daemonRuntime = await startDaemonSessionControlRuntime({ machineId, credentials: daemonCredentials,
      serverId: 'generic-home', serverBaseUrl: fixture.accountRuntime.serverHttpBaseUrl, externalActionAccountId: 'generic-owner',
      api, pluginRuntimeController: pluginReloadController,
      connectedServicesMaterializationBaseDir: join(fixture.directory, 'connected-services'),
      daemonSessionMutationCustody: { stageTranscriptEvent: async () => { throw new Error('Unexpected Session transcript'); },
        stageTranscriptMessage: async () => { throw new Error('Unexpected Session message'); } },
      getConnectedServiceRefreshCoordinator: () => null, getConnectedServiceQuotasCoordinator: () => null,
      pidToTrackedSession: new Map(), pidToAwaiter: new Map(), pidToSpawnResultResolver: new Map(), pidToSpawnWebhookTimeout: new Map(),
      getApiMachineForSessions: () => installed, spawnResourceCleanupByPid: new Map(), sessionAttachCleanupByPid: new Map(),
      connectedServicesRestartRequestedPids: new Set(),
      resolveCurrentMachineExecutionOriginContext: createCurrentMachineExecutionOriginContextResolver({
        serverUrl: fixture.accountRuntime.serverHttpBaseUrl, resolveCurrentMachineId: () => machineId,
        resolveCurrentServerIdentityId: () => homeIdentity,
      }),
      beforeShutdown: async () => {}, onHappySessionWebhook: async () => { throw new Error('Reachability must not start an Agent'); },
      requestShutdown() {}, processEnv: {},
    });
    const ingressOwner = daemonRuntime.externalActionIngressOwner;
    if (!ingressOwner) throw new Error('Expected the actual credentialed daemon Action ingress producer');
    installed.setRPCHandlers({ spawnSession: async () => { throw new Error('Reachability must not start an Agent'); },
      stopSession: async () => true, requestShutdown() {} }, {
      actionsSettingsProvider: createActionSettingsProvider(), externalActionIngressOwner: ingressOwner,
    });
    const target = { serverId: 'generic-home', machineId, installationId, custodianAccountId: 'generic-owner' };
    const adminAccess = createDaemonMachineAdminAccessRoutes({ target: () => target, getMachineClient: () => installed,
      nativeDependencies: fixture.identity.nativeDependencies });
    installed.registerMachineReachabilityRoutes(createDaemonMachineReachabilityRoutes({ target: () => target,
      getMachineClient: () => installed, agentIsolation: { read: () => ({ ...installed.getAgentIsolationSnapshot(), workspaceRoots: [] }) }, adminAccess }));
    expect(installed.getAgentIsolationSnapshot()).toEqual({ enabled: true,
      status: { kind: 'effective', platform: 'linux', agentUser: 'happier-agent' } });
    let requestNumber = 0;
    const invoke = async (method: string, input: unknown) => {
      if (method === 'machines.reachability.inspect') {
        // The parent must enter the same real credentialed Action executor as
        // Configure; a raw native port has no admitted reviewed-child lifetime.
        const result = await executeOriginalCli(method, input, 'present_user');
        return result.ok ? result.result : result;
      }
      const rpcContext = { signal: lifetime.signal,
        machineAdmission: { machineId, installationId, custodianAccountId: 'generic-owner', actorAccountId: 'generic-owner',
          role: 'manage' as const, encryptionMode: 'plain' as const }, verifyMachineAdmissionCurrent: async () => true };
      try {
        const result = await installed.invokeLocalMachineAction(method, input, { signal: rpcContext.signal, rpcContext,
          localActionContext: { actionRequestId: `generic-raw-${++requestNumber}` } });
        const failure = readActionFailureEnvelope(result);
        if (failure) inspectFixtureDiagnostic('public_machine_failure', failure);
        return result;
      } catch (error) { inspectFixtureDiagnostic('public_machine_throw', error); throw error; }
    };
    const runningDaemon = daemonRuntime;
    const originalCliSettings = createActionSettingsProvider();
    const capturedCliCredentials = new Map<string, NonNullable<Awaited<ReturnType<typeof readStoredCredentialsForServerId>>>>();
    const executeOriginalCli = async (
      actionId: 'machines.reachability.inspect' | 'machines.reachability.configure' | 'approval.request.decide',
      input: unknown,
      authority: 'account_automation' | 'present_user',
    ) => {
      // The existing CLI constructor derives authority from the canonical stored
      // credential classification and the current terminal present-user policy.
      writeDaemonState({ pid: process.pid, startedAt: Date.now(), startedWithCliVersion: 'test',
        httpPort: runningDaemon.controlPort, controlToken: runningDaemon.controlToken, machineId, accountId: 'generic-owner' });
      const credentials = await readCallerCredentials();
      if (!credentials) throw new Error('The scoped standalone CLI credentials are unavailable');
      expect(hasStoredSessionCredentialProvenance(credentials)).toBe(true);
      capturedCliCredentials.set(actionId, credentials);
      const actionRequestId = `generic-original-cli-${++requestNumber}`;
      if (actionId === 'machines.reachability.configure') originalConfigureRequestId = actionRequestId;
      const pending = createCliActionExecutorFromCredentials({ credentials,
        serverId: 'generic-home', serverApiUrl: fixture.accountRuntime.serverHttpBaseUrl,
        machineId, externalActionClient: true,
        onRequesterSessionCredentialDisclosure: disclosure =>
          confirmCliRequesterCredentialDisclosure(disclosure, { signal: lifetime.signal }),
        ...(requesterCredentials ? {} : { actionsSettingsProvider: originalCliSettings }),
        readCredentials: readCallerCredentials,
      }).bindInvocation(lifetime.signal).execute(actionId, input, { surface: 'cli', authority, actionRequestId });
      pendingRpc.add(pending);
      try { return await pending; }
      finally { pendingRpc.delete(pending); }
    };
    console.info('Generic public journey stage', { stage: 'runtime_ready', atMs: Date.now() });
    return { client: installed, machine, runtimeId, runtime, invoke,
      async connectMachineControl() {
        installed.connect();
        await vi.waitFor(() => expect(installed.isMachineControlRegistrationReady()).toBe(true));
      },
      requesterAdmission: signedHome.manageGrantee?.machineAdmission,
      signal: lifetime.signal,
      async trackCompletion<T>(work: () => Promise<T>): Promise<T> {
        lifetime.signal.throwIfAborted();
        const pending = work();
        pendingRpc.add(pending);
        try { return await pending; }
        finally { pendingRpc.delete(pending); }
      },
      assertInvalidAdmissionProofRejected: async () => {
        const identity = readInstallationIdentityIfExistsSync();
        if (!identity || identity.installationId !== machine.installationId) throw new Error('The actual installation identity is unavailable');
        const context = SocketRpcMachineAdmissionContextV1Schema.parse({ actorAccountId: fixture.accountRuntime.accountId,
          custodianAccountId: machine.access!.custodian.accountId, machineId: machine.id,
          installationId: identity.installationId, role: machine.access!.role, encryptionMode: machine.access!.resourceMode });
        const method = `${machine.id}:${RPC_METHODS.APPROVAL_REQUEST_REPLAY_APPROVED}`;
        const payload = MachineInstallationProofPayloadV1Schema.parse({ version: 1, machineId: machine.id,
          installationId: identity.installationId, accountId: context.custodianAccountId, rpcAdmission: { context, method } });
        const valid = signMachineInstallationProof({ payload, privateKey: identity.privateKey });
        const bytes = decodeBase64(valid.signature, 'base64url'); bytes[0] = bytes[0]! ^ 1;
        const proof = MachineInstallationProofV1Schema.parse({ ...valid, signature: encodeBase64(bytes, 'base64url') });
        const response = await axios.post(`${fixture.accountRuntime.serverHttpBaseUrl}/v1/machines/${machine.id}/admission/verify`,
          { v: 1, context, method, proof }, { headers: { Authorization: `Bearer ${daemonCredentials.token}` }, validateStatus: () => true });
        expect(response.status, 'The real proof boundary must reject an invalid signature').toBe(403);
        expect(fixture.home.admissionProofChecks.at(-1)).toEqual({ signatureValid: false, accepted: false });
      },
      runOriginalCli: (input: ReturnType<typeof fixture.configureInput>) => {
        console.info('Generic public journey stage', { stage: 'configure_submitted', atMs: Date.now() });
        return executeOriginalCli('machines.reachability.configure', input, 'account_automation');
      },
      inspectOriginalCli: async (input: Parameters<typeof inspectMachineReachability>[0]) => {
        const result = await executeOriginalCli('machines.reachability.inspect', input, 'account_automation');
        console.info('Generic public journey stage', { stage: 'public_inspect_returned', atMs: Date.now() });
        return result;
      },
      setReplayAdmissionFault(value: NonNullable<typeof replayAdmissionFault>) { replayAdmissionFault = value; },
      // Read-only diagnostic: these are the exact credential objects supplied
      // above, never replacement currentness or approval authority.
      readCurrentnessDiagnostic: async (request: ApprovalRequest) => {
        const current = await readCallerCredentials();
        const origin = request.v === 2 ? request.executionOriginV1 : undefined;
        const configure = capturedCliCredentials.get('machines.reachability.configure');
        const reviewer = capturedCliCredentials.get('approval.request.decide');
        const snapshot = reviewer ? await fetchServerFeaturesSnapshot({
          serverUrl: fixture.accountRuntime.serverHttpBaseUrl, token: reviewer.token,
        }) : undefined;
        const daemon = daemonCredentials;
        const matches = {
          originPresent: origin !== undefined,
          currentCredentialsPresent: current !== null,
          snapshotReady: snapshot?.status === 'ready',
          snapshotAuthenticated: snapshot?.status === 'ready' && snapshot.provenance === 'authenticated',
          originAccount: origin !== undefined && reviewer !== undefined
            && (origin.accountId === undefined || origin.accountId === readAccountIdFromToken(reviewer.token)),
          originHome: origin !== undefined && snapshot?.status === 'ready'
            && (origin.serverIdentityId ? origin.serverIdentityId === snapshot.features.capabilities.serverIdentity.serverIdentityId
              : origin.serverId === 'generic-home'),
          configureStoredCredentials: configure !== undefined && sameStoredCredentials(configure, current),
          reviewerStoredCredentials: reviewer !== undefined && sameStoredCredentials(reviewer, current),
          daemonStoredCredentials: sameStoredCredentials(daemon, current),
          configureTokenBytes: configure !== undefined && current !== null && configure.token === current.token,
          reviewerTokenBytes: reviewer !== undefined && current !== null && reviewer.token === current.token,
          daemonTokenBytes: current !== null && daemon.token === current.token,
          configureStoredSession: configure !== undefined && hasStoredSessionCredentialProvenance(configure),
          reviewerStoredSession: reviewer !== undefined && hasStoredSessionCredentialProvenance(reviewer),
          daemonStoredSession: hasStoredSessionCredentialProvenance(daemon),
          currentStoredSession: current !== null && hasStoredSessionCredentialProvenance(current),
        };
        return { differingFields: Object.entries(matches).filter(([, equal]) => !equal).map(([field]) => field),
          matches, snapshotStatus: snapshot?.status,
          snapshotReason: snapshot && snapshot.status !== 'ready' ? snapshot.reason : undefined,
          externalAuthorizationPresent: origin?.externalActionExecutionAuthorization !== undefined };
      },
      readFreshApprovalDiagnostic: async (artifactId: string) => {
        // Observation after the real replay failure, never a replacement reader
        // or authority callback for that replay.
        try {
          const credentials = await readCallerCredentials();
          if (!credentials) return { status: 'credentials_unavailable' as const };
          const request = await runWithServerHttpBaseUrl(fixture.accountRuntime.serverHttpBaseUrl, () =>
            createCliApprovalsArtifactStore({ credentials, serverId: 'generic-home',
              serverHttpBaseUrl: fixture.accountRuntime.serverHttpBaseUrl,
            }).approvalsGet({ artifactId, serverId: null }));
          return { status: request ? 'available' as const : 'missing' as const };
        } catch (error) {
          const knownFields = new Set(['id', 'header', 'body', 'dataEncryptionKey', 'headerVersion', 'bodyVersion',
            'seq', 'createdAt', 'updatedAt', 'ownerAccountId', 'access', 'encryptionMode', 'publicAudience',
            'provenance', 'provenanceDataEncryptionKey', 'mode', 'v', 'kind', 'artifactId', 'status']);
          const issues = error && typeof error === 'object' && 'issues' in error && Array.isArray(error.issues)
            ? error.issues.flatMap((issue: unknown) => {
                if (!issue || typeof issue !== 'object' || !('path' in issue) || !Array.isArray(issue.path)) return [];
                return [issue.path.map((part: unknown) => typeof part === 'number' ? part
                  : typeof part === 'string' && knownFields.has(part) ? part : '[redacted-field]')];
              }) : undefined;
          return { status: 'refused' as const, name: error instanceof Error ? error.name : undefined,
            code: error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
              ? error.code : undefined, issuePaths: issues };
        }
      },
      readFailureDiagnostic: async (error: string) => {
        // Observe existing failure text only after removing every exact held
        // credential and grant string; no authority or exception is replaced.
        let summary = error;
        const redact = (value: unknown): void => {
          if (typeof value === 'string' && value.length) summary = summary.split(value).join('[REDACTED]');
          else if (Array.isArray(value)) value.forEach(redact);
          else if (value && typeof value === 'object') Object.values(value).forEach(redact);
        };
        [fixture.privateSetupKey, daemonCredentials.token, runningDaemon.controlToken,
          ...[...capturedCliCredentials.values()].map(value => value.token),
          ...fixture.home.connectorGrantRedactions()].forEach(redact);
        return { errorSummary: summary, boundaries: { grants: await fixture.home.readConnectorGrantCount(),
          authorizationMintResponses: fixture.home.authorizationMintResponses,
          rootLaunches: fixture.elevation.launches.length, elevationStages: fixture.elevation.diagnostics,
          metadata: metadataPublications.length,
          nativeMutations: fixture.hostNative.networkMutations(), nativeCalls: fixture.hostNative.calls.length,
          setupNativeCalls: fixture.hostNative.calls.length, statePublicationRejections: statePublicationRejections.length,
          proofsAccepted: fixture.home.admissionProofChecks.filter(check => check.accepted).length,
          proofsRefused: fixture.home.admissionProofChecks.filter(check => !check.accepted).length },
          processFailures: processBoundary.failures.map(error => ({
            name: error instanceof Error ? error.name : undefined,
            code: error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
              ? error.code : undefined,
          })) };
      },
      statePublications, metadataPublications, processBoundary, statePublicationRejections, unsupportedSocket, socketOutcomes,
      setStatePublicationRejected(value: boolean) { rejectStatePublication = value; },
      listOperations: async () => ActionOperationListV1ResponseSchema.parse(await invoke(ACTION_OPERATION_RPC_METHODS_V2.list, {})),
      decide: (artifactId: string, decision: 'approve' | 'reject' = 'approve') =>
        executeOriginalCli('approval.request.decide', { artifactId, decision }, 'present_user'),
      replay: (artifactId: string) => installed.invokeLocalMachineAction(RPC_METHODS.APPROVAL_REQUEST_REPLAY_APPROVED, { artifactId }),
      dispose,
    };
  } catch (error) {
    try { await dispose(); } catch (cleanupError) { throw new AggregateError([error, cleanupError], 'Installed Generic fixture preparation and cleanup failed'); }
    throw error;
  }
}

function readFixtureApprovalFact(artifact: Readonly<Record<string, unknown>>) {
  // Observe only already-owned carrier metadata. Never print input, title,
  // credential, Artifact bytes, Account identity or free-form failure text.
  try {
    if (typeof artifact.header !== 'string' || typeof artifact.body !== 'string') return { family: 'unreadable' };
    const header = decodePlainArtifactStoredContent(artifact.header), body = decodePlainArtifactStoredContent(artifact.body);
    if (!header || typeof header !== 'object' || Array.isArray(header)
      || !body || typeof body !== 'object' || !('body' in body) || typeof body.body !== 'string') return { family: 'unreadable' };
    const parsed = approvalArtifactBodyMatchesHeaderV1(header as Record<string, unknown>, body.body);
    if (!parsed) return { family: 'unmatched' };
    const subject = parsed.family === 'built_in'
      ? parsed.request.actionId === 'machines.reachability.configure' ? 'reachability_configure' : 'other_builtin'
      : parsed.family === 'target_action'
        ? parsed.request.qualifiedActionId.endsWith('/actions/join') ? 'selected_provider_join'
          : parsed.request.qualifiedActionId.endsWith('/actions/inspect') ? 'selected_provider_inspect'
          : parsed.request.qualifiedActionId.endsWith('/actions/leave') ? 'selected_provider_leave' : 'other_target'
        : 'execution_run_host_action';
    return { family: parsed.family, status: parsed.request.status, subject };
  } catch { return { family: 'unreadable' }; }
}

function projectGenericFixtureCode(value: unknown) {
  // Reasons/codes are free-form strings at several real boundaries. Only
  // these reviewed protocol/OS literals may leave this observation tap.
  return value === undefined ? 'absent' : typeof value === 'string' && [
    'foreign_effect_conflict', 'required_fact_unavailable', 'action_forbidden', 'needs_admin_to_check',
    'secret_missing', 'needs_attendance', 'recoveryRequired', 'cancelled', 'scope-retired',
    'plan_changed', 'plan_stale', 'action_failed', 'plugin_action_execution_failed', 'admission_unavailable',
    'action_operation_failed', 'invalid_action_output', 'ERR_CANCELED', 'ECONNABORTED',
    'generic_fixture_os_refused', 'RPC_REQUEST_TIMEOUT',
    // Canonical Action/role/credential refusals; never arbitrary error prose.
    'invalid_parameters', 'action_request_input_conflict', 'action_disabled',
    'approval_required', 'approval_unavailable', 'approval_stale', 'approval_context_unavailable',
    'credential_unavailable', 'saved_secret_unavailable', 'needsAuth',
    'access_provider_target_unsupported', 'access_provider_unavailable', 'native_status_unknown',
    'machine_recipe_native_unavailable', 'machine_setup_content_unavailable',
    'plugin_action_execution_origin_unavailable', 'plugin_action_execution_origin_changed',
    'plugin_action_input_invalid', 'plugin_action_input_schema_invalid', 'plugin_activation_failed',
    'plugin_managed_provider_operation_custody_invalid',
    'plugin_action_surface_unavailable', 'plugin_action_session_required', 'plugin_action_selection_unavailable',
    'plugin_action_generation_retired', 'plugin_action_aborted', 'plugin_action_pre_dispatch_unavailable',
    'plugin_action_current_intent_unavailable', 'plugin_action_current_intent_mismatch',
    'plugin_action_current_intent_rejected', 'plugin_action_outcome_unknown',
    'plugin_action_schema_projection_mismatch', 'plugin_action_result_schema_invalid',
    // Closed refusals authored by this same public fixture module below.
    'profile_conflict', 'provider_unavailable', 'fixture_not_joined', 'unexpected_leave',
    ...Object.values(RPC_ERROR_CODES),
  ].includes(value) ? value : 'other';
}

function inspectFixtureDiagnostic(site: string, error: unknown) {
  const record = error !== null && typeof error === 'object' ? error : {};
  const rawCode = 'errorCode' in record ? record.errorCode : 'code' in record ? record.code : undefined;
  const code = typeof rawCode === 'string' && /^[a-zA-Z0-9_]+$/.test(rawCode) ? rawCode : undefined;
  const frames = 'stack' in record && typeof record.stack === 'string' ? record.stack.split('\n').slice(1)
    .flatMap(line => line.match(/([a-zA-Z0-9_.-]+\.(?:ts|mjs|js):\d+:\d+)\)?$/)?.[1] ?? []) : [];
  console.info('Generic inspect secret-free diagnostic', { site, code, frames });
}

export function createDockerNetworkAuthoredProvider(enabled = false, nativeJoin = false, installClient = false,
  options: Readonly<{ installDockerService?: boolean }> = {}): AuthoredProvider {
  const pluginId = 'com.example.docker-network';
  const membership = (role: 'join' | 'leave'): MachineRecipeV1 => ({
    id: `network-${role}`, revision: '1', title: role, inputSchema: ROLE_SCHEMAS[`${role}Input`].jsonSchema,
    steps: [{ id: `network-${role}`, kind: 'command', executable: '/usr/bin/network-client',
      args: role === 'join' ? ['join', { kind: 'input', path: 'setupCredentialFile' }] : ['leave'],
      check: { executable: '/usr/bin/network-client', args: ['status'], unsatisfiedExitCodes: [127],
        stdoutJson: { op: 'eq', path: 'joined', value: role === 'join' } } }],
  });
  const authored = definePlugin({ id: pluginId, version: '1.0.0', displayName: 'Docker-backed network fixture',
    entrypoints: { daemon: './daemon.mjs' },
    hostAccess: { required: [{ id: 'network-client', capability: 'process', reason: 'Observe this fixture native client',
      scope: { executables: [{ kind: 'systemTool', id: 'network-client-tool' }] } }], optional: [] },
    systemTools: { 'network-client-tool': { title: 'Network fixture client', executableNames: ['network-client'] } },
    machineRecipes: { 'docker-service': { revision: '1', title: 'Docker-backed network service',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      steps: [{ id: 'docker-unit', kind: 'serviceUnit', unit: 'docker.service', enabled, running: true }] },
      'network-client': { revision: '1', title: 'Install the fixture network client',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        steps: [{ id: 'client-bin', kind: 'directory', path: '/usr/bin', owner: 'root', group: 'root', mode: 0o755 },
          { id: 'client-executable', kind: 'file', path: '/usr/bin/network-client', owner: 'root', group: 'root', mode: 0o755,
            content: { kind: 'literal', value: 'fixture native executable' } }] } },
    accessProviders: { 'docker-network': { ...GENERIC_ACCESS_PROVIDER, title: 'Docker-backed network fixture',
      ...(nativeJoin && !installClient && !options.installDockerService ? {}
        : { install: { kind: 'recipe' as const, ref: { pluginId, recipeId: installClient ? 'network-client' : 'docker-service', revision: '1' } } }),
      membership: { join: membership('join'), leave: membership('leave') },
    } },
    actions: {
      inspect: { title: 'Inspect network fixture', scopes: ['machine'], surfaces: ['cli', 'plugin'],
        hostAccess: ['network-client'],
        execution: { target: 'daemon' }, dangerLevel: 'safe', inputSchema: ROLE_SCHEMAS.inspectInput,
        resultSchema: ROLE_SCHEMAS.result, run: async () => ({ kind: 'unknown' as const, code: 'fixture_not_joined' }) },
      join: { title: 'Join network fixture', scopes: ['machine'], surfaces: ['cli', 'plugin'],
        hostAccess: ['network-client'],
        execution: { target: 'daemon' }, dangerLevel: 'externalSideEffect',
        confirmation: { title: 'Join network fixture?', body: 'Apply the reviewed native service and membership change.' }, inputSchema: ROLE_SCHEMAS.joinInput,
        resultSchema: ROLE_SCHEMAS.result, run: async () => ({ kind: 'refused' as const, code: 'plan_changed' }) },
      leave: { title: 'Leave network fixture', scopes: ['machine'], surfaces: ['cli', 'plugin'],
        hostAccess: ['network-client'],
        execution: { target: 'daemon' }, dangerLevel: 'externalSideEffect',
        confirmation: { title: 'Leave network fixture?', body: 'Disconnect this fixture network.' }, inputSchema: ROLE_SCHEMAS.leaveInput,
        resultSchema: ROLE_SCHEMAS.result, run: async () => ({ kind: 'unknown' as const, code: 'unexpected_leave' }) },
    },
  });
  // Physical public activate ABI, not instantiateCommittedModule or a host
  // registry callback. The real loader owns this exact authored module.
  const module = `export const manifest = ${JSON.stringify(authored.manifest)};
let mutations = 0;
export const readMutations = () => mutations;
function inspectDiagnostic(stage, error, facts = {}) {
  const value = error && typeof error === 'object' ? error : {};
  const code = typeof value.code === 'string' && /^[a-zA-Z0-9_]+$/.test(value.code) ? value.code : undefined;
  const name = ['Error','TypeError','SyntaxError','ReferenceError','RangeError','PluginError'].includes(value.name) ? value.name : 'other';
  const frames = typeof value.stack === 'string' ? value.stack.split('\\n').slice(1)
    .flatMap(line => line.match(/([a-zA-Z0-9_.-]+\\.(?:ts|mjs|js):\\d+:\\d+)\\)?$/)?.[1] ?? []) : [];
  const cause = value.cause && typeof value.cause === 'object' ? value.cause : {};
  const causeCode = typeof cause.code === 'string' && /^[a-zA-Z0-9_]+$/.test(cause.code) ? cause.code : undefined;
  console.info('Generic authored inspect secret-free diagnostic', { stage, name, code, causeCode, frames, ...facts });
}
export function activate(api) {
  api.actions.register('inspect', async (input, context) => {
    let stage = 'entered';
    try {
    ${nativeJoin ? `stage = 'tool_resolution'; const tool = await context.services.exec.systemTools.resolve({toolId:'network-client-tool',purpose:'Observe fixture membership'}).catch(error => { inspectDiagnostic(stage, error); return null; });
    if (!tool) return {kind:'unknown',code:'provider_unavailable'};
    stage = 'exec_run'; const result = await context.services.exec.run({executable:tool.executable,args:['status']});
    inspectDiagnostic('exec_returned', null, { stdoutKind: typeof result.stdout, stdoutBytes: result.stdout?.byteLength, decoderAvailable: typeof TextDecoder === 'function', terminationKind: result.termination?.observed?.kind });
    stage = 'decode_parse'; const observed = JSON.parse(new TextDecoder().decode(result.stdout));
    if (observed.profileName !== input.config.profileName) return {kind:'refused',code:'profile_conflict'};
    const joined = observed.joined === true;
    const state = joined ? 'ready' : 'stopped';
    return {kind:'confirmed',facts:{state,privateNetwork:{provider:{pluginId:${JSON.stringify(pluginId)},localId:'docker-network'},
      networkIdentity:'fixture-network',displayName:'Fixture network',dnsName:null,addresses:joined?['100.91.0.7']:[],
      state,interfaceName:joined?'fixture-network':null,sourceRanges:joined?['100.91.0.0/16']:[],magicDnsEnabled:false}}};`
    : "return {kind:'unknown',code:'fixture_not_joined'};"}
    } catch (error) { inspectDiagnostic(stage, error); throw error; }
  });
  api.actions.register('join', async () => { mutations++;
    return {kind:'refused',code:'unexpected_daemon_membership_action'};
  });
  api.actions.register('leave', async () => { mutations++; return {kind:'unknown',code:'unexpected_leave'}; });
}`;
  return { pluginId, plugin: { manifest: authored.manifest, files: { 'daemon.mjs': module } } };
}

export function parseReachabilityInspectResult(value: unknown) {
  const failure = readActionFailureEnvelope(value);
  expect(failure && { errorCode: failure.errorCode, effectAttempted: failure.effectAttempted }, 'Actual inspect refusal before DTO parsing').toBeNull();
  return MachineReachabilityInspectResultV1Schema.parse(value);
}


/** Observe and decide an ordinary deferred Ask through the existing public owners. */
export function executeReviewedReachabilityConfigure(...args: Parameters<typeof executeReviewedReachabilityConfigureTask>) {
  return args[1].trackCompletion(() => executeReviewedReachabilityConfigureTask(...args));
}

async function executeReviewedReachabilityConfigureTask(
  fixture: Awaited<ReturnType<typeof journey>>,
  api: Awaited<ReturnType<typeof createGenericDefaultFactoryJourney>>,
  review: ReturnType<typeof parseReachabilityInspectResult>,
  options: Readonly<{ beforeDecision?(): void | Promise<void>; reviewArtifact?(request: ApprovalRequest): void }> = {},
) {
  if (!review.plan) throw new Error('Expected the real reviewed plan');
  const artifactCount = fixture.home.artifacts.size;
  const before = { mutations: fixture.hostNative.networkMutations(), grants: await fixture.home.readConnectorGrantCount(),
    metadata: api.metadataPublications.length, root: fixture.elevation.launches.length };
  const raw = ActionExecuteResultSchema.parse(await api.runOriginalCli(fixture.configureInput(review)));
  api.signal.throwIfAborted();
  const earlyFailure = readActionFailureEnvelope(raw);
  const earlyBoundary = earlyFailure ? await api.readFailureDiagnostic(earlyFailure.error) : undefined;
  expect(earlyFailure && { errorCode: earlyFailure.errorCode, effectAttempted: earlyFailure.effectAttempted,
    elevationStages: earlyBoundary?.boundaries.elevationStages,
    processFailures: earlyBoundary?.processFailures,
    boundaries: { artifacts: fixture.home.artifacts.size - artifactCount, grants: await fixture.home.readConnectorGrantCount() - before.grants,
      root: fixture.elevation.launches.length - before.root, metadata: api.metadataPublications.length - before.metadata,
      nativeMutations: fixture.hostNative.networkMutations() - before.mutations } },
    'Standalone CLI Configure refused before its retained approval').toBeNull();
  if (!raw.ok) throw new Error(raw.errorCode);
  const created = ActionApprovalRequestCreatedResultSchema.parse(raw.result);
  expect(created.actionId).toBe('machines.reachability.configure');
  expect(fixture.home.artifacts.size).toBe(artifactCount + 1);
  const readRetained = () => {
    const index = [...fixture.home.artifacts.keys()].indexOf(created.artifactId);
    if (index < 0) throw new Error('The approval Artifact was not retained');
    return ApprovalRequestSchema.parse(fixture.home.approvalRequests()[index]);
  };
  const request = readRetained();
  expect(request.status).toBe('open');
  expect({ mutations: fixture.hostNative.networkMutations(), grants: await fixture.home.readConnectorGrantCount(),
    metadata: api.metadataPublications.length, root: fixture.elevation.launches.length }).toEqual(before);
  const preview = request.preview;
  if (!preview || typeof preview !== 'object' || !('actionArgs' in preview)
    || !preview.actionArgs || typeof preview.actionArgs !== 'object' || !('reviewedPlanBasis' in preview.actionArgs)) {
    throw new Error('The retained approval has no reviewed checklist');
  }
  const basis = MachineReachabilityPlanBasisV1Schema.parse(preview.actionArgs.reviewedPlanBasis);
  expect(basis).toEqual(review.plan.basis);
  const presentation = describeApprovalActionFields({ actionId: request.actionId, actionArgs: request.actionArgs,
    preview: request.preview, status: request.status });
  expect(presentation.unrepresentable).toBeNull();
  const row = presentation.rows.find(row => row.kind === 'value' && row.path === 'reviewedPlanBasis');
  if (!row || row.kind !== 'value') throw new Error('The retained checklist has no public renderer row');
  expect(MachineReachabilityPlanBasisV1Schema.parse(JSON.parse(row.value))).toEqual(basis);
  expect(JSON.stringify(request.preview)).not.toContain(fixture.privateSetupKey);
  expect(JSON.stringify(request.preview)).not.toContain('grantRef');
  expect(JSON.stringify([...fixture.home.artifacts.values()])).not.toContain(fixture.privateSetupKey);
  options.reviewArtifact?.(request);
  console.info('Generic public journey stage', { stage: 'review_ready', atMs: Date.now() });
  await options.beforeDecision?.();
  api.signal.throwIfAborted();
  const decision = await api.decide(created.artifactId);
  api.signal.throwIfAborted();
  console.info('Generic public journey stage', { stage: 'decision_returned', atMs: Date.now() });
  const decisionFailure = readActionFailureEnvelope(decision);
  if (decisionFailure) {
    const retained = readRetained();
    const retainedFailure = readApprovalExecutionFailure(retained);
    const decisionDetails = decisionFailure.details;
    const decisionReasonCode = decisionDetails && typeof decisionDetails === 'object' && 'reasonCode' in decisionDetails
      && typeof decisionDetails.reasonCode === 'string' ? decisionDetails.reasonCode : undefined;
    const details = retainedFailure?.errorCode === 'approval_execution_outcome_unknown' ? retainedFailure.details : undefined;
    const reasonCode = details && typeof details === 'object' && 'reasonCode' in details
      && typeof details.reasonCode === 'string' ? details.reasonCode : undefined;
    const boundary = await api.readFailureDiagnostic(decisionFailure.error);
    expect({ errorCode: decisionFailure.errorCode, effectAttempted: decisionFailure.effectAttempted,
      retainedErrorCode: retainedFailure?.errorCode, reasonCode, decisionReasonCode,
      decisionOk: decision.ok, decisionDetailsPresent: decisionFailure.details !== undefined,
      retainedStatus: retained.status, retainedDecisionKind: retained.decision?.kind,
      retainedHasExecution: retained.execution !== undefined, retainedExecutionOk: retained.execution?.ok,
      retainedExecutionEffectAttempted: retained.v === 2 ? retained.execution?.effectAttempted : undefined,
      boundaries: boundary.boundaries, processFailures: boundary.processFailures,
      unsupportedHttp: fixture.home.unsupportedHttp, unsupportedSocket: api.unsupportedSocket,
          artifactCas: fixture.home.artifactCas, socketOutcomes: api.socketOutcomes,
      freshApprovalRead: await api.readFreshApprovalDiagnostic(created.artifactId) },
      'Actual decision failure and retained boundary diagnostic').toBeUndefined();
  }
  expect(decisionFailure?.errorCode, 'Public approval decision failure code').toBeUndefined();
  expect(decision).toMatchObject({ ok: true });
  const alreadyExecuted = readRetained().execution !== undefined;
  const mutationsBeforeReplay = fixture.hostNative.networkMutations();
  await api.replay(created.artifactId);
  api.signal.throwIfAborted();
  console.info('Generic public journey stage', { stage: 'replay_returned', atMs: Date.now() });
  if (alreadyExecuted) expect(fixture.hostNative.networkMutations()).toBe(mutationsBeforeReplay);
  const retained = readRetained();
  if (!retained.execution) throw new Error('The approved Action has no retained execution');
  const execution = retained.execution;
  if (execution.ok) return { artifactId: created.artifactId, request: retained,
    result: { ok: true as const, result: execution.result } };
  const failure = readActionFailureEnvelope(execution);
  if (!failure) throw new Error('The retained execution has no canonical failure code');
  if (failure.errorCode === 'machine_reachability_unavailable') {
    const diagnostic = await api.readFailureDiagnostic(failure.error);
    console.info('Reachability retained failure boundary', {
      errorCode: failure.errorCode, boundaries: diagnostic.boundaries,
      processFailures: diagnostic.processFailures,
    });
  }
  return { artifactId: created.artifactId, request: retained, result: failure };
}

export function parseCompletedReachabilityConfigure(result: Awaited<ReturnType<typeof executeReviewedReachabilityConfigure>>['result']) {
  const staleDetails = !result.ok && result.errorCode === 'approval_stale'
    ? ApprovalStaleFailureDetailsSchema.safeParse(result.details) : null;
  expect(!result.ok && { errorCode: result.errorCode, effectAttempted: result.effectAttempted,
    staleReason: staleDetails?.success ? staleDetails.data.reason : undefined,
    setupOutcome: result.details && typeof result.details === 'object' && 'setupOutcome' in result.details
      ? result.details.setupOutcome : undefined }, 'Actual retained Configure failure before DTO parsing').toBe(false);
  if (!result.ok) throw new Error(result.errorCode);
  return MachineReachabilityConfigureResultV1Schema.parse(result.result);
}
