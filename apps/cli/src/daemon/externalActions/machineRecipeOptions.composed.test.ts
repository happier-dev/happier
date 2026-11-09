import { afterEach, expect, it, vi } from 'vitest';
import axios from 'axios';
import tweetnacl from 'tweetnacl';
import { API_TOKEN_FULL_GRANT_V1 } from '@happier-dev/protocol';
import { computeExternalActionRequestEnvelopeDigestV1 } from '@happier-dev/protocol/actions';
import { normalizeActionsSettingsV1 } from '@happier-dev/protocol/actions/actionSettings';
import { SessionActionRpcOriginV1Schema } from '@happier-dev/protocol/socketRpc';
import { createCliActionExecutorFromCredentials } from '@/session/actions/createCliActionExecutorFromCredentials';
import { createMachineRecipeReadAction } from '@/machines/setup/machineRecipeActionDeps';
import { createAuthoredAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { acquireAuthoritativePluginRuntimeRegistryLease } from '@/plugins/runtime/reload/runtimeLease';
import { createDaemonExternalActionTargetResolver } from './daemonExternalActionTargetResolver';
import { executeExternalAction } from './executeExternalAction';
import { ApiMachineClient } from '@/api/apiMachine';
import type { Machine } from '@/api/types';

afterEach(() => vi.restoreAllMocks());

it.each(['available', 'agent', 'metadata absent', 'empty', 'wrong Home', 'wrong Machine', 'retired before acquisition', 'retired during acquisition', 'retired at settlement'] as const)(
  'serves software choices through actual admitted external execution without a raw catalog RPC: %s', async scenario => {
  const homeId = 'srv_software';
  const target = { kind: 'machine' as const, machineId: 'software-machine' };
  const credentials = { token: `fixture.${Buffer.from(JSON.stringify({ sub: 'account' })).toString('base64url')}.signature`, encryption: null };
  const key = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(28));
  const apiPrincipal = { accountId: 'account', principalId: 'principal', credentialId: 'credential',
    grant: API_TOKEN_FULL_GRANT_V1, authority: 'account_automation' as const };
  const sessionActionOrigin = SessionActionRpcOriginV1Schema.parse({ v: 1,
    caller: { kind: 'session', sessionId: 'source', starterDepth: 1, turnDepth: 2 }, sourceTurnId: 'turn',
    callerPermissionMode: 'read-only', causalPermissionAuthority: { kind: 'admittedSessionInputV1', admittedPermissionCeiling: 'read-only' },
    workspaceWrites: 'deny', requestId: 'software-options' });
  const principal = scenario === 'agent' ? { accountId: apiPrincipal.accountId, authority: apiPrincipal.authority,
    authentication: { kind: 'account' as const, tokenEpoch: 7 }, sessionActionOrigin } : apiPrincipal;
  const actionId = 'action.options.resolve';
  const ref = { pluginId: 'com.example.software', recipeId: 'fonts', revision: '3' };
  const expectsChoices = scenario === 'available' || scenario === 'agent' || scenario === 'metadata absent';
  const envelope = { v: 1 as const, requestId: 'software-options', target, input: {
    actionId: 'machines.setup.plan', fieldPath: 'sources.0.setup.items.0.selection.ref',
    draftInput: { homeId: scenario === 'wrong Home' ? 'another-home' : homeId,
      machineId: scenario === 'wrong Machine' ? 'another-machine' : target.machineId },
    ...(expectsChoices ? { values: [ref] } : {}),
  } };
  const authorization = { v: 1 as const, token: 'home-admitted-options', binding: {
    accountId: principal.accountId,
    ...(scenario === 'agent' ? { authentication: { kind: 'account' as const, tokenEpoch: 7 }, sessionActionOrigin,
      sessionActionSource: { machineId: 'source-machine', installationId: 'source-installation' } }
      : { principalId: apiPrincipal.principalId, credentialId: apiPrincipal.credentialId, grant: apiPrincipal.grant }),
    accountEncryptionMode: 'plain' as const, serverIdentityId: homeId,
    machineId: target.machineId, custodianAccountId: principal.accountId, installationId: 'installation',
    actionId, requestId: envelope.requestId, target, requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope),
  } };
  const networkRequests: string[] = [];
  // Only Home HTTP is substituted. Real external admission, credential factory,
  // Action option resolution and transport policy remain in the path.
  vi.spyOn(axios, 'get').mockImplementation(async url => {
    const path = new URL(String(url)).pathname;
    networkRequests.push(path);
    if (path === '/v2/account/settings') return { status: 200, data: { content: { t: 'plain', v: {} }, version: 1 } };
    if (path === '/v1/account/encryption') return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
    if (path === '/v1/account/encryption/currentness') return { status: 200, data: { mode: 'plain', version: 1,
      signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } };
    throw new Error(`Unexpected software HTTP read: ${path}`);
  });
  vi.spyOn(axios, 'post').mockImplementation(async url => {
    const path = new URL(String(url)).pathname;
    networkRequests.push(path);
    if (path === `/v1/actions/${actionId}/execution-authorization/verify`) return { status: 200, data: { ok: true } };
    throw new Error(`Unexpected software HTTP mutation: ${path}`);
  });
  const pluginId = 'com.example.software';
  const recipe = { id: 'fonts', revision: '3', title: 'Fonts', software: true,
    inputSchema: { type: 'object', properties: { manager: { type: 'string', enum: ['apt'] } },
      required: ['manager'], additionalProperties: false },
    inputHints: { fields: [{ path: 'manager', widget: 'select',
      title: { key: 'software.manager', fallback: 'Package manager' },
      options: [{ value: 'apt', label: { key: 'software.manager.apt', fallback: 'APT' } }] }] },
    steps: [{ id: 'fonts', kind: 'package', manager: { kind: 'input', path: 'manager' }, packages: [{ name: 'fonts-dejavu-core' }] }],
    removeSteps: [{ id: 'remove-fonts', kind: 'package', state: 'absent', manager: { kind: 'input', path: 'manager' },
      packages: [{ name: 'fonts-dejavu-core' }] }],
  };
  const { software: _software, ...setupRecipe } = recipe;
  const runtime = await createAuthoredAdmittedPluginRuntimeFixture({ coldStart: true, plugins: [{ files: {},
    manifest: { schemaVersion: 2, id: pluginId, version: '1.0.0', displayName: 'Software', runtime: { apiVersion: 1 },
      contributes: { machineRecipes: scenario === 'empty' ? [] : [recipe,
        { ...recipe, id: 'unrelated', title: 'Unrelated software' }, { ...setupRecipe, id: 'setup-only' }] } },
  }] });
  const machine: Machine = { id: target.machineId, encryptionMode: 'plain', metadataVersion: 1, daemonState: null, daemonStateVersion: 0,
    metadata: scenario === 'metadata absent' ? null : { host: 'recipe-receiver', platform: 'darwin', arch: 'arm64',
      happyCliVersion: 'dev', homeDir: '/users/receiver', happyHomeDir: '/users/receiver/.happier' } };
  const apiMachine = new ApiMachineClient(credentials.token, machine);
  let descriptorReads = 0;
  let receiverChecks = 0;
  let receiverCurrent = true;
  const recipeReaderParams = { homeId, machineId: target.machineId,
    readMachineMetadataSnapshot: () => apiMachine.getMachineMetadataSnapshot(),
    acquirePluginRuntimeRegistryLease: async () => {
      descriptorReads++;
      const lease = await acquireAuthoritativePluginRuntimeRegistryLease({ controller: runtime.controller, happyHomeDir: runtime.happyHomeDir });
      return { ...lease, release: async () => {
        await lease.release();
        if (scenario === 'retired at settlement') receiverCurrent = false;
      } };
    },
    // The receiver's current identity is an environment boundary. Replacement
    // must prevent disclosure before acquisition, after it and after release.
    isCurrent: async (context: Parameters<Parameters<typeof createMachineRecipeReadAction>[0]['isCurrent']>[0]) => {
      expect(context.surface).toBe(scenario === 'agent' ? 'agent' : 'api');
      if (scenario === 'agent') {
        expect(context.externalActionCredential).toBeUndefined();
        expect(context.actionCaller).toEqual(sessionActionOrigin.caller);
      } else expect(context.externalActionCredential).toMatchObject({ accountId: principal.accountId });
      expect(context.externalActionExecutionAuthorization?.binding).toMatchObject({ serverIdentityId: homeId, machineId: target.machineId });
      receiverChecks++;
      return receiverCurrent && !(scenario === 'retired before acquisition' || scenario === 'retired during acquisition' && receiverChecks >= 2);
    },
  };
  const readRecipes = createMachineRecipeReadAction(recipeReaderParams);
  let readRequest: Parameters<typeof readRecipes>[0] | undefined;
  let readResult: Awaited<ReturnType<typeof readRecipes>> | undefined;
  let readContext: Parameters<typeof readRecipes>[1] | undefined;
  const machineRecipesRead: typeof readRecipes = async (input, context) => {
    readRequest = input;
    readContext = context;
    readResult = await readRecipes(input, context);
    return readResult;
  };
  try {
  const executor = createCliActionExecutorFromCredentials({ credentials, machineId: target.machineId,
    pluginActionExecutionOwner: 'current_process',
    machineRecipesRead,
    serverId: 'profile', serverApiUrl: 'https://software.test', serverIdentityId: homeId,
    externalActionMachineRequestPrivateKey: key.secretKey, externalActionMachineInstallationId: 'installation',
    actionsSettingsProvider: { getActionsSettings: () => normalizeActionsSettingsV1({}) },
  });
  const result = await executeExternalAction({ actionId, envelope, principal, executionAuthorization: authorization,
    currentMachineId: target.machineId, currentServerId: 'profile', currentInstallationId: 'installation', executor,
    externalActionMachineRequestPrivateKey: key.secretKey, verifyExecutionAuthorization: async () => true,
    resolveTarget: createDaemonExternalActionTargetResolver({ credentials }),
  });
  if (!expectsChoices && scenario !== 'empty') {
    expect(result, JSON.stringify(result)).toMatchObject({ kind: 'response', response: { execution: { ok: false, errorCode: 'unavailable' } } });
  } else expect(result, JSON.stringify(result)).toMatchObject({ kind: 'response', response: { execution: { ok: true,
    result: { optionsSourceId: 'machines.setup.software.available', options: [{
      value: { pluginId: 'com.example.software', recipeId: 'fonts', revision: '3' }, label: 'Fonts',
    }].slice(0, scenario === 'empty' ? 0 : 1) },
  } } });
  if (expectsChoices) {
    expect(readRequest).toEqual({ homeId, machineId: target.machineId, recipeRefs: [ref] });
    const details = [expect.objectContaining({ id: `${ref.pluginId}/${ref.recipeId}`, pluginId: ref.pluginId,
      definition: expect.objectContaining({ id: ref.recipeId, revision: ref.revision, inputSchema: recipe.inputSchema,
        inputHints: recipe.inputHints, steps: recipe.steps, removeSteps: recipe.removeSteps }) })];
    expect(readResult).toMatchObject({ entries: details });
    expect(result).toMatchObject({ kind: 'response', response: { execution: { ok: true,
      result: { machineRecipeDetails: details } } } });
    if (scenario === 'metadata absent') expect(readResult).not.toHaveProperty('target');
    else expect(readResult).toMatchObject({ target: { platform: 'darwin', arch: 'arm64' } });
  }
  expect(descriptorReads).toBe(scenario === 'wrong Home' || scenario === 'wrong Machine' || scenario === 'retired before acquisition' ? 0 : 1);
  if (expectsChoices) {
    if (!readContext) throw new Error('Missing admitted external recipe read context');
    const emptyRecipeRequest = { homeId, machineId: target.machineId, recipeRefs: [] };
    const noBodies = await readRecipes(emptyRecipeRequest, readContext);
    expect(noBodies).toMatchObject({ entries: [] });
    if (scenario === 'metadata absent') expect(noBodies).not.toHaveProperty('target');
    else expect(noBodies).toMatchObject({ target: { platform: 'darwin', arch: 'arm64' } });
  }
  expect(networkRequests.filter(path => path.includes('/rpc') || path.includes('/environment'))).toEqual([]);
  } finally { await apiMachine.shutdown(); await runtime.dispose(); }
});
