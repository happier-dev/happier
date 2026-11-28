// Load the OS boundary before the production owners or named filesystem imports.
import { createDockerNetworkAuthoredProvider, createGenericDefaultFactoryJourney, executeReviewedReachabilityConfigure,
  installationId, journey, machineId, parseCompletedReachabilityConfigure, parseReachabilityInspectResult, selection,
} from './genericMachineReachability.composed.testkit';
import { lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir, userInfo } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import axios from 'axios';
import type { AccessProviderSelectionV1 } from '@happier-dev/plugin-sdk/access-providers';
import { resolveRelayRuntimeDefaults } from '@happier-dev/cli-common/firstPartyRuntime';
import { ActionsSettingsV1Schema, setActionApprovalOverride } from '@happier-dev/protocol';
import { ActionExecuteResultSchema } from '@happier-dev/protocol/actions/actionExecutionResult';
import { HostReviewedChildrenPlanV1Schema } from '@happier-dev/protocol/actions/executor/hostReviewedChildrenV1';
import { createHostReviewedChildPortV1 } from '@happier-dev/protocol/actions/executor/deploymentRoleChild';
import { bindExternalActionExecutionAuthorizationVerifyHttpPathV1 } from '@happier-dev/protocol/actions/externalActionApi';
import { readApprovalExecutionFailure } from '@happier-dev/protocol/approvals/approvalExecutionFailure';
import { machineNativeEffectAdmission } from '@/daemon/local/services/launch/machineNativeEffectAdmission';
import * as externalActionPhase from '@/daemon/externalActions/externalActionPhase';
import * as agentIsolationLaunchPolicy from '@/daemon/agentIsolation/agentIsolationLaunchPolicy';
import { formatQualifiedPluginActionId } from '@happier-dev/protocol/plugins/actions/qualifiedActionId';
import { reachabilityConnectorSubject } from '@/machines/reachability/prepareReachabilityJoinCredential';
import * as terminalInput from '@/terminal/prompts/promptInput';
import { inspectMachineReachability } from './machineReachabilityHost';
import { prepareReachabilityReviewedChildrenForHost } from './reachabilityProviderHost';

vi.mock('node:os', async importOriginal => {
  const os = await importOriginal<typeof import('node:os')>();
  return { ...os, homedir: vi.fn(os.homedir) };
});
afterEach(() => { vi.mocked(homedir).mockReset(); });

// Generic physical plugin authoring drives the same production factory,
// custody, parent Action, native admission and retained approval owners.
describe.runIf(process.platform === 'linux' && userInfo().uid !== 0)('public generic Machine reachability journey', () => {
it('reviews keyless plugin membership using its inspected profile without preparing a Saved Secret', async () => {
  const authoredProvider = createDockerNetworkAuthoredProvider(false, true, false, { keyless: true, observedMembership: true });
  const selected: AccessProviderSelectionV1 = { ...selection, credentialRefs: [] };
  const fixture = await journey('external', [], { providerSelection: selected, authoredProvider, keylessNetworkClient: true });
  const api = await createGenericDefaultFactoryJourney(fixture);
  try {
    const review = parseReachabilityInspectResult(await api.invoke('machines.reachability.inspect', {
      serverId: 'generic-home', machineId, change: { kind: 'privateNetwork', intent: 'join', selection: selected },
    }));
    expect(review.plan?.basis).toMatchObject({ change: { selection: selected },
      recipePlans: [expect.objectContaining({ plan: expect.objectContaining({ basis: expect.objectContaining({
        selection: expect.objectContaining({ inputs: expect.objectContaining({ machineId, config: selected.config,
          credentialRefs: [], membership: { profileId: selection.config.profileName, flags: ['profile-available'] } }) }),
      }) }) })] });
    expect(review.plan?.basis.nativeProfiles).toEqual([{ provider: selected.provider,
      profileId: selection.config.profileName, networkIdentity: 'fixture-network' }]);
    expect(review.plan?.basis.recipePlans[0]?.plan.steps.map(step => step.id)).toEqual(['network-join']);
    expect(review.plan?.basis.credentialFileReview).toBeUndefined();
    expect(fixture.elevation.launches).toHaveLength(0);
    const { result } = await executeReviewedReachabilityConfigure(fixture, api, review);
    expect(parseCompletedReachabilityConfigure(result)).toMatchObject({ status: 'applied', selections: [selected] });
    expect(fixture.hostNative.networkJoined()).toBe(true);
    expect(await fixture.home.readConnectorGrantCount()).toBe(0);
    expect(api.processBoundary.failures).toEqual([]);
  } finally { await api.dispose(); }
}, 120_000);

it('admits the exact inspect role for the selected contributed default ingress', async () => {
  const authoredProvider = createDockerNetworkAuthoredProvider(false, true, false, { serviceIngress: true });
  const selected: AccessProviderSelectionV1 = { ...selection, credentialRefs: [] };
  const fixture = await journey('external', [], { providerSelection: selected, authoredProvider });
  expect(await prepareReachabilityReviewedChildrenForHost({
    actionId: 'machines.reachability.inspect', input: { serverId: 'generic-home', machineId },
    context: fixture.context(), runtimeRegistry: fixture.runtime.registry, selections: [], currentIngress: selected,
  })).toEqual({ children: [{ action: { pluginId: authoredProvider.pluginId, localId: 'inspect' }, role: 'inspect',
    input: { machineId, config: selected.config, credentialRefs: [] } }] });
});

it('reviews the contributed Home Relay route on the explicitly addressed Machine', async () => {
  const authoredProvider = createDockerNetworkAuthoredProvider(false, true, false, { serviceIngress: 'homeRelay' });
  const selected: AccessProviderSelectionV1 = { ...selection, credentialRefs: [] };
  const fixture = await journey('external', [], { providerSelection: selected, authoredProvider });
  const route = { ownerId: 'generic-home', hostname: 'relay.example.test', httpsPort: 443,
    path: '/', upstream: 'http://127.0.0.1:8123' };
  const input = { serverId: 'generic-home', machineId,
    change: { kind: 'homeRelay', selection: selected, relay: { channel: 'stable', mode: 'user' } } } as const;
  const homeRelay = { route, currentSelection: null };
  const context = fixture.context();
  const reviewed = await inspectMachineReachability(input, { ...fixture.dependencies(context), homeRelay });
  if (!('plan' in reviewed) || !reviewed.plan) throw new Error('Home Relay route did not reach review');
  const result = await prepareReachabilityReviewedChildrenForHost({ actionId: 'machines.reachability.configure',
    input: { ...input, reviewedPlanDigest: reviewed.plan.reviewedPlanDigest, reviewedPlanBasis: reviewed.plan.basis },
    context, runtimeRegistry: fixture.runtime.registry, selections: [], homeRelay });
  expect(result).toEqual({ children: [
    { action: { pluginId: authoredProvider.pluginId, localId: 'configure' }, role: 'configure',
      input: { machineId, route, config: selected.config, credentialRefs: [] } },
  ] });
});

it('publishes live facts for the selected contributed default ingress', async () => {
  const authoredProvider = createDockerNetworkAuthoredProvider(false, true, false, { serviceIngress: true });
  const selected: AccessProviderSelectionV1 = { ...selection, credentialRefs: [] };
  const fixture = await journey('external', [], { providerSelection: selected, authoredProvider });
  const api = await createGenericDefaultFactoryJourney(fixture);
  try {
    const snapshot = api.client.getMachineMetadataSnapshot();
    if (snapshot.status !== 'ready') throw new Error('The public Machine metadata is unavailable');
    expect(await api.client.compareAndSwapMachineMetadata({
      expectedMetadataVersion: snapshot.metadataVersion,
      metadata: { ...snapshot.metadata, reachabilityPosture: {
        revision: 1,
        management: { providers: [], publicSsh: { kind: 'open', port: 22, sourceCidrs: ['0.0.0.0/0'] },
          independentRecovery: { kind: 'providerConsole', evidence: 'verified' } },
        defaultServiceIngress: { kind: 'provider', selection: selected },
      } },
    })).toMatchObject({ status: 'applied' });
    const inspected = parseReachabilityInspectResult(await api.invoke('machines.reachability.inspect', {
      serverId: 'generic-home', machineId,
    }));
    expect(inspected.observation.ingress).toEqual([
      expect.objectContaining({ provider: selected.provider, state: 'needsSetup', remedies: ['configure'] }),
    ]);
  } finally { await api.dispose(); }
}, 120_000);

it('applies and disables a contributed Home Relay route on the admitted Machine', async () => {
  const authoredProvider = createDockerNetworkAuthoredProvider(false, true, false, { serviceIngress: 'homeRelay' });
  const selected: AccessProviderSelectionV1 = { ...selection, credentialRefs: [] };
  const fixture = await journey('external', [], { providerSelection: selected, authoredProvider });
  vi.mocked(homedir).mockReturnValue(fixture.directory);
  const relay = { channel: 'stable', mode: 'user' } as const;
  const defaults = resolveRelayRuntimeDefaults({ ...relay, homeDir: fixture.directory });
  await mkdir(defaults.installRoot, { recursive: true });
  await writeFile(join(defaults.installRoot, 'self-host-state.json'), JSON.stringify({ version: '0.3.0' }));
  const upstream = `http://${defaults.serverHost}:${defaults.serverPort}`;
  // The local Relay and the signed-in address expose the same Home identity.
  const fetchHome = vi.mocked(globalThis.fetch).getMockImplementation();
  if (!fetchHome) throw new Error('The fixture Home HTTP boundary is unavailable');
  vi.mocked(globalThis.fetch).mockImplementation(async (input, options) => {
    if (String(input) === `${upstream}/v1/features`) {
      return await fetchHome(`${fixture.accountRuntime.serverHttpBaseUrl}/v1/features`, options);
    }
    return await fetchHome(input, options);
  });
  const api = await createGenericDefaultFactoryJourney(fixture);
  try {
    const target = { serverId: 'generic-home', machineId };
    const hostname = 'relay.example.test';
    const publicUrl = `https://${hostname}`;
    const configure = async (selection: AccessProviderSelectionV1 | null) => {
      const review = parseReachabilityInspectResult(await api.invoke('machines.reachability.inspect', {
        ...target, change: { kind: 'homeRelay', relay, selection, ...(selection ? { hostname } : {}) },
      }));
      expect(review.plan?.basis).toMatchObject({ machineId, installationId, homeRelay: {
        ...(selection ? { route: { upstream, hostname } } : { currentRoute: { upstream, hostname } }),
      } });
      const { result } = await executeReviewedReachabilityConfigure(fixture, api, review);
      return parseCompletedReachabilityConfigure(result);
    };
    const read = async () => parseReachabilityInspectResult(await api.invoke('machines.reachability.inspect',
      { ...target, homeRelay: relay })).relayAccess;
    expect(await configure(selected)).toMatchObject({ status: 'applied', relayAccess: {
      configured: true, selection: selected, status: { state: 'enabled', shareUrl: publicUrl },
    } });
    expect(await read()).toMatchObject({ configured: true, status: { state: 'enabled', shareUrl: publicUrl } });
    expect(await configure(null)).toMatchObject({ status: 'applied', relayAccess: { configured: false, status: { state: 'disabled' } } });
    expect(await read()).toMatchObject({ configured: false, status: { state: 'disabled' } });
  } finally { await api.dispose(); }
}, 120_000);

describe('publication failure diagnostics', () => {
  let fixture: Awaited<ReturnType<typeof journey>>;
  let api: Awaited<ReturnType<typeof createGenericDefaultFactoryJourney>>;
  beforeEach(async () => {
    const authoredProvider = createDockerNetworkAuthoredProvider(false, true);
    const selected = { ...selection, provider: { pluginId: authoredProvider.pluginId, localId: 'docker-network' } };
    fixture = await journey('external', [], { providerSelection: selected, authoredProvider });
    api = await createGenericDefaultFactoryJourney(fixture);
  }, 120_000);

  it('retains the socket failure cause after saving the reviewed posture without exposing exception prose', async () => {
    try {
      const review = parseReachabilityInspectResult(await api.invoke('machines.reachability.inspect', {
        serverId: 'generic-home', machineId, change: { kind: 'posture', posture: {
          revision: 1, management: { providers: [], publicSsh: { kind: 'open', port: 22,
            sourceCidrs: ['0.0.0.0/0'] }, independentRecovery: { kind: 'providerConsole', evidence: 'verified' } },
          defaultServiceIngress: { kind: 'none' },
        } },
      }));
      api.setStatePublicationRejected(true);
      const { result } = await executeReviewedReachabilityConfigure(fixture, api, review);
      expect(result).toMatchObject({ ok: false, errorCode: 'machine_reachability_publication_unavailable',
        effectAttempted: true, failureCause: { phase: 'machines.reachability.publication',
          errorClass: 'Error', errorCode: 'ECONNRESET', httpStatus: null } });
      expect(JSON.stringify(result)).not.toContain('Synthetic Machine state Socket transport refusal');
      expect(api.client.getMachineMetadataSnapshot()).toMatchObject({ status: 'ready', metadata: {
        reachabilityPosture: review.plan?.basis.change.kind === 'posture' ? review.plan.basis.change.posture : undefined,
      } });
    } finally { api.setStatePublicationRejected(false); await api.dispose(); }
  });
});

it('keeps provider configuration out of the Home connector subject while retaining its canonical identity', () => {
  const subject = reachabilityConnectorSubject(selection, { machineId, installationId });
  expect(subject.connectorId).toMatch(/^[a-f0-9]{64}$/u);
  expect(JSON.stringify(subject)).not.toContain(selection.config.managementUrl);
  expect(JSON.stringify(subject)).not.toContain(selection.config.profileName);
  expect(reachabilityConnectorSubject({ ...selection,
    config: { profileName: selection.config.profileName, managementUrl: selection.config.managementUrl },
  }, { machineId, installationId })).toEqual(subject);
  expect(reachabilityConnectorSubject({ ...selection,
    config: { ...selection.config, profileName: 'Different selected profile' },
  }, { machineId, installationId }).connectorId).not.toBe(subject.connectorId);
});

it('retains a real reviewed-child no_plan cause through selected provider observation', async () => {
  const authoredProvider = createDockerNetworkAuthoredProvider(false, true);
  const selected = { ...selection, provider: { pluginId: authoredProvider.pluginId, localId: 'docker-network' } };
  const fixture = await journey('external', [], { providerSelection: selected, authoredProvider });
  const input = { serverId: 'generic-home', machineId,
    change: { kind: 'privateNetwork' as const, intent: 'join' as const, selection: selected } };
  const context = fixture.context();
  // Exercise the real canonical port's refusal; no provider or issuer is replaced.
  const hostReviewedChild = createHostReviewedChildPortV1({
    actionId: 'machines.reachability.configure', input, context,
  });
  await expect(inspectMachineReachability(input, fixture.dependencies({ ...context, hostReviewedChild })))
    .rejects.toMatchObject({ code: 'credential_scope_denied', errorCode: 'credential_scope_denied',
      failureCause: { phase: 'deployment.reviewed_child', errorClass: 'Error', errorCode: 'no_plan', httpStatus: null } });
  expect(fixture.hostNative.networkMutations()).toBe(0);
  expect(fixture.elevation.launches).toHaveLength(0);
});

// Reuse the Server QB87 disposable SQLite acquisition budget for each fresh
// Home; behavior stays under the CLI test body's unchanged 30-second budget.
describe('Manage grantee Saved Secret join', () => {
  let selected: AccessProviderSelectionV1;
  let fixture: Awaited<ReturnType<typeof journey>>;
  let api: Awaited<ReturnType<typeof createGenericDefaultFactoryJourney>>;
  const granteeAccountId = 'generic-manage-grantee';

  beforeEach(async () => {
    const authoredProvider = createDockerNetworkAuthoredProvider(false, true);
    selected = { ...selection, provider: { pluginId: authoredProvider.pluginId, localId: 'docker-network' } };
    fixture = await journey('external', [], { providerSelection: selected, authoredProvider });
    // A custodian's Account policy is not the grantee's invocation policy.
    // Borrowing it would refuse before this row reaches the actual grant set.
    fixture.home.setActionsSettingsForAccount('generic-owner', ActionsSettingsV1Schema.parse({ v: 1,
      actions: { 'machines.reachability.configure': { enabled: false } },
    }));
    fixture.home.setActionsSettingsForAccount(granteeAccountId, ActionsSettingsV1Schema.parse({ v: 1 }));
    api = await createGenericDefaultFactoryJourney(fixture, { manageGranteeAccountId: granteeAccountId });
  }, 120_000);

  it('joins another custodian Machine using the admitted Manage requester own Saved Secret and one parent approval', async () => {
    // Only terminal availability and text input are replaced. Another
    // custodian's Machine receives the sign-in with no prompt (owner ruling
    // 2026-11-23); a prompt that did appear would read a default-no answer.
    const terminalAvailability = vi.spyOn(terminalInput, 'isInteractiveTerminal').mockReturnValue(true);
    const terminalAnswer = vi.spyOn(terminalInput, 'promptInput').mockResolvedValue('no');
    try {
      expect(api.requesterAdmission).toMatchObject({ actorAccountId: granteeAccountId,
        custodianAccountId: 'generic-owner', machineId, installationId, role: 'manage', encryptionMode: 'plain' });
      expect(api.machine.access?.custodian.accountId).toBe('generic-owner');
      const review = parseReachabilityInspectResult(await api.invoke('machines.reachability.inspect', {
        serverId: 'generic-home', machineId, change: { kind: 'privateNetwork', intent: 'join', selection: selected },
      }));
      expect(fixture.hostNative.networkMutations()).toBe(0);
      expect(fixture.elevation.launches).toHaveLength(0);
      const configured = await executeReviewedReachabilityConfigure(fixture, api, review, {
        reviewArtifact(request) {
          const preview = request.preview;
          const storedPlan = preview && typeof preview === 'object' && !Array.isArray(preview) && 'hostReviewedChildren' in preview
            ? preview.hostReviewedChildren : undefined;
          const plan = HostReviewedChildrenPlanV1Schema.safeParse(storedPlan);
          // Observe only the real stored review's closed shape, never child operands or credentials.
          console.info('Manage retained reviewed child plan', {
            state: storedPlan === undefined ? 'absent' : !plan.success ? 'invalid'
              : plan.data.children.length === 0 ? 'empty' : 'present',
            count: plan.success ? plan.data.children.length : undefined,
            children: plan.success ? plan.data.children.map(child => ({
              inspectRole: child.role === 'inspect', joinRole: child.role === 'join',
              selectedInspectAction: typeof child.action !== 'string'
                && child.action.pluginId === fixture.authoredProvider?.pluginId && child.action.localId === 'inspect',
              selectedJoinAction: typeof child.action !== 'string'
                && child.action.pluginId === fixture.authoredProvider?.pluginId && child.action.localId === 'join',
              inputPresent: child.input !== undefined,
            })) : undefined,
          });
        },
      });
      expect(terminalAnswer).not.toHaveBeenCalled();
      expect(parseCompletedReachabilityConfigure(configured.result)).toMatchObject({ status: 'applied', selections: [selected],
        observation: { privateNetworks: [expect.objectContaining({ provider: selected.provider, state: 'ready' })] } });
      expect(fixture.home.connectorSetRequesterProofs, 'Actual grant set carries the admitted grantee installation signature').toEqual([true]);
      expect(fixture.home.secretMaterialReads).toContainEqual({ accountId: granteeAccountId, resourceId: 'generic-join-resource' });
      expect(fixture.home.secretMaterialReads.every(read => read.accountId === granteeAccountId)).toBe(true);
      expect(fixture.home.approvalRequests().map(request => request.actionId)).toEqual(['machines.reachability.configure']);
      expect(fixture.hostNative.networkMutations()).toBe(1);
      expect(fixture.elevation.launches.length).toBeGreaterThan(0);
      if (!review.plan?.basis.credentialFileReview) throw new Error('Expected the reviewed root-only join key path');
      await expect(readFile(review.plan.basis.credentialFileReview.path)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(JSON.stringify([review, configured.result, fixture.home.approvalRequests()])).not.toContain(fixture.privateSetupKey);
      expect(api.processBoundary.failures).toEqual([]);
    } finally {
      try { await api.dispose(); }
      finally { terminalAnswer.mockRestore(); terminalAvailability.mockRestore(); }
    }
  });
});

describe('reviewed role Require', () => {
  let authoredProvider: ReturnType<typeof createDockerNetworkAuthoredProvider>;
  let selected: AccessProviderSelectionV1;
  let fixture: Awaited<ReturnType<typeof journey>>;
  let api: Awaited<ReturnType<typeof createGenericDefaultFactoryJourney>>;

  beforeEach(async () => {
    authoredProvider = createDockerNetworkAuthoredProvider(false, true);
    selected = { ...selection,
      provider: { pluginId: authoredProvider.pluginId, localId: 'docker-network' } };
    fixture = await journey('external', [], { providerSelection: selected, authoredProvider });
    let settings = setActionApprovalOverride({ settings: ActionsSettingsV1Schema.parse({ v: 1 }),
      actionId: 'machines.reachability.configure', surface: 'cli', approvalRequired: false });
    const action = formatQualifiedPluginActionId({ pluginId: authoredProvider.pluginId, localId: 'join' });
    for (const surface of ['cli', 'plugin'] as const) {
      settings = setActionApprovalOverride({ settings, actionId: action, surface, approvalRequired: true });
    }
    fixture.home.setActionsSettings(settings);
    vi.stubEnv('HAPPIER_ACTIONS_SETTINGS_V1', JSON.stringify(settings));
    api = await createGenericDefaultFactoryJourney(fixture);
  }, 120_000);

  it('folds explicit role Require into a waived parent, then only ROOT P20 mutates membership', async () => {
    try {
      const rawReview = await api.invoke('machines.reachability.inspect', {
        serverId: 'generic-home', machineId,
        change: { kind: 'privateNetwork', intent: 'join', selection: selected },
      });
      const failedReview = ActionExecuteResultSchema.safeParse(rawReview);
      if (failedReview.success && !failedReview.data.ok) {
        expect(await api.readFailureDiagnostic(failedReview.data.error), 'Redacted public Inspect failure boundary').toBeUndefined();
      }
      const review = parseReachabilityInspectResult(rawReview);
      if (!review.plan?.basis.credentialFileReview) throw new Error('Expected the real reviewed protected key path');
      const input = { machineId, config: selected.config, credentialRefs: selected.credentialRefs };
      const children = [
        { action: { pluginId: authoredProvider.pluginId, localId: 'inspect' }, role: 'inspect', input },
        { action: { pluginId: authoredProvider.pluginId, localId: 'join' }, role: 'join',
          input: { ...input, setupCredentialFile: review.plan.basis.credentialFileReview.path } },
      ];
      let replayRootVerifications = 0;
      let requesterAcquisitionVerifications = 0;
      // Observe proof publication without replacing any internal behavior.
      // Later native readers may consume its lazy currentness separately.
      const retainedProofs = vi.spyOn(agentIsolationLaunchPolicy, 'retainVerifiedExternalActionRequester');
      const requesterStages = vi.spyOn(externalActionPhase, 'runTracedExternalActionStage');
      const configured = await executeReviewedReachabilityConfigure(fixture, api, review, {
        beforeDecision() {
          retainedProofs.mockClear();
          requesterStages.mockClear();
          const post = vi.mocked(axios.post).getMockImplementation();
          if (!post) throw new Error('The Home transport fixture is unavailable');
          vi.mocked(axios.post).mockImplementation(async (url, body, config) => {
            if (new URL(String(url)).pathname === '/v1/actions/machines.reachability.configure/execution-authorization/verify') {
              if (!retainedProofs.mock.calls.some(([proof]) => proof.authorization.binding.actionId === 'machines.reachability.configure')
                && fixture.home.approvalRequests().some(request => request.status === 'approved' || request.status === 'executing')) {
                replayRootVerifications++;
                // Credential reacquisition has its own existing root owner;
                // count it separately from origin admission/replay proof.
                requesterAcquisitionVerifications = requesterStages.mock.calls.filter(([actionId, , stage]) =>
                  actionId === 'machines.reachability.configure' && stage === 'requester.root_verification').length;
              }
            }
            return post(url, body, config);
          });
        },
        reviewArtifact(request) {
          expect(request.actionId).toBe('machines.reachability.configure');
          expect(request.preview).toMatchObject({ hostReviewedChildren: { children } });
        },
      });
      expect({ replay: replayRootVerifications - requesterAcquisitionVerifications,
        requesterAcquisition: requesterAcquisitionVerifications }, 'Home root verifications before replay proof publication')
        .toEqual({ replay: 1, requesterAcquisition: 1 });
      expect(parseCompletedReachabilityConfigure(configured.result)).toMatchObject({
        status: 'applied', selections: [selected],
        observation: { privateNetworks: [expect.objectContaining({ state: 'ready' })] },
      });
      expect(fixture.home.approvalRequests().map(request => request.actionId))
        .toEqual(['machines.reachability.configure']);
      if (!('modulesByPluginId' in api.runtime)) throw new Error('Expected the physical authored runtime');
      const moduleNamespace = api.runtime.modulesByPluginId.get(authoredProvider.pluginId);
      const readMutations: unknown = moduleNamespace && Reflect.get(moduleNamespace, 'readMutations');
      if (typeof readMutations !== 'function') throw new Error('Missing authored role observation');
      expect(readMutations()).toBe(0);
      expect(fixture.hostNative.networkMutations()).toBe(1);
      expect(fixture.elevation.launches.length).toBeGreaterThan(0);
      await expect(readFile(review.plan.basis.credentialFileReview.path)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(api.processBoundary.failures).toEqual([]);
    } finally {
      try { await api?.dispose(); }
      finally { vi.unstubAllEnvs(); }
    }
  });

  it.each(['foreign Account', 'missing snapshot'] as const)(
    'refuses reviewed Configure replay with %s instead of borrowing daemon policy', async fault => {
      try {
        const review = parseReachabilityInspectResult(await api.invoke('machines.reachability.inspect', {
          serverId: 'generic-home', machineId,
          change: { kind: 'privateNetwork', intent: 'join', selection: selected },
        }));
        const get = vi.mocked(axios.get).getMockImplementation();
        if (!get) throw new Error('The Home transport fixture is unavailable');
        let refusedReads = 0;
        let foreignSettingsReads = 0;
        const configured = await executeReviewedReachabilityConfigure(fixture, api, review, {
          beforeDecision() {
            // Only the reopened original requester is faulted: the deciding
            // invocation loads before the durable execution claim. All domain
            // admission and replay logic below the HTTP boundary stays real.
            vi.mocked(axios.get).mockImplementation(async (url, config) => {
              const path = new URL(String(url)).pathname;
              if (fixture.home.approvalRequests().some(request => request.status === 'executing')) {
                if (fault === 'foreign Account' && path === '/v1/account/profile') {
                  refusedReads++;
                  return { status: 200, data: { id: 'another-account' } };
                }
                if (path === '/v2/account/settings') {
                  if (fault === 'foreign Account') foreignSettingsReads++;
                  else {
                    refusedReads++;
                    return { status: 503, data: { error: 'settings_unavailable' } };
                  }
                }
              }
              return get(url, config);
            });
          },
        });
        expect(refusedReads).toBeGreaterThan(0);
        expect(configured.result).toMatchObject({ ok: false });
        expect(foreignSettingsReads).toBe(0);
        expect(fixture.hostNative.networkMutations()).toBe(0);
        expect(fixture.elevation.launches).toHaveLength(0);
        expect(await fixture.home.readConnectorGrantCount()).toBe(0);
      } finally {
        try { await api?.dispose(); }
        finally { vi.unstubAllEnvs(); }
      }
    });
});

describe('reviewed native leave', () => {
  let authoredProvider: ReturnType<typeof createDockerNetworkAuthoredProvider>;
  let selected: AccessProviderSelectionV1;
  let fixture: Awaited<ReturnType<typeof journey>>;
  let api: Awaited<ReturnType<typeof createGenericDefaultFactoryJourney>>;

  beforeEach(async () => {
    authoredProvider = createDockerNetworkAuthoredProvider(false, true);
    selected = { ...selection,
      provider: { pluginId: authoredProvider.pluginId, localId: 'docker-network' } };
    fixture = await journey('external', [selected], { providerSelection: selected, authoredProvider });
    fixture.hostNative.setNetworkJoined(true);
    const snapshot = fixture.metadata.read();
    expect(await fixture.metadata.port.compareAndSwap({ expectedMetadataVersion: snapshot.metadataVersion,
      metadata: { ...snapshot.metadata, accessProviderSelections: [selected] } })).toMatchObject({ status: 'applied' });
    api = await createGenericDefaultFactoryJourney(fixture);
  }, 120_000);

  it.each([false, true])('leaves a reviewed native membership through its accepted parent when already left is %s', async (alreadyLeft) => {
    try {
      const review = parseReachabilityInspectResult(await api.invoke('machines.reachability.inspect', {
        serverId: 'generic-home', machineId,
        change: { kind: 'privateNetwork', intent: 'leave', selection: selected },
      }));
      expect(review.plan?.basis.currentSelections).toEqual([selected]);
      if (alreadyLeft) fixture.hostNative.setNetworkJoined(false);
      const { result } = await executeReviewedReachabilityConfigure(fixture, api, review);
      expect(parseCompletedReachabilityConfigure(result)).toMatchObject({ status: 'applied', selections: [] });
      expect(fixture.hostNative.networkJoined()).toBe(false);
      expect(fixture.hostNative.networkMutations()).toBe(alreadyLeft ? 0 : 1);
      expect(await fixture.home.readConnectorGrantCount()).toBe(0);
      expect(fixture.home.approvalRequests().map(request => request.actionId))
        .toEqual(['machines.reachability.configure']);
      if (!('modulesByPluginId' in api.runtime)) throw new Error('Expected the physical authored runtime');
      const readMutations: unknown = api.runtime.modulesByPluginId.get(authoredProvider.pluginId)?.readMutations;
      if (typeof readMutations !== 'function') throw new Error('Missing authored role observation');
      expect(readMutations()).toBe(0);
      await expect(readFile(`/run/happier-machine-credentials/${encodeURIComponent(installationId)}.setup-key`))
        .rejects.toMatchObject({ code: 'ENOENT' });
      expect(api.processBoundary.failures).toEqual([]);
    } finally { await api.dispose(); }
  });

  it('refuses a modified reviewed native command even when its supplied digest is unchanged', async () => {
    try {
      const review = parseReachabilityInspectResult(await api.invoke('machines.reachability.inspect', {
        serverId: 'generic-home', machineId,
        change: { kind: 'privateNetwork', intent: 'leave', selection: selected },
      }));
      const step = review.plan?.basis.recipePlans[0]?.plan.steps.find(step => step.kind === 'command');
      if (!step || step.kind !== 'command') throw new Error('Expected the reviewed native leave command');
      step.args = ['leave', '--other-profile'];
      const { result } = await executeReviewedReachabilityConfigure(fixture, api, review);
      expect(result).toMatchObject({ ok: false, errorCode: 'plan_changed', effectAttempted: false });
      expect(fixture.hostNative.networkJoined()).toBe(true);
      expect(fixture.hostNative.networkMutations()).toBe(0);
      expect(fixture.elevation.launches).toHaveLength(0);
      expect(await fixture.home.readConnectorGrantCount()).toBe(0);
    } finally { await api.dispose(); }
  });

  it('refuses an unretained leave without changing native membership', async () => {
    try {
      const snapshot = api.client.getMachineMetadataSnapshot();
      if (snapshot.status !== 'ready') throw new Error('Expected the public Machine metadata');
      expect(await api.client.compareAndSwapMachineMetadata({ expectedMetadataVersion: snapshot.metadataVersion,
        metadata: { ...snapshot.metadata, accessProviderSelections: [] } })).toMatchObject({ status: 'applied' });
      const review = parseReachabilityInspectResult(await api.invoke('machines.reachability.inspect', {
        serverId: 'generic-home', machineId, change: { kind: 'privateNetwork', intent: 'leave', selection: selected },
      }));
      expect(review.plan?.basis.currentSelections).toEqual([]);
      const { result } = await executeReviewedReachabilityConfigure(fixture, api, review);
      expect(result).toMatchObject({ ok: false, errorCode: 'provider_conflict', effectAttempted: false });
      expect(fixture.hostNative.networkJoined()).toBe(true);
      expect(fixture.hostNative.networkMutations()).toBe(0);
      expect(await fixture.home.readConnectorGrantCount()).toBe(0);
    } finally { await api.dispose(); }
  });
});

describe.each([
    { binding: 'local', bound: true, enabled: false, incumbent: true },
    { binding: 'unreadable observed union', bound: false, enabled: false, incumbent: true },
    { binding: 'unobservable inventory', bound: false, enabled: false, incumbent: false },
    { binding: 'effectless prefix', bound: false, enabled: true, incumbent: true },
  ])('authored Docker recipe impact ($binding)', ({ binding, bound, enabled, incumbent }) => {
  let pluginId: string;
  let selected: AccessProviderSelectionV1;
  let fixture: Awaited<ReturnType<typeof journey>>;
  let api: Awaited<ReturnType<typeof createGenericDefaultFactoryJourney>>;

  beforeEach(async () => {
    vi.stubEnv('DOCKER_HOST', 'tcp://unrelated-engine.test:2376');
    vi.stubEnv('DOCKER_CONTEXT', 'unrelated-engine');
    const authoredProvider = createDockerNetworkAuthoredProvider(enabled, true, false, { installDockerService: true });
    pluginId = authoredProvider.pluginId;
    selected = { ...selection, provider: { pluginId, localId: 'docker-network' } };
    fixture = await journey('external', [selected], { providerSelection: selected, dockerUnitsAvailable: true,
      authoredProvider, dockerProcessAvailable: bound, dockerInventoryAvailable: incumbent });
    // This case starts with every prerequisite satisfied, including the
    // protected credential directory. No credential file exists or is acquired.
    if (enabled) await mkdir('/run/happier-machine-credentials', { mode: 0o700 });
    api = await createGenericDefaultFactoryJourney(fixture);
  }, 120_000);

  it(`admits the full public authored Docker recipe impact before credentials or host mutations (${binding})`, async () => {
    const review = parseReachabilityInspectResult(await api.invoke('machines.reachability.inspect', {
      serverId: 'generic-home', machineId, change: { kind: 'privateNetwork', intent: 'join', selection: selected },
    }));
    expect(review.plan?.basis.recipePlans.flatMap(entry => entry.plan.steps)).toContainEqual(expect.objectContaining({
      kind: 'serviceUnit', unit: 'docker.service',
    }));
    if (enabled) fixture.hostNative.setNetworkProfile('different-selected-profile');
    let release = () => {};
    let entered!: () => void;
    const running = new Promise<void>(resolve => { entered = resolve; });
    const held = incumbent ? machineNativeEffectAdmission.run({ operation: { operationId: 'held-public-compose', kind: 'fixture' },
      keys: [{ kind: 'composeProject', dockerEndpoint: fixture.hostNative.engineId, projectName: 'incumbent' }] }, async () => {
      entered(); await new Promise<void>(resolve => { release = resolve; });
    }) : Promise.resolve();
    if (incumbent) await running;
    try {
      const { result, request } = await executeReviewedReachabilityConfigure(fixture, api, review);
      if (!('modulesByPluginId' in api.runtime)) throw new Error('Expected the physical authored module');
      const moduleNamespace = api.runtime.modulesByPluginId.get(pluginId);
      const readMutations: unknown = moduleNamespace && Reflect.get(moduleNamespace, 'readMutations');
      if (typeof readMutations !== 'function') throw new Error('Missing authored fixture observation');
      const authoredMutations: unknown = readMutations();
      if (typeof authoredMutations !== 'number') throw new Error('Invalid authored fixture observation');
      console.info('Generic public journey stage', { stage: 'authored_impact_boundary',
        status: result.ok ? 'succeeded' : 'refused', errorCode: result.ok ? undefined : result.errorCode,
        effectAttempted: result.ok ? undefined : result.effectAttempted,
        retainedEffectAttempted: request.v === 2 ? request.execution?.effectAttempted : undefined,
        dockerReads: fixture.hostNative.engineReads(), dockerUnitMutations: fixture.hostNative.dockerUnitMutations,
        probeLaunches: api.processBoundary.probeLaunches, probeDispatchFailures: api.processBoundary.probeDispatchFailures,
        probeTerminals: api.processBoundary.probeTerminals, dockerFactReads: fixture.filesystem.dockerFactReads,
        probePreparation: api.processBoundary.probePreparation,
        systemOwnerReads: fixture.hostNative.calls.filter(command => command.args.includes('--system')).length,
        grants: await fixture.home.readConnectorGrantCount(), rootLaunches: fixture.elevation.launches.length,
        metadataWrites: api.metadataPublications.length, nativeMutations: fixture.hostNative.networkMutations(), authoredMutations });
      if (enabled) {
        // Configure's selected-profile observation refuses before ROOT or
        // key acquisition; no setup program was applied.
        expect(result).toMatchObject({ ok: false, errorCode: 'profile_conflict', effectAttempted: false });
        if (result.ok) throw new Error('Expected selected-profile refusal');
        expect(result.details).toBeUndefined();
        expect(request).toMatchObject({ v: 2, execution: { effectAttempted: false } });
        expect(fixture.hostNative.engineReads()).toBe(0);
        expect(fixture.hostNative.dockerUnitMutations).toEqual([]);
        expect(await fixture.home.readConnectorGrantCount()).toBe(0);
        expect(fixture.elevation.launches).toHaveLength(0);
        expect(api.metadataPublications).toHaveLength(0);
        expect(authoredMutations).toBe(0);
        expect(fixture.hostNative.networkMutations()).toBe(0);
        expect(fixture.home.approvalRequests().map(request => request.actionId)).toEqual(['machines.reachability.configure']);
        // Absence here proves pre-acquisition refusal, not credential cleanup.
        await expect(lstat(`/run/happier-machine-credentials/${encodeURIComponent(installationId)}.setup-key`))
          .rejects.toMatchObject({ code: 'ENOENT' });
        return;
      }
      if (!incumbent) {
        expect(result).toMatchObject({ ok: true });
        expect(fixture.hostNative.dockerUnitMutations.length).toBeGreaterThan(0);
        return;
      }
      expect(fixture.hostNative.dockerUnitMutations).toEqual([]);
      expect(result).toMatchObject({ ok: false, errorCode: 'effect_in_progress',
        effectAttempted: false });
      expect(request).toMatchObject({ v: 2, execution: { effectAttempted: false } });
      expect(fixture.hostNative.networkMutations()).toBe(0);
      if (incumbent) {
        if (result.ok) throw new Error('Expected native admission refusal');
        expect(result.details).toEqual({ actionOperationId: 'held-public-compose' });
        expect(readApprovalExecutionFailure(request)).toMatchObject({ errorCode: 'effect_in_progress',
          details: { actionOperationId: 'held-public-compose' } });
      }
      expect(fixture.hostNative.engineReads()).toBe(incumbent ? 0 : 1);
      expect(fixture.home.approvalRequests().map(request => request.actionId)).toEqual(['machines.reachability.configure']);
      expect(await fixture.home.readConnectorGrantCount()).toBe(0);
      expect(fixture.elevation.launches).toHaveLength(0);
      expect(api.metadataPublications).toHaveLength(0);
      expect(authoredMutations).toBe(0);
    } finally { release(); await held; await api.dispose(); }
  });
});

describe('independent Generic join', () => {
  let selected: AccessProviderSelectionV1;
  let fixture: Awaited<ReturnType<typeof journey>>;
  let api: Awaited<ReturnType<typeof createGenericDefaultFactoryJourney>>;

  beforeEach(async () => {
    // Same deciding invariant through a physical generic author:
    // NetBird production declarations remain deferred and unactivated.
    const authoredProvider = createDockerNetworkAuthoredProvider(false, true);
    selected = { ...selection, provider: { pluginId: authoredProvider.pluginId, localId: 'docker-network' } };
    fixture = await journey('external', [], { providerSelection: selected, authoredProvider });
    api = await createGenericDefaultFactoryJourney(fixture);
  }, 120_000);

  it.each(['disabled', 'applying', 'unavailable', 'unseparated'] as const)(
    'reports the isolation prerequisite before Saved Secret acquisition when isolation is %s', async state => {
    try {
      if (state === 'disabled') {
        await api.client.updateMachineMetadata(metadata => {
          if (!metadata) throw new Error('Expected the published Machine metadata');
          return { ...metadata, agentIsolation: { enabled: false } };
        });
        expect(api.client.getAgentIsolationSnapshot()).toMatchObject({ enabled: false });
      } else if (state === 'unseparated') {
        fixture.identity.setAgentGroupIds([fixture.identity.agentUid, fixture.identity.daemon.gid]);
      } else {
        const status = state === 'applying' ? { kind: 'applying', phase: 'account' } as const
          : { kind: 'unavailable', code: 'provisioning_unavailable' } as const;
        await api.client.updateDaemonState(current => ({ ...current, agentIsolation: status }));
        expect(api.client.getAgentIsolationSnapshot()).toMatchObject({ enabled: true, status });
      }
      const materialReads = fixture.home.secretMaterialReads.length;
      const result = await api.invoke('machines.reachability.inspect', {
        serverId: 'generic-home', machineId, change: { kind: 'privateNetwork', intent: 'join', selection: selected },
      });
      expect(result).toMatchObject({ ok: false, errorCode: 'agent_isolation_unavailable' });
      expect(result).not.toHaveProperty('result.plan');
      expect(fixture.home.secretMaterialReads).toHaveLength(materialReads);
      expect(fixture.hostNative.networkMutations()).toBe(0);
      expect(fixture.elevation.launches).toHaveLength(0);
    } finally { await api.dispose(); }
  });

  it('keeps a public Generic join independent of an incumbent Docker engine with zero Docker reads', async () => {
    let release!: () => void;
    let entered!: () => void;
    const running = new Promise<void>(resolve => { entered = resolve; });
    const held = machineNativeEffectAdmission.run({ operation: { operationId: 'held-unrelated-engine', kind: 'fixture' },
      keys: [{ kind: 'composeProject', dockerEndpoint: fixture.hostNative.engineId, projectName: 'incumbent' }] }, async () => {
      entered(); await new Promise<void>(resolve => { release = resolve; });
    });
    await running;
    try {
      const review = parseReachabilityInspectResult(await api.invoke('machines.reachability.inspect', {
        serverId: 'generic-home', machineId, change: { kind: 'privateNetwork', intent: 'join', selection: selected },
      }));
      expect(parseCompletedReachabilityConfigure((await executeReviewedReachabilityConfigure(fixture, api, review)).result))
        .toMatchObject({ status: 'applied' });
      expect(fixture.hostNative.engineReads()).toBe(0);
      expect(fixture.hostNative.calls.filter(command => command.args.includes('--system'))).toEqual([]);
      expect(fixture.hostNative.networkMutations()).toBe(1);
      await expect(readFile(`/run/happier-machine-credentials/${encodeURIComponent(installationId)}.setup-key`))
        .rejects.toMatchObject({ code: 'ENOENT' });
      expect(await fixture.home.readConnectorGrantCount()).toBe(0);
      expect(api.processBoundary.failures).toEqual([]);
    } finally { release(); await held; await api.dispose(); }
  });

  it.each([false, true])('removes the exact Home join grant after a native command fails during consumption (publicationRejected: %s)', async rejectPublication => {
    let grantCountAtNativeFailure: number | undefined;
    fixture.hostNative.setOnNetworkMutation(async () => {
      // Assert this observation after the command returns: a native adapter
      // exception must not hide a failed test assertion inside its error path.
      grantCountAtNativeFailure = await fixture.home.readConnectorGrantCount();
      throw Object.assign(new Error('Synthetic native command IO failure'), { code: 'EIO' });
    });
    try {
      const review = parseReachabilityInspectResult(await api.invoke('machines.reachability.inspect', {
        serverId: 'generic-home', machineId, change: { kind: 'privateNetwork', intent: 'join', selection: selected },
      }));
      api.setStatePublicationRejected(rejectPublication);
      const { result, request } = await executeReviewedReachabilityConfigure(fixture, api, review);
      // The command may already have changed native state before EIO. The
      // canonical host reports that uncertainty as a typed Configure result,
      // not a known pre-effect Action refusal or a successful applied join.
      if (rejectPublication) {
        expect(result).toMatchObject({ ok: false, errorCode: 'native_effect_failed', effectAttempted: true,
          failureCause: { phase: 'machines.reachability.publication', errorCode: 'ECONNRESET' } });
        expect(request.execution).toMatchObject({ ok: false, errorCode: 'native_effect_failed' });
      } else {
        expect(parseCompletedReachabilityConfigure(result))
          .toMatchObject({ status: 'outcome_unknown', errorCode: 'native_effect_failed' });
        expect(request.execution).toMatchObject({ ok: true,
          result: { status: 'outcome_unknown', errorCode: 'native_effect_failed' } });
      }
      expect(grantCountAtNativeFailure).toBe(1);
      const nativeFailures = fixture.elevation.diagnostics.flatMap(diagnostic => diagnostic.records)
        .filter(record => record.type === 'result' && record.stepId === 'network-join');
      expect(nativeFailures).toEqual([expect.objectContaining({ resultStatus: 'outcome_unknown',
        nativeReason: 'native_effect_failed', completedStepIds: ['access-provider-setup-key'] })]);
      expect(fixture.hostNative.networkMutations()).toBe(1);
      await expect(readFile(`/run/happier-machine-credentials/${encodeURIComponent(installationId)}.setup-key`))
        .rejects.toMatchObject({ code: 'ENOENT' });
      expect(await fixture.home.readConnectorGrantCount()).toBe(0);
      expect(api.processBoundary.failures).toEqual([]);
    } finally { api.setStatePublicationRejected(false); fixture.hostNative.setOnNetworkMutation(undefined); await api.dispose(); }
  });
});

describe('native busy producer through the public caller', () => {
  let selected: AccessProviderSelectionV1;
  let fixture: Awaited<ReturnType<typeof journey>>;
  let api: Awaited<ReturnType<typeof createGenericDefaultFactoryJourney>>;

  beforeEach(async () => {
    const authoredProvider = createDockerNetworkAuthoredProvider();
    selected = { ...selection, provider: { pluginId: authoredProvider.pluginId, localId: 'docker-network' } };
    fixture = await journey('external', [selected], { providerSelection: selected, authoredProvider,
      dockerUnitsAvailable: true, dockerProcessAvailable: true });
    api = await createGenericDefaultFactoryJourney(fixture);
  }, 120_000);

  it('keeps the pre-effect native busy producer fact before durable CLI settlement', async () => {
    let release!: () => void;
    let entered!: () => void;
    const running = new Promise<void>(resolve => { entered = resolve; });
    const held = machineNativeEffectAdmission.run({ operation: { operationId: 'held-owner-compose', kind: 'fixture' },
      keys: [{ kind: 'composeProject', dockerEndpoint: fixture.hostNative.engineId, projectName: 'incumbent' }] }, async () => {
      entered(); await new Promise<void>(resolve => { release = resolve; });
    });
    await running;
    try {
      const review = parseReachabilityInspectResult(await api.invoke('machines.reachability.inspect', {
        serverId: 'generic-home', machineId, change: { kind: 'privateNetwork', intent: 'join', selection: selected },
      }));
      const { result, request } = await executeReviewedReachabilityConfigure(fixture, api, review);
      console.info('Generic public journey stage', { stage: 'native_busy_producer',
        errorCode: result.ok ? undefined : result.errorCode, effectAttempted: result.ok ? undefined : result.effectAttempted,
        dockerReads: fixture.hostNative.engineReads(), dockerUnitMutations: fixture.hostNative.dockerUnitMutations,
        grants: await fixture.home.readConnectorGrantCount(), rootLaunches: fixture.elevation.launches.length, metadataWrites: fixture.metadata.writes.length });
      expect(result).toMatchObject({ ok: false, errorCode: 'effect_in_progress', effectAttempted: false,
        details: { actionOperationId: 'held-owner-compose' } });
      expect(request.execution).toMatchObject({ ok: false, errorCode: 'effect_in_progress', effectAttempted: false,
        details: { actionOperationId: 'held-owner-compose' } });
      expect(readApprovalExecutionFailure(request)).toMatchObject({ ok: false, errorCode: 'effect_in_progress',
        details: { actionOperationId: 'held-owner-compose' } });
      expect(fixture.hostNative.dockerUnitMutations).toEqual([]);
      expect(await fixture.home.readConnectorGrantCount()).toBe(0);
      expect(fixture.elevation.launches).toHaveLength(0);
      expect(fixture.metadata.writes).toHaveLength(0);
    } finally { release(); await held; await api.dispose(); }
  });
});

describe('local Docker setup before profile refusal', () => {
  let authoredProvider: ReturnType<typeof createDockerNetworkAuthoredProvider>;
  let selected: AccessProviderSelectionV1;
  let fixture: Awaited<ReturnType<typeof journey>>;
  let api: Awaited<ReturnType<typeof createGenericDefaultFactoryJourney>>;

  beforeEach(async () => {
    authoredProvider = createDockerNetworkAuthoredProvider(false, true, false, { installDockerService: true });
    selected = { ...selection, provider: { pluginId: authoredProvider.pluginId, localId: 'docker-network' } };
    fixture = await journey('external', [selected], { providerSelection: selected, authoredProvider,
      dockerUnitsAvailable: true, dockerProcessAvailable: true });
    api = await createGenericDefaultFactoryJourney(fixture);
  }, 120_000);

  it('preserves changed Docker setup evidence when the selected native profile refuses before credential acquisition', async () => {
    try {
      const review = parseReachabilityInspectResult(await api.invoke('machines.reachability.inspect', {
        serverId: 'generic-home', machineId, change: { kind: 'privateNetwork', intent: 'join', selection: selected },
      }));
      fixture.hostNative.setOnDockerUnitMutation(operation => {
        if (operation === 'disable') fixture.hostNative.setNetworkProfile('different-selected-profile');
      });
      const { result, request } = await executeReviewedReachabilityConfigure(fixture, api, review);
      expect(result).toMatchObject({ ok: false, errorCode: 'profile_conflict', effectAttempted: true,
        details: { setupOutcome: 'applied' } });
      expect(request).toMatchObject({ v: 2, execution: { effectAttempted: true } });
      expect(fixture.hostNative.dockerUnitMutations).toEqual(['disable']);
      expect(fixture.hostNative.engineReads()).toBeGreaterThan(0);
      expect(api.processBoundary.probeDispatchFailures).toEqual([]);
      expect(api.processBoundary.failures).toEqual([]);
      expect(await fixture.home.readConnectorGrantCount()).toBe(0);
      expect(api.metadataPublications).toHaveLength(0);
      expect(fixture.hostNative.networkMutations()).toBe(0);
      if (!('modulesByPluginId' in api.runtime)) throw new Error('Expected the physical authored module');
      const readMutations: unknown = api.runtime.modulesByPluginId.get(authoredProvider.pluginId)?.readMutations;
      if (typeof readMutations !== 'function') throw new Error('Missing authored fixture observation');
      expect(readMutations()).toBe(0);
      expect(fixture.home.approvalRequests().map(request => request.actionId)).toEqual(['machines.reachability.configure']);
      // No grant was acquired: absence is not evidence of post-join cleanup.
      await expect(lstat(`/run/happier-machine-credentials/${encodeURIComponent(installationId)}.setup-key`))
        .rejects.toMatchObject({ code: 'ENOENT' });
    } finally { await api.dispose(); }
  });
});

describe('revoked next credential acquisition', () => {
  let selected: AccessProviderSelectionV1;
  let fixture: Awaited<ReturnType<typeof journey>>;
  let api: Awaited<ReturnType<typeof createGenericDefaultFactoryJourney>>;

  beforeEach(async () => {
    const authoredProvider = createDockerNetworkAuthoredProvider(false, true);
    selected = { ...selection, provider: { pluginId: authoredProvider.pluginId, localId: 'docker-network' } };
    fixture = await journey('external', [], { providerSelection: selected, authoredProvider });
    api = await createGenericDefaultFactoryJourney(fixture);
  }, 120_000);

  it('N15 removes the captured root-only join key on revoke and refuses the next acquisition', async () => {
    try {
      const review = parseReachabilityInspectResult(await api.invoke('machines.reachability.inspect', {
        serverId: 'generic-home', machineId, change: { kind: 'privateNetwork', intent: 'join', selection: selected },
      }));
      fixture.hostNative.setOnNetworkMutation(() => fixture.home.revoke());
      const { result } = await executeReviewedReachabilityConfigure(fixture, api, review);
      expect(fixture.hostNative.networkMutations()).toBe(1);
      await expect(readFile(`/run/happier-machine-credentials/${encodeURIComponent(installationId)}.setup-key`))
        .rejects.toMatchObject({ code: 'ENOENT' });
      expect(result).toMatchObject({ ok: true, result: { status: 'applied', selections: [selected] } });
      // A later real native disconnect requires a new acquisition. Revocation
      // affects that next boundary, not this already admitted cleanup.
      fixture.hostNative.setOnNetworkMutation(undefined);
      fixture.hostNative.setNetworkJoined(false);
      const next = parseReachabilityInspectResult(await api.invoke('machines.reachability.inspect', {
        serverId: 'generic-home', machineId, change: { kind: 'privateNetwork', intent: 'join', selection: selected },
      }));
      expect((await executeReviewedReachabilityConfigure(fixture, api, next)).result)
        .toMatchObject({ ok: false, errorCode: 'secret_missing' });
      expect(fixture.hostNative.networkMutations()).toBe(1);
      await expect(readFile(`/run/happier-machine-credentials/${encodeURIComponent(installationId)}.setup-key`))
        .rejects.toMatchObject({ code: 'ENOENT' });
    } finally { await api.dispose(); }
  });
});

describe('single Home admission and metadata continuity', () => {
  let selected: AccessProviderSelectionV1;
  let fixture: Awaited<ReturnType<typeof journey>>;
  let api: Awaited<ReturnType<typeof createGenericDefaultFactoryJourney>>;

  beforeEach(async () => {
    const authoredProvider = createDockerNetworkAuthoredProvider(false, true);
    selected = { ...selection, provider: { pluginId: authoredProvider.pluginId, localId: 'docker-network' } };
    fixture = await journey('external', [], { providerSelection: selected, authoredProvider });
    const settings = setActionApprovalOverride({ settings: ActionsSettingsV1Schema.parse({ v: 1 }),
      actionId: 'machines.reachability.configure', surface: 'cli', approvalRequired: false });
    fixture.home.setActionsSettings(settings);
    vi.stubEnv('HAPPIER_ACTIONS_SETTINGS_V1', JSON.stringify(settings));
    api = await createGenericDefaultFactoryJourney(fixture);
  }, 120_000);

  it('N11/N12/N13/N21 checks Home once and preserves an unrelated metadata update across native stages', async () => {
    // Call-through observation only: the canonical metadata logic stays real.
    const metadataReads = vi.spyOn(api.client, 'getMachineMetadataSnapshot');
    let readsAtMutation = 0, writesAtMutation = 0;
    fixture.hostNative.setOnNetworkMutation(async () => {
      const current = api.client.getMachineMetadataSnapshot();
      if (current.status !== 'ready') throw new Error('The public Machine metadata is unavailable');
      expect(await api.client.compareAndSwapMachineMetadata({ expectedMetadataVersion: current.metadataVersion,
        metadata: { ...current.metadata, displayName: 'Changed during join' } })).toMatchObject({ status: 'applied' });
      readsAtMutation = metadataReads.mock.calls.length; writesAtMutation = api.metadataPublications.length;
    });
    try {
      const review = parseReachabilityInspectResult(await api.invoke('machines.reachability.inspect', {
        serverId: 'generic-home', machineId, change: { kind: 'privateNetwork', intent: 'join', selection: selected },
      }));
      const homeVerifies = fixture.home.requests.filter(request => request.path.endsWith('/admission/verify')).length;
      const rootAdmissionPath = bindExternalActionExecutionAuthorizationVerifyHttpPathV1('machines.reachability.configure');
      const rootAdmissions = fixture.home.requests.filter(request => request.method === 'POST' && request.path === rootAdmissionPath).length;
      const result = ActionExecuteResultSchema.parse(await api.runOriginalCli(fixture.configureInput(review)));
      expect(fixture.hostNative.networkMutations()).toBe(1);
      expect(result).toMatchObject({ ok: true, result: { status: 'applied' } });
      // The installed requester preparation owns the one actual Home admission.
      // The unchanged effect target consumes it instead of repeating a phase.
      expect(fixture.home.requests.filter(request => request.method === 'POST' && request.path === rootAdmissionPath).length
        - rootAdmissions).toBe(1);
      expect(fixture.home.requests.filter(request => request.path.endsWith('/admission/verify')).length - homeVerifies).toBe(0);
      // Each actual field settlement owns its read. All other post-native
      // metadata reads here are the redundant currentness checks being removed.
      expect(metadataReads.mock.calls.length - readsAtMutation - (api.metadataPublications.length - writesAtMutation)).toBe(0);
      expect(api.client.getMachineMetadataSnapshot()).toMatchObject({ status: 'ready', metadata: { displayName: 'Changed during join' } });
    } finally { await api.dispose(); }
  });
});

describe('parent role and selected profile', () => {
  let authoredProvider: ReturnType<typeof createDockerNetworkAuthoredProvider>;
  let selected: AccessProviderSelectionV1;
  let fixture: Awaited<ReturnType<typeof journey>>;
  let api: Awaited<ReturnType<typeof createGenericDefaultFactoryJourney>>;

  beforeEach(async () => {
    authoredProvider = createDockerNetworkAuthoredProvider(false, true, true);
    selected = { ...selection, provider: { pluginId: authoredProvider.pluginId, localId: 'docker-network' } };
    fixture = await journey('external', [], { providerSelection: selected, authoredProvider, nativeClientInitiallyAvailable: false });
    api = await createGenericDefaultFactoryJourney(fixture);
  }, 120_000);

  it('N06/N09/N10/N17 binds one parent role and refuses a changed selected profile before joining', async () => {
    try {
      await expect(lstat('/usr/bin/network-client')).rejects.toMatchObject({ code: 'ENOENT' });
      const review = parseReachabilityInspectResult(await api.invoke('machines.reachability.inspect', {
        serverId: 'generic-home', machineId, change: { kind: 'privateNetwork', intent: 'join', selection: selected },
      }));
      const current = api.client.getMachineMetadataSnapshot();
      if (current.status !== 'ready') throw new Error('The public Machine metadata is unavailable');
      expect(await api.client.compareAndSwapMachineMetadata({ expectedMetadataVersion: current.metadataVersion,
        metadata: { ...current.metadata, serviceWatchesV1: { v: 1, watches: [] } } })).toMatchObject({ status: 'applied' });
      const joined = await executeReviewedReachabilityConfigure(fixture, api, review);
      expect(parseCompletedReachabilityConfigure(joined.result)).toMatchObject({ status: 'applied' });
      const installed = await lstat('/usr/bin/network-client');
      expect({ uid: installed.uid, gid: installed.gid, mode: installed.mode & 0o777 }).toEqual({ uid: 0, gid: 0, mode: 0o755 });
      if (!('modulesByPluginId' in api.runtime)) throw new Error('Expected physical authored runtime');
      const readRoles: unknown = api.runtime.modulesByPluginId.get(authoredProvider.pluginId)?.readMutations;
      if (typeof readRoles !== 'function') throw new Error('Missing physical role observation');
      expect(readRoles()).toBe(0);
      expect(fixture.hostNative.networkMutations()).toBe(1);
      fixture.hostNative.setNetworkJoined(false);
      const next = parseReachabilityInspectResult(await api.invoke('machines.reachability.inspect', {
        serverId: 'generic-home', machineId, change: { kind: 'privateNetwork', intent: 'join', selection: selected },
      }));
      const rootLaunchesBeforeRefusal = fixture.elevation.launches.length;
      fixture.hostNative.setNetworkProfile('different-selected-profile');
      const refused = await executeReviewedReachabilityConfigure(fixture, api, next);
      expect(refused.result).toMatchObject({ ok: false, errorCode: 'profile_conflict', effectAttempted: false });
      expect(refused.request).toMatchObject({ v: 2, execution: { effectAttempted: false } });
      expect(fixture.elevation.launches).toHaveLength(rootLaunchesBeforeRefusal);
      expect(fixture.hostNative.networkMutations()).toBe(1);
    } finally { await api.dispose(); }
  });
});


});

