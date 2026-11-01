import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import axios from 'axios';
import { ConnectedServiceBindingsV2IngressSchema, SPAWN_SESSION_ERROR_CODES } from '@happier-dev/protocol';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildConnectedServiceCredentialRecord, FeaturesResponseSchema, QualifiedConnectedAccountCredentialMutationV4Schema, QualifiedConnectedAccountCredentialSnapshotV4Schema, QualifiedConnectedAccountListResponseV4Schema, QualifiedConnectedAccountRefreshLeaseV4Schema, sealAccountScopedBlobCiphertext, sealQualifiedConnectedAccountContentEnvelope } from '@happier-dev/protocol';
import type { ApiClient } from '@/api/api';
import { getResolvedContributionRegistry } from '@/plugins/projection/registry/builtIn/snapshot';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { resolveExecutablePluginRuntimeRegistry } from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';
import type { PluginRuntimeRegistryLease } from '@/plugins/runtime/reload/controller';
import { createQualifiedConnectedAccountEstablishedRuntimeOwner } from './qualifiedConnectedAccountEstablishedRuntimeOwner';
import { createConnectedAccountPurposeBindingOwner } from './purposeBindings/ConnectedAccountPurposeBindingOwner';
import { resolveQualifiedPurposeBindingSnapshotForAgentSpawn } from './requestAuth/prepareConnectedAccountRequestAuthForSpawn';
import { resolveConnectedServiceAuthForSpawn } from './resolveConnectedServiceAuthForSpawn';
import { ConnectedServiceRefreshCoordinator, persistConnectedServiceCredentialHealthForMaterializationFailure } from './refresh/ConnectedServiceRefreshCoordinator';
import { readQualifiedConnectedAccountCredentialV4, acquireQualifiedConnectedAccountRefreshLeaseV4, mutateQualifiedConnectedAccountCredentialV4, mutateQualifiedConnectedAccountCredentialHealthV4, listQualifiedConnectedAccountsV4 } from '@/api/client/qualifiedConnectedAccountApi';
import { QualifiedConnectedAccountGroupV4Schema } from '@happier-dev/protocol';
import { ConnectedServiceAuthGroupSwitchCoordinator, InMemoryConnectedServiceAuthGroupSwitchLeaseRegistry } from './accountGroups/switching/ConnectedServiceAuthGroupSwitchCoordinator';
import { buildQualifiedConnectedAccountAuthGroupSwitchState } from './accountGroups/switching/buildConnectedServiceAuthGroupSwitchState';
import { createStablePluginConnectedAccountsHost } from '@/plugins/runtime/invocation/services/connectedAccounts';
import { resolveAgentSpawnPurposeDeclarations } from './requestAuth/agentPurposeDeclarations';
import { resolveNativeAgentLaunchEnvironment } from '@/agent/runtime/launchEnvironment';
import { CONNECTED_ACCOUNT_REQUEST_AUTH_CAPABILITY_PATH_ENV } from '@happier-dev/plugin-sdk/connected-accounts';
import type { AgentRuntimeContext, AgentSessionOpenRequest } from '@happier-dev/plugin-sdk/agents/runtime';
import { prepareOpenCodeQualifiedConnectedAccounts, type PreparedOpenCodeQualifiedConnectedAccounts } from '../../../../../packages/plugins/opencode/src/agent/auth/services/qualifiedPurposeLaunch';
import { buildOpenCodeRequestAuthMarker } from '../../../../../packages/plugins/opencode/src/agent/auth/services/requestAuth/source';
import { resolveOpenCodeRequestAuthPluginPath, resolveOpenCodeRequestAuthV2PluginDir } from '../../../../../packages/plugins/opencode/src/agent/auth/services/requestAuth/assets';
import { buildOpenCodeManagedServerSpawnSpec } from '../../../../../packages/plugins/opencode/src/agent/runtime/server/spawnSpec';
import { prepareDaemonConnectedServices } from '@/daemon/spawn/prepareDaemonConnectedServices';
import { prepareDaemonSpawnChildEnvironment } from '@/daemon/spawn/prepareDaemonSpawnChildEnvironment';
import { createProviderLaunchResourceScope } from '@/providers/lifecycle/resourceScope';
import { createProviderRedactionLease } from '@/providers/spawn/redaction';
import { writeExecutableShimSync } from '@/testkit/fs/executableShim';
import { resolveExplicitSpawnScopedEnvironmentFromProcessEnv } from '@/daemon/spawn/spawnExplicitEnvKeysMarker';
import { createDaemonControlApp } from '@/daemon/controlServer';
import { createConnectedAccountRequestAuthService } from './requestAuth/ConnectedAccountRequestAuthService';
import { createConnectedAccountRequestAuthSubjectRegistry } from './requestAuth/ConnectedAccountRequestAuthSubjectRegistry';
import { createDaemonQualifiedRequestAuthCallbacks } from './requestAuth/createDaemonQualifiedRequestAuthCallbacks';
import { scopeConnectedAccountSessionPurposeBindingLease } from './purposeBindings/ConnectedAccountPurposeBindingOwner';
import { createDaemonConnectedAccountPurposeBindingRuntime } from './purposeBindings/createDaemonConnectedAccountPurposeBindingRuntime';
import { assertOpenCodeManagedPrompt } from './requestAuth/openCodeManagedPrompt.test-support';
import { logger } from '@/ui/logger';

const service = { pluginId: 'happier.agent.codex', localId: 'openai-codex' } as const;
const credentials = { token: 'test-token', encryption: { type: 'legacy' as const, secret: new Uint8Array(32).fill(7) } };
const revision = 'csr_0123456789ABCDEFGHJKMNPQRS';
let lease: PluginRuntimeRegistryLease;
let directory: string;
let providerRejectsRefresh = false;
let groupActiveAccount: { service: typeof service; accountId: string } | null = null;
const purposeInvalidations = new Set<() => void>();
const established = createQualifiedConnectedAccountEstablishedRuntimeOwner({
  reloadController: pluginReloadController,
  credentials,
  getAccountEncryptionMode: async () => 'e2ee',
  configuration: {
    read: async () => null,
    secrets: { admit: async () => undefined, has: async () => false, read: async () => null },
  },
});
const purposeOwner = createConnectedAccountPurposeBindingOwner({
  store: { read: async () => ({ v: 1, bindings: [] }), update: async (mutate) => mutate({ v: 1, bindings: [] }), subscribe: () => ({ dispose() {} }) },
  selectTarget: async () => { throw new Error('unexpected selection'); },
  resolveTarget: async (target) => {
    const account = target.kind === 'account' ? target.account : groupActiveAccount;
    return account ? { displayName: 'QA fixture', account } : null;
  },
  resolveCredentialRevision: (account, signal) => established.readCredentialRevision({ account, signal }),
  subscribeInvalidations(listener) {
    purposeInvalidations.add(listener);
    return { dispose: () => { purposeInvalidations.delete(listener); } };
  },
  materializeAccount: async ({ account, request, signal, credentialRevisionBasis }) => {
    const invoked = await established.invokeWithReceipt({ account, operation: { kind: 'materialize', request }, signal });
    credentialRevisionBasis?.captureCredentialRevision(invoked.basis.credentialRevision);
    return invoked.result;
  },
  projectTargetAccounts: async () => { throw new Error('unexpected listing'); },
  assertTargetAccountMaterializable: async () => { throw new Error('unexpected listed materialization'); },
});

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'happier-qualified-spawn-'));
  lease = await pluginReloadController.acquireRuntimeRegistry({
    resolveRuntimeRegistry: () => resolveExecutablePluginRuntimeRegistry({
      contributes: getResolvedContributionRegistry(),
      resolveDevelopmentSourceAuthority: ({ pluginId, rootPath }) => ({ kind: 'development', registeredRootId: `qualified-spawn:${pluginId}`, canonicalRoot: rootPath, observedRevision: 1 }),
      connectedAccounts: purposeOwner,
      qualifiedConnectedAccountEstablishedRuntimeOwner: established,
      networkDependencies: {
        resolveNetworkAddresses: async () => ['8.8.8.8'],
        openPinnedStream: async (request) => {
          if (request.url !== 'https://auth.openai.com/oauth/token') throw new Error('Unexpected provider transport');
          const body = new TextEncoder().encode(JSON.stringify(providerRejectsRefresh
            ? { error: 'invalid_grant' }
            : { access_token: 'refreshed-access', refresh_token: 'refreshed-refresh', id_token: 'fixture-id', expires_in: 3600 }));
          let delivered = false;
          return { status: providerRejectsRefresh ? 400 : 200, headers: {}, contentLength: body.length, read: async () => { if (delivered) return null; delivered = true; return body; }, cancel() {} };
        },
      },
    }),
  });
});
afterAll(async () => {
  vi.restoreAllMocks();
  await lease?.release();
  await pluginReloadController.shutdown({ timeoutMs: 5_000 });
  if (directory) await rm(directory, { recursive: true, force: true });
});

describe('qualified first-party spawn credential authority', () => {
  it.each([
    { provider: 'anthropic' as const, service: { pluginId: 'happier.agent.claude', localId: 'claude-subscription' }, purpose: 'anthropic-model-request' },
    { provider: 'openai' as const, service, purpose: 'openai-codex-model-request' },
  ])('prepares OpenCode $provider OAuth startup from qualified authority without pre-seeded native auth', async ({ provider, service: selectedService, purpose }) => {
    const sessionId = `opencode-${provider}`;
    const expiresAt = Date.now() + 3_600_000;
    const account = { service: selectedService, accountId: sessionId };
    const content = sealQualifiedConnectedAccountContentEnvelope({
      kind: 'credential', accountMode: 'e2ee', material: credentials.encryption,
      payload: { v: 1, values: { accessToken: 'fixture-access', refreshToken: 'fixture-refresh', idToken: 'fixture-id', providerAccountId: 'fixture-account', expiresAtMs: String(Date.now() + 3_600_000) } },
      randomBytes: (length) => new Uint8Array(length).fill(3),
    });
    let snapshot = QualifiedConnectedAccountCredentialSnapshotV4Schema.parse({ ref: account, authenticationModeId: 'oauth', revisionSemantics: 'revisioned', credentialRevision: revision, configurationRevision: null, content, metadata: { scopes: [] } });
    const purposeOwner = createDaemonConnectedAccountPurposeBindingRuntime({
      establishedRuntimeOwner: established, reloadController: pluginReloadController,
      resolveQualifiedConnectedAccountV4Support: () => 'advertised',
      store: { read: async () => ({ v: 1, bindings: [] }), update: async mutate => mutate({ v: 1, bindings: [] }), subscribe: () => ({ dispose() {} }) },
      qualifiedApi: {
        listAccounts: (service, signal) => listQualifiedConnectedAccountsV4({ token: credentials.token, service, signal }),
        listGroups: async () => { throw new Error('Unexpected group inventory'); },
        readGroup: async () => { throw new Error('Unexpected group read'); },
      },
    });
    let holdCredentialRead: (() => Promise<void>) | undefined;
    let refuseInventory = false;
    // Credential HTTP is the system boundary. Envelope opening, current plugin
    // invocation, binding ownership, public plugin assets and native launch remain real.
    const http = vi.spyOn(axios, 'get').mockImplementation(async (url) => {
      const path = new URL(String(url)).pathname;
      if (path === '/v4/connect/qualified/credential') {
        await holdCredentialRead?.();
        return { status: 200, data: snapshot };
      }
      if (path === '/v4/connect/qualified/accounts') {
        if (refuseInventory) throw new axios.AxiosError('Private transport detail must never be logged', 'ERR_BAD_RESPONSE', undefined, undefined,
          { status: 403, statusText: 'Forbidden', headers: {}, config: { headers: new axios.AxiosHeaders() }, data: {} });
        return { status: 200, data: { service: selectedService, accounts: [{
        ref: account, authenticationModeId: 'oauth', status: 'connected', kind: 'oauth', expiresAt,
        revisionSemantics: 'revisioned', credentialRevision: snapshot.credentialRevision, configurationReady: true, configurationRevision: null, scopes: [],
      }] } };
      }
      throw new Error(`Unexpected HTTP read: ${path}`);
    });
    const declarations = resolveAgentSpawnPurposeDeclarations({ agentId: 'opencode', contributions: lease.registry.contributes })!;
    const declaration = declarations.snapshot;
    const scope = declaration.authorizedPurposes.find((candidate) => candidate.purpose.purpose === purpose)!;
    const active = purposeOwner.activateSessionPurposeBindings({ sessionId, purposes: declaration.purposes, bindings: [{ purpose: scope.purpose, target: { kind: 'account', account } }] });
    const controller = new AbortController();
    const connectedAccounts = createStablePluginConnectedAccountsHost(purposeOwner.owner).bind({
      plugin: { id: 'happier.agent.opencode', version: '1.0.0' },
      contribution: { id: 'opencode', qualifiedId: 'happier.agent.opencode/agents/opencode' },
      occurrenceId: sessionId, correlationId: sessionId, surface: 'agent', session: { id: sessionId },
      signal: controller.signal, isOccurrenceCurrent: () => !controller.signal.aborted,
    }, declaration.authorizedPurposes.map((authorized) => ({
      purpose: authorized.purpose.purpose, serviceRefs: authorized.serviceRefs, operations: ['use'],
      materializationKinds: declarations.declarations.find((candidate) => candidate.purpose === authorized.purpose.purpose)?.materializationKinds,
    })));
    const preparedAuth = await prepareDaemonConnectedServices({
      options: { directory, backendTarget: { kind: 'backend', backendId: 'opencode', sourceKind: 'built_in' },
        agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.opencode', localId: 'opencode' } },
        connectedServices: { v: 2, bindingsByServiceId: {
        [`${selectedService.pluginId}/${selectedService.localId}`]: { source: 'connected', selection: 'profile', profileId: account.accountId },
      } } },
      normalizedExistingSessionId: '', requestedSessionId: sessionId, effectiveResume: '', catalogAgentId: 'opencode',
      credentials, api: { getAccountEncryptionMode: async () => 'e2ee' } as ApiClient,
      qualifiedConnectedAccountApi: { readGroup: async () => null, listAccounts: async () => QualifiedConnectedAccountListResponseV4Schema.parse({ service: selectedService, accounts: [{ ref: account,
        authenticationModeId: 'oauth', status: 'connected', kind: 'oauth', expiresAt: Date.now() + 3_600_000,
        revisionSemantics: 'revisioned', credentialRevision: revision, configurationReady: true,
        configurationRevision: null, scopes: [] }] }) },
      connectedServiceRefreshCoordinator: null, processEnv: {},
      activeServerDir: directory, connectedServicesMaterializationBaseDir: join(directory, 'materialized'),
      pluginRuntimeRegistry: lease.registry,
      connectedAccountsOwner: purposeOwner.owner, activatePurposeBindings: purposeOwner.activatePurposeBindings,
    });
    expect(preparedAuth.ok).toBe(true);
    if (!preparedAuth.ok) throw new Error(preparedAuth.result.errorMessage);
    const hostMaterialization = preparedAuth.auth;
    if (!hostMaterialization) throw new Error('Expected host request-auth materialization');
    const capabilityPath = hostMaterialization.env[CONNECTED_ACCOUNT_REQUEST_AUTH_CAPABILITY_PATH_ENV];
    expect(capabilityPath).toBeTruthy();
    // Only the native executable is replaced. Real Agent resolution, activated
    // auth inventory parsing and daemon child preparation must all run.
    const cli = writeExecutableShimSync({ dir: directory,
      fileName: process.platform === 'win32' ? 'opencode.cmd' : 'opencode',
      contents: process.platform === 'win32'
        ? '@echo off\r\nif "%1"=="--version" (echo 1.19.0 & exit /b 0)\r\necho 0 credentials\r\nexit /b 0\r\n'
        : '#!/bin/sh\nif [ "$1" = "--version" ]; then echo 1.19.0; exit 0; fi\necho "0 credentials"\n',
    });
    const launchResourceScope = createProviderLaunchResourceScope();
    const redactionLease = createProviderRedactionLease({ values: [] });
    const prepareChild = (auth: typeof preparedAuth.auth) => prepareDaemonSpawnChildEnvironment({
      options: { ...preparedAuth.options, ...(auth ? {} : { connectedServices: undefined }) },
      resolvedAgentId: 'opencode', pluginRuntimeRegistry: lease.registry,
      effectiveModelSelection: undefined, terminal: undefined, profileEnvironmentVariables: {}, daemonSpawnHooks: null,
      processEnv: { PATH: '', HOME: directory, USERPROFILE: directory, HAPPIER_OPENCODE_PATH: cli,
        HAPPIER_JS_RUNTIME_PATH: process.execPath }, connectedServiceAuth: auth,
      connectedServiceMaterializationIdentity: preparedAuth.materializationIdentity,
      providerBindingAttempt: null, providerAgentTargetKey: null,
      providerDiagnosticRedactionLease: redactionLease, launchResourceScope,
    });
    let prepared: PreparedOpenCodeQualifiedConnectedAccounts<AgentSessionOpenRequest> | undefined;
    try {
      // An ambient capability or merely materialized environment cannot replace
      // the qualified request-auth binding (including when wiring drops it).
      const unboundSnapshot = resolveQualifiedPurposeBindingSnapshotForAgentSpawn({
        agentId: 'opencode', bindings: { v: 2, bindingsByServiceId: {} },
        contributions: lease.registry.contributes,
        catalogEntry: await lease.registry.acquireAgentCatalogEntry?.('opencode'),
      });
      for (const auth of [null,
        { ...hostMaterialization, qualifiedPurposeBindingSnapshot: null },
        { ...hostMaterialization, qualifiedPurposeBindingSnapshot: unboundSnapshot },
      ]) {
        const unboundChild = await prepareChild(auth);
        expect(unboundChild, unboundChild.ok ? 'Unexpected admitted native launch' : unboundChild.result.errorMessage).toMatchObject({ ok: false,
          result: { errorCode: 'agent_signed_out', agentId: 'opencode' } });
      }
      const child = await prepareChild(hostMaterialization);
      expect(child, child.ok ? 'Admitted bound launch' : child.result.errorCode).toMatchObject({ ok: true });
      if (!child.ok) throw new Error(child.result.errorCode);
      const scoped = resolveExplicitSpawnScopedEnvironmentFromProcessEnv(child.extraEnvForChild);
      const request: AgentSessionOpenRequest = {
        kind: 'create', sessionId, cwd: directory,
        // The daemon marks host materialization as explicit child environment;
        // runner dispatch forwards exactly that scope to the shared launch owner.
        launchEnvironment: resolveNativeAgentLaunchEnvironment({ processEnv: child.extraEnvForChild, environmentVariables: scoped?.env }),
      };
      // The preparation leaf needs only this real scoped service; unrelated host services are unavailable.
      const context = { signal: controller.signal, services: { connectedAccounts } } as unknown as AgentRuntimeContext;
      // Prove the exact selected credential is available through the real established plugin owner.
      expect(await established.readCredentialRevision({ account })).toBe(revision);
      prepared = await prepareOpenCodeQualifiedConnectedAccounts(request, context);
      // A reconnect invalidates the Account projection, not necessarily this
      // purpose's credential. The real host watch must preserve this launch.
      for (const invalidate of purposeInvalidations) invalidate();
      purposeOwner.invalidate();
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(prepared.isInvalidated()).toBe(false);
      const requestAuth = await connectedAccounts.materialize(purpose, {
        kind: 'httpHeaders',
        origin: provider === 'anthropic' ? 'https://api.anthropic.com' : 'https://chatgpt.com',
        headerNames: provider === 'anthropic' ? ['authorization'] : ['authorization', 'chatgpt-account-id'],
      }, { expectedAccount: account });
      expect(requestAuth.kind).toBe('httpHeaders');
      if (requestAuth.kind !== 'httpHeaders') throw new Error('Expected request-scoped credential headers');
      expect(new Headers(requestAuth.headers).get('authorization')).toBe('Bearer fixture-access');
      const spec = buildOpenCodeManagedServerSpawnSpec({ id: sessionId, dialect: 'v1', systemToolId: 'opencode-cli', env: prepared.request.launchEnvironment?.values });
      if (spec.mode.kind !== 'spawn') throw new Error('Expected native OpenCode process');
      const env = spec.mode.launch.env!;
      expect(JSON.parse(env.OPENCODE_AUTH_CONTENT!)).toEqual({ [provider]: { type: 'api', key: buildOpenCodeRequestAuthMarker(provider) } });
      expect(env.HAPPIER_CONNECTED_ACCOUNT_REQUEST_AUTH_CAPABILITY_PATH).toBe(capabilityPath);
      expect(env.OPENAI_API_KEY).toBe('');
      expect(env.ANTHROPIC_API_KEY).toBe('');
      expect(JSON.stringify(env)).not.toContain('fixture-access');
      expect(JSON.stringify(env)).not.toContain('fixture-refresh');
      const configHome = env.XDG_CONFIG_HOME!;
      const pluginPath = resolveOpenCodeRequestAuthPluginPath(configHome, provider);
      await access(pluginPath);
      expect(JSON.parse(env.OPENCODE_CONFIG_CONTENT!).plugins).toContain(resolveOpenCodeRequestAuthV2PluginDir(configHome, provider));
      const pluginSource = await readFile(pluginPath, 'utf8');
      expect(pluginSource).not.toContain('fixture-access');
      expect(pluginSource).not.toContain('fixture-refresh');
      // Consume the actual host-issued capability from the generated native
      // leaf. HTTP and the clock are boundaries; selection, authorization,
      // materialization and the SDK transport beneath them remain real.
      const registry = createConnectedAccountRequestAuthSubjectRegistry();
      // Legacy same-Account launches activate their lease before requester
      // custody is recovered. Recovery creates another real purpose owner;
      // it cannot reconstruct the issuer's process-local lease from its id.
      const recoveredPurposes = createDaemonConnectedAccountPurposeBindingRuntime({
        establishedRuntimeOwner: established, reloadController: pluginReloadController,
        resolveQualifiedConnectedAccountV4Support: () => 'advertised',
        store: { read: async () => ({ v: 1, bindings: [] }), update: async mutate => mutate({ v: 1, bindings: [] }), subscribe: () => ({ dispose() {} }) },
        qualifiedApi: { listAccounts: (service, signal) => listQualifiedConnectedAccountsV4({ token: credentials.token, service, signal }),
          listGroups: async () => ({ groups: [] }), readGroup: async () => null },
      });
      let requesterCurrent = true;
      const recoveredContext = { bootstrap: { serverHttpBaseUrl: 'http://localhost:3005' },
        isCurrent: async () => requesterCurrent,
        resolveCurrentRequestAuthBinding: recoveredPurposes.resolveCurrentRequestAuthBinding,
        materializeRequestAuthBearer: recoveredPurposes.materializeRequestAuthBearer };
      const callbacks = createDaemonQualifiedRequestAuthCallbacks({
        withSessionAccountContext: async (_sessionId, operation) => await operation(recoveredContext),
        assertSessionAccountCurrent: async () => { if (!requesterCurrent) throw new Error('requester_session_not_current'); },
      });
      const requestAuthService = createConnectedAccountRequestAuthService({
        ...callbacks,
        refreshAfterAuthFailure: async () => ({ status: 'current_unchanged' }),
        reportQuotaFailure: async () => ({ status: 'current_unchanged' }),
      });
      const app = createDaemonControlApp({
        getChildren: () => [], machineId: 'machine',
        stopSession: async () => ({ status: 'not_found' }),
        spawnSession: async () => ({ type: 'error', errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED, errorMessage: 'unused' }),
        requestShutdown() {}, onHappySessionWebhook() {}, controlToken: 'fixture-control',
        connectedAccountRequestAuth: { authenticate: registry.authenticate, ...requestAuthService },
      });
      const originalFetch = globalThis.fetch;
      const originalCapabilityPath = process.env[CONNECTED_ACCOUNT_REQUEST_AUTH_CAPABILITY_PATH_ENV];
      let releaseRead!: () => void;
      let readStarted!: () => void;
      const held = new Promise<void>(resolve => { releaseRead = resolve; });
      const started = new Promise<void>(resolve => { readStarted = resolve; });
      const requests: Array<{ authorization: string | null; accountId: string | null; model: string }> = [];
      const model = provider === 'openai' ? 'gpt-5.4-mini' : 'claude-haiku-4-5';
      let descriptor: Awaited<ReturnType<typeof registry.activate>> | undefined;
      let restoreTimeout: (() => void) | undefined;
      try {
        await app.listen({ host: '127.0.0.1', port: 0 });
        const address = app.server.address();
        if (!address || typeof address === 'string') throw new Error('Expected request-auth TCP address');
        const subject = scopeConnectedAccountSessionPurposeBindingLease({
          lease: active, subjectId: active.subjectId, parentSessionId: sessionId,
          uses: hostMaterialization.qualifiedPurposeBindingSnapshot?.requestAuthUses ?? [], registerRedaction() {},
        });
        if (!preparedAuth.materializationIdentity) throw new Error('Expected materialization identity');
        descriptor = await registry.activate({ subject,
          materializedRootDir: dirname(dirname(capabilityPath!)),
          materializationId: preparedAuth.materializationIdentity.id, httpPort: address.port });
        expect(descriptor.path).toBe(capabilityPath);
        process.env[CONNECTED_ACCOUNT_REQUEST_AUTH_CAPABILITY_PATH_ENV] = env[CONNECTED_ACCOUNT_REQUEST_AUTH_CAPABILITY_PATH_ENV];
        globalThis.fetch = async (input, init) => {
          if (String(input).startsWith(`http://127.0.0.1:${address.port}/`)) return await originalFetch(input, init);
          const headers = new Headers(init?.headers);
          requests.push({ authorization: headers.get('authorization'), accountId: headers.get('chatgpt-account-id'), model: JSON.parse(String(init?.body)).model });
          return new Response('READY', { status: 200 });
        };
        const nativePlugin = await import(pathToFileURL(pluginPath).href);
        const hooks = await nativePlugin.default();
        const loader = await hooks.auth.loader(async () => JSON.parse(env.OPENCODE_AUTH_CONTENT!)[provider]);
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        // The native AbortSignal clock is a separate OS boundary from Vitest's
        // timer clock, so drive both with the same controlled timer here.
        const timeout = vi.spyOn(AbortSignal, 'timeout').mockImplementation(ms => {
          const clock = new AbortController();
          setTimeout(() => clock.abort(new DOMException('Timed out', 'TimeoutError')), ms);
          return clock.signal;
        });
        restoreTimeout = () => timeout.mockRestore();
        holdCredentialRead = async () => { readStarted(); await held; };
        const pending = loader.fetch(provider === 'openai'
          ? 'https://chatgpt.com/backend-api/responses'
          : 'https://api.anthropic.com/v1/messages', {
            method: 'POST', signal: controller.signal, body: JSON.stringify({ model }),
          }).then((response: Response) => ({ status: response.status }), (error: unknown) => ({ error }));
        expect(await Promise.race([started.then(() => 'reading'), pending])).toBe('reading');
        // This is beyond both former hidden cutoffs, not a new product budget.
        await vi.advanceTimersByTimeAsync(31_000);
        holdCredentialRead = undefined;
        releaseRead();
        expect(await pending).toEqual({ status: 200 });
        expect(requests).toEqual([{ authorization: 'Bearer fixture-access', accountId: provider === 'openai' ? 'fixture-account' : null, model }]);
        timeout.mockRestore();
        vi.useRealTimers();
        const nativeExecutable = process.env.HAPPIER_TEST_OPENCODE_EXECUTABLE;
        if (nativeExecutable) {
          globalThis.fetch = originalFetch;
          await assertOpenCodeManagedPrompt({ executable: nativeExecutable, directory: join(directory, provider),
            configHome, spec, provider, model });
          // The next negative still consumes the generated leaf in this process.
          globalThis.fetch = async (input, init) => {
            if (String(input).startsWith(`http://127.0.0.1:${address.port}/`)) return await originalFetch(input, init);
            throw new Error('A refused capability reached vendor IO');
          };
        }
        const diagnostic = vi.spyOn(logger, 'debug');
        refuseInventory = true;
        await expect(requestAuthService.lookupRequestAuth({ subject, purpose: scope.purpose })).rejects.toMatchObject({
          code: 'request_auth_binding_unavailable', diagnostic: { causeCode: 'binding_http_refused', httpStatus: 403 },
        });
        expect(diagnostic).toHaveBeenCalledWith('[CONNECTED ACCOUNT] Request-auth lookup refused', {
          phase: 'binding_before', errorCode: 'request_auth_binding_unavailable', causeCode: 'binding_http_refused', httpStatus: 403, sessionId,
        });
        expect(JSON.stringify(diagnostic.mock.calls)).not.toContain('Private transport detail');
        refuseInventory = false;
        await expect(active.requestAuth.resolveCurrentBinding({ binding: {
          purpose: scope.purpose, target: { kind: 'account', account: { ...account, accountId: 'another-account' } },
        }, signal: controller.signal })).resolves.toBeNull();
        // Account revocation still fences a cached bearer from the launch owner.
        requesterCurrent = false;
        await expect(requestAuthService.lookupRequestAuth({ subject, purpose: scope.purpose })).rejects.toMatchObject({
          code: 'request_auth_binding_unavailable', diagnostic: { causeCode: 'requester_session_not_current' },
        });
        await expect(loader.fetch(provider === 'openai'
          ? 'https://chatgpt.com/backend-api/responses' : 'https://api.anthropic.com/v1/messages',
        { method: 'POST', body: JSON.stringify({ model }) })).rejects.toMatchObject({ code: 'request_auth_unavailable' });
        requesterCurrent = true;
        // Missing issuer wiring must refuse rather than reselect from a
        // reconstructed requester runtime's same-looking subject id.
        await registry.retire(descriptor);
        descriptor = await registry.activate({ subject: { ...subject, bindingAuthority: undefined },
          materializedRootDir: dirname(dirname(capabilityPath!)),
          materializationId: preparedAuth.materializationIdentity.id, httpPort: address.port });
        await expect(loader.fetch(provider === 'openai'
          ? 'https://chatgpt.com/backend-api/responses' : 'https://api.anthropic.com/v1/messages',
        { method: 'POST', body: JSON.stringify({ model }) })).rejects.toMatchObject({ code: 'request_auth_unavailable' });
        expect(diagnostic).toHaveBeenCalledWith('[CONNECTED ACCOUNT] Request-auth lookup refused', {
          phase: 'binding_before', errorCode: 'request_auth_binding_unavailable', causeCode: 'binding_resolver_unavailable', sessionId,
        });
        // A capability issued for another purpose cannot borrow this binding.
        await registry.retire(descriptor);
        descriptor = await registry.activate({ subject: { ...subject,
          resolvePurposeUse: () => null, listPurposeUses: () => [] },
          materializedRootDir: dirname(dirname(capabilityPath!)),
          materializationId: preparedAuth.materializationIdentity.id, httpPort: address.port });
        await expect(loader.fetch(provider === 'openai'
          ? 'https://chatgpt.com/backend-api/responses' : 'https://api.anthropic.com/v1/messages',
        { method: 'POST', body: JSON.stringify({ model }) })).rejects.toMatchObject({ code: 'request_auth_purpose_forbidden' });
        expect(diagnostic).toHaveBeenCalledWith('[CONNECTED ACCOUNT] Request-auth lookup refused', {
          phase: 'binding_before', errorCode: 'request_auth_purpose_forbidden', sessionId,
        });
        diagnostic.mockRestore();
        expect(requests).toHaveLength(1);
      } finally {
        holdCredentialRead = undefined;
        releaseRead();
        restoreTimeout?.();
        vi.useRealTimers();
        globalThis.fetch = originalFetch;
        if (originalCapabilityPath === undefined) delete process.env[CONNECTED_ACCOUNT_REQUEST_AUTH_CAPABILITY_PATH_ENV];
        else process.env[CONNECTED_ACCOUNT_REQUEST_AUTH_CAPABILITY_PATH_ENV] = originalCapabilityPath;
        if (descriptor) await registry.retire(descriptor);
        await app.close();
      }
      // The same Account with a different credential is a real invalidation;
      // suppressing all projection wakes would incorrectly keep it usable.
      snapshot = QualifiedConnectedAccountCredentialSnapshotV4Schema.parse({ ...snapshot, credentialRevision: 'csr_aaaaaaaaaaaaaaaaaaaaaa' });
      for (const invalidate of purposeInvalidations) invalidate();
      purposeOwner.invalidate();
      await vi.waitFor(() => expect(prepared?.isInvalidated()).toBe(true));
      await prepared.dispose();
      await expect(access(configHome)).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(prepareOpenCodeQualifiedConnectedAccounts({
        ...request,
        launchEnvironment: resolveNativeAgentLaunchEnvironment({
          processEnv: hostMaterialization.env,
          environmentVariables: Object.fromEntries(Object.entries(scoped?.env ?? {})
            .filter(([key]) => key !== CONNECTED_ACCOUNT_REQUEST_AUTH_CAPABILITY_PATH_ENV)),
        }),
      }, context)).rejects.toThrow(/requires the host child capability/u);
    } finally {
      await prepared?.dispose();
      await launchResourceScope.release();
      redactionLease.close();
      await hostMaterialization.cleanupOnExit?.();
      await hostMaterialization.materializationPurposeLease?.dispose();
      controller.abort();
      active.dispose();
      http.mockRestore();
    }
  });
  it('does not write scalar health when materialization has no qualified snapshot basis', async () => {
    const scalarWrite = vi.fn(async () => undefined);
    // Retained caller shape must not regain scalar mutation authority.
    const input = {
      api: { updateConnectedServiceCredentialHealth: scalarWrite },
      binding: { serviceId: 'openai-codex', profileId: 'unproven' }, now: 10,
      diagnostic: { code: 'disk_failure', providerId: 'codex', serviceId: 'happier.agent.codex/openai-codex', severity: 'blocking' as const, reason: 'disk_failure' },
    } as const;
    await persistConnectedServiceCredentialHealthForMaterializationFailure(input);
    expect(scalarWrite).not.toHaveBeenCalled();
  });
  it.each([false, true])('persists qualified materialization failure health with payload-free attribution (known health=%s)', async knownHealth => {
    const account = { service, accountId: 'device-health' };
    let patch: unknown;
    const diagnostic = vi.spyOn(logger, 'debug');
    const http = vi.spyOn(axios, 'patch').mockImplementation(async (url, body) => {
      expect(new URL(String(url)).pathname).toBe('/v4/connect/qualified/credential/health');
      patch = body;
      return { status: 200, data: { success: true, credentialRevision: revision, configurationRevision: null } };
    });
    await persistConnectedServiceCredentialHealthForMaterializationFailure({
      binding: { serviceId: 'openai-codex', profileId: account.accountId },
      qualifiedCredential: { token: credentials.token, ref: account, expectedCredentialRevision: revision, expectedConfigurationRevision: null,
        ...(knownHealth ? { previousHealth: { v: 1 as const, status: 'refresh_failed_retryable' as const,
          reconnectRequired: false, lastRefreshAttemptAt: 1, lastRefreshFailureAt: 1,
          lastRefreshFailureKind: 'unknown' as const, providerErrorCode: 'disk_failure' } }
          : { previousStatus: 'connected' as const }) },
      diagnostic: { code: 'disk_failure', providerId: 'codex', serviceId: 'happier.agent.codex/openai-codex', severity: 'blocking', reason: 'disk_failure' },
      now: 10,
    });
    expect(patch).toMatchObject({ ref: account, expectedCredentialRevision: revision, health: { status: 'refresh_failed_retryable', reconnectRequired: false } });
    expect(diagnostic.mock.calls.filter(([event]) => event === '[ConnectedServiceRefreshCoordinator] credential health write'))
      .toEqual([['[ConnectedServiceRefreshCoordinator] credential health write', {
        path: 'materialization-failure', serviceKind: service.localId,
        beforeStatus: knownHealth ? 'refresh_failed_retryable' : 'connected',
        afterStatus: 'refresh_failed_retryable', substantiveChanged: knownHealth ? false : null,
      }]]);
    diagnostic.mockRestore();
    http.mockRestore();
  });
  it.each([
    { authenticationModeId: 'device', refresh: false, groupRecovery: false, cachedFeatures: true },
    { authenticationModeId: 'device', refresh: false, groupRecovery: false, cachedFeatures: false },
    { authenticationModeId: 'oauth', refresh: false, groupRecovery: false, cachedFeatures: true },
    { authenticationModeId: 'device', refresh: true, groupRecovery: false, cachedFeatures: true },
    { authenticationModeId: 'device', refresh: true, groupRecovery: true, cachedFeatures: true },
  ])('materializes V4 $authenticationModeId with refresh=$refresh groupRecovery=$groupRecovery cachedFeatures=$cachedFeatures without a legacy credential read', async ({ authenticationModeId, refresh, groupRecovery, cachedFeatures }) => {
    providerRejectsRefresh = groupRecovery;
    const account = { service, accountId: `${authenticationModeId}-${refresh}-${groupRecovery}-${cachedFeatures}` };
    const backup = { service, accountId: `${account.accountId}-backup` };
    groupActiveAccount = groupRecovery ? account : null;
    const content = sealQualifiedConnectedAccountContentEnvelope({
      kind: 'credential', accountMode: 'e2ee', material: credentials.encryption,
      payload: { v: 1, values: { accessToken: 'fixture-access', refreshToken: 'fixture-refresh', idToken: 'fixture-id', providerAccountId: 'fixture-account', expiresAtMs: String(Date.now() + 3_600_000) } },
      randomBytes: (length) => new Uint8Array(length).fill(3),
    });
    let currentRevision = revision;
    let expiresAt = Date.now() + (refresh ? 120_000 : 3_600_000);
    let snapshot = QualifiedConnectedAccountCredentialSnapshotV4Schema.parse({ ref: account, authenticationModeId, revisionSemantics: 'revisioned', credentialRevision: revision, configurationRevision: null, content, metadata: { scopes: [] } });
    let primaryNeedsReauth = false;
    let activeAccountId = account.accountId;
    let group = QualifiedConnectedAccountGroupV4Schema.parse({
      v: 1, ref: { service, groupId: 'recovery' }, incarnation: 'recovery-1', displayName: 'Recovery',
      policy: { v: 1, autoSwitch: true }, activeConnectedAccountId: activeAccountId,
      generation: 1, runtimeStateRevision: 0, state: {}, createdAt: 1, updatedAt: 1,
      members: [account, backup].map((ref, index) => ({ v: 1, connectedAccountId: ref.accountId, priority: index + 1, enabled: true, state: {}, createdAt: 1, updatedAt: 1 })),
    });
    const listAccounts = async () => QualifiedConnectedAccountListResponseV4Schema.parse({ service, accounts: [
      { ref: account, authenticationModeId, status: primaryNeedsReauth ? 'needs_reauth' : 'connected', kind: 'oauth', expiresAt, revisionSemantics: 'revisioned', credentialRevision: currentRevision, configurationReady: true, configurationRevision: null, scopes: [] },
      ...(groupRecovery ? [{ ref: backup, authenticationModeId, status: 'connected', kind: 'oauth', expiresAt: Date.now() + 3_600_000, revisionSemantics: 'revisioned', credentialRevision: revision, configurationReady: true, configurationRevision: null, scopes: [] }] : []),
    ] });
    const loadState = async () => ({
      ...buildQualifiedConnectedAccountAuthGroupSwitchState({ group, profiles: (await listAccounts()).accounts }),
      serviceId: 'happier.agent.codex/openai-codex',
    });
    const switchCoordinator = new ConnectedServiceAuthGroupSwitchCoordinator({
      leases: new InMemoryConnectedServiceAuthGroupSwitchLeaseRegistry<string>(),
      nowMs: Date.now, quotaFreshnessMs: 60_000, loadState,
      // This is the persistent group CAS boundary, not a mocked selector.
      commitSwitch: async (input) => {
        expect(input.expectedGeneration).toBe(group.generation);
        activeAccountId = input.toProfileId;
        groupActiveAccount = activeAccountId === backup.accountId ? backup : account;
        group = { ...group, activeConnectedAccountId: activeAccountId, generation: group.generation + 1 };
        return loadState();
      },
      applyGeneration: async () => ({ ok: true }),
    });
    // HTTP is the genuine system boundary. Persistence, envelope opening, plugin
    // invocation, purpose authority, and launch-file materialization remain real.
    const http = vi.spyOn(axios, 'get').mockImplementation(async (url) => {
      const path = new URL(String(url)).pathname;
      if (path === '/v4/connect/qualified/credential') return { status: 200, data: activeAccountId === backup.accountId ? { ...snapshot, ref: backup } : snapshot };
      throw new Error(`Unexpected HTTP read: ${path}`);
    });
    const healthPatches: unknown[] = [];
    const healthWrites = vi.spyOn(axios, 'patch').mockImplementation(async (url, body) => {
      expect(new URL(String(url)).pathname).toBe('/v4/connect/qualified/credential/health');
      healthPatches.push(body);
      // The boundary persists the settled health: only a reconnect-required patch makes the profile need re-auth.
      primaryNeedsReauth = (body as { health?: { status?: string } }).health?.status === 'needs_reauth';
      return { status: 200, data: { success: true, credentialRevision: currentRevision, configurationRevision: null } };
    });
    const writes = vi.spyOn(axios, 'post').mockImplementation(async (url, body) => {
      const path = new URL(String(url)).pathname;
      if (path === '/v4/connect/qualified/credential/refresh-lease') {
        const request = QualifiedConnectedAccountRefreshLeaseV4Schema.parse(body);
        expect(request.expectedCredentialRevision).toBe(currentRevision);
        return { status: 200, data: { acquired: true, leaseUntil: Date.now() + request.ttlMs, ownerId: request.ownerId, credentialRevision: currentRevision } };
      }
      if (path === '/v4/connect/qualified/credential') {
        const mutation = QualifiedConnectedAccountCredentialMutationV4Schema.parse(body);
        expect(mutation.ref).toEqual(account);
        expect(mutation.authenticationModeId).toBe(authenticationModeId);
        expect(mutation.expectedCredentialRevision).toBe(currentRevision);
        currentRevision = currentRevision === revision ? 'csr_aaaaaaaaaaaaaaaaaaaaaa' : 'csr_bbbbbbbbbbbbbbbbbbbbbb';
        expiresAt = Date.now() + 3_600_000;
        snapshot = QualifiedConnectedAccountCredentialSnapshotV4Schema.parse({ ...snapshot, content: mutation.content, metadata: mutation.metadata, credentialRevision: currentRevision });
        return { status: 200, data: { success: true, credentialRevision: currentRevision, configurationRevision: null } };
      }
      throw new Error(`Unexpected HTTP write: ${path}`);
    });
    const forbiddenLegacyRead = vi.fn(async () => { throw new Error('V2 unsupported credential format'); });
    const refreshCoordinator = new ConnectedServiceRefreshCoordinator({
      credentials, api: { getAccountEncryptionMode: async () => 'e2ee' } as ApiClient, machineIdProvider: () => 'test-machine',
      activeServerDir: directory, baseDir: directory, refreshWindowMs: 300_000,
      refreshLeaseMs: 60_000, now: Date.now,
      resolveQualifiedPurposeBindingSnapshot: async ({ agentId, connectedServicesBindingsRaw }) => resolveQualifiedPurposeBindingSnapshotForAgentSpawn({
        agentId, bindings: ConnectedServiceBindingsV2IngressSchema.parse(connectedServicesBindingsRaw), contributions: lease.registry.contributes,
      }),
      qualifiedConnectedAccountRuntime: {
        resolvePeerClass: () => 'advertised_v4', establishedRuntimeOwner: established,
        readCredential: readQualifiedConnectedAccountCredentialV4,
        acquireRefreshLease: acquireQualifiedConnectedAccountRefreshLeaseV4,
        mutateCredential: mutateQualifiedConnectedAccountCredentialV4,
        mutateCredentialHealth: mutateQualifiedConnectedAccountCredentialHealthV4,
      },
    });
    const result = await resolveConnectedServiceAuthForSpawn({
      agentId: 'codex', connectedServicesBindingsRaw: { v: 2, bindingsByServiceId: { 'happier.agent.codex/openai-codex': groupRecovery
        ? { source: 'connected', selection: 'group', groupId: group.ref.groupId, profileId: account.accountId }
        : { source: 'connected', selection: 'profile', profileId: account.accountId } } },
      materializationKey: account.accountId, activeServerDir: directory, baseDir: directory,
      processEnv: { HOME: directory }, credentials,
      api: { getServerFeaturesSnapshot: async () => cachedFeatures ? ({ status: 'ready', features: FeaturesResponseSchema.parse({ features: { connectedServices: { enabled: true } }, capabilities: { connectedServices: { qualifiedAccounts: { protocolVersion: 4 } } } }) }) : undefined, getConnectedServiceCredentialSealed: forbiddenLegacyRead, getConnectedServiceCredentialPlain: forbiddenLegacyRead, getAccountEncryptionMode: async () => 'e2ee' } as unknown as ApiClient,
      qualifiedConnectedAccountApi: { listAccounts, readGroup: async () => groupRecovery ? group : null },
      ...(groupRecovery ? { authGroupSwitchCoordinator: switchCoordinator } : {}),
      resolveQualifiedPurposeBindingSnapshot: (bindings) => resolveQualifiedPurposeBindingSnapshotForAgentSpawn({ agentId: 'codex', bindings, contributions: lease.registry.contributes }),
      activateQualifiedPurposeBindings: (snapshot) => purposeOwner.activateSessionPurposeBindings({ sessionId: `qualified-${account.accountId}`, purposes: snapshot.purposes, bindings: snapshot.bindings }),
      credentialRefreshService: refreshCoordinator,
    });
    expect(result).not.toBeNull();
    expect(result!.targetMaterializedRoot).toBe(result!.env.CODEX_HOME);
    const auth = JSON.parse(await readFile(join(result!.targetMaterializedRoot!, 'auth.json'), 'utf8'));
    expect(auth.tokens.access_token).toBe(refresh && !groupRecovery ? 'refreshed-access' : 'fixture-access');
    const selections = JSON.parse(result!.env.HAPPIER_CONNECTED_SERVICE_SELECTIONS_JSON!);
    expect(selections[0].credentialRevision).toBe(currentRevision);
    if (refresh && !groupRecovery) {
      const bridge = refreshCoordinator.refreshOpenAiCodexChatGptTokensForBridge({
        refreshAttemptId: `health-${account.accountId}`, selection: { kind: 'profile', serviceId: 'openai-codex', profileId: account.accountId },
        expectedCredentialRevision: currentRevision, chatgptPlanType: null, forceRefresh: true,
      });
      await bridge;
      expect(healthPatches).toContainEqual(expect.objectContaining({
        ref: account, expectedCredentialRevision: currentRevision,
        expectedConfigurationRevision: null,
        health: expect.objectContaining({ status: 'connected', reconnectRequired: false }),
      }));
    }
    if (groupRecovery) {
      expect(selections[0].activeProfileId).toBe(backup.accountId);
      expect(group.generation).toBe(2);
    }
    expect(forbiddenLegacyRead).not.toHaveBeenCalled();
    await result?.cleanupOnExit?.();
    http.mockRestore();
    writes.mockRestore();
    healthWrites.mockRestore();
    vi.restoreAllMocks();
    providerRejectsRefresh = false;
    groupActiveAccount = null;
  });

  it('materializes retained released 0.2 credential data through the qualified reader', async () => {
    const record = buildConnectedServiceCredentialRecord({ now: 10, serviceId: 'openai-codex', profileId: 'legacy', kind: 'oauth', expiresAt: null, oauth: { accessToken: 'legacy-access', refreshToken: 'legacy-refresh', idToken: 'legacy-id', scope: null, tokenType: null, providerAccountId: 'legacy-account', providerEmail: null } });
    const ciphertext = sealAccountScopedBlobCiphertext({ kind: 'connected_service_credential', material: credentials.encryption, payload: record, randomBytes: (length) => new Uint8Array(length).fill(4) });
    const legacyRead = vi.fn(async () => { throw new Error('Unexpected legacy credential projection'); });
    const account = { service, accountId: 'legacy' };
    const http = vi.spyOn(axios, 'get').mockImplementation(async (url) => {
      expect(new URL(String(url)).pathname).toBe('/v4/connect/qualified/credential');
      return { status: 200, data: QualifiedConnectedAccountCredentialSnapshotV4Schema.parse({
        ref: account, authenticationModeId: 'oauth', revisionSemantics: 'revisioned',
        credentialRevision: revision, configurationRevision: null,
        content: { t: 'encrypted', c: ciphertext }, metadata: { scopes: [] },
      }) };
    });
    const accounts = QualifiedConnectedAccountListResponseV4Schema.parse({ service, accounts: [{
      ref: account, authenticationModeId: 'oauth', status: 'connected',
      revisionSemantics: 'revisioned', credentialRevision: revision,
      configurationReady: true, configurationRevision: null, scopes: [],
    }] });
    const result = await resolveConnectedServiceAuthForSpawn({
      agentId: 'codex', connectedServicesBindingsRaw: { v: 1, bindingsByServiceId: { 'openai-codex': { source: 'connected', profileId: 'legacy' } } },
      materializationKey: 'legacy', activeServerDir: directory, baseDir: directory, processEnv: { HOME: directory }, credentials,
      api: { getAccountEncryptionMode: async () => 'e2ee', getConnectedServiceCredentialSealed: legacyRead } as unknown as ApiClient,
      qualifiedConnectedAccountApi: { listAccounts: async () => accounts, readGroup: async () => null },
      resolveQualifiedPurposeBindingSnapshot: (bindings) => resolveQualifiedPurposeBindingSnapshotForAgentSpawn({ agentId: 'codex', bindings, contributions: lease.registry.contributes }),
      activateQualifiedPurposeBindings: (snapshot) => purposeOwner.activateSessionPurposeBindings({ sessionId: 'retained-legacy', purposes: snapshot.purposes, bindings: snapshot.bindings }),
    });
    expect(result).not.toBeNull();
    const auth = JSON.parse(await readFile(join(result!.env.CODEX_HOME!, 'auth.json'), 'utf8'));
    expect(auth.tokens.access_token).toBe('legacy-access');
    expect(legacyRead).not.toHaveBeenCalled();
    await result?.cleanupOnExit?.();
    http.mockRestore();
  });
});
