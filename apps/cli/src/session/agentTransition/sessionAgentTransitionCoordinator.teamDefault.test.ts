import axios from 'axios';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConnectedAccountCatalogRowReadResponseV1Schema, CONNECTED_ACCOUNT_CATALOG_ROWS_ROUTE_V1 } from '@happier-dev/protocol/connect/connectedAccountConfigurationRowsV1';
import type { QualifiedConnectedAccountPurposeV1 } from '@happier-dev/protocol';
import * as persistence from '@/persistence';
import { createAccountEncryptionCurrentnessFixture } from '@/testkit/backends/sessionFixtures';
import { createAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { bootstrapAccountSettingsContext, resetInMemoryAccountSettingsContextForTests } from '@/settings/accountSettings/bootstrapAccountSettingsContext';
import { createInvocationSavedSecretOperationContextV1 } from '@/settings/secrets/savedSecretOperationContext';
import { resolveServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';

/**
 * The transition's TARGET connected-service binding, through the real
 * spawn-defaulting owner (`resolveSessionSpawnConnectedServicesDefaultsPayload`).
 *
 * Only Home HTTP, credential storage and the recipient Team catalog read are
 * substituted. The admitted Agent catalog, settings bootstrap and purpose-row
 * opener run for real.
 * The owner's own decisions — default projection, Team currentness, typed
 * refusal — run for real, so a Team default that no longer resolves must reach
 * the coordinator as the owner's typed refusal (lane 10 child 02 §11.6 "no
 * silent native fallback"), before the source runtime is touched.
 */

const { runSessionAgentTransition } = await import('./sessionAgentTransitionCoordinator');
type SessionAgentTransitionDeps =
  import('./sessionAgentTransitionCoordinator').SessionAgentTransitionDeps;
const {
  buildTransitionRequest,
  createTransitionDepsHarness,
  CLAUDE_SOURCE_METADATA,
  TEST_LOCAL_ID,
} = await import('./sessionAgentTransitionTestkit');
const { resolveSessionSpawnConnectedServicesDefaultsPayload } =
  await import('@/session/services/spawnConnectedServicesDefaults');
const { resolveQualifiedPurposeDeclarationSnapshotForAgentSpawn } =
  await import('@/daemon/connectedServices/requestAuth/prepareConnectedAccountRequestAuthForSpawn');
const TEST_CREDENTIALS = { token: `header.${Buffer.from(JSON.stringify({ sub: 'recipient-account' })).toString('base64url')}.signature`, encryption: null } as const;
let CODEX_PURPOSE: QualifiedConnectedAccountPurposeV1;
const CODEX_SERVICE = { pluginId: 'happier.agent.codex', localId: 'openai-codex' };
const TEAM_SELECTION = {
  source: 'team_resource' as const,
  resourceId: 'resource-a',
  deliveryMode: 'brokered' as const,
};

let hasTeamDefault = true;
let runtime: Awaited<ReturnType<typeof createAdmittedPluginRuntimeFixture>>;
beforeAll(async () => {
  runtime = await createAdmittedPluginRuntimeFixture({ controller: pluginReloadController,
    runtimeOptions: { pluginIds: ['happier.agent.codex'] } });
  const scope = resolveQualifiedPurposeDeclarationSnapshotForAgentSpawn({ agentId: 'codex',
    contributions: runtime.registry.contributes })?.authorizedPurposes.find(scope => scope.serviceRefs[0]?.localId === 'openai-codex');
  if (!scope) throw new Error('Admitted Codex purpose is unavailable');
  CODEX_PURPOSE = scope.purpose;
});
afterAll(async () => { await runtime?.dispose(); });

function buildTeamCatalog(resources: readonly Record<string, unknown>[]) {
  return {
    serverId: 'home-a',
    accountId: 'recipient-account',
    resources,
  } as never;
}

const CURRENT_TEAM_RESOURCE = {
  id: 'resource-a', teamId: 'team-a', displayName: 'Shared Codex account',
  resourceRevision: 7, readiness: { kind: 'available' as const }, recoveryAction: null,
  mayBroker: true, mayReceiveDirect: false, directMaterialState: 'never_delivered' as const,
  sessionUsePolicy: 'personal_allowed' as const, providerModels: [],
  connectedServiceSelections: [TEAM_SELECTION],
  sourcePresentation: { kind: 'connected_service' as const, service: CODEX_SERVICE },
};

const SOURCE_BOUND = {
  ...CLAUDE_SOURCE_METADATA,
  connectedServices: {
    v: 1,
    bindingsByServiceId: {
      'claude-subscription': { source: 'connected', selection: 'profile', profileId: 'team' },
    },
  },
  connectedServicesUpdatedAt: 11,
  connectedServiceMaterializationIdentityV1: { v: 1, id: 'csm_source', createdAt: 1, source: 'first_spawn' },
};

function readSealedMetadata(currentView: unknown): Record<string, unknown> {
  const view = currentView as { metadataCiphertext?: unknown };
  return JSON.parse(String(view.metadataCiphertext)) as Record<string, unknown>;
}

function createHarness(input: Readonly<{
  readTeamCatalog: (teamIds: readonly string[]) => Promise<unknown>;
}>) {
  const captured: { currentView: unknown; teamCredentialBindings: unknown } = {
    currentView: null,
    teamCredentialBindings: undefined,
  };
  const readTeamCatalog = vi.fn(async ({ teamIds }: { teamIds: readonly string[] }) =>
    await input.readTeamCatalog(teamIds));
  const harness = createTransitionDepsHarness({
    // The Home's cutover route is the network boundary; what the daemon sends
    // it is the observable contract.
    applySessionAgentTransitionCutover: vi.fn(async (request: {
      currentView: unknown;
      teamCredentialBindings?: unknown;
    }) => {
      captured.currentView = request.currentView;
      captured.teamCredentialBindings = request.teamCredentialBindings;
      return { ok: true as const, dividerSeq: 77 };
    }) as unknown as SessionAgentTransitionDeps['applySessionAgentTransitionCutover'],
    resolveSpawnConnectedServicesDefaults: resolveSessionSpawnConnectedServicesDefaultsPayload,
    createTeamCredentialResourceCatalogResolver: () =>
      readTeamCatalog as unknown as ReturnType<
        SessionAgentTransitionDeps['createTeamCredentialResourceCatalogResolver']
      >,
  });
  harness.setMetadata({ ...SOURCE_BOUND });
  return { harness, captured, readTeamCatalog };
}

beforeEach(() => {
  resetInMemoryAccountSettingsContextForTests();
  hasTeamDefault = true;
  vi.spyOn(persistence, 'readStoredCredentials').mockResolvedValue(TEST_CREDENTIALS);
  vi.spyOn(axios, 'get').mockImplementation(async input => {
    const path = new URL(String(input)).pathname;
    if (path === '/v2/account/settings') return { status: 200,
      data: { content: { t: 'plain', v: {} }, version: 9 } };
    if (path === '/v1/account/encryption/currentness') return { status: 200,
      data: createAccountEncryptionCurrentnessFixture({ settingsVersion: 9 }) };
    if (path === `${CONNECTED_ACCOUNT_CATALOG_ROWS_ROUTE_V1}/purposes`) return { status: 200,
      data: ConnectedAccountCatalogRowReadResponseV1Schema.parse({ status: 'present', revision: 3,
        content: { t: 'plain', v: { key: 'purposes', value: { v: 1, bindings: hasTeamDefault ? [{
          purpose: CODEX_PURPOSE,
          target: { kind: 'team_resource', service: CODEX_SERVICE, teamId: 'team-a', selection: TEAM_SELECTION },
        }] : [] } } } }) };
    return { status: 404, data: { error: 'unsupported' } };
  });
});
afterEach(() => { vi.restoreAllMocks(); resetInMemoryAccountSettingsContextForTests(); });

/**
 * A connected-service binding is Agent-scoped: it names a `serviceId` the
 * SOURCE Agent's catalog declares, so the cutover never carries it. Carried in
 * the predecessor tree, `openai-codex` survived a switch to `claude`, the
 * daemon spawn-preflighted the wrong service's credential and the target died
 * with the Session already committed to it.
 */
describe('runSessionAgentTransition — the target binding comes from the one spawn-defaulting owner', () => {
  it.each([true, false])('uses requester custody rather than the daemon bearer when custody is current=%s', async current => {
    hasTeamDefault = false;
    vi.mocked(persistence.readStoredCredentials).mockResolvedValue({ ...TEST_CREDENTIALS, token: 'daemon-local-bearer' });
    const snapshot = await bootstrapAccountSettingsContext({ credentials: TEST_CREDENTIALS,
      mode: 'blocking', publication: 'invocation', deps: { applySideEffects: () => undefined } });
    const operationContext = createInvocationSavedSecretOperationContextV1({ credentials: TEST_CREDENTIALS,
      snapshot, serverHttpBaseUrl: resolveServerHttpBaseUrl(), isCurrent: async () => current });
    const { harness, captured } = createHarness({ readTeamCatalog: async () => buildTeamCatalog([]) });
    const invocation = { credentials: TEST_CREDENTIALS, request: buildTransitionRequest(),
      operationContext, deps: harness.deps };

    const result = await runSessionAgentTransition(invocation);

    if (current) {
      expect(result).toEqual({ type: 'accepted', localId: TEST_LOCAL_ID });
      expect(readSealedMetadata(captured.currentView).connectedServices).toBeUndefined();
    } else {
      expect(result).toEqual({ type: 'rejected', code: 'target_unavailable', sourceEffect: 'none' });
      expect(captured.currentView).toBeNull();
      expect(harness.deps.requestSessionStop).not.toHaveBeenCalled();
    }
  });

  it('refuses typed, with the source untouched, when the target Team default no longer resolves', async () => {
    // The Home no longer offers the resource from that Team.
    const { harness, captured, readTeamCatalog } = createHarness({
      readTeamCatalog: async () => buildTeamCatalog([]),
    });

    const result = await runSessionAgentTransition({
      credentials: TEST_CREDENTIALS,
      request: buildTransitionRequest(),
      deps: harness.deps,
    });

    expect(result).toEqual({ type: 'rejected', code: 'target_unavailable', sourceEffect: 'none' });
    expect(readTeamCatalog).toHaveBeenCalledWith({ teamIds: ['team-a'] });
    expect(harness.deps.requestSessionStop).not.toHaveBeenCalled();
    expect(harness.deps.callSessionProviderInputAdmission).not.toHaveBeenCalled();
    expect(captured.currentView).toBeNull();
  });

  it('refuses typed when the Home catalog cannot be read for a Team default', async () => {
    const { harness, captured } = createHarness({ readTeamCatalog: async () => null });

    const result = await runSessionAgentTransition({
      credentials: TEST_CREDENTIALS,
      request: buildTransitionRequest(),
      deps: harness.deps,
    });

    expect(result).toEqual({ type: 'rejected', code: 'target_unavailable', sourceEffect: 'none' });
    expect(harness.deps.requestSessionStop).not.toHaveBeenCalled();
    expect(captured.currentView).toBeNull();
  });

  it('rebinds the target to its current Team default instead of carrying the source binding', async () => {
    const { harness, captured } = createHarness({
      readTeamCatalog: async () => buildTeamCatalog([CURRENT_TEAM_RESOURCE]),
    });

    const result = await runSessionAgentTransition({
      credentials: TEST_CREDENTIALS,
      request: buildTransitionRequest(),
      deps: harness.deps,
    });

    expect(result).toEqual({ type: 'accepted', localId: TEST_LOCAL_ID });
    const sealed = readSealedMetadata(captured.currentView);
    expect(sealed.connectedServices).toEqual({
      v: 2,
      bindingsByServiceId: { 'happier.agent.codex/openai-codex': TEAM_SELECTION },
    });
    // The materialized credential home is per-binding; reusing the source's id
    // would point the target at the departed Agent's home.
    expect(sealed.connectedServiceMaterializationIdentityV1).not.toMatchObject({ id: 'csm_source' });
    // The Home admits a Team target only through the Session's own binding
    // witness (lane 10 child 01 principle 3), so the switch mutation carries the
    // slot binding the defaults owner resolved against the same catalog read.
    expect(captured.teamCredentialBindings).toEqual([{
      v: 1,
      slot: { kind: 'connected_service_purpose', purpose: CODEX_PURPOSE },
      resourceId: 'resource-a',
      expectedResourceRevision: 7,
      deliveryMode: 'brokered',
      teamId: 'team-a',
    }]);
  });

  it('leaves the target on native auth when the Account configures no default for it', async () => {
    hasTeamDefault = false;
    const { harness, captured, readTeamCatalog } = createHarness({
      readTeamCatalog: async () => buildTeamCatalog([]),
    });

    const result = await runSessionAgentTransition({
      credentials: TEST_CREDENTIALS,
      request: buildTransitionRequest(),
      deps: harness.deps,
    });

    expect(result).toEqual({ type: 'accepted', localId: TEST_LOCAL_ID });
    expect(readTeamCatalog).not.toHaveBeenCalled();
    const sealed = readSealedMetadata(captured.currentView);
    expect(sealed.connectedServices).toBeUndefined();
    expect(sealed.connectedServicesUpdatedAt).toBeUndefined();
    expect(sealed.connectedServiceMaterializationIdentityV1).toBeUndefined();
    expect(captured.teamCredentialBindings).toBeUndefined();
  });
});
