import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';

import { PluginManifestV2Schema } from '@happier-dev/protocol/plugins/manifest/v2';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { SCM_OPERATION_ERROR_CODES } from '@happier-dev/protocol';
import {
  PluginConnectedAccountDescriptorContributionV2Schema,
  ScmHostingProviderContributionSchema,
  type QualifiedConnectedAccountPurposeBindingsV1,
} from '@happier-dev/protocol';
import type { ExternalActionExecutionAuthorizationV1 } from '@happier-dev/protocol/actions/externalActionApi';
import {
  GITHUB_SCM_HOSTING_PROVIDER_ID,
  PLUGIN_MANIFEST as COLD_GITHUB_MANIFEST,
  githubHostingProviderAdapter,
  githubPullRequestAdapter,
  githubRepositoryProvisioningAdapter,
} from '@happier-dev/plugins-scm-github';

import type { RpcHandler, RpcHandlerContext } from '@/api/rpc/types';
import { createConnectedAccountPurposeBindingOwner } from '@/daemon/connectedServices/purposeBindings/ConnectedAccountPurposeBindingOwner';
import { requesterActionContext } from '@/daemon/sessionEncryption/requesterAccountActionContext';
import { registerScmHandlers } from '@/rpc/handlers/scm';
import { createHostScmHostingProviderRuntimeServices } from '@/scm/hostingProviders/runtimeServices';
import { createRegisteredScmBackendAdapter } from '@/scm/pluginBackends/registeredScmBackendAdapter';
import { createScmBackendRegistry } from '@/scm/registry';
import { startGitSmartHttpFixture } from '@/testkit/scm/gitSmartHttpFixture';
import { logger } from '@/ui/logger';
import { createGitScmBackendRuntimeRegistration } from '../../../../../../packages/plugins/scm-git/src/backend';
import { createGitWorkspace, runGit } from './testRpcHarness';

// Synthetic values only. They are never printed; assertions compare presence.
const GUEST_TOKEN = 'synthetic-guest-hosting-token-1126';
const OTHER_GUEST_TOKEN = 'synthetic-other-guest-hosting-token-1126';
const OWNER_TOKEN = 'synthetic-owner-hosting-token-1126';
const OWNER_NATIVE_TOKEN = 'synthetic-owner-native-token-1126';
const WRONG_HOST_TOKEN = 'synthetic-wrong-host-hosting-token-1126';
const REPOSITORY_URL = 'https://github.com/guest/project.git';
const GITHUB = PluginManifestV2Schema.parse(COLD_GITHUB_MANIFEST);

const basic = (token: string) =>
  `Basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`;

type OwnerCalls = string[];

/** Real purpose-binding owner; only persistence, Account metadata and the credential producer are stand-ins. */
function createAccountOwner(
  input: Readonly<{
    accountId: string;
    token?: string;
    nativeToken?: string;
    /** The deployment the account is connected to; a different host than the remote never serves it. */
    base?: string;
    calls: OwnerCalls;
  }>,
) {
  const service = { pluginId: GITHUB.id, localId: 'github-account' };
  const account = { service, accountId: input.accountId };
  let bindings: QualifiedConnectedAccountPurposeBindingsV1 = {
    v: 1,
    bindings: input.token
      ? [
          {
            purpose: {
              consumer: { pluginId: GITHUB.id, localId: 'github' },
              purpose: 'authentication',
            },
            target: { kind: 'account', account },
          },
        ]
      : [],
  };
  return createConnectedAccountPurposeBindingOwner({
    store: {
      read: async () => bindings,
      update: async (mutate) => {
        bindings = mutate(bindings);
        return bindings;
      },
      subscribe: () => ({ dispose() {} }),
    },
    selectTarget: async () => {
      throw new Error('No Account selection in this flow');
    },
    resolveTarget: async () => ({ displayName: input.accountId, account }),
    assertTargetAccountMaterializable: async () => undefined,
    materializeAccount: async () => {
      input.calls.push(`account:${input.accountId}`);
      return {
        kind: 'httpHeaders',
        headers: { authorization: `Bearer ${input.token}` },
      };
    },
    ...(input.nativeToken
      ? {
          materializeNative: async () => {
            input.calls.push(`native:${input.accountId}`);
            return {
              kind: 'httpHeaders' as const,
              headers: { authorization: `Bearer ${input.nativeToken}` },
            };
          },
        }
      : {}),
    projectTargetAccounts: async () => ({
      status: 'complete',
      accounts: input.token
        ? [
            {
              account,
              displayName: input.accountId,
              state: 'connected',
              connectedAccountOrigins: [input.base ?? 'https://github.com'],
              connectedAccountBases: [input.base ?? 'https://github.com'],
            },
          ]
        : [],
    }),
  });
}

/** Home's admitted requester custody, reduced to the host-local facet this owner reads. */
function requesterAuthorization(
  accountId: string,
): ExternalActionExecutionAuthorizationV1 {
  const projection = {};
  Object.defineProperty(projection, requesterActionContext, {
    value: { accountId, savedSecretOperationContext: {} },
    enumerable: false,
  });
  // Boundary fixture: the signed Home authorization is not reconstructed here.
  return {
    binding: { accountId, custodianAccountId: 'owner' },
    requesterAccountProjection: projection,
  } as unknown as ExternalActionExecutionAuthorizationV1;
}

function admittedContext(
  accountId: string,
  withCustody = true,
): RpcHandlerContext {
  return {
    signal: new AbortController().signal,
    machineAdmission: {
      actorAccountId: accountId,
      custodianAccountId: 'owner',
      machineId: 'machine-1',
      installationId: 'installation-1',
      role: 'use',
      encryptionMode: 'plain',
    },
    ...(withCustody && accountId !== 'owner'
      ? { callerInputAuthorization: requesterAuthorization(accountId) }
      : {}),
  };
}

/** The Machine's owner from another of their devices: the same Account as the custodian, with its own admitted custody. */
function ownerFromAnotherDeviceContext(): RpcHandlerContext {
  const context = admittedContext('owner');
  return {
    ...context,
    machineAdmission: { ...context.machineAdmission!, role: 'manage' },
    callerInputAuthorization: requesterAuthorization('owner'),
  };
}

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'happier-guest-hosting-'));
  const forge = await startGitSmartHttpFixture({
    authorization: basic(GUEST_TOKEN),
    branch: 'main',
  });
  onTestFinished(async () => {
    await forge.close();
    await rm(root, { recursive: true, force: true });
  });

  // The Machine owner's native Git login: a credential helper in the daemon user's global Git config.
  const helperMarker = join(root, 'owner-helper-invoked');
  const globalConfig = join(root, 'owner.gitconfig');
  await writeFile(
    globalConfig,
    `[credential]\n\thelper = "!f() { echo invoked > '${helperMarker}'; echo username=x-access-token; echo password=${OWNER_NATIVE_TOKEN}; }; f"\n`,
  );
  vi.stubEnv('GIT_CONFIG_GLOBAL', globalConfig);
  // A direct HTTPS attempt must fail fast here rather than leave this host.
  vi.stubEnv('https_proxy', 'http://127.0.0.1:9');
  vi.stubEnv('HTTPS_PROXY', 'http://127.0.0.1:9');

  // Stand-in at the hosting provider's HTTP boundary: Git smart HTTP for the repository, REST for pull requests.
  const providerRequests: {
    kind: 'git' | 'api';
    authorization: string | null;
  }[] = [];
  const realFetch = globalThis.fetch;
  vi.stubGlobal(
    'fetch',
    async (resource: string | URL | Request, init?: RequestInit) => {
      const url = String(resource instanceof Request ? resource.url : resource);
      const headers = new Headers(
        init?.headers ??
          (resource instanceof Request ? resource.headers : undefined),
      );
      if (url.startsWith(`${REPOSITORY_URL}/`)) {
        providerRequests.push({
          kind: 'git',
          authorization: headers.get('authorization'),
        });
        return await realFetch(
          `${forge.url}/${url.slice(REPOSITORY_URL.length + 1)}`,
          init,
        );
      }
      if (url.startsWith('https://api.github.com/repos/guest/project/pulls')) {
        providerRequests.push({
          kind: 'api',
          authorization: headers.get('authorization'),
        });
        return new Response('[]', {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return await realFetch(resource, init);
    },
  );

  // Every line handed to the CLI logger during the run (pass-through spies at the log boundary).
  const logged = (['debug', 'debugLargeJson', 'info', 'infoFile', 'infoDeveloper', 'warn', 'error', 'debugLocalFile'] as const)
    .map((method) => vi.spyOn(logger, method));
  const loggedText = () => logged.flatMap((spy) => spy.mock.calls.map((args) =>
    args.map((arg) => (typeof arg === 'string' ? arg : JSON.stringify(arg) ?? String(arg))).join(' '))).join('\n');

  const calls: OwnerCalls = [];
  const owner = createAccountOwner({
    accountId: 'owner',
    token: OWNER_TOKEN,
    nativeToken: OWNER_NATIVE_TOKEN,
    calls,
  });
  const guest = createAccountOwner({
    accountId: 'guest',
    token: GUEST_TOKEN,
    calls,
  });
  const otherGuest = createAccountOwner({
    accountId: 'other-guest',
    token: OTHER_GUEST_TOKEN,
    calls,
  });
  const unconnectedGuest = createAccountOwner({
    accountId: 'unconnected',
    calls,
  });
  const wrongHostGuest = createAccountOwner({
    accountId: 'wrong-host',
    token: WRONG_HOST_TOKEN,
    base: 'https://github.example.com',
    calls,
  });
  const requesterOwners = new Map([
    ['guest', guest],
    ['other-guest', otherGuest],
    ['unconnected', unconnectedGuest],
    ['wrong-host', wrongHostGuest],
  ]);
  const prepared: string[] = [];
  const disposed: string[] = [];

  const services = createHostScmHostingProviderRuntimeServices({
    contributes: {
      scmHostingProviders: [
        {
          id: 'github',
          provenance: 'external',
          source: { kind: 'path' },
          pluginId: GITHUB.id,
          definition: ScmHostingProviderContributionSchema.parse(
            GITHUB.contributes.scmHostingProviders![0],
          ),
        },
      ],
      connectedAccountDescriptors: [
        {
          provenance: 'external',
          source: { kind: 'path' },
          pluginId: GITHUB.id,
          definition:
            PluginConnectedAccountDescriptorContributionV2Schema.parse(
              GITHUB.contributes.connectedAccountDescriptors![0],
            ),
        },
      ],
    },
    scmHostingProvidersById: new Map([
      [
        GITHUB_SCM_HOSTING_PROVIDER_ID,
        {
          pluginId: GITHUB.id,
          occurrenceId: 'guest-hosting-fixture',
          registration: {
            id: 'github',
            adapter: {
              routing: githubHostingProviderAdapter,
              pullRequests: githubPullRequestAdapter,
              repositoryClone: githubRepositoryProvisioningAdapter,
            },
          },
        },
      ],
    ]),
    resolveConnectedAccountPurposeBindingOwner: () => owner,
  });
  const registration = createGitScmBackendRuntimeRegistration();
  const runtime = registration.runtime!;
  const registry = createScmBackendRegistry([
    createRegisteredScmBackendAdapter({
      definition: { id: registration.id, kind: 'git' },
      qualifiedId: `happier.scm.backend.git:${registration.id}`,
      executableDefinition: {
        repoModes: runtime.repoModes,
        capabilities: runtime.capabilities,
        commands: runtime.commands,
      },
      registration,
      hostingProviderRuntimeServices: services,
    }),
  ]);

  const workspace = createGitWorkspace('happier-guest-hosting-workspace-');
  await writeFile(join(workspace, 'guest.txt'), 'guest work\n');
  runGit(workspace, ['add', 'guest.txt']);
  runGit(workspace, ['commit', '-m', 'guest work']);
  runGit(workspace, ['remote', 'add', 'origin', REPOSITORY_URL]);
  // The local branches each case pushes.
  for (const branch of ['guest-work', 'other-work', 'owner-work', 'guest-local']) runGit(workspace, ['branch', branch]);

  const handlers = new Map<string, RpcHandler>();
  registerScmHandlers(
    {
      registerHandler: (method, handler) => {
        handlers.set(method, handler as RpcHandler);
      },
    },
    workspace,
    {
      registry,
      accessPolicy: { kind: 'restrictedRoots', roots: [workspace] },
      prepareRequesterCredentials: async (account: unknown) => {
        const accountId = String(Reflect.get(account as object, 'accountId'));
        prepared.push(accountId);
        const connectedAccounts = requesterOwners.get(accountId);
        if (!connectedAccounts) throw new Error('unknown requester');
        return {
          connectedAccounts,
          dispose: async () => {
            disposed.push(accountId);
          },
        };
      },
    } as Parameters<typeof registerScmHandlers>[2],
  );
  const call = async (
    method: string,
    request: unknown,
    context: RpcHandlerContext,
  ) => {
    const handler = handlers.get(method);
    if (!handler) throw new Error(`No handler for ${method}`);
    return (await handler(request, context)) as Record<string, unknown>;
  };
  const helperInvoked = async () =>
    await access(helperMarker).then(
      () => true,
      () => false,
    );
  const capturedText = async (result: unknown) =>
    [
      JSON.stringify(result),
      await readFile(join(workspace, '.git', 'config'), 'utf8'),
      runGit(workspace, ['remote', 'get-url', '--all', 'origin']),
      await readFile(join(workspace, '.git', 'FETCH_HEAD'), 'utf8').catch(() => ''),
      loggedText(),
    ].join('\n');
  return {
    workspace,
    forge,
    call,
    calls,
    prepared,
    disposed,
    providerRequests,
    helperInvoked,
    capturedText,
  };
}

const pushRequest = { cwd: '.', remote: 'origin', branch: 'guest-work' };

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("a guest on someone else's Machine uses their own hosting account", () => {
  it("(1)(5) push and fetch carry only the guest's credential; the owner's login and accounts are never consulted", async () => {
    const fixture = await setup();
    const pushed = await fixture.call(
      RPC_METHODS.SCM_REMOTE_PUSH,
      pushRequest,
      admittedContext('guest'),
    );
    expect(pushed.success, JSON.stringify(pushed)).toBe(true);
    expect(
      runGit(fixture.forge.bareRepositoryPath, [
        'rev-parse',
        'refs/heads/guest-work',
      ]),
    ).toBe(runGit(fixture.workspace, ['rev-parse', 'HEAD']));
    const fetched = await fixture.call(
      RPC_METHODS.SCM_REMOTE_FETCH,
      { cwd: '.', remote: 'origin' },
      admittedContext('guest'),
    );
    expect(fetched.success, JSON.stringify(fetched.errorCode)).toBe(true);

    const gitRequests = fixture.providerRequests.filter(
      (request) => request.kind === 'git',
    );
    expect(gitRequests.length).toBeGreaterThan(0);
    expect(
      gitRequests.every(
        (request) => request.authorization === basic(GUEST_TOKEN),
      ),
    ).toBe(true);
    expect(fixture.calls.filter((call) => call.endsWith(':owner'))).toEqual([]);
    expect(await fixture.helperInvoked()).toBe(false);
    const captured = await fixture.capturedText([pushed, fetched]);
    expect(captured.includes(GUEST_TOKEN)).toBe(false);
    expect(
      captured.includes(
        Buffer.from(`x-access-token:${GUEST_TOKEN}`).toString('base64'),
      ),
    ).toBe(false);
    expect(fixture.disposed).toEqual(fixture.prepared);
  });

  it("(1) pull-request hosting reads use the guest's bound account", async () => {
    const fixture = await setup();
    const listed = await fixture.call(
      RPC_METHODS.SCM_PULL_REQUEST_LIST,
      { cwd: '.' },
      admittedContext('guest'),
    );
    const api = fixture.providerRequests.filter(
      (request) => request.kind === 'api',
    );
    expect(api.length, JSON.stringify(listed.errorCode)).toBeGreaterThan(0);
    expect(
      api.every((request) => request.authorization === `Bearer ${GUEST_TOKEN}`),
    ).toBe(true);
    expect(fixture.calls.filter((call) => call.endsWith(':owner'))).toEqual([]);
  });

  it("(1c) custody retained only in an Action's original ingress (no raw Machine admission, e.g. an approval replay) still uses only the guest's own account (SEC-RU2-1127A F1)", async () => {
    const fixture = await setup();
    const context = {
      signal: new AbortController().signal,
      localActionContext: { externalActionExecutionAuthorization: requesterAuthorization('guest') },
    } as RpcHandlerContext;
    const listed = await fixture.call(RPC_METHODS.SCM_PULL_REQUEST_LIST, { cwd: '.' }, context);
    const api = fixture.providerRequests.filter((request) => request.kind === 'api');
    expect(api.length, JSON.stringify(listed.errorCode)).toBeGreaterThan(0);
    expect(api.every((request) => request.authorization === `Bearer ${GUEST_TOKEN}`)).toBe(true);
    expect(fixture.calls.filter((call) => call.endsWith(':owner'))).toEqual([]);
    expect(fixture.prepared).toEqual(['guest']);
  });

  it('(2) a guest with no connected account, or no admitted Account custody, gets the typed authentication refusal and no network call', async () => {
    const fixture = await setup();
    for (const context of [
      admittedContext('unconnected'),
      admittedContext('guest', false),
    ]) {
      const pushed = await fixture.call(
        RPC_METHODS.SCM_REMOTE_PUSH,
        pushRequest,
        context,
      );
      expect(pushed.success).toBe(false);
      expect(pushed.errorCode).toBe(
        SCM_OPERATION_ERROR_CODES.REMOTE_AUTH_REQUIRED,
      );
      const fetched = await fixture.call(
        RPC_METHODS.SCM_REMOTE_FETCH,
        { cwd: '.', remote: 'origin' },
        context,
      );
      expect(fetched.success).toBe(false);
      expect(fetched.errorCode).toBe(
        SCM_OPERATION_ERROR_CODES.REMOTE_AUTH_REQUIRED,
      );
    }
    expect(fixture.providerRequests).toEqual([]);
    expect(fixture.calls).toEqual([]);
    expect(await fixture.helperInvoked()).toBe(false);
  });

  it("(4)(6) another guest and the Machine owner cannot cause a request that uses this guest's credential", async () => {
    const fixture = await setup();
    await fixture.call(
      RPC_METHODS.SCM_REMOTE_PUSH,
      pushRequest,
      admittedContext('guest'),
    );
    const before = fixture.providerRequests.length;
    await fixture.call(
      RPC_METHODS.SCM_REMOTE_PUSH,
      { ...pushRequest, branch: 'other-work' },
      admittedContext('other-guest'),
    );
    await fixture.call(
      RPC_METHODS.SCM_REMOTE_PUSH,
      { ...pushRequest, branch: 'owner-work' },
      admittedContext('owner'),
    );
    const later = fixture.providerRequests.slice(before);
    expect(
      later.some((request) => request.authorization === basic(GUEST_TOKEN)),
    ).toBe(false);
    expect(
      later
        .filter((request) => request.kind === 'git')
        .every((request) => request.authorization === basic(OTHER_GUEST_TOKEN)),
    ).toBe(true);
    expect(
      fixture.calls.filter((call) => call === 'account:guest'),
    ).toHaveLength(1);
    expect(fixture.disposed).toEqual(fixture.prepared);
  });

  it('(3) the Machine owner keeps native Git login behaviour', async () => {
    const fixture = await setup();
    runGit(fixture.workspace, ['remote', 'add', 'direct', fixture.forge.url]);
    // The owner's helper answers the fixture with the owner's native credential: the fixture accepts only the guest's,
    // so this push is refused by the forge after Git consulted the owner's helper, exactly as before.
    await fixture.call(
      RPC_METHODS.SCM_REMOTE_PUSH,
      { cwd: '.', remote: 'direct', branch: 'owner-work' },
      admittedContext('owner'),
    );
    expect(await fixture.helperInvoked()).toBe(true);
    expect(fixture.prepared).toEqual([]);
  });

  it("(3b) the Machine owner acting from another device is this Machine's custodian: native login and own accounts, no requester material", async () => {
    const fixture = await setup();
    runGit(fixture.workspace, ['remote', 'add', 'direct', fixture.forge.url]);
    await fixture.call(
      RPC_METHODS.SCM_REMOTE_PUSH,
      { cwd: '.', remote: 'direct', branch: 'owner-work' },
      ownerFromAnotherDeviceContext(),
    );
    expect(await fixture.helperInvoked()).toBe(true);
    const listed = await fixture.call(
      RPC_METHODS.SCM_PULL_REQUEST_LIST,
      { cwd: '.' },
      ownerFromAnotherDeviceContext(),
    );
    const api = fixture.providerRequests.filter((request) => request.kind === 'api');
    expect(api.length, JSON.stringify(listed.errorCode)).toBeGreaterThan(0);
    expect(api.every((request) => request.authorization === `Bearer ${OWNER_TOKEN}`)).toBe(true);
    expect(fixture.prepared).toEqual([]);
  });

  it('(2b) a guest whose connected account is for another host than the remote gets authentication required, with no provider request and no credential read', async () => {
    const fixture = await setup();
    const context = admittedContext('wrong-host');
    const pushed = await fixture.call(RPC_METHODS.SCM_REMOTE_PUSH, pushRequest, context);
    expect(pushed.errorCode).toBe(SCM_OPERATION_ERROR_CODES.REMOTE_AUTH_REQUIRED);
    const fetched = await fixture.call(RPC_METHODS.SCM_REMOTE_FETCH, { cwd: '.', remote: 'origin' }, context);
    expect(fetched.errorCode).toBe(SCM_OPERATION_ERROR_CODES.REMOTE_AUTH_REQUIRED);
    expect(fixture.providerRequests).toEqual([]);
    expect(fixture.calls).toEqual([]);
    expect(await fixture.helperInvoked()).toBe(false);
    const captured = await fixture.capturedText([pushed, fetched]);
    expect(captured.includes(WRONG_HOST_TOKEN)).toBe(false);
    expect(captured.includes(OWNER_NATIVE_TOKEN)).toBe(false);
  });

  it("(8b) a guest's push to a repository on this Machine's disk needs no credential and works as before", async () => {
    const fixture = await setup();
    runGit(fixture.workspace, ['remote', 'add', 'local', fixture.forge.bareRepositoryPath]);
    const pushed = await fixture.call(
      RPC_METHODS.SCM_REMOTE_PUSH,
      { cwd: '.', remote: 'local', branch: 'guest-local' },
      admittedContext('guest'),
    );
    expect(pushed.success, JSON.stringify(pushed)).toBe(true);
    expect(runGit(fixture.forge.bareRepositoryPath, ['rev-parse', 'refs/heads/guest-local']))
      .toBe(runGit(fixture.workspace, ['rev-parse', 'HEAD']));
    // The same repository named by a relative path works for the guest as for the owner (SEC-RU2-1127A F2).
    runGit(fixture.workspace, ['remote', 'add', 'relative', relative(fixture.workspace, fixture.forge.bareRepositoryPath)]);
    const relativePush = await fixture.call(
      RPC_METHODS.SCM_REMOTE_PUSH,
      { cwd: '.', remote: 'relative', branch: 'other-work' },
      admittedContext('guest'),
    );
    expect(relativePush.success, JSON.stringify(relativePush)).toBe(true);
    expect(fixture.providerRequests).toEqual([]);
    // No credential is materialized for it (their own account listing may be read); material is disposed with the request.
    expect(fixture.calls).toEqual([]);
    expect(fixture.disposed).toEqual(fixture.prepared);
    expect(await fixture.helperInvoked()).toBe(false);
  });
});
