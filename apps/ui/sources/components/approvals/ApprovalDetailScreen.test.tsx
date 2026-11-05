import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  approvalArtifactBodyMatchesHeaderV1,
  TargetActionApprovalRequestV1Schema,
  ApprovalRequestV2Schema,
  buildApprovalRequestArtifactHeaderV1,
  buildTargetActionApprovalArtifactHeaderV1,
  computeWorkspaceSyncPolicyDigest,
  type ApprovalRequestV1,
  type ApprovalRequestV2,
  type HandoffTargetApprovalConsequenceV1,
  WorkspaceSyncConflictResolutionResultV1Schema,
} from '@happier-dev/protocol';
import type { Machine, Session } from '@/sync/domains/state/storageTypes';
import { collectRenderedTestIds } from '@/dev/testkit/render/collectRenderedTestIds';
import { createMachineFixture, createPlainMachineRowFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { createLockedEncryptedSessionByIdResponseFixture, createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { renderScreen as renderUiScreen } from '@/dev/testkit/render/renderScreen';
import { standardCleanup, createRootLayoutFeaturesResponse } from '@/dev/testkit';
import { createProviderSettingsAccountHarness } from '@/dev/testkit/harness/providerSettingsHarness';
import { createUiApprovalRequest } from '@/dev/testkit/harness/approvalInbox';
import { waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installBrowserRuntimeForTests } from '@/dev/testkit/harness/browserRuntimeHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { installSessionActionRpcBoundary } from '@/dev/testkit/harness/sessionActionRpcBoundary';
import { encodePlainArtifactStoredContent, decodePlainArtifactStoredContent, ARTIFACT_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol/storage/artifactStoredContent';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import type { Artifact, DecryptedArtifact } from '@/sync/domains/artifacts/artifactTypes';
import { ExternalActionRequestEnvelopeV1Schema, ExternalActionResponseEnvelopeV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { buildApprovalExecutionOriginV1 } from '@happier-dev/protocol/actions/actionExecutor';
import { buildApprovalRequesterConfirmationV1 } from '@happier-dev/protocol/approvals/approvalRequestV1';
import { projectTargetActionApprovalInvocationV1 } from '@happier-dev/protocol/approvals/targetActionApprovalRequestV1';
import { computeExternalActionRequestEnvelopeDigestV1, signExternalActionApprovalInputV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import type { ActionExecutorContext } from '@happier-dev/protocol/actions/executor/types';
import tweetnacl from 'tweetnacl';
import { encodeBase64 } from '@happier-dev/protocol/crypto/base64';
import { installApprovalCommonModuleMocks } from './approvalsTestHelpers';
import { createTriageSelectedPrStartApprovalInput } from '../../../../../packages/plugins/triage/src/sessions/testkit/entrySessionTestkit.test-support';

vi.mock('socket.io-client', async importOriginal =>
  (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));

const loadActivitySpinner = async () =>
  (await import('@/components/ui/feedback/ActivitySpinner')).ActivitySpinner;

/** Text actually rendered by the real rows and their structured-value children. */
function readRenderedText(
  screen: Awaited<ReturnType<typeof renderScreen>>,
): string {
  return screen.getTextContent();
}

/**
 * The real Item owns rendering element-valued subtitles inside this screen.
 */
async function readRenderedTextWithRowContent(
  screen: Awaited<ReturnType<typeof renderScreen>>,
): Promise<string> {
  return readRenderedText(screen);
}

describe('approval field semantics shared by card and page', () => {
  it.each(['card', 'page'] as const)(
    'preserves principal kinds, ids and arbitrary JSON in the %s',
    async (anatomy) => {
      const { describeApprovalActionFields } =
        await import('./approvalFieldValues');
      const { ActionApprovalFieldsCard } =
        await import('./ActionApprovalFieldsCard');
      for (const kind of ['account', 'team', 'group']) {
        const principal = {
          kind,
          ...(kind === 'group' ? { teamId: 'team-1' } : {}),
          [`${kind}Id`]: 'session-1',
        };
        const screen = await renderScreen(
          <ActionApprovalFieldsCard
            anatomy={anatomy}
            serverId="ui-A"
            presentation={describeApprovalActionFields({
              actionId: 'machines.access.grant.set',
              actionArgs: {
                serverId: 'ui-A',
                machineId: 'machine',
                principal,
                level: 'view',
              },
            })}
          />,
        );
        // Every key and value reads as a labelled entry; the literal is never shown raw.
        const text = await readRenderedTextWithRowContent(screen);
        // A discriminator reads as a word ("Kind Account"); ids stay exact.
        expect(text).toContain(
          `Kind ${kind.charAt(0).toUpperCase()}${kind.slice(1)}`,
        );
        expect(text).toContain(
          `${kind.charAt(0).toUpperCase()}${kind.slice(1)} id session-1`,
        );
        if (kind === 'group') expect(text).toContain('Team id team-1');
        expect(text).not.toContain(JSON.stringify(principal));
      }
      const value = {
        kind: 'session',
        sessionId: 'session-1',
        empty: '',
        absent: null,
      };
      const screen = await renderScreen(
        <ActionApprovalFieldsCard
          anatomy={anatomy}
          serverId="ui-A"
          presentation={describeApprovalActionFields({
            actionId: 'settings.set',
            actionArgs: { anchor: 'example', value },
          })}
        />,
      );
      const text = await readRenderedTextWithRowContent(screen);
      for (const entry of [
        'Kind Session',
        'Session id session-1',
        'Empty ""',
      ])
        expect(text).toContain(entry);
      // An unset (`null`) member reads under Technical details, like an empty list or object.
      expect(text).not.toContain('Absent null');
      expect(text).not.toContain(JSON.stringify(value));
    },
  );
  it.each(['card', 'page'] as const)(
    'names only the typed Voice target on its own Home in the %s',
    async (anatomy) => {
      const { describeApprovalActionFields } =
        await import('./approvalFieldValues');
      const { ActionApprovalFieldsCard } =
        await import('./ActionApprovalFieldsCard');
      const previous = sessionFixturesByServerId;
      sessionFixturesByServerId = {
        ...previous,
        'other-home': {
          'voice-session': createSessionFixture({
            id: 'voice-session',
            encryptionMode: 'plain',
            encryptedContentAvailability: 'ready',
            metadata: {
              name: 'Voice target elsewhere',
              path: '/repo',
              host: 'example.test',
            },
          }),
        },
      };
      try {
        await prepareApprovalFixture();
        const targetHomeId = homeIds['other-home'];
        if (!targetHomeId) throw new Error('Expected the typed Voice target Home fixture');
        const screen = await renderScreen(
          <ActionApprovalFieldsCard
            anatomy={anatomy}
            serverId="ui-A"
            presentation={describeApprovalActionFields({
              actionId: 'ui.voice_global.start',
              actionArgs: {
                target: {
                  kind: 'session',
                  sessionAddress: {
                    serverId: targetHomeId,
                    sessionId: 'voice-session',
                  },
                },
                expectedAttempt: null,
              },
            })}
          />,
        );
        expect(readRenderedText(screen)).toContain('Voice target elsewhere');
        expect(readRenderedText(screen)).not.toContain('voice-session');
      } finally {
        sessionFixturesByServerId = previous;
      }
    },
  );
});

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const backSpy = vi.fn();
const pushSpy = vi.fn();
const dismissToSpy = vi.fn();
let approvalHomeFixture: {
  kind: 'resolved' | 'missing';
  serverIdentityId: string;
  profile?: { id: string; serverIdentityId: string; name: string; serverUrl?: string };
} = {
  kind: 'resolved',
  serverIdentityId: 'srv_approval_home_a',
  profile: { id: 'ui-A', serverIdentityId: 'srv_approval_home_a', name: '' },
};
let modalConfirmResult = true;
const defaultApprovalArtifactBody = {
  v: 1 as const,
  status: 'open' as const,
  createdAtMs: 1,
  updatedAtMs: 1,
  createdBy: {
    surface: 'agent' as const,
    agentId: 'codex',
    sessionId: 'session-1',
  },
  actionId: 'session.user_action.answer',
  actionArgs: {
    sessionId: 'session-1',
    requestId: 'ask-1',
    answers: [{ question: 'Continue?', values: ['Yes'] }],
  },
  summary: 'Approve answering the user',
  preview: {
    kind: 'user_action',
    summary: 'Agent wants to answer the pending question',
  },
};

function createApprovalArtifact(serverId?: string) {
  return {
    id: 'artifact-1',
    header: {
      v: 1,
      kind: 'approval_request.v1',
      title: 'Approve answering the user',
      approvalStatus: 'open',
      actionId: 'session.user_action.answer',
      sessionId: 'session-1',
      sessions: ['session-1'],
    },
    body: JSON.stringify({
      ...defaultApprovalArtifactBody,
      ...(serverId ? { serverId } : {}),
    }),
  };
}

async function createBuiltInApprovalArtifact(
  input: Readonly<{
    actionId: ApprovalRequestV2['actionId'];
    actionArgs: ApprovalRequestV2['actionArgs'];
    summary: string;
    preview?: unknown;
    serverId?: string;
    executedResult?: unknown;
    sourceSessionId?: string;
    explicitRequest?: true;
  }>,
) {
  await prepareApprovalFixture();
  await homes.requireUiApproval(account.serverId, input.actionId);
  let producedId: string;
  if (input.explicitRequest) {
    const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
    const outcome = await createDefaultActionExecutor().execute('approval.request.create', {
      actionId: input.actionId, actionArgs: input.actionArgs, summary: input.summary, createdBy: { surface: 'system' },
    }, { surface: 'ui', serverId: account.serverId, actionRequestId: 'request-built-in-1' });
    if (!outcome.ok || !outcome.result || typeof outcome.result !== 'object'
      || !('artifactId' in outcome.result) || typeof outcome.result.artifactId !== 'string') {
      throw new Error('Expected the public explicit approval request producer to store its proposal');
    }
    producedId = outcome.result.artifactId;
  } else if (input.sourceSessionId) {
    const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
    const { readDisplayMachineIdForSession } = await import('@/sync/ops/sessionMachineTarget');
    const sourceSession = storage.getState().sessions[input.sourceSessionId];
    if (!sourceSession) throw new Error('The source Session must be published before requesting approval');
    const machineId = readDisplayMachineIdForSession({ serverId: account.serverId,
      sessionId: sourceSession.id, metadata: sourceSession.metadata });
    const outcome = await createDefaultActionExecutor().execute(input.actionId, input.actionArgs, {
      surface: 'ui', serverId: account.serverId, actionRequestId: 'request-built-in-1',
      defaultSessionId: sourceSession.id, ...(machineId ? { defaultSessionMachineId: machineId } : {}),
    });
    const { ActionApprovalRequestCreatedResultSchema } = await import('@happier-dev/protocol/actions/actionExecutionResult');
    if (!outcome.ok) throw new Error(`Source Session approval failed: ${outcome.errorCode}`);
    producedId = ActionApprovalRequestCreatedResultSchema.parse(outcome.result).artifactId;
  } else {
    producedId = await createUiApprovalRequest({ serverId: account.serverId,
      actionId: input.actionId, actionInput: input.actionArgs, actionRequestId: 'request-built-in-1' });
  }
  const producedBody = homes.artifacts(account.serverId).readPlainBody(producedId);
  if (!producedBody) throw new Error('Expected the current UI approval producer to store its request');
  const produced = ApprovalRequestV2Schema.parse(JSON.parse(producedBody));
  const request = ApprovalRequestV2Schema.parse({
    ...produced,
    status: input.executedResult === undefined ? 'open' : 'executed',
    updatedAtMs: input.executedResult === undefined ? produced.updatedAtMs : produced.createdAtMs + 2,
    summary: input.summary,
    ...(input.preview === undefined ? {} : { preview: input.preview }),
    ...(input.executedResult === undefined
      ? {}
      : {
          decision: { kind: 'approve' as const, decidedAtMs: produced.createdAtMs + 1 },
          execution: {
            executedAtMs: produced.createdAtMs + 2,
            ok: true as const,
            result: input.executedResult,
          },
        }),
  });
  prepared = false;
  return {
    id: 'artifact-1',
    fixtureHomeKey: input.serverId ?? 'server-cache',
    header: buildApprovalRequestArtifactHeaderV1(request),
    body: JSON.stringify(request),
  };
}

async function createCurrentApprovalArtifact(serverId = 'server-approval') {
  return await createBuiltInApprovalArtifact({ actionId: 'session.user_action.answer',
    actionArgs: defaultApprovalArtifactBody.actionArgs, summary: defaultApprovalArtifactBody.summary,
    preview: defaultApprovalArtifactBody.preview, serverId });
}

async function createSignedRequesterApprovalOrigin(actionId: ApprovalRequestV2['actionId'], input: unknown, requesterAccountId = 'account-1') {
  await prepareApprovalFixture();
  // The source is another Account at the same Home. Capture its actual installed
  // credential before returning to the recipient's ordinary Account below.
  await account.restore({ accountId: 'bot-owner', currentAccount: true, serverIdentityId: 'srv_approval_home_a',
    machines: [exactApprovalMachine('bot-owner')] });
  const sourceSession = createSessionFixtures()['session-1'];
  const sourceMetadata = sourceSession.metadata;
  if (!sourceMetadata) throw new Error('Expected readable source Session metadata');
  installSessionActionFixture({ homes, storage, serverId: account.serverId,
    session: { ...sourceSession, serverId: account.serverId,
      metadata: { ...sourceMetadata, machineId: 'machine-exact', permissionMode: 'yolo' } } });
  const { captureLazyActionAccountContext } = await import('@/sync/ops/actions/actionAccountContext');
  const { resolveInvocationAuthority } = await import('@happier-dev/protocol/actions/invocationAuthority');
  const source = await captureLazyActionAccountContext(account.serverId);
  const installationId = storage.getState().machines['machine-exact']?.installationId;
  if (!installationId) throw new Error('Expected the Home-published source installation');
  const caller = { kind: 'session' as const, sessionId: 'session-1', starterDepth: 0, turnDepth: 0 };
  const target = { kind: 'session' as const, sessionId: 'session-1' };
  const requestId = 'received-question';
  const envelope = ExternalActionRequestEnvelopeV1Schema.parse({ v: 1, requestId, target, input });
  const installation = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(29));
  const context: ActionExecutorContext = {
    surface: 'agent', authority: resolveInvocationAuthority({ credential: source.credentialAuthorityKind, surface: 'agent' }),
    serverId: source.serverId, serverIdentityId: source.serverIdentityId,
    runtimeAccountId: source.accountId, actionRequestId: requestId, actionCaller: caller, defaultSessionId: 'session-1',
    callerPermissionMode: 'yolo', sessionInputSource: { sourceSessionId: 'session-1', sourceTurnId: 'turn-1', via: 'action' },
    actionRequestAttributionV1: { requestRef: requestId, requester: { serverId: source.serverId, accountId: requesterAccountId },
      persona: { serverId: source.serverId, sessionId: 'session-1' }, origin: null },
    externalActionTarget: target,
    externalActionExecutionAuthorization: { v: 1, token: 'signed-bot-source', binding: {
      serverIdentityId: source.serverIdentityId!, accountId: source.accountId, custodianAccountId: source.accountId,
      machineId: 'machine-exact', installationId, actionId, requestId, target,
      authentication: { kind: 'account', tokenEpoch: 0 },
      requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope),
      sessionActionOrigin: { v: 1, caller, sourceTurnId: 'turn-1', callerPermissionMode: 'yolo', requestId },
      sessionActionSource: { machineId: 'machine-exact', installationId },
    } },
    signExternalActionApprovalInput: args => signExternalActionApprovalInputV1({ authorizationToken: args.authorization.token,
      actionId: args.actionId, target: args.target, input: args.input, privateKey: installation.secretKey,
      requesterConfirmation: args.requesterConfirmation, sessionTargetsV1: args.sessionTargetsV1 }),
  };
  const requesterConfirmation = buildApprovalRequesterConfirmationV1({ context, actionId, input });
  if (!requesterConfirmation) throw new Error('Expected the admitted requester confirmation');
  const executionOriginV1 = buildApprovalExecutionOriginV1({ actionId, input, context, targetSessionId: 'session-1', requesterConfirmation });
  if (!executionOriginV1) throw new Error('Expected the signed original Bot execution origin');
  source.assertCurrent();
  source.dispose();
  prepared = false;
  return { executionOriginV1, requesterConfirmation };
}

async function createRequesterTargetApprovalArtifact(requesterAccountId = 'account-1') {
  const base = TargetActionApprovalRequestV1Schema.parse(JSON.parse(createTargetActionApprovalArtifact().body));
  const invocation = projectTargetActionApprovalInvocationV1(base);
  if (!invocation) throw new Error('Expected the canonical contributed Action invocation');
  const signed = await createSignedRequesterApprovalOrigin(invocation.actionId, invocation.actionArgs, requesterAccountId);
  const request = await produceTargetApprovalRequest(base, signed);
  return { id: 'requester-target', ownerAccountId: 'bot-owner',
    header: buildTargetActionApprovalArtifactHeaderV1(request), body: JSON.stringify(request) };
}

async function captureApiApprovalProducer(actionId: ApprovalRequestV2['actionId'], input: unknown, grantedActionId: string = actionId) {
  await prepareApprovalFixture();
  await homes.requireActionApproval(account.serverId, actionId, 'api');
  const { captureLazyActionAccountContext } = await import('@/sync/ops/actions/actionAccountContext');
  const { ExternalActionApiTokenServerPrincipalV1Schema, ExternalActionExecutionAuthorizationV1Schema } =
    await import('@happier-dev/protocol/actions/externalActionApi');
  const source = await captureLazyActionAccountContext(account.serverId);
  const installationId = storage.getState().machines['machine-exact']?.installationId;
  if (!installationId) throw new Error('Expected the Home-published API installation');
  const target = { kind: 'session' as const, sessionId: 'session-1' };
  const envelope = ExternalActionRequestEnvelopeV1Schema.parse({ v: 1, requestId: 'request-1', target, input });
  const installation = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(29));
  // Home issuer and installed-key signing are external boundaries. Their admitted
  // principal is confined to this captured Account, Action and exact target;
  // the actual executor, origin producer, Artifact writer and readers stay real.
  const principal = ExternalActionApiTokenServerPrincipalV1Schema.parse({
    accountId: source.accountId, principalId: 'principal-1', credentialId: 'credential-1',
    authority: 'account_automation', grant: { v: 1,
      actions: { families: [], ids: [grantedActionId] },
      targets: { sessions: ['session-1'], machines: ['machine-exact'] },
      approve: false, origins: [], models: null, permissionModes: null, create: null },
  });
  const { authority, ...credential } = principal;
  const authorization = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1,
    token: 'approval-api-issuer-boundary', binding: {
      ...credential, serverIdentityId: source.serverIdentityId,
      machineId: 'machine-exact', custodianAccountId: source.accountId, installationId,
      actionId, requestId: 'request-1', target,
      requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope),
    } });
  const context: ActionExecutorContext = {
      surface: 'api', authority, serverId: source.serverId, serverIdentityId: source.serverIdentityId,
      runtimeAccountId: source.accountId, actionRequestId: 'request-1', actionCaller: { kind: 'host' },
      defaultSessionId: 'session-1', defaultSessionMachineId: 'machine-exact',
      externalActionCredential: credential, externalActionExecutionAuthorization: authorization, externalActionTarget: target,
      signExternalActionApprovalInput: args => signExternalActionApprovalInputV1({ authorizationToken: args.authorization.token,
        actionId: args.actionId, target: args.target, input: args.input, privateKey: installation.secretKey,
        requesterConfirmation: args.requesterConfirmation, sessionTargetsV1: args.sessionTargetsV1 }),
  };
  source.assertCurrent();
  return { source, context };
}

async function createDaemonRoutedApprovalArtifact() {
  const actionId = 'session.title.set';
  const input = { sessionId: 'session-1', title: 'Current title' };
  const { source, context } = await captureApiApprovalProducer(actionId, input);
  // The source host knows its Session. Receiver-side projections below may
  // intentionally omit it; source production must not depend on their cache.
  installSessionActionFixture({ homes, storage, serverId: source.serverId,
    session: { ...createSessionFixtures()['session-1'], serverId: source.serverId } });
  const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
  let outcome;
  try { outcome = await createDefaultActionExecutor().execute(actionId, input, context); }
  finally { source.dispose(); }
  const { ActionApprovalRequestCreatedResultSchema } = await import('@happier-dev/protocol/actions/actionExecutionResult');
  if (!outcome.ok) throw new Error(`API approval request failed: ${outcome.errorCode}`);
  const created = ActionApprovalRequestCreatedResultSchema.parse(outcome.result);
  const body = homes.artifacts(account.serverId).readPlainBody(created.artifactId);
  if (!body) throw new Error('Expected a current API approval request');
  const request = ApprovalRequestV2Schema.parse(JSON.parse(body));
  prepared = false;
  return {
    id: 'daemon-approval-1',
    fixtureHomeKey: 'local-A',
    header: buildApprovalRequestArtifactHeaderV1(request),
    body: JSON.stringify(request),
  };
}

function createTargetActionApprovalArtifact() {
  return {
    id: 'target-artifact-1',
    header: {
      v: 1,
      kind: 'target_action_approval.v1',
      title: 'Publish the release notes',
      approvalStatus: 'open',
      qualifiedActionId: 'acme.publisher/actions/releases/publish',
      subjectFingerprint: 'b'.repeat(64),
      sessionId: 'session-1',
      sessions: ['session-1'],
    },
    body: JSON.stringify({
      v: 1,
      kind: 'plugin_target_action',
      status: 'open',
      createdAtMs: 1,
      updatedAtMs: 1,
      createdBy: { surface: 'agent', agentId: 'codex', sessionId: 'session-1' },
      requestedSurface: 'agent',
      qualifiedActionId: 'acme.publisher/actions/releases/publish',
      input: { releaseTag: 'v1.2.3-public-release' },
      secretInputPaths: [],
      accountId: 'account-secret',
      resourceId: 'resource-secret',
      sourceCustody: {
        kind: 'bundled_first_party',
        packagedRuntime: {
          kind: 'cli_version_root',
          versionRootId: 'cli-root-7',
        },
      },
      policyFingerprint: 'a'.repeat(64),
      subjectFingerprint: 'b'.repeat(64),
      summary: 'Publish the release notes',
      detail:
        'This publishes the approved release notes to the configured remote.',
    }),
  };
}

type TargetApprovalRequest = ReturnType<typeof TargetActionApprovalRequestV1Schema.parse>;

async function produceTargetApprovalRequest(base: TargetApprovalRequest,
  provenance: Pick<TargetApprovalRequest, 'executionOriginV1' | 'requesterConfirmation'>) {
  const { captureLazyActionAccountContext } = await import('@/sync/ops/actions/actionAccountContext');
  const { createPluginActionPresentUserGate } = await import('@happier-dev/protocol/plugins/actions/invocation');
  // These test-only CLI owners have portable runtime dependencies (Protocol and
  // relative pure modules). Nonliteral loading keeps their CLI-only type imports
  // out of the UI compiler program; it does not replace their runtime behavior.
  const producerPath = '../../../../cli/src/session/actions/approvals/targetActionCurrentIntent';
  const policyPath = '../../../../cli/src/plugins/runtime/invocation/actionExecutor';
  const [producer, policy] = await Promise.all([
    vi.importActual<{ createTargetActionCurrentIntentAdapter(deps: Readonly<{
      create(request: TargetApprovalRequest): Promise<{ artifactId: string }>;
      read(artifactId: string): Promise<TargetApprovalRequest | null>;
    }>): (request: unknown) => Promise<import('@happier-dev/protocol/plugins/actions/invocation').PluginActionCurrentIntentResult> }>(producerPath),
    vi.importActual<{
      fingerprintTargetActionPolicy(action: unknown): string;
      resolvePresentUserGatePolicy(action: unknown, authorization: unknown): import('@happier-dev/protocol').PluginActionPresentUserGatePolicy;
    }>(policyPath),
  ]);
  const source = await captureLazyActionAccountContext(account.serverId);
  const generation = 'publisher-fixture-generation';
  // A registered foreign plugin declaration is an external host boundary.
  // Its policy and subject fingerprints are calculated by the real owners.
  const declaration = {
    qualifiedId: base.qualifiedActionId, pluginId: 'acme.publisher', localId: 'releases/publish',
    occurrenceId: generation, dangerLevel: 'safe' as const, scopes: ['session'], surfaces: ['agent', 'api'],
    hostAccess: [], input: base.input, accountId: base.accountId, resourceId: base.resourceId,
    secretInputPaths: [], sourceCustody: base.sourceCustody,
    confirmation: { title: base.summary, body: base.detail },
  };
  const action = { ...declaration, policyFingerprint: policy.fingerprintTargetActionPolicy(declaration) };
  const admittedPolicy = policy.resolvePresentUserGatePolicy(action, {
    generation: { targetGeneration: generation, desiredGeneration: generation, appliedGeneration: generation },
    resourceSelections: [], scopedGrants: [], operatingSystemAuthorization: [],
  });
  const adapter = producer.createTargetActionCurrentIntentAdapter({
    create: async request => ({ artifactId: await source.createArtifact(
      buildTargetActionApprovalArtifactHeaderV1(request), JSON.stringify(request),
    ) }),
    read: async artifactId => {
      const artifact = await source.fetchArtifact(artifactId);
      if (typeof artifact?.body !== 'string') return null;
      return TargetActionApprovalRequestV1Schema.parse(JSON.parse(artifact.body));
    },
  });
  const origin = provenance.executionOriginV1;
  if (!origin?.machineId) throw new Error('The target producer requires its admitted exact daemon');
  try {
    const gate = createPluginActionPresentUserGate({
      resolve: async () => ({ status: 'resolved' as const, action, policy: admittedPolicy, isCurrent: () => true }),
      requestCurrentIntent: request => adapter({ ...request, action, ...provenance,
        replayPlacement: { serverId: origin.serverId, machineId: origin.machineId, defaultSessionId: 'session-1' } }),
    });
    const result = await gate.admit({ input: base.input, surface: origin.surface,
      invocationSurface: origin.surface, invocationAuthority: origin.authority, sessionId: 'session-1' });
    if (result.status !== 'deferred') throw new Error(`Expected the canonical target proposal: ${result.status}`);
    const body = homes.artifacts(account.serverId).readPlainBody(result.artifactId);
    if (!body) throw new Error('Expected the target producer to persist its current proposal');
    return TargetActionApprovalRequestV1Schema.parse(JSON.parse(body));
  } finally { source.dispose(); prepared = false; }
}

async function createApiTargetActionApprovalArtifact() {
  const base = TargetActionApprovalRequestV1Schema.parse(JSON.parse(createTargetActionApprovalArtifact().body));
  const invocation = projectTargetActionApprovalInvocationV1(base);
  if (!invocation) throw new Error('Expected the contributed Action invocation');
  const { source, context } = await captureApiApprovalProducer(invocation.actionId, invocation.actionArgs, base.qualifiedActionId);
  let request: TargetApprovalRequest;
  try {
    const executionOriginV1 = buildApprovalExecutionOriginV1({ ...invocation, input: invocation.actionArgs,
      context, targetSessionId: 'session-1' });
    if (!executionOriginV1) throw new Error('Expected admitted API target provenance');
    request = await produceTargetApprovalRequest(base, { executionOriginV1 });
  } finally { source.dispose(); }
  return { id: 'target-api-artifact-1', header: buildTargetActionApprovalArtifactHeaderV1(request), body: JSON.stringify(request) };
}

function createExecutionRunHostActionApprovalArtifact() {
  return {
    id: 'host-action-artifact-1',
    header: {
      v: 1,
      kind: 'execution_run_host_action_approval.v1',
      title: 'Create 1 proposed review comment',
      approvalStatus: 'open',
      actionId: 'reviews.comments.create',
      sessionId: 'session-1',
      sessions: ['session-1'],
      runId: 'run-1',
      profileId: 'acme.review/review',
      subjectFingerprint: 'c'.repeat(64),
      serverId: 'server-1',
    },
    body: JSON.stringify({
      v: 1,
      kind: 'execution_run_host_action',
      status: 'open',
      createdAtMs: 1,
      updatedAtMs: 1,
      createdBy: { surface: 'agent', sessionId: 'session-1' },
      requestedSurface: 'agent',
      actionId: 'reviews.comments.create',
      sessionId: 'session-1',
      runId: 'run-1',
      callId: 'call-1',
      profileId: 'acme.review/review',
      pluginId: 'acme.review',
      agentId: 'claude',
      projectId: 'project-1',
      workspaceId: 'workspace-1',
      serverId: 'server-1',
      proposalCount: 1,
      proposalPreview: [
        {
          pathLabel: 'src/a.ts',
          pathSha256: 'a'.repeat(64),
          startLine: 7,
          endLine: 7,
          bodySha256: 'b'.repeat(64),
          bodyPreview: 'Use the canonical owner.',
        },
      ],
      subjectFingerprint: 'c'.repeat(64),
      summary: 'Create 1 proposed review comment',
    }),
  };
}

function createSessionTitleApprovalArtifact(serverId?: string) {
  return {
    id: 'artifact-1',
    header: {
      v: 1,
      kind: 'approval_request.v1',
      title: 'Set session title',
      approvalStatus: 'open',
      actionId: 'session.title.set',
      sessionId: 'session-1',
      sessions: ['session-1'],
    },
    body: JSON.stringify({
      v: 1,
      status: 'open',
      createdAtMs: 1,
      updatedAtMs: 1,
      createdBy: {
        surface: 'mcp',
        sessionId: 'session-1',
      },
      requestedSurface: 'mcp',
      actionId: 'session.title.set',
      actionArgs: {
        sessionId: 'session-1',
        title: 'New title from MCP',
      },
      summary: 'Set session title',
      preview: {
        kind: 'session_title_set',
        summary: 'Set a new title for the session',
      },
      ...(serverId ? { serverId } : {}),
    }),
  };
}

function createHandoffApprovalArtifact(
  input: Readonly<{
    mode: 'keep_synced' | 'mirror_exactly' | 'copy_once';
    consequences: readonly HandoffTargetApprovalConsequenceV1[];
  }>,
) {
  const contentPolicyFields = {
    v: 1 as const,
    selection: 'all_files' as const,
    extraIgnorePatterns: [],
    extraIncludePatterns: [],
  };
  const contentPolicy = {
    ...contentPolicyFields,
    policyDigest: computeWorkspaceSyncPolicyDigest(contentPolicyFields),
  };
  const request = {
    ...defaultApprovalArtifactBody,
    actionId: 'session.handoff',
    actionArgs: {
      sessionId: 'session-1',
      targetMachineId: 'machine-2',
      targetPath: '/workspace/target',
      workspaceAction:
        input.mode === 'copy_once'
          ? { kind: 'copy_once', contentPolicy }
          : {
              kind: 'create_relationship',
              mode: input.mode,
              contentPolicy,
              flushBeforeCommit: true,
            },
    },
    summary: 'Move session and mirror workspace',
    handoffTargetReplacementApproval: {
      v: 1,
      consequences: [...input.consequences],
      serverId: 'srv_approval_home_a',
      machineId: 'machine-2',
      canonicalRoot: '/workspace/target',
      rootFingerprint: 'a'.repeat(64),
      operationId: 'handoff-action-1',
    },
  } satisfies ApprovalRequestV1;
  return {
    id: 'artifact-1',
    header: buildApprovalRequestArtifactHeaderV1(request),
    body: JSON.stringify(request),
  };
}

function createSessionFixtures() {
  return {
    'session-1': createSessionFixture({
      id: 'session-1',
      metadata: {
        name: 'Repo session',
        host: 'tester.local',
        path: '/Users/leeroy/repo',
        homeDir: '/Users/leeroy',
        machineId: 'machine-target',
      },
    }),
  } satisfies Record<string, Session>;
}

function createMachineFixtures() {
  return {
    'machine-target': createMachineFixture({
      id: 'machine-target',
      metadata: {
        displayName: 'Rebound workstation',
        host: 'workstation.local',
        platform: 'darwin',
        happyCliVersion: '0.0.0-test',
        happyHomeDir: '/Users/tester/.happy-dev',
        homeDir: '/Users/tester',
      },
    }),
    'machine-2': createMachineFixture({
      id: 'machine-2',
      metadata: {
        displayName: 'Studio laptop',
        host: 'studio.local',
        platform: 'darwin',
        happyCliVersion: '0.0.0-test',
        happyHomeDir: '/Users/tester/.happy-dev',
        homeDir: '/Users/tester',
      },
    }),
  } satisfies Record<string, Machine>;
}

// This boundary corpus deliberately includes malformed and retained locked rows; the real
// Artifact reader and approval schemas, rather than a fixture cast, decide their admission.
let currentArtifact: any = createApprovalArtifact();
let sessionFixtures: Record<string, Session> = createSessionFixtures();
let machineFixtures: Record<string, Machine> = createMachineFixtures();
let sessionFixturesByServerId: Record<string, Record<string, Session>> = {
  'server-cache': sessionFixtures,
};
let machineFixturesByServerId: Record<string, Record<string, Machine>> = {
  'server-cache': machineFixtures,
};
installApprovalCommonModuleMocks({
  reactNative: async () => {
    const { createReactNativeWebMock } =
      await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
      View: 'View',
      Text: 'Text',
      ScrollView: 'ScrollView',
      ActivityIndicator: 'ActivityIndicator',
    });
  },
  unistyles: async () => {
    const { createUnistylesMock } =
      await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
  },
  router: async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock({
      router: { back: backSpy, push: pushSpy, dismissTo: dismissToSpy },
    }).module;
  },
  text: async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    const { t } = await vi.importActual<typeof import('@/text')>('@/text');
    return createTextModuleMock({ translate: (key: string, params) => {
      if ((key === 'actionPresentation.title' || key === 'actionPresentation.summary')
        && typeof params?.actionId === 'string' && typeof params.source === 'string') {
        return t(key, { actionId: params.actionId, source: params.source,
          subject: typeof params.subject === 'string' ? params.subject : null });
      }
      return key;
    } });
  },
  modal: async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock({
      spies: {
        confirm: vi.fn(async () => modalConfirmResult),
        alert: vi.fn(),
      },
    }).module;
  },
});

const account = createProviderSettingsAccountHarness();
const homes = account.home;
const rpcDestinations: Array<{ method: string; serverUrl: string | undefined }> = [];
const rpcRequests = installSessionActionRpcBoundary((request, context) => {
  rpcDestinations.push({ method: request.method, serverUrl: context.serverUrl });
  if (request.method.endsWith(`:${RPC_METHODS.DAEMON_COMPUTER_ACTION_EXECUTE}`)) {
    const computer = request.params as { sessionId: string; actionId: string };
    if (computer.sessionId !== 'session-1' || computer.actionId !== 'computer.target.get') {
      throw new Error('Unexpected computer owner request in the approval fixture');
    }
    return { protocolVersion: 1, result: {
      consentGranted: false, sourceId: 'computer:1',
      selectedTarget: { kind: 'window', displayId: ':77', pid: 123, windowId: 456 },
      approvalDisplay: { machineDisplayName: 'Workstation one', requiresTargetSelection: false,
        target: { kind: 'window', title: 'Sign in to Lumen' } },
    } };
  }
  if (request.method.endsWith(`:${RPC_METHODS.APPROVAL_REQUEST_DECIDE}`)) {
    if (remoteArtifact) commitRemoteArtifact(remoteArtifact);
    if (daemonError) throw daemonError;
    return daemonReply;
  }
  if (request.method.endsWith(`:${RPC_METHODS.SESSION_USER_ACTION_ANSWER}`)) return { ok: true };
  return { error: 'RPC method not found', errorCode: 'METHOD_NOT_FOUND' };
});
await loadSyncSingletonForTests();
const { storage } = await import('@/sync/domains/state/storage');
const initialApprovalStorageState = storage.getState();
const { sync } = await import('@/sync/sync');
const { Item } = await import('@/components/ui/lists/Item');
const { RoundButton } = await import('@/components/ui/buttons/RoundButton');
const { installSessionActionFixture } = await import('@/dev/testkit/harness/sessionActionRpcBoundary');
const { resolveServerProfileScopeIdForIdentifier } = await import('@/sync/domains/server/serverProfiles');
let browser: Awaited<ReturnType<typeof installBrowserRuntimeForTests>>;
let prepared = false;
let cachedArtifact: unknown;
let homeIds: Record<string, string> = {};
let daemonReply: unknown = { ok: true, result: {} };
let daemonError: Error | null = null;
let remoteArtifact: typeof currentArtifact = null;
let beforeArtifactUpdate: (() => Promise<void>) | null = null;
let includeExactApprovalMachine = true;

function storedArtifact(artifact: NonNullable<typeof currentArtifact>, revision = 1): Artifact {
  return { id: artifact.id, ownerAccountId: artifact.ownerAccountId ?? 'account-1', access: 'owner', encryptionMode: 'plain', publicAudience: 'none',
    header: encodePlainArtifactStoredContent(artifact.header), headerVersion: revision,
    ...(typeof artifact.body === 'string' ? { body: encodePlainArtifactStoredContent({ body: artifact.body }), bodyVersion: revision } : {}),
    dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER, seq: revision, createdAt: 1, updatedAt: revision };
}

function commitRemoteArtifact(artifact: NonNullable<typeof currentArtifact>) {
  const store = homes.artifacts(account.serverId);
  const prior = store.read(artifact.id);
  store.replaceStoredRow(storedArtifact(artifact, Math.max(prior?.headerVersion ?? 0, prior?.bodyVersion ?? 0) + 1));
  if (artifact.ownerAccountId && artifact.ownerAccountId !== 'account-1') store.seedAccountGrant(artifact.id, 'account-1', 'view');
}

function artifactReads(artifactId: string) {
  return homes.requestsFor(`/v1/artifacts/${artifactId}`).filter(request => request.input === null);
}

function approvalItem(screen: Awaited<ReturnType<typeof renderScreen>>, testID: string) {
  return screen.findAllByType(Item).find(node => node.props.testID === testID);
}

function decisionButton(screen: Awaited<ReturnType<typeof renderScreen>>, testID: string) {
  return screen.findAllByType(RoundButton).find(node => node.props.testID === testID);
}

function artifactWrites(artifactId = currentArtifact?.id) {
  return homes.requestsFor(`/v1/artifacts/${artifactId}`).filter(request => request.input !== null);
}

function decodedArtifactWrite(index = 0) {
  const write = artifactWrites()[index];
  if (!write || !write.input || typeof write.input !== 'object') throw new Error('Expected an Artifact HTTP write');
  const input = write.input as Record<string, unknown>;
  const header = typeof input.header === 'string' ? decodePlainArtifactStoredContent(input.header) : null;
  const envelope = typeof input.body === 'string' ? decodePlainArtifactStoredContent(input.body) : null;
  if (!envelope || typeof envelope !== 'object' || !('body' in envelope) || typeof envelope.body !== 'string') throw new Error('Expected a Plain Artifact body');
  return { artifactId: currentArtifact.id, header, body: JSON.parse(envelope.body) };
}

function daemonDecisions() {
  return rpcRequests.filter(request => request.method.endsWith(`:${RPC_METHODS.APPROVAL_REQUEST_DECIDE}`));
}

function expectDaemonDecision(artifactId: string, decision: 'approve' | 'reject', originServerId: string) {
  expect(daemonDecisions()).toEqual([expect.objectContaining({ method: `machine-exact:${RPC_METHODS.APPROVAL_REQUEST_DECIDE}`,
    params: { artifactId, decision, serverIdentityId: 'srv_approval_home_a', originServerId } })]);
  expect(rpcDestinations.filter(request => request.method.endsWith(`:${RPC_METHODS.APPROVAL_REQUEST_DECIDE}`)))
    .toEqual([{ method: `machine-exact:${RPC_METHODS.APPROVAL_REQUEST_DECIDE}`, serverUrl: 'https://provider-settings-account.test' }]);
}

function clientExecutionEffects() {
  return [...rpcRequests.filter(request => !request.method.endsWith(`:${RPC_METHODS.APPROVAL_REQUEST_DECIDE}`)),
    ...homes.requestsFor('/v1/actions/approval.request.decide')];
}

function exactApprovalMachine(accountId = 'account-1') {
  const { operationProtocolCapabilities: _unpublishedCapabilities, ...publishedRow } =
    createPlainMachineRowFixture({ id: 'machine-exact', accountId });
  const published = { ...publishedRow,
    installationPublicKey: encodeBase64(tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(29)).publicKey, 'base64') };
  return createMachineFixture({ ...published,
    metadata: createMachineFixture().metadata, daemonState: null });
}

async function prepareApprovalFixture() {
  if (prepared) return;
  // A freshly restored receiver has only its declared Home projections, never
  // the source host's Session cache or another test's duplicate-id records.
  storage.setState({ sessions: {}, sessionListRowsByServerId: {} });
  const selectedKey = approvalHomeFixture.profile?.id ?? 'ui-A';
  const identity = approvalHomeFixture.profile?.serverIdentityId ?? 'srv_approval_home_b';
  let originKey: string | undefined;
  try {
    const request = JSON.parse(currentArtifact?.body ?? '{}');
    originKey = request.executionOriginV1?.serverId ?? request.serverId;
  } catch { /* Malformed approvals remain malformed input to the real reader. */ }
  // These are fixture source labels, not invented profile ids. A creator-local origin
  // and this device's selected route may describe the same published Home identity.
  const fixtureKey = Object.hasOwn(sessionFixturesByServerId, selectedKey) ? selectedKey
    : typeof currentArtifact?.fixtureHomeKey === 'string' && Object.hasOwn(sessionFixturesByServerId, currentArtifact.fixtureHomeKey)
      ? currentArtifact.fixtureHomeKey
    : originKey && Object.hasOwn(sessionFixturesByServerId, originKey) ? originKey
      : Object.hasOwn(sessionFixturesByServerId, 'server-cache') ? 'server-cache' : selectedKey;
  await homes.addHome({ name: approvalHomeFixture.profile?.name ?? '', serverUrl: 'https://provider-settings-account.test',
    serverIdentityId: identity, accountId: 'account-1', currentAccount: true });
  await account.restore({ accountId: 'account-1', currentAccount: true, serverIdentityId: identity,
    features: createRootLayoutFeaturesResponse({ capabilities: { serverIdentity: { serverIdentityId: identity } } }),
    machines: [...Object.values(machineFixtures), ...(includeExactApprovalMachine ? [exactApprovalMachine()] : [])] });
  homeIds = { [selectedKey]: account.serverId, [fixtureKey]: account.serverId };
  const keys = new Set([...Object.keys(sessionFixturesByServerId), ...Object.keys(machineFixturesByServerId)]);
  for (const key of keys) {
    if (homeIds[key]) continue;
    homeIds[key] = await account.addHome({ name: key, serverUrl: `https://${key.toLowerCase()}.approval.test`,
      serverIdentityId: key, accountId: 'account-1', currentAccount: true, active: false });
  }
  for (const [key, homeId] of Object.entries(homeIds)) {
    if (homeId === account.serverId && key !== fixtureKey) continue;
    const sessions = sessionFixturesByServerId[key] ?? (homeId === account.serverId ? sessionFixtures : {});
    const machines = machineFixturesByServerId[key] ?? (homeId === account.serverId ? machineFixtures : {});
    for (const session of Object.values(sessions)) await publishApprovalSessionFixture(session,
      resolveServerProfileScopeIdForIdentifier(homeId));
    await account.publishMachines(homeId, [...Object.values(machines), ...(homeId === account.serverId
      && includeExactApprovalMachine ? [exactApprovalMachine()] : [])]);
  }
  // Scoped reading and a process's focused Session projection have separate producers.
  // Publish the focused Home last so its records cannot be replaced by another Home's duplicate ids.
  const selectedSessions = sessionFixturesByServerId[fixtureKey] ?? sessionFixtures;
  const focusedHomeId = resolveServerProfileScopeIdForIdentifier(account.serverId);
  storage.setState({ sessions: Object.fromEntries(await Promise.all(Object.values(selectedSessions).map(async session => {
    const published = await publishApprovalSessionFixture(session, focusedHomeId);
    return [published.id, published];
  }))) });
  await account.publishMachines(account.serverId, [
    ...Object.values(machineFixturesByServerId[fixtureKey] ?? machineFixtures),
    ...(includeExactApprovalMachine ? [exactApprovalMachine()] : []),
  ]);
  homes.answer(account.serverId, '/v1/actions/approval.request.decide', { select: body => {
    const envelope = ExternalActionRequestEnvelopeV1Schema.parse(body);
    if (remoteArtifact) commitRemoteArtifact(remoteArtifact);
    if (daemonError) return { status: 503, body: { error: 'machine_unavailable' } };
    return { body: ExternalActionResponseEnvelopeV1Schema.parse({ v: 1, actionId: 'approval.request.decide', requestId: envelope.requestId, execution: daemonReply }) };
  } });
  prepared = true;
}

async function publishApprovalSessionFixture(session: Session, serverId: string): Promise<Session> {
  const published = installSessionActionFixture({ homes, storage, serverId, session: { ...session, serverId } });
  if (published.encryptionMode === 'e2ee') {
    const response = await createLockedEncryptedSessionByIdResponseFixture(published);
    homes.answer(serverId, `/v2/sessions/${published.id}`, { body: response });
    homes.answer(serverId, `/v2/sessions/${published.id}?accessProjectionVersion=1`, { body: response });
    homes.answer(serverId, `/v1/sessions/${published.id}/turns`, { body: { v: 1, sessionId: published.id,
      updatedAt: published.updatedAt, turns: [] } });
  }
  return published;
}

async function renderScreen(element: React.ReactElement) {
  await prepareApprovalFixture();
  if (currentArtifact && cachedArtifact !== currentArtifact) {
    cachedArtifact = currentArtifact;
    // Source-host production is complete. These assertions observe only the
    // receiving surface's reads, decisions and effects, not fixture creation.
    homes.requests.length = 0;
    rpcRequests.length = 0;
    rpcDestinations.length = 0;
    if (currentArtifact.isDecrypted === false) storage.getState().updateArtifact(currentArtifact);
    else {
      commitRemoteArtifact(currentArtifact);
      // Publish through the real Artifact reader/codec, not an independent UI-hook fixture.
      if (typeof currentArtifact.body === 'string') {
        const opened = await sync.fetchArtifactWithBody(currentArtifact.id);
        if (!opened) throw new Error('The Home did not open its Plain Artifact fixture');
        storage.getState().updateArtifact(opened);
      }
      else storage.getState().updateArtifact({ ...currentArtifact, isDecrypted: true, title: currentArtifact.header?.title ?? null,
        headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 } satisfies DecryptedArtifact);
    }
  }
  if (beforeArtifactUpdate) {
    homes.artifacts(account.serverId).beforeNextUpdate(beforeArtifactUpdate);
    beforeArtifactUpdate = null;
  }
  const props = element.props as { serverId?: string; artifactId?: string };
  const screen = await renderUiScreen(React.isValidElement<{ serverId?: string }>(element) && props.serverId && homeIds[props.serverId]
    ? React.cloneElement(element, { serverId: homeIds[props.serverId] }) : element);
  if (props.artifactId) await vi.waitFor(() => expect(screen.getTextContent().length).toBeGreaterThan(0));
  return screen;
}

beforeEach(async () => {
  browser = await installBrowserRuntimeForTests({ url: 'https://approval-detail.test/' });
  await account.reset();
  storage.setState(initialApprovalStorageState, true);
  prepared = false;
  cachedArtifact = undefined;
  homeIds = {};
  rpcRequests.length = 0;
  rpcDestinations.length = 0;
  daemonReply = { ok: true, result: {} };
  daemonError = null;
  remoteArtifact = null;
  beforeArtifactUpdate = null;
  includeExactApprovalMachine = true;
  const { Modal } = await import('@/modal');
  vi.mocked(Modal.alert).mockClear();
});

afterEach(async () => {
  await standardCleanup();
  try { await account.reset(); } finally { browser?.restore(); }
});

// Load the real screen graph after boundary fixtures are initialized. Cold
// transforms belong to collection, not the individual interaction's budget.
const approvalDetailScreenModule = await import('./ApprovalDetailScreen');

describe('ApprovalDetailScreen', () => {
  beforeEach(async () => {
    backSpy.mockReset();
    pushSpy.mockReset();
    dismissToSpy.mockReset();
    approvalHomeFixture = {
      kind: 'resolved',
      serverIdentityId: 'srv_approval_home_a',
      profile: { id: 'ui-A', serverIdentityId: 'srv_approval_home_a', name: '' },
    };
    modalConfirmResult = true;
    sessionFixtures = createSessionFixtures();
    machineFixtures = createMachineFixtures();
    sessionFixturesByServerId = { 'server-cache': sessionFixtures };
    machineFixturesByServerId = { 'server-cache': machineFixtures };
    currentArtifact = createApprovalArtifact();
  });

  it('names the origin Machine of a sessionless daemon approval in its existing requester context', async () => {
    const request = ApprovalRequestV2Schema.parse({ v: 2, status: 'open', createdAtMs: 1, updatedAtMs: 1,
      createdBy: { surface: 'system', pluginId: 'example.observer', contributionLocalId: 'observer' },
      actionId: 'automation.event.sources.list', actionArgs: { transport: { kind: 'checkpointedPull' } }, summary: 'Read sources',
      executionOriginV1: { v: 1, authority: 'account_automation', surface: 'plugin', serverId: 'ui-A',
        serverIdentityId: 'srv_approval_home_a', machineId: 'machine-daemon', actionId: 'automation.event.sources.list', requestId: 'request',
        caller: { kind: 'plugin', pluginId: 'example.observer', contributionLocalId: 'observer',
          sourceCustody: { kind: 'development', registeredRootId: 'observer-root' } } } });
    currentArtifact = { id: 'artifact-1', fixtureHomeKey: 'ui-A',
      header: buildApprovalRequestArtifactHeaderV1(request), body: JSON.stringify(request) };
    sessionFixturesByServerId = { 'ui-A': {} };
    machineFixturesByServerId = { 'ui-A': { 'machine-daemon': createMachineFixture({ id: 'machine-daemon',
      metadata: { ...createMachineFixture().metadata!, displayName: 'Build Mac', host: 'build.test' } }) } };
    const screen = await renderScreen(<approvalDetailScreenModule.ApprovalDetailScreen artifactId="artifact-1" />);
    expect(await readRenderedTextWithRowContent(screen)).toContain('Build Mac');
  });

  it('keeps a CLI delete target readable when the target is also the requesting Session', async () => {
    const artifact = await createBuiltInApprovalArtifact({
      actionId: 'session.delete',
      actionArgs: { sessionId: 'session-1' },
      summary: 'Delete session',
      serverId: 'server-cache',
      executedResult: { success: true },
    });
    const request = ApprovalRequestV2Schema.parse({
      ...JSON.parse(artifact.body),
      createdBy: { surface: 'cli', sessionId: 'session-1' },
      requestedSurface: 'cli',
      executionOriginV1: {
        ...JSON.parse(artifact.body).executionOriginV1,
        surface: 'cli',
      },
    });
    currentArtifact = {
      ...artifact,
      header: buildApprovalRequestArtifactHeaderV1(request),
      body: JSON.stringify(request),
    };
    sessionFixturesByServerId = {
      'ui-A': {
        'session-1': createSessionFixture({
          id: 'session-1',
          metadata: {
            name: 'Release cleanup',
            host: 'build.test',
            path: '/workspace/release',
            machineId: 'machine-delete',
          },
        }),
      },
    };
    machineFixturesByServerId = {
      'ui-A': {
        'machine-delete': createMachineFixture({
          id: 'machine-delete',
          metadata: {
            displayName: 'Build Mac',
            host: 'build.test',
            platform: 'darwin',
            happyCliVersion: '0.0.0-test',
            happyHomeDir: '/Users/tester/.happier',
            homeDir: '/Users/tester',
          },
        }),
      },
    };

    const screen = await renderScreen(
      <approvalDetailScreenModule.ApprovalDetailScreen artifactId="artifact-1" />,
    );
    const text = await readRenderedTextWithRowContent(screen);

    expect(text).toContain('Release cleanup');
    expect(text).toContain('contextBar.machine Build Mac');
    expect(text).toContain('…ession-1');
  });

  it('keeps an executed preset refusal visible as failure without completion navigation', async () => {
    currentArtifact = await createBuiltInApprovalArtifact({
      actionId: 'machines.presets.archive',
      actionArgs: { homeId: 'home-1', id: 'preset-1', expectedRevision: 0 },
      summary: 'Archive preset',
      executedResult: { kind: 'refused', code: 'provider_unavailable' },
    });
    const { ApprovalDetailScreen } = approvalDetailScreenModule;
    const screen = await renderScreen(
      <ApprovalDetailScreen artifactId="artifact-1" completionHref="/" />,
    );
    // The readable reason leads; its typed code waits in the technical disclosure.
    const reason = approvalItem(screen, 'approvals.execution-failure')?.props.subtitle;
    expect(typeof reason).toBe('string');
    expect(reason).not.toContain('provider_unavailable');
    const { ApprovalTechnicalDetails } = await import('./ActionApprovalFieldsCard');
    // One disclosure: the Home's original operand, the concurrency revision and the failure code.
    expect(screen.findAllByType(ApprovalTechnicalDetails as never).map((node) => node.props.lines)).toEqual([
      expect.arrayContaining([
        { key: 'expectedRevision', label: 'Expected revision', value: '0' },
        { key: 'failure-code', label: 'common.error', value: 'provider_unavailable' },
      ]),
    ]);
    expect(readRenderedText(screen)).toContain('approvals.status.failed');
    expect(readRenderedText(screen)).not.toContain('approvals.status.executed');
    expect(dismissToSpy).not.toHaveBeenCalled();
  });

  it('shows the bound Browser open operation beside an executed receipt that only accepted it', async () => {
    const { actionOperationStore } = await import('@/sync/domains/actionOperations/actionOperationStore');
    const { ActionOperationSnapshotV1Schema } = await import('@happier-dev/protocol/actions/operations/v1');
    const base = await createBuiltInApprovalArtifact({
      actionId: 'browser.view.open',
      sourceSessionId: 'session-1',
      actionArgs: { kind: 'openView', commandId: 'c1', browserSessionId: 'bs', viewId: 'v1', platform: 'web',
        target: { kind: 'externalUrl', targetId: 't', url: 'http://localhost:5173/login' } },
      summary: 'Open browser view',
      executedResult: { v: 1, status: 'in_progress', phase: 'browser_runtime_provisioning', commandId: 'c1',
        browserSessionId: 'bs', viewId: 'v1', operationId: 'open-1' },
    });
    const request = ApprovalRequestV2Schema.parse(JSON.parse(base.body));
    const machineId = request.executionOriginV1.machineId;
    const accountId = request.executionOriginV1.accountId;
    if (!machineId || !accountId) throw new Error('Expected the real source Session approval to bind its operation owner');
    currentArtifact = base;
    await prepareApprovalFixture();
    const operationServerId = resolveServerProfileScopeIdForIdentifier(account.serverId);
    const operation = (overrides: Record<string, unknown>) => ActionOperationSnapshotV1Schema.parse({
      version: 1, operationId: 'open-1', revision: 1, actionId: 'browser.view.open', state: 'running',
      title: 'Open browser view', createdAt: 1, startedAt: 2, cancellation: 'unsupported',
      scope: { accountId, machineId, sessionId: 'session-1' }, ...overrides });
    const { ApprovalDetailScreen } = approvalDetailScreenModule;
    try {
      actionOperationStore.mergeSnapshots({ serverId: operationServerId, snapshots: [operation({
        progress: { kind: 'phase', phase: 'browser_runtime_provisioning', label: 'Preparing' } })] });
      const preparing = await renderScreen(<ApprovalDetailScreen artifactId="artifact-1" />);
      expect(approvalItem(preparing, 'approvals.browser-open')?.props.subtitle).toBe('browserPresence.stream.preparingTitle');
      // Accepted is not opened: the receipt still reads Executed while the operation is live.
      expect(readRenderedText(preparing)).toContain('approvals.status.executed');

      await act(async () => {
        actionOperationStore.mergeSnapshots({ serverId: operationServerId, snapshots: [operation({ revision: 2 })] });
      });
      expect(approvalItem(preparing, 'approvals.browser-open')?.props.subtitle).toBe('browserPresence.stream.openingPage');

      await act(async () => {
        actionOperationStore.mergeSnapshots({ serverId: operationServerId, snapshots: [operation({ revision: 3, state: 'succeeded', settledAt: 4,
          result: { v: 1, commandId: 'c1', status: 'dispatched', adapterKind: 'chromiumSidecar', events: [] } })] });
      });
      expect(approvalItem(preparing, 'approvals.browser-open')?.props.subtitle).toBe('browserPresence.stream.pageOpened');
      // No sandbox is allowed to open a page that is open; a blocked sandbox has its one Allow control.
      expect(preparing.findAllByTestId('approvals.browser-open-allow-sandbox')).toHaveLength(0);

      await act(async () => {
        actionOperationStore.mergeSnapshots({ serverId: operationServerId, snapshots: [operation({ revision: 4, state: 'succeeded', settledAt: 5,
          result: { v: 1, commandId: 'c1', status: 'failed', adapterKind: 'chromiumSidecar',
            error: { code: 'sandbox_unavailable', message: 'Managed Chromium sandbox is unavailable.' } } })] });
      });
      expect(approvalItem(preparing, 'approvals.browser-open-allow-sandbox')?.props.title).toBe('browserPresence.stream.sandboxAllow');
    } finally {
      actionOperationStore.reset();
    }
  });

  it('follows the detached operation an executed receipt accepted until it settles (CLOUD-ACQ)', async () => {
    const { actionOperationStore } = await import('@/sync/domains/actionOperations/actionOperationStore');
    const { ActionOperationSnapshotV1Schema } = await import('@happier-dev/protocol/actions/operations/v1');
    currentArtifact = await createBuiltInApprovalArtifact({
      // Any executed result that names its detached operation (managed Create and Delete do) is followed alike.
      actionId: 'machines.presets.archive',
      actionArgs: { homeId: 'home-1', id: 'preset-1', expectedRevision: 0 },
      summary: 'Delete machine',
      executedResult: { kind: 'accepted', managedId: 'managed-1', intentRevision: 2, operation: { operationId: 'delete-1' } },
    });
    await prepareApprovalFixture();
    const operationServerId = resolveServerProfileScopeIdForIdentifier(account.serverId);
    const operation = (overrides: Record<string, unknown>) => ActionOperationSnapshotV1Schema.parse({
      version: 1, operationId: 'delete-1', revision: 1, actionId: 'machines.presets.archive', state: 'running',
      title: 'Delete machine', createdAt: 1, startedAt: 2, cancellation: 'unsupported',
      scope: { accountId: 'account-1', machineId: 'controller-1' }, ...overrides });
    const { ApprovalDetailScreen } = approvalDetailScreenModule;
    try {
      actionOperationStore.mergeSnapshots({ serverId: operationServerId, snapshots: [operation({})] });
      const screen = await renderScreen(<ApprovalDetailScreen artifactId="artifact-1" />);
      // Executed only accepted the Delete: the operation row says it is still running.
      expect(approvalItem(screen, 'approvals.operation')?.props.subtitle).toBe('inbox.actionOperations.status.running');

      await act(async () => {
        actionOperationStore.mergeSnapshots({ serverId: operationServerId, snapshots: [operation({ revision: 2, state: 'failed', settledAt: 3,
          error: { errorCode: 'provider_unavailable', error: 'Hetzner refused the request.' } })] });
      });
      const failed = String(approvalItem(screen, 'approvals.operation')?.props.subtitle);
      expect(failed).toContain('inbox.actionOperations.status.failed');
      expect(failed).not.toContain('inbox.actionOperations.status.running');
    } finally {
      actionOperationStore.reset();
    }
  });

  it('names an agent draft for a Discussion as Post and Decline', async () => {
    const artifact = await createCurrentApprovalArtifact('server-cache');
    const produced = JSON.parse(artifact.body);
    const post = { discussionId: 'discussion-1', localId: 'draft-local-1', mentionedSessionIds: [],
      content: { v: 1, parts: [{ type: 'text', text: 'Start backoff at 800 ms.' }] } };
    const request = ApprovalRequestV2Schema.parse({ ...produced, actionId: 'discussion.post', actionArgs: post,
      requestedSurface: 'agent', createdBy: { surface: 'agent', sessionId: 'session-1' },
      executionOriginV1: { ...produced.executionOriginV1, actionId: 'discussion.post', surface: 'agent',
        caller: { kind: 'session', sessionId: 'session-1', starterDepth: 0, turnDepth: 0 } } });
    currentArtifact = { ...artifact, header: buildApprovalRequestArtifactHeaderV1(request), body: JSON.stringify(request) };
    const screen = await renderScreen(<approvalDetailScreenModule.ApprovalDetailScreen artifactId="artifact-1" />);
    await vi.waitFor(() => expect(screen.findByTestId('approvals.approve')).not.toBeNull());
    expect(decisionButton(screen, 'approvals.approve')?.props.title).toBe('session.collaboration.discussion.draftReview.post');
    expect(decisionButton(screen, 'approvals.reject')?.props.title).toBe('session.collaboration.discussion.draftReview.decline');
  });

  it('keeps settled capability review fields readable without offering another approval', async () => {
    const { getActionSpec } = await import('@happier-dev/protocol/actions');
    const { settleApprovalRequestActionArgs } = await import('@happier-dev/protocol/approvals/approvalRequestTransition');
    const spec = getActionSpec('skills.rules.set');
    const input = spec.inputSchema.parse({ items: [{ skillId: 'skill-reviewed' }],
      change: { kind: 'write', write: { place: { t: 'machine', machineId: 'machine-1' }, state: 'on' } } });
    const artifact = await createBuiltInApprovalArtifact({ actionId: spec.id, actionArgs: input, summary: spec.title,
      preview: { actionId: spec.id, actionArgs: spec.projectObservationInput?.(input) } });
    const open = ApprovalRequestV2Schema.parse(JSON.parse(artifact.body));
    const settled = ApprovalRequestV2Schema.parse({ ...open, status: 'executed', updatedAtMs: 3,
      actionArgs: settleApprovalRequestActionArgs(open), decision: { kind: 'approve', decidedAtMs: 2 },
      execution: { executedAtMs: 3, ok: true } });
    currentArtifact = { ...artifact, body: JSON.stringify(settled), header: buildApprovalRequestArtifactHeaderV1(settled) };
    const screen = await renderScreen(<approvalDetailScreenModule.ApprovalDetailScreen artifactId="artifact-1" />);
    const text = await readRenderedTextWithRowContent(screen);
    expect(text).toContain('Turn on');
    expect(text).toContain('Where');
    expect(text).not.toContain('approvals.unsafeDetailsBody');
    expect(screen.findAllByTestId('approvals.approve')).toHaveLength(0);
    // History already consumed by an older development writer cannot reconstruct the change.
    // It reports unavailable history without claiming another decision can be made.
    const reduced = ApprovalRequestV2Schema.parse({ ...settled, actionArgs: spec.projectObservationInput?.(input) });
    currentArtifact = { ...artifact, body: JSON.stringify(reduced), header: buildApprovalRequestArtifactHeaderV1(reduced) };
    const history = await renderScreen(<approvalDetailScreenModule.ApprovalDetailScreen artifactId="artifact-1" />);
    expect(await readRenderedTextWithRowContent(history)).toContain('common.unavailable');
    expect(await readRenderedTextWithRowContent(history)).not.toContain('approvals.unsafeDetailsBody');
    expect(history.findAllByTestId('approvals.approve')).toHaveLength(0);
  });

  it('uses the typed stale outcome even when execution carries another diagnostic message', async () => {
    const artifact = await createDaemonRoutedApprovalArtifact();
    const request = ApprovalRequestV2Schema.parse({
      ...JSON.parse(artifact.body),
      status: 'failed',
      updatedAtMs: 2,
      decision: { kind: 'approve', decidedAtMs: 2 },
      execution: { executedAtMs: 2, ok: false, errorCode: 'approval_stale', error: 'Reviewed policy no longer matches' },
    });
    currentArtifact = { ...artifact, header: buildApprovalRequestArtifactHeaderV1(request), body: JSON.stringify(request) };
    const { ApprovalDetailScreen } = await import('./ApprovalDetailScreen');
    const screen = await renderScreen(<ApprovalDetailScreen artifactId={currentArtifact.id} />);

    expect(approvalItem(screen, 'approvals.execution-failure')?.props.subtitle).toBe('approvals.staleFailure');
  });

  it('titles a failure that never reached its effect as not run, and an attempted one by its action', async () => {
    const artifact = await createDaemonRoutedApprovalArtifact();
    const failedWith = (execution: Record<string, unknown>) => ApprovalRequestV2Schema.parse({
      ...JSON.parse(artifact.body), status: 'failed', updatedAtMs: 2,
      decision: { kind: 'approve', decidedAtMs: 2 },
      execution: { executedAtMs: 2, ok: false, ...execution },
    });
    const { ApprovalDetailScreen } = await import('./ApprovalDetailScreen');
    const titleOf = async (request: ApprovalRequestV2) => {
      currentArtifact = { ...artifact, header: buildApprovalRequestArtifactHeaderV1(request), body: JSON.stringify(request) };
      const screen = await renderScreen(<ApprovalDetailScreen artifactId={currentArtifact.id} />);
      return approvalItem(screen, 'approvals.execution-failure')?.props.title;
    };

    expect(await titleOf(failedWith({
      errorCode: 'approval_context_unavailable', error: 'approval_context_unavailable', effectAttempted: false,
    }))).toBe('approvals.failureNotRun');
    expect(await titleOf(failedWith({
      errorCode: 'executor_failed', error: 'Executor failed', effectAttempted: true,
    }))).toBe('approvals.failureNamed');
  });

  it('says what failed when a recorded failure carries only a machine code, never that the decision could not be saved', async () => {
    const artifact = await createDaemonRoutedApprovalArtifact();
    const { ApprovalDetailScreen } = await import('./ApprovalDetailScreen');
    const reasonOf = async (errorCode: string) => {
      const request = ApprovalRequestV2Schema.parse({
        ...JSON.parse(artifact.body), status: 'failed', updatedAtMs: 2,
        decision: { kind: 'approve', decidedAtMs: 2 },
        execution: { executedAtMs: 2, ok: false, errorCode, error: errorCode, effectAttempted: true },
      });
      currentArtifact = { ...artifact, header: buildApprovalRequestArtifactHeaderV1(request), body: JSON.stringify(request) };
      const screen = await renderScreen(<ApprovalDetailScreen artifactId={currentArtifact.id} />);
      return approvalItem(screen, 'approvals.execution-failure')?.props.subtitle;
    };

    expect(await reasonOf('plugin_change_daemon_unavailable')).toBe('approvals.pluginChangeDaemonUnavailable');
    expect(await reasonOf('executor_failed')).toBe('approvals.failureNoReason');
  });

  it('presents a durable Provider refusal through the shared Provider error copy', async () => {
    const artifact = await createDaemonRoutedApprovalArtifact();
    const request = ApprovalRequestV2Schema.parse({
      ...JSON.parse(artifact.body), status: 'failed', updatedAtMs: 2,
      decision: { kind: 'approve', decidedAtMs: 2 },
      execution: { executedAtMs: 2, ok: false, errorCode: 'provider_connection_invalid', error: 'provider_connection_invalid' },
    });
    currentArtifact = { ...artifact, header: buildApprovalRequestArtifactHeaderV1(request), body: JSON.stringify(request) };
    const { ApprovalDetailScreen } = await import('./ApprovalDetailScreen');
    const { presentProviderError } = await import('@/providers/connection/errorPresentation');
    const screen = await renderScreen(<ApprovalDetailScreen artifactId={currentArtifact.id} />);
    expect(approvalItem(screen, 'approvals.execution-failure')?.props.subtitle)
      .toBe(presentProviderError('provider_connection_invalid').descriptionKey);
    expect(readRenderedText(screen)).not.toContain('provider_connection_invalid');
  });

  it('renders an executing approval truthfully without decision controls', async () => {
    const artifact = await createDaemonRoutedApprovalArtifact();
    const request = ApprovalRequestV2Schema.parse({
      ...JSON.parse(artifact.body),
      status: 'executing',
      updatedAtMs: 2,
      decision: { kind: 'approve', decidedAtMs: 2 },
    });
    currentArtifact = {
      ...artifact,
      header: buildApprovalRequestArtifactHeaderV1(request),
      body: JSON.stringify(request),
    };
    const { ApprovalDetailScreen } = await import('./ApprovalDetailScreen');
    const screen = await renderScreen(
      <ApprovalDetailScreen artifactId={currentArtifact.id} />,
    );

    expect(readRenderedText(screen)).toContain('approvals.status.executing');
    expect(screen.findByTestId('approvals.actions')).toBeNull();
    expect(screen.findByTestId('approvals.approve')).toBeNull();
  });

  it('renders an executing target Action approval without decision controls', async () => {
    const artifact = createTargetActionApprovalArtifact();
    const request = TargetActionApprovalRequestV1Schema.parse({
      ...JSON.parse(artifact.body),
      status: 'executing',
      updatedAtMs: 2,
      decision: { kind: 'approve', decidedAtMs: 2 },
    });
    currentArtifact = {
      ...artifact,
      header: buildTargetActionApprovalArtifactHeaderV1(request),
      body: JSON.stringify(request),
    };
    const { ApprovalDetailScreen } = await import('./ApprovalDetailScreen');
    const screen = await renderScreen(
      <ApprovalDetailScreen artifactId={currentArtifact.id} />,
    );

    expect(readRenderedText(screen)).toContain('approvals.status.executing');
    expect(screen.findByTestId('approvals.actions')).toBeNull();
    expect(screen.findByTestId('approvals.approve')).toBeNull();
  });

  it('renders the exact plugin target input and updates only that artifact', async () => {
    currentArtifact = createTargetActionApprovalArtifact();
    const { ApprovalDetailScreen } = await import('./ApprovalDetailScreen');
    const screen = await renderScreen(
      <ApprovalDetailScreen artifactId="target-artifact-1" />,
    );

    const text = readRenderedText(screen);
    expect(text).toContain('Publish the release notes');
    expect(text).toContain(
      'This publishes the approved release notes to the configured remote.',
    );
    expect(text).not.toContain('acme.publisher');
    expect(text).not.toContain('releases/publish');
    expect(text).toContain('v1.2.3-public-release');
    expect(text).not.toContain('bundled_first_party');
    expect(text).not.toContain('must-not-render');
    expect(text).not.toContain('account-secret');
    expect(text).not.toContain('resource-secret');
    expect(text).not.toContain('a'.repeat(64));

    await screen.pressByTestIdAsync('approvals.approve');
    expect(clientExecutionEffects()).toHaveLength(0);
    expect(artifactWrites()).toHaveLength(1);
    const { artifactId, header, body } = decodedArtifactWrite();
    expect(artifactId).toBe('target-artifact-1');
    expect(header).toMatchObject({
      kind: 'target_action_approval.v1',
      approvalStatus: 'approved',
    });
    expect(body).toMatchObject({
      kind: 'plugin_target_action',
      status: 'approved',
      qualifiedActionId: 'acme.publisher/actions/releases/publish',
      subjectFingerprint: 'b'.repeat(64),
      decision: { kind: 'approve' },
    });
  });

  it('shows the real Triage credential identity and approves its complete admitted input', async () => {
    const input = createTriageSelectedPrStartApprovalInput();
    const base = createTargetActionApprovalArtifact();
    const request = TargetActionApprovalRequestV1Schema.parse({ ...JSON.parse(base.body),
      qualifiedActionId: 'happier.triage/actions/sessions/start-entry-v1', input,
    });
    currentArtifact = { ...base, header: buildTargetActionApprovalArtifactHeaderV1(request), body: JSON.stringify(request) };
    const { ApprovalDetailScreen } = await import('./ApprovalDetailScreen');
    const screen = await renderScreen(<ApprovalDetailScreen artifactId="target-artifact-1" />);
    expect(readRenderedText(screen)).toContain(JSON.stringify(input.prepareReviewWorkspaceSelection));
    expect(screen.findByTestId('approvals.approve')?.props.disabled).toBe(false);
    await screen.pressByTestIdAsync('approvals.approve');
    expect(decodedArtifactWrite().body).toMatchObject({ status: 'approved', input });
  });

  it('withholds plugin approval when a secret operand hides the effect despite unrelated readable input', async () => {
    const artifact = createTargetActionApprovalArtifact();
    currentArtifact = { ...artifact, body: JSON.stringify({
      ...JSON.parse(artifact.body),
      input: { releaseTag: 'must-not-render', benign: null }, secretInputPaths: ['releaseTag'],
    }) };
    const { ApprovalDetailScreen } = await import('./ApprovalDetailScreen');
    const screen = await renderScreen(<ApprovalDetailScreen artifactId="target-artifact-1" />);
    expect(readRenderedText(screen)).not.toContain('must-not-render');
    expect(screen.findByTestId('approvals.approve')?.props.disabled).toBe(true);
    expect(screen.findByTestId('approvals.reject')?.props.disabled).toBe(false);
    await screen.pressByTestIdAsync('approvals.approve');
    expect(artifactWrites()).toHaveLength(0);
    expect(daemonDecisions()).toHaveLength(0);
  });

  it.each(['approve', 'reject', 'cancel'] as const)('routes the target requester %s through the Bot Session with only View and no Machine grant', async decision => {
    currentArtifact = await createRequesterTargetApprovalArtifact();
    includeExactApprovalMachine = false;
    machineFixtures = {};
    machineFixturesByServerId = {};
    daemonReply = { ok: true, result: { status: decision === 'approve' ? 'executed' : decision === 'reject' ? 'rejected' : 'canceled' } };
    const { ApprovalDetailScreen } = await import('./ApprovalDetailScreen');
    const screen = await renderScreen(<ApprovalDetailScreen artifactId="requester-target" serverId="ui-A" />);
    const received = homes.artifacts(account.serverId).readPlainBody('requester-target');
    const { resolveApprovalReplayRoute } = await import('@/sync/ops/actions/defaultActionExecutor');
    const origin = JSON.parse(currentArtifact.body).executionOriginV1;
    const route = resolveApprovalReplayRoute(JSON.parse(currentArtifact.body));
    const routeEvidence = JSON.stringify({ route, accountServerId: account.serverId,
      signedOrigin: { serverId: origin.serverId, serverIdentityId: origin.serverIdentityId } });
    expect(route, routeEvidence).toMatchObject({
      serverIdentityId: origin.serverIdentityId, originServerId: origin.serverId,
    });
    expect(resolveServerProfileScopeIdForIdentifier(route?.serverId), routeEvidence)
      .toBe(resolveServerProfileScopeIdForIdentifier(account.serverId));
    expect(storage.getState().artifacts['requester-target']?.access).toBe('view');
    expect(storage.getState().machines['machine-exact']).toBeUndefined();

    await screen.pressByTestIdAsync(`approvals.${decision}`);

    const { Modal } = await import('@/modal');
    expect(Modal.alert).not.toHaveBeenCalled();
    expect(daemonDecisions()).toEqual([expect.objectContaining({ method: `session-1:${RPC_METHODS.APPROVAL_REQUEST_DECIDE}`,
      params: { artifactId: 'requester-target', sessionId: 'session-1', decision } })]);
    expect(homes.artifacts(account.serverId).readPlainBody('requester-target')).toBe(received);
    expect(artifactWrites()).toHaveLength(0);
    expect(screen.findByTestId('approvals.actions')).toBeNull();
  });

  it('shows another Account who can confirm a requester-bound request instead of a decision it cannot make', async () => {
    currentArtifact = await createRequesterTargetApprovalArtifact('another-requester');
    includeExactApprovalMachine = false;
    machineFixtures = {};
    machineFixturesByServerId = {};
    const { ApprovalDetailScreen } = await import('./ApprovalDetailScreen');
    const screen = await renderScreen(<ApprovalDetailScreen artifactId="requester-target" serverId="ui-A" />);
    const received = homes.artifacts(account.serverId).readPlainBody('requester-target');
    expect(storage.getState().artifacts['requester-target']?.access).toBe('view');

    expect(screen.findByTestId('approvals.requester-confirmation.waiting')).not.toBeNull();
    expect(screen.findByTestId('approvals.actions')).toBeNull();
    expect(screen.findByTestId('approvals.approve')).toBeNull();
    expect(daemonDecisions()).toHaveLength(0);
    expect(artifactWrites()).toHaveLength(0);
    expect(homes.artifacts(account.serverId).readPlainBody('requester-target')).toBe(received);
  });

  it('offers the requester-bound decision only to the Account that asked', async () => {
    currentArtifact = await createRequesterTargetApprovalArtifact();
    includeExactApprovalMachine = false;
    machineFixtures = {};
    machineFixturesByServerId = {};
    const { ApprovalDetailScreen } = await import('./ApprovalDetailScreen');
    const screen = await renderScreen(<ApprovalDetailScreen artifactId="requester-target" serverId="ui-A" />);

    expect(screen.findByTestId('approvals.requester-confirmation')).not.toBeNull();
    expect(screen.findByTestId('approvals.requester-confirmation.waiting')).toBeNull();
    expect(screen.findByTestId('approvals.approve')).not.toBeNull();
  });

  it('routes an API target-action approval to its stamped daemon instead of mutating the Artifact locally', async () => {
    currentArtifact = await createApiTargetActionApprovalArtifact();
    const { ApprovalDetailScreen } = await import('./ApprovalDetailScreen');
    const screen = await renderScreen(
      <ApprovalDetailScreen artifactId="target-api-artifact-1" />,
    );

    await screen.pressByTestIdAsync('approvals.approve');

    expectDaemonDecision('target-api-artifact-1', 'approve', TargetActionApprovalRequestV1Schema.parse(JSON.parse(currentArtifact.body)).executionOriginV1!.serverId);
    expect(artifactWrites()).toHaveLength(0);
    expect(clientExecutionEffects()).toHaveLength(0);
  });

  it('routes an API target-action rejection to its stamped daemon without executing client-side', async () => {
    currentArtifact = await createApiTargetActionApprovalArtifact();
    const { ApprovalDetailScreen } = await import('./ApprovalDetailScreen');
    const screen = await renderScreen(
      <ApprovalDetailScreen artifactId="target-api-artifact-1" />,
    );

    await screen.pressByTestIdAsync('approvals.reject');

    expectDaemonDecision('target-api-artifact-1', 'reject', TargetActionApprovalRequestV1Schema.parse(JSON.parse(currentArtifact.body)).executionOriginV1!.serverId);
    expect(artifactWrites()).toHaveLength(0);
    expect(clientExecutionEffects()).toHaveLength(0);
  });

  it('refreshes a typed stale target refusal and removes its decision controls', async () => {
    currentArtifact = await createApiTargetActionApprovalArtifact();
    const request = TargetActionApprovalRequestV1Schema.parse({
      ...JSON.parse(currentArtifact.body), status: 'failed', updatedAtMs: 2,
      decision: { kind: 'approve', decidedAtMs: 2 },
      execution: { executedAtMs: 2, ok: false, errorCode: 'approval_stale', error: 'Current policy differs' },
    });
    const failedArtifact = { ...currentArtifact, header: buildTargetActionApprovalArtifactHeaderV1(request), body: JSON.stringify(request) };
    daemonReply = { ok: false, errorCode: 'approval_stale', error: 'Current policy differs' };
    remoteArtifact = failedArtifact;
    const { ApprovalDetailScreen } = await import('./ApprovalDetailScreen');
    const screen = await renderScreen(<ApprovalDetailScreen artifactId="target-api-artifact-1" />);
    await screen.pressByTestIdAsync('approvals.approve');

    expect(approvalItem(screen, 'approvals.execution-failure')?.props.subtitle).toBe('approvals.staleFailure');
    expect(readRenderedText(screen)).toContain('approvals.status.failed');
    expect(readRenderedText(screen)).not.toContain('approvals.status.approved');
    expect(screen.findByTestId('approvals.approve')).toBeNull();
    expect(screen.findByTestId('approvals.reject')).toBeNull();
    const { Modal } = await import('@/modal');
    expect(Modal.alert).toHaveBeenCalledWith('common.error', 'approvals.staleFailure');
    expect(clientExecutionEffects()).toHaveLength(0);
    expect(artifactWrites()).toHaveLength(0);
  });

  it('refreshes the target approval after exact-daemon replay so the decision UI reflects the durable result', async () => {
    currentArtifact = await createApiTargetActionApprovalArtifact();
    const refreshedRequest = TargetActionApprovalRequestV1Schema.parse({
      ...JSON.parse(currentArtifact.body),
      status: 'approved',
      updatedAtMs: 2,
      decision: { kind: 'approve', decidedAtMs: 2 },
    });
    remoteArtifact = {
      ...currentArtifact,
      header: buildTargetActionApprovalArtifactHeaderV1(refreshedRequest),
      body: JSON.stringify(refreshedRequest),
    };
    const { ApprovalDetailScreen } = await import('./ApprovalDetailScreen');
    const screen = await renderScreen(
      <ApprovalDetailScreen artifactId="target-api-artifact-1" />,
    );

    await screen.pressByTestIdAsync('approvals.approve');

    expectDaemonDecision('target-api-artifact-1', 'approve', TargetActionApprovalRequestV1Schema.parse(JSON.parse(currentArtifact.body)).executionOriginV1!.serverId);
    expect(artifactReads('target-api-artifact-1').length).toBeGreaterThan(1);
    expect(readRenderedText(screen)).toContain('approvals.status.approved');
    expect(screen.findByTestId('approvals.actions')).toBeNull();
  });

  it('routes a current durable Action approval through this device profile while preserving its immutable origin', async () => {
    currentArtifact = await createDaemonRoutedApprovalArtifact();
    const { ApprovalDetailScreen } = await import('./ApprovalDetailScreen');
    const screen = await renderScreen(
      <ApprovalDetailScreen artifactId="daemon-approval-1" />,
    );

    expect(artifactWrites()).toHaveLength(0);
    await screen.pressByTestIdAsync('approvals.approve');

    const decisions = homes.requestsFor('/v1/actions/approval.request.decide');
    expect(decisions).toHaveLength(1);
    expect(decisions[0]).toMatchObject({ serverId: account.serverId, input: {
      target: { kind: 'machine', machineId: 'machine-exact' },
      input: { artifactId: 'daemon-approval-1', decision: 'approve', serverIdentityId: 'srv_approval_home_a',
        originServerId: ApprovalRequestV2Schema.parse(JSON.parse(currentArtifact.body)).executionOriginV1.serverId },
    } });
    expect(JSON.parse(homes.artifacts(account.serverId).readPlainBody('daemon-approval-1')!)).toMatchObject({
      executionOriginV1: JSON.parse(currentArtifact.body).executionOriginV1,
    });
    const writes = artifactWrites();
    const transitions = writes.map((_, index) => {
      const written = decodedArtifactWrite(index).body;
      return { status: written.status, decision: written.decision?.kind, executed: written.execution?.ok };
    });
    // The real decision owner records consent before handing execution to
    // the original daemon. That write is not a client-side Action replay.
    expect(transitions).toEqual([{ status: 'approved', decision: 'approve', executed: undefined }]);
    expect(rpcRequests).toEqual([]);
  });

  it('shows the original execution surface and exact Home without exposing principal credentials', async () => {
    currentArtifact = await createDaemonRoutedApprovalArtifact();
    // The producing host had its Session; this receiver knows only its Home.
    sessionFixturesByServerId = { ...sessionFixturesByServerId, 'ui-A': {} };
    const { ApprovalDetailScreen } = await import('./ApprovalDetailScreen');
    const screen = await renderScreen(
      <ApprovalDetailScreen artifactId="daemon-approval-1" />,
    );

    expect(readRenderedText(screen)).toContain('api');
    // The Home has no name of its own, but this device is signed in to it: the sentence names it.
    expect(readRenderedText(screen)).toContain(
      'detailPages.approval.sessionOnHome',
    );
    expect(readRenderedText(screen)).not.toContain('principal-1');
    expect(readRenderedText(screen)).not.toContain('credential-1');
  });

  it('names the asking Home and the Action as a person knows them, not by raw ids', async () => {
    approvalHomeFixture = {
      kind: 'resolved',
      serverIdentityId: 'srv_approval_home_a',
      profile: {
        id: 'ui-A',
        serverIdentityId: 'srv_approval_home_a',
        name: 'Studio Mac',
      },
    };
    currentArtifact = await createDaemonRoutedApprovalArtifact();
    const { ApprovalDetailScreen } = await import('./ApprovalDetailScreen');
    const screen = await renderScreen(
      <ApprovalDetailScreen artifactId="daemon-approval-1" />,
    );

    const requestedBy = screen.findAll(
      (node: any) => node.props?.homeName !== undefined,
    )[0];
    expect(requestedBy?.props.homeName).toBe('Studio Mac');
    // The built-in Action reads by its title; its raw id is not copy.
    expect(
      String(approvalItem(screen, 'approvals.action')?.props.subtitle ?? ''),
    ).not.toContain('session.title.set');
  });

  it('titles an older request without its raw session id and names the sessions its details point at', async () => {
    sessionFixturesByServerId = {
      ...sessionFixturesByServerId,
      'ui-A': {
        'session-1': createSessionFixture({
          id: 'session-1',
          metadata: {
            name: 'Child A',
            path: '/Users/leeroy/repo',
            host: 'tester.local',
          },
        }),
        'session-lead': createSessionFixture({
          id: 'session-lead',
          metadata: {
            name: 'Lead session',
            path: '/Users/leeroy/repo',
            host: 'tester.local',
          },
        }),
      },
    };
    currentArtifact = await createBuiltInApprovalArtifact({
      actionId: 'session.manager.set',
      actionArgs: {
        sessionId: 'session-1',
        managerSessionId: 'session-lead',
        expectedManagerSessionId: null,
      },
      summary: 'Set Session manager — session-1',
    });
    const { ApprovalDetailScreen } = await import('./ApprovalDetailScreen');
    const screen = await renderScreen(
      <ApprovalDetailScreen artifactId="artifact-1" />,
    );

    // One title rule with the Inbox row: no raw id, and the Action row does not repeat it.
    const details = readRenderedText(screen);
    expect(details).toContain('Set Session manager');
    expect(details).not.toContain('— session-1');
    expect(screen.findByTestId('approvals.action')).toBeNull();
    expect(details, details).not.toContain('session-lead');
    expect(details).toContain('Lead session');
    expect(details).toContain('Child A');
    expect(details).not.toContain('null to detach');
  });

  it('says who asked in words: a session this device does not have reads by where it lives, the origin is never a raw enum, and the Home is never its address', async () => {
    approvalHomeFixture = {
      kind: 'resolved',
      serverIdentityId: 'srv_approval_home_a',
      profile: {
        id: 'ui-A',
        serverIdentityId: 'srv_approval_home_a',
        name: 'happier-agent-qa-orc.localhost:3021',
        serverUrl: 'http://happier-agent-qa-orc.localhost:3021',
      },
    };
    // No session fixture for ui-A: the asking session is not on this device.
    sessionFixturesByServerId = { ...sessionFixturesByServerId, 'ui-A': {} };
    currentArtifact = await createDaemonRoutedApprovalArtifact();
    const { ApprovalDetailScreen } = await import('./ApprovalDetailScreen');
    const screen = await renderScreen(
      <ApprovalDetailScreen artifactId="daemon-approval-1" />,
    );

    const text = readRenderedText(screen);
    // The Home has no name of its own but is this device's Home: the session is on "this Home", never "on <address>"
    // and never "not on this device".
    expect(text).toContain('detailPages.approval.sessionOnHome');
    expect(text).not.toContain('detailPages.approval.sessionElsewhere');
    expect(text).not.toContain('localhost:3021');
    expect(text).toContain('detailPages.approval.origin.api');
    expect(
      String(screen.findByTestId('approvals.requester-origin')?.props.children),
    ).not.toBe('api');
    // The Details row names the unknown session the same way, never by its id.
    expect(text).not.toContain('session-1');
  });

  it('fails closed when the original Home is removed and a different Home is available', async () => {
    currentArtifact = await createDaemonRoutedApprovalArtifact();
    const { ApprovalDetailScreen } = await import('./ApprovalDetailScreen');
    const screen = await renderScreen(
      <ApprovalDetailScreen artifactId="daemon-approval-1" />,
    );
    const { getServerProfileById, removeServerProfile, resolveServerProfileForPortableIdentity } =
      await import('@/sync/domains/server/serverProfiles');
    const source = getServerProfileById(account.serverId);
    if (!source) throw new Error('Expected the original approval Home');
    await homes.addHome({ name: 'Another Home', serverUrl: 'https://other-approval-home.test',
      serverIdentityId: 'srv_approval_home_b', accountId: 'account-1', currentAccount: true, active: false });
    await act(async () => { await removeServerProfile(source.id); });
    expect(resolveServerProfileForPortableIdentity('srv_approval_home_a').kind).toBe('missing');
    expect(resolveServerProfileForPortableIdentity('srv_approval_home_b').kind).toBe('resolved');

    expect(daemonDecisions()).toHaveLength(0);
    expect(clientExecutionEffects()).toHaveLength(0);
    expect(artifactWrites()).toHaveLength(0);
    // Losing the Artifact's Home retires its reader as well as its decision route.
    expect(screen.findByTestId('approvals.approve')).toBeNull();
    expect(screen.findByTestId('approvals.reject')).toBeNull();
    expect(screen.findByTestId('approvals.retry')).not.toBeNull();
    expect(readRenderedText(screen)).toContain('actionConfirmations.homeUnavailable');
  });

  it('explains how to recover when the deep-linked Home is unavailable before the Artifact can load', async () => {
    currentArtifact = await createDaemonRoutedApprovalArtifact();
    const { ApprovalDetailScreen } = await import('./ApprovalDetailScreen');
    const screen = await renderScreen(
      <ApprovalDetailScreen
        artifactId="daemon-approval-1"
        serverId="srv_missing_approval_home"
      />,
    );

    expect(readRenderedText(screen)).toContain(
      'actionConfirmations.homeUnavailable',
    );
    expect(screen.findByTestId('approvals.approve')).toBeNull();
    expect(screen.findByTestId('approvals.reject')).toBeNull();
  });

  it('refreshes the durable result without local fallback when exact-daemon replay records approval_stale', async () => {
    currentArtifact = await createDaemonRoutedApprovalArtifact();
    const request = ApprovalRequestV2Schema.parse(JSON.parse(currentArtifact.body));
    const settledAtMs = request.updatedAtMs + 1;
    const failed = ApprovalRequestV2Schema.parse({ ...request, status: 'failed', updatedAtMs: settledAtMs,
      decision: { kind: 'approve', decidedAtMs: settledAtMs },
      execution: { executedAtMs: settledAtMs, ok: false, errorCode: 'approval_stale' } });
    remoteArtifact = { ...currentArtifact, header: buildApprovalRequestArtifactHeaderV1(failed), body: JSON.stringify(failed) };
    daemonReply = {
      ok: true,
      result: {
        status: 'failed',
        execution: failed.execution,
      },
    };
    const { ApprovalDetailScreen } = await import('./ApprovalDetailScreen');
    const screen = await renderScreen(
      <ApprovalDetailScreen artifactId="daemon-approval-1" />,
    );

    await screen.pressByTestIdAsync('approvals.approve');

    expect(homes.requestsFor('/v1/actions/approval.request.decide')).toHaveLength(1);
    expect(artifactWrites()).toHaveLength(1);
    expect(decodedArtifactWrite().body).toMatchObject({ status: 'approved', decision: { kind: 'approve' } });
    expect(decodedArtifactWrite().body.execution).toBeUndefined();
    expect(rpcRequests).toEqual([]);
    expect(artifactReads('daemon-approval-1').length).toBeGreaterThan(1);
    expect(readRenderedText(screen)).toContain('approvals.status.failed');
    expect(screen.findByTestId('approvals.approve')).toBeNull();
  });

  it('does not fall back to the UI executor when the exact approval daemon is unavailable', async () => {
    currentArtifact = await createDaemonRoutedApprovalArtifact();
    daemonError = Object.assign(new Error('Machine RPC target unavailable'), {
        code: 'MACHINE_RPC_TARGET_UNAVAILABLE',
      });
    const { ApprovalDetailScreen } = await import('./ApprovalDetailScreen');
    const screen = await renderScreen(
      <ApprovalDetailScreen artifactId="daemon-approval-1" />,
    );

    await screen.pressByTestIdAsync('approvals.approve');

    expect(homes.requestsFor('/v1/actions/approval.request.decide')).toHaveLength(1);
    expect(artifactWrites()).toHaveLength(1);
    expect(decodedArtifactWrite().body).toMatchObject({ status: 'approved', decision: { kind: 'approve' } });
    expect(decodedArtifactWrite().body.execution).toBeUndefined();
    expect(rpcRequests).toEqual([]);
  });

  it('renders and updates only the execution-run host-action approval artifact', async () => {
    currentArtifact = createExecutionRunHostActionApprovalArtifact();
    const { ApprovalDetailScreen } = await import('./ApprovalDetailScreen');
    const screen = await renderScreen(
      <ApprovalDetailScreen artifactId="host-action-artifact-1" />,
    );

    const text = readRenderedText(screen);
    expect(text).toContain('Create 1 proposed review comment');
    expect(text).not.toContain('acme.review');
    expect(text).not.toContain('reviews.comments.create');
    expect(text).toContain('approvals.proposedComments');
    expect(text).toContain('Use the canonical owner.');
    expect(text).not.toContain('project-1');
    expect(text).not.toContain('c'.repeat(64));

    await screen.pressByTestIdAsync('approvals.approve');
    expect(clientExecutionEffects()).toHaveLength(0);
    expect(artifactWrites()).toHaveLength(1);
    const { artifactId, header, body } = decodedArtifactWrite();
    expect(artifactId).toBe('host-action-artifact-1');
    expect(header).toMatchObject({
      kind: 'execution_run_host_action_approval.v1',
      approvalStatus: 'approved',
      actionId: 'reviews.comments.create',
      runId: 'run-1',
    });
    expect(body).toMatchObject({
      kind: 'execution_run_host_action',
      status: 'approved',
      decision: { kind: 'approve' },
      subjectFingerprint: 'c'.repeat(64),
    });
  });

  it('shows the authoritative execution failure reason for a terminal target action approval', async () => {
    const targetApproval = createTargetActionApprovalArtifact();
    currentArtifact = {
      ...targetApproval,
      header: {
        ...targetApproval.header,
        approvalStatus: 'failed',
      },
      body: JSON.stringify({
        ...JSON.parse(targetApproval.body),
        status: 'failed',
        updatedAtMs: 2,
        decision: { kind: 'approve', decidedAtMs: 2 },
        execution: {
          executedAtMs: 3,
          ok: false,
          errorCode: 'machine_offline',
          error: 'The selected machine is offline.',
        },
      }),
    };
    const { ApprovalDetailScreen } = await import('./ApprovalDetailScreen');
    const screen = await renderScreen(
      <ApprovalDetailScreen artifactId="target-artifact-1" />,
    );

    expect(readRenderedText(screen)).toContain(
      'The selected machine is offline.',
    );
    expect(screen.findByTestId('approvals.execution-failure')).not.toBeNull();
    expect(screen.findByTestId('approvals.approve')).toBeNull();
    expect(screen.findByTestId('approvals.reject')).toBeNull();
  });

  it('fails closed when a target header is paired with a built-in body', async () => {
    currentArtifact = {
      ...createApprovalArtifact(),
      id: 'target-artifact-1',
      header: createTargetActionApprovalArtifact().header,
    };
    const { ApprovalDetailScreen } = await import('./ApprovalDetailScreen');
    const screen = await renderScreen(
      <ApprovalDetailScreen artifactId="target-artifact-1" />,
    );

    expect(readRenderedText(screen)).toContain('approvals.loadError');
    expect(screen.findByTestId('approvals.approve')).toBeNull();
    expect(clientExecutionEffects()).toHaveLength(0);
    expect(artifactWrites()).toHaveLength(0);
  });

  it('reloads the authoritative artifact after a decision version conflict', async () => {
    currentArtifact = createTargetActionApprovalArtifact();
    const authoritative = {
      ...createTargetActionApprovalArtifact(),
      header: {
        ...createTargetActionApprovalArtifact().header,
        approvalStatus: 'approved',
      },
      body: JSON.stringify({
        ...JSON.parse(createTargetActionApprovalArtifact().body),
        status: 'approved',
        updatedAtMs: 2,
        decision: { kind: 'approve', decidedAtMs: 2 },
      }),
    };
    beforeArtifactUpdate = async () => { commitRemoteArtifact(authoritative); };
    const { ApprovalDetailScreen } = await import('./ApprovalDetailScreen');
    const screen = await renderScreen(
      <ApprovalDetailScreen artifactId="target-artifact-1" />,
    );

    await screen.pressByTestIdAsync('approvals.approve');

    expect(artifactReads('target-artifact-1').length).toBeGreaterThan(1);
    expect(storage.getState().artifacts['target-artifact-1']).toMatchObject(authoritative);
    expect(clientExecutionEffects()).toHaveLength(0);
  });

  it('writes exact reject and cancel transitions without executing client-side', async () => {
    currentArtifact = createTargetActionApprovalArtifact();
    const { ApprovalDetailScreen } = await import('./ApprovalDetailScreen');
    const rejectScreen = await renderScreen(
      <ApprovalDetailScreen artifactId="target-artifact-1" />,
    );
    await rejectScreen.pressByTestIdAsync('approvals.reject');
    expect(
      decodedArtifactWrite().body,
    ).toMatchObject({
      status: 'rejected',
      decision: { kind: 'reject' },
    });

    // Cancellation is a separate open request; a rejected request cannot be reopened.
    currentArtifact = { ...createTargetActionApprovalArtifact(), id: 'target-cancel-artifact-1' };
    const cancelScreen = await renderScreen(
      <ApprovalDetailScreen artifactId="target-cancel-artifact-1" />,
    );
    await cancelScreen.pressByTestIdAsync('approvals.cancel');
    const canceled = decodedArtifactWrite().body;
    expect(canceled).toMatchObject({ status: 'canceled' });
    expect(canceled).not.toHaveProperty('decision');
    expect(clientExecutionEffects()).toHaveLength(0);
  });

  it('guards same-frame duplicate decisions and removes controls for terminal artifacts', async () => {
    currentArtifact = createTargetActionApprovalArtifact();
    let release!: () => void;
    beforeArtifactUpdate = async () =>
        await new Promise<void>((resolve) => {
          release = resolve;
        });
    const { ApprovalDetailScreen } = await import('./ApprovalDetailScreen');
    const screen = await renderScreen(
      <ApprovalDetailScreen artifactId="target-artifact-1" />,
    );
    const approve = screen.findByTestId('approvals.approve');
    expect(approve).not.toBeNull();
    await act(async () => {
      approve!.props.onPress();
      approve!.props.onPress();
      await vi.waitFor(() => expect(artifactWrites()).toHaveLength(1));
    });
    expect(artifactWrites()).toHaveLength(1);
    await act(async () => release());

    currentArtifact = {
      ...createTargetActionApprovalArtifact(),
      header: {
        ...createTargetActionApprovalArtifact().header,
        approvalStatus: 'approved',
      },
      body: JSON.stringify({
        ...JSON.parse(createTargetActionApprovalArtifact().body),
        status: 'approved',
        updatedAtMs: 2,
        decision: { kind: 'approve', decidedAtMs: 2 },
      }),
    };
    const terminal = await renderScreen(
      <ApprovalDetailScreen artifactId="target-artifact-1" />,
    );
    expect(terminal.findByTestId('approvals.approve')).toBeNull();
    expect(terminal.findByTestId('approvals.reject')).toBeNull();
    expect(terminal.findByTestId('approvals.cancel')).toBeNull();
  });

  it('provides explicit accessible labels for all target decision controls', async () => {
    currentArtifact = createTargetActionApprovalArtifact();
    const { ApprovalDetailScreen } = await import('./ApprovalDetailScreen');
    const screen = await renderScreen(
      <ApprovalDetailScreen artifactId="target-artifact-1" />,
    );

    expect(
      screen.findByTestId('approvals.approve')?.props.accessibilityLabel,
    ).toBe('approvals.approve');
    expect(
      screen.findByTestId('approvals.reject')?.props.accessibilityLabel,
    ).toBe('approvals.reject');
    expect(
      screen.findByTestId('approvals.cancel')?.props.accessibilityLabel,
    ).toBe('approvals.dismiss');
  });

  it('shows both target replacement and exact-mirror deletion in one handoff approval that names both endpoints', async () => {
    currentArtifact = createHandoffApprovalArtifact({
      mode: 'mirror_exactly',
      consequences: [
        'replace_nonempty_workspace_target',
        'delete_target_only_files_during_exact_mirror',
      ],
    });
    const { ApprovalDetailScreen } = await import('./ApprovalDetailScreen');
    const screen = await renderScreen(
      <ApprovalDetailScreen artifactId="artifact-1" />,
    );
    // The requester line holds a placeholder until its exact-Home reading settles.
    await waitForHomeGovernance(() => expect(screen.findByTestId('approvals.requester-title')).not.toBeNull());
    expect(
      screen.findByTestId('approvals.handoff-target-consequences'),
    ).not.toBeNull();
    const text = readRenderedText(screen);
    expect(text).toContain('sessionHandoff.targetApproval.replaceTarget');
    expect(text).toContain('sessionHandoff.targetApproval.exactMirror');
    // The confirmation must name where the workspace comes from and where it lands.
    expect(text).toContain('sessionHandoff.targetApproval.sourceLabel');
    expect(text).toContain('sessionHandoff.targetApproval.destinationLabel');
    expect(text).toContain('Rebound workstation');
    expect(text).toContain('~/repo');
    expect(text).toContain('Studio laptop');
    expect(text).toContain('/workspace/target');
    // The chosen sync mode is read from the persisted action arguments.
    expect(text).toContain('sessionHandoff.targetApproval.modeLabel');
    expect(text).toContain('workspaceSync.mode.mirrorExactly');
    // Read the real button's public props, not a nested platform host node.
    // The exact-mirror consequence replaces the generic decision label.
    const approve = decisionButton(screen, 'approvals.approve');
    expect(approve?.props.title).toBe(
      'sessionHandoff.targetApproval.decision.mirrorAndAllowRemovals',
    );
    expect(approve?.props.accessibilityLabel).toBe(
      'sessionHandoff.targetApproval.decision.mirrorAndAllowRemovals',
    );
    expect(
      screen.findAllByTestId('approvals.handoff-target-consequences'),
    ).toHaveLength(1);
  });

  it('says what a computer input sends, and where, from the computer owner’s display facts', async () => {
    currentArtifact = await createBuiltInApprovalArtifact({
      actionId: 'computer.input',
      sourceSessionId: 'session-1',
      actionArgs: {
        machineId: 'machine-2',
        captureId: 'capture_1',
        operation: { kind: 'type', text: 'ana@lumen.dev' },
      },
      summary: 'Type the QA user email',
      // Host-resolved by the computer owner (W7); the agent's arguments carry no target.
      preview: {
        computerApprovalDisplay: {
          machineDisplayName: 'Workstation one',
          requiresTargetSelection: false,
          target: { kind: 'window', title: 'Sign in to Lumen' },
        },
      },
    });
    const { ApprovalDetailScreen } = await import('./ApprovalDetailScreen');
    const screen = await renderScreen(
      <ApprovalDetailScreen artifactId="artifact-1" />,
    );
    expect(screen.findByTestId('approvals.computer-action')).not.toBeNull();
    const text = readRenderedText(screen);
    expect(text).toContain('computerUse.approval.act.type');
    expect(text).toContain('ana@lumen.dev');
    // This suite's `t` drops params, so read what the page handed the card.
    const card = screen.tree.root.findAll(
      (node) => node.props?.presentation?.machineName === 'Workstation one',
    );
    expect(card.length).toBeGreaterThan(0);
    expect(card[0]!.props.presentation.target).toEqual({
      kind: 'window',
      title: 'Sign in to Lumen',
    });
  });

  it('names both endpoints and uses a consequence-specific decision for an ordinary non-empty replacement', async () => {
    currentArtifact = createHandoffApprovalArtifact({
      mode: 'keep_synced',
      consequences: ['replace_nonempty_workspace_target'],
    });
    delete machineFixtures['machine-target'];
    const { ApprovalDetailScreen } = await import('./ApprovalDetailScreen');
    const screen = await renderScreen(
      <ApprovalDetailScreen artifactId="artifact-1" />,
    );
    // The requester line holds a placeholder until its exact-Home reading settles.
    await waitForHomeGovernance(() => expect(screen.findByTestId('approvals.requester-title')).not.toBeNull());

    const text = readRenderedText(screen);
    expect(text).toContain('sessionHandoff.targetApproval.replaceTarget');
    expect(text).not.toContain('sessionHandoff.targetApproval.exactMirror');
    expect(text).toContain('machine-target');
    expect(text).toContain('~/repo');
    expect(text).toContain('Studio laptop');
    expect(text).toContain('/workspace/target');
    expect(text).toContain('workspaceSync.mode.keepSynced');
    expect(decisionButton(screen, 'approvals.approve')?.props.title).toBe(
      'sessionHandoff.targetApproval.decision.replaceDestination',
    );
  });

  it('names the copy-once mode from the persisted action arguments without implying mirror deletions', async () => {
    currentArtifact = createHandoffApprovalArtifact({
      mode: 'copy_once',
      consequences: ['replace_nonempty_workspace_target'],
    });
    const { ApprovalDetailScreen } = await import('./ApprovalDetailScreen');
    const screen = await renderScreen(
      <ApprovalDetailScreen artifactId="artifact-1" />,
    );

    const text = readRenderedText(screen);
    expect(text).toContain('sessionHandoff.targetApproval.modeLabel');
    expect(text).toContain('workspaceSync.mode.copyOnce');
    expect(text).not.toContain('workspaceSync.mode.mirrorExactly');
    expect(text).toContain('sessionHandoff.targetApproval.replaceTarget');
    expect(text).not.toContain('sessionHandoff.targetApproval.exactMirror');
    expect(decisionButton(screen, 'approvals.approve')?.props.title).toBe(
      'sessionHandoff.targetApproval.decision.replaceDestination',
    );
    // A consequence-bearing label is never truncated: it wraps to whatever the
    // narrow width, large text size or translation needs.
    expect(
      decisionButton(screen, 'approvals.approve')?.props.titleNumberOfLines,
    ).toBe('complete');
    expect(
      decisionButton(screen, 'approvals.reject')?.props.titleNumberOfLines,
    ).toBe('complete');
  });

  it('renders requester, session context, and structured action details', async () => {
    const { ApprovalDetailScreen } = await import('./ApprovalDetailScreen');

    const screen = await renderScreen(
      <ApprovalDetailScreen artifactId="artifact-1" />,
    );
    // The requester line holds a placeholder until its exact-Home reading settles.
    await waitForHomeGovernance(() => expect(screen.findByTestId('approvals.requester-title')).not.toBeNull());

    const text = readRenderedText(screen);
    expect(text).toContain('Approve answering the user');
    expect(text).toContain('Respond to user-action request');
    expect(text).toContain('Repo session');
    expect(text).toContain('Rebound workstation');
    expect(text).toContain('~/repo');
    expect(text).toContain('codex');
    expect(text).toContain('Agent wants to answer the pending question');
    expect(text).toContain('Continue?');
    expect(text).toContain('Yes');
  });

  it('shows the exact reviewed source and destination in a conflict approval without a second Use Version action', async () => {
    currentArtifact = await createBuiltInApprovalArtifact({
      actionId: 'workspace.sync.conflict.resolve',
      summary: 'Resolve src/tool',
      actionArgs: {
        strategy: 'use_source',
        controllerMachineId: 'machine-a',
        hubWorkspaceRefId: 'workspace-a',
        path: 'src/tool',
        source: {
          workspaceRefId: 'workspace-c',
          expected: {
            kind: 'file',
            digest: 'a'.repeat(40),
            executable: true,
            size: 12,
          },
        },
        targets: [
          {
            workspaceRefId: 'workspace-b',
            expected: {
              kind: 'file',
              digest: 'b'.repeat(40),
              executable: false,
              size: 12,
            },
          },
        ],
        relationshipIds: ['a-b', 'a-c'],
      },
    });
    const { ApprovalDetailScreen } = await import('./ApprovalDetailScreen');
    const screen = await renderScreen(
      <ApprovalDetailScreen artifactId="artifact-1" />,
    );
    expect(
      screen.findByTestId('workspace-sync-approved-review'),
    ).not.toBeNull();
    expect(readRenderedText(screen)).toContain('workspace-c');
    expect(readRenderedText(screen)).toContain('workspace-b');
    expect(screen.findByTestId('approvals.approve')).not.toBeNull();
    expect(
      screen.findAll(
        (node) => node.props?.title === 'workspaceSync.review.useNamedVersion',
      ),
    ).toHaveLength(0);
  });

  it('shows a completed conflict Action’s per-endpoint and preserved recovery outcomes in the approved comparison', async () => {
    currentArtifact = await createBuiltInApprovalArtifact({
      actionId: 'workspace.sync.conflict.resolve',
      summary: 'Resolve src/tool',
      actionArgs: {
        strategy: 'keep_both',
        controllerMachineId: 'machine-a',
        hubWorkspaceRefId: 'workspace-a',
        path: 'src/tool',
        source: {
          workspaceRefId: 'workspace-a',
          expected: {
            kind: 'file',
            digest: 'a'.repeat(40),
            executable: false,
            size: 12,
          },
        },
        targets: [
          {
            workspaceRefId: 'workspace-b',
            expected: {
              kind: 'file',
              digest: 'b'.repeat(40),
              executable: false,
              size: 12,
            },
          },
        ],
        relationshipIds: ['a-b'],
        alternatives: [
          {
            source: {
              workspaceRefId: 'workspace-b',
              expected: {
                kind: 'file',
                digest: 'b'.repeat(40),
                executable: false,
                size: 12,
              },
            },
            destination: {
              workspaceRefId: 'workspace-a',
              path: 'src/tool.happier-conflict.b',
              expected: { kind: 'missing' },
            },
            consequence: { propagatingToWorkspaceRefIds: ['workspace-b'] },
          },
        ],
      },
      executedResult: {
        endpoints: [
          { workspaceRefId: 'workspace-a', status: 'applied_paused' },
          {
            workspaceRefId: 'workspace-b',
            status: 'recovery_needed',
            recoveryPath: '/work/recovery-b',
          },
        ],
        preserved: [
          {
            alternativeIndex: 0,
            sourceWorkspaceRefId: 'workspace-b',
            destinationWorkspaceRefId: 'workspace-a',
            path: 'src/tool.happier-conflict.b',
            propagatingToWorkspaceRefIds: [],
            unverifiedPropagationToWorkspaceRefIds: ['workspace-b'],
            outcome: { status: 'not_started' },
          },
        ],
      },
    });
    expect(
      WorkspaceSyncConflictResolutionResultV1Schema.safeParse(
        JSON.parse(currentArtifact.body).execution.result,
      ).success,
    ).toBe(true);
    const matched = approvalArtifactBodyMatchesHeaderV1(
      currentArtifact.header,
      currentArtifact.body,
    );
    expect(matched?.request.status).toBe('executed');
    expect(
      matched?.family === 'built_in' && matched.request.execution,
    ).toMatchObject({ ok: true, result: { endpoints: expect.any(Array) } });
    const { ApprovalDetailScreen } = await import('./ApprovalDetailScreen');
    const screen = await renderScreen(
      <ApprovalDetailScreen artifactId="artifact-1" />,
    );
    expect(
      screen.find((node) => node.props?.reportedOutcome !== undefined).props
        .reportedOutcome.endpoints,
    ).toHaveLength(2);
    expect(
      screen.find(
        (node) =>
          node.props?.title === 'workspace-a' &&
          node.props?.subtitle?.includes('workspaceSync.review.appliedPaused'),
      ),
    ).not.toBeNull();
    expect(
      screen.find(
        (node) =>
          node.props?.title === 'workspaceSync.review.recoveryNeeded' &&
          node.props?.copy === '/work/recovery-b',
      ),
    ).not.toBeNull();
    expect(
      screen.find(
        (node) =>
          node.props?.title === 'workspaceSync.review.preserveAt' &&
          node.props?.subtitle?.includes('workspaceSync.review.notStarted') &&
          node.props?.subtitle?.includes(
            'workspaceSync.review.propagationUnverified',
          ) &&
          node.props?.copy === 'src/tool.happier-conflict.b',
      ),
    ).not.toBeNull();
    expect(
      screen.find(
        (node) =>
          node.props?.title === 'workspaceSync.review.inspectCurrentVersions',
      ),
    ).not.toBeNull();
    await screen.unmount();
  });

  it.each([true, false])('shows the reviewed Profile values or withholds Approve when complete=%s', async (complete) => {
    const profile = { v: 2, id: 'profile-a', name: 'Payments release workspace', createdAt: 1, updatedAt: 2 };
    currentArtifact = await createBuiltInApprovalArtifact({ actionId: 'launch_profiles.save',
      actionArgs: { id: profile.id, expectedRevision: 'absent', profile },
      summary: 'Save launch profile', preview: { actionId: 'launch_profiles.save', actionArgs: { id: profile.id } },
    });
    if (!complete) currentArtifact = { ...currentArtifact, body: JSON.stringify({
      ...JSON.parse(currentArtifact.body), actionArgs: { id: profile.id, expectedRevision: 'absent' },
    }) };
    const screen = await renderScreen(<approvalDetailScreenModule.ApprovalDetailScreen artifactId="artifact-1" />);
    expect(screen.findByTestId('approvals.approve')?.props.disabled).toBe(!complete);
    if (complete) expect(await readRenderedTextWithRowContent(screen)).toContain(profile.name);
    else expect(readRenderedText(screen)).toContain('approvals.unsafeDetailsTitle');
  });

  it('shows the exact Team and member targets before approving deferred governance', async () => {
    currentArtifact = await createBuiltInApprovalArtifact({
      actionId: 'teams.members.remove',
      actionArgs: {
        v: 1,
        teamId: 'team-acme',
        membershipId: 'membership-alice',
      },
      summary: 'Remove Team member',
    });
    const { ApprovalDetailScreen } = await import('./ApprovalDetailScreen');

    const screen = await renderScreen(
      <ApprovalDetailScreen artifactId="artifact-1" />,
    );
    const text = readRenderedText(screen);

    expect(text).toContain('Team ID');
    expect(text).toContain('team-acme');
    expect(text).toContain('Membership ID');
    expect(text).toContain('membership-alice');
    expect(screen.findByTestId('approvals.approve')?.props.disabled).toBe(
      false,
    );
  });

  it('shows canonical invitation context and permits approval without revealing the bearer', async () => {
    const bearer = 'a'.repeat(43);
    approvalHomeFixture = { kind: 'resolved', serverIdentityId: 'srv-home-acme',
      profile: { id: 'ui-A', serverIdentityId: 'srv-home-acme', name: '' } };
    await prepareApprovalFixture();
    const { bindHomeDomainActionHttpRequestV1 } = await import('@happier-dev/protocol/actions/homeDomainActionFamily');
    const { TeamInvitationAcceptApprovalPrepareResultV1Schema } = await import('@happier-dev/protocol/teams/invitation');
    const preparation = bindHomeDomainActionHttpRequestV1('teams.invitations.accept.prepareApproval', { v: 1, token: bearer });
    homes.answer(account.serverId, `${preparation.method} ${preparation.path}`, { body:
      TeamInvitationAcceptApprovalPrepareResultV1Schema.parse({ outcome: 'ok',
        continuation: { v: 1, kind: 'post_auth_invitation', reference: 'invitation-continuation-1', teamId: 'team-acme' },
        preview: { home: { serverId: 'srv-home-acme', displayName: 'Acme Home', storageMode: 'plain' },
          team: { teamId: 'team-acme', name: 'Acme Platform', logo: null, accentSeed: 'team-acme' },
          role: 'member', historyAccess: 'from_membership', state: 'active', expiresAt: Date.now() + 60_000,
          recipientEmailMask: null },
      }) });
    currentArtifact = await createBuiltInApprovalArtifact({
      actionId: 'teams.invitations.accept',
      actionArgs: { v: 1, token: bearer },
      summary: 'Accept Team invitation',
    });
    const { ApprovalDetailScreen } = await import('./ApprovalDetailScreen');

    const screen = await renderScreen(
      <ApprovalDetailScreen artifactId="artifact-1" />,
    );

    const text = readRenderedText(screen);
    expect(text).not.toContain(bearer);
    expect(text).toContain('srv-home-acme');
    expect(text).toContain('team-acme');
    expect(text).toContain('Acme Platform');
    expect(text).toContain('member');
    expect(text).toContain('from_membership');
    expect(screen.findByTestId('approvals.unrepresentable-details')).toBeNull();
    expect(screen.findByTestId('approvals.approve')?.props.disabled).toBe(
      false,
    );
    expect(screen.findByTestId('approvals.reject')?.props.disabled).toBe(false);
  });

  it('renders the released scalar structured-answer shape while withholding legacy approval', async () => {
    currentArtifact = {
      ...createApprovalArtifact(),
      body: JSON.stringify({
        ...defaultApprovalArtifactBody,
        actionArgs: {
          sessionId: 'session-1',
          requestId: 'ask-legacy',
          answers: [
            {
              question: '  Use the compatibility path?  ',
              answer: '  Yes, once  ',
            },
          ],
        },
      }),
    };
    const { ApprovalDetailScreen } = await import('./ApprovalDetailScreen');

    const screen = await renderScreen(
      <ApprovalDetailScreen artifactId="artifact-1" />,
    );
    const text = readRenderedText(screen);

    // The rendered-text testkit normalizes layout whitespace. Exact value
    // preservation is asserted at the structured-answer projection owner.
    expect(text).toContain('Use the compatibility path?');
    expect(text).toContain('Yes, once');
    expect(screen.findByTestId('approvals.unrepresentable-details')).toBeNull();
    expect(screen.findByTestId('approvals.approve')?.props.disabled).toBe(true);
    expect(screen.findByTestId('approvals.reject')?.props.disabled).toBe(false);
  });

  it('withholds approval and shows a bounded safety error when one structured answer is malformed', async () => {
    currentArtifact = {
      ...createApprovalArtifact(),
      body: JSON.stringify({
        ...defaultApprovalArtifactBody,
        actionArgs: {
          sessionId: 'session-1',
          requestId: 'ask-malformed',
          answers: [
            {
              question: '  Use the compatibility path?  ',
              answer: '  Yes, once  ',
            },
            { question: 'Malformed', values: [{ secret: 'must-not-render' }] },
          ],
        },
      }),
    };
    const { ApprovalDetailScreen } = await import('./ApprovalDetailScreen');

    const screen = await renderScreen(
      <ApprovalDetailScreen artifactId="artifact-1" />,
    );
    const text = readRenderedText(screen);

    expect(
      screen.findByTestId('approvals.unrepresentable-details'),
    ).not.toBeNull();
    expect(text).toContain('approvals.unsafeDetailsTitle');
    expect(text).not.toContain('must-not-render');
    // Partial content would imply the reader saw the whole question set.
    expect(text).not.toContain('Use the compatibility path?');

    const approve = screen.findByTestId('approvals.approve');
    expect(approve?.props.disabled).toBe(true);
    expect(approve?.props.accessibilityHint).toBe(
      'approvals.approveUnavailableHint',
    );
    // Rejecting an unshowable request stays available.
    expect(screen.findByTestId('approvals.reject')?.props.disabled).toBe(false);

    await screen.pressByTestIdAsync('approvals.approve');
    expect(clientExecutionEffects()).toHaveLength(0);
    expect(artifactWrites()).toHaveLength(0);
  });

  it('withholds approval for a duplicated structured question', async () => {
    currentArtifact = {
      ...createApprovalArtifact(),
      body: JSON.stringify({
        ...defaultApprovalArtifactBody,
        actionArgs: {
          sessionId: 'session-1',
          requestId: 'ask-duplicate',
          answers: [
            { question: 'Deploy to production?', values: ['No'] },
            { question: 'Deploy to production?', values: ['Yes'] },
          ],
        },
      }),
    };
    const { ApprovalDetailScreen } = await import('./ApprovalDetailScreen');

    const screen = await renderScreen(
      <ApprovalDetailScreen artifactId="artifact-1" />,
    );

    expect(
      screen.findByTestId('approvals.unrepresentable-details'),
    ).not.toBeNull();
    expect(readRenderedText(screen)).not.toContain('Deploy to production?');
    expect(screen.findByTestId('approvals.approve')?.props.disabled).toBe(true);

    await screen.pressByTestIdAsync('approvals.approve');
    expect(clientExecutionEffects()).toHaveLength(0);
  });

  it('withholds approval instead of only hiding a structured answer payload above the canonical total-size bound', async () => {
    currentArtifact = {
      ...createApprovalArtifact(),
      body: JSON.stringify({
        ...defaultApprovalArtifactBody,
        actionArgs: {
          sessionId: 'session-1',
          requestId: 'ask-oversized',
          answers: Array.from({ length: 16 }, (_, index) => ({
            question: `Question ${index}`,
            values: [`oversized-answer-${index}-${'x'.repeat(16_360)}`],
          })),
        },
      }),
    };
    const { ApprovalDetailScreen } = await import('./ApprovalDetailScreen');

    const screen = await renderScreen(
      <ApprovalDetailScreen artifactId="artifact-1" />,
    );

    expect(readRenderedText(screen)).not.toContain('oversized-answer-0');
    expect(
      screen.findByTestId('approvals.unrepresentable-details'),
    ).not.toBeNull();
    expect(screen.findByTestId('approvals.approve')?.props.disabled).toBe(true);

    await screen.pressByTestIdAsync('approvals.approve');
    expect(clientExecutionEffects()).toHaveLength(0);
  });

  it('uses the approval Home for duplicate session ids and opens the scoped session route', async () => {
    currentArtifact = await createCurrentApprovalArtifact('server-approval');
    expect(JSON.parse(currentArtifact.body).executionOriginV1).toMatchObject({ sessionId: 'session-1' });
    approvalHomeFixture = {
      kind: 'resolved',
      serverIdentityId: 'srv_approval_home_a',
      profile: {
        id: 'server-approval',
        serverIdentityId: 'srv_approval_home_a',
        name: '',
      },
    };
    sessionFixtures = {
      'session-1': createSessionFixture({
        id: 'session-1',
        metadata: {
          name: 'Active Home session',
          host: 'tester.local',
          path: '/active',
          machineId: 'machine-active',
        },
      }),
    };
    sessionFixturesByServerId = {
      'server-active': sessionFixtures,
      'server-approval': {
        'session-1': createSessionFixture({
          id: 'session-1',
          metadata: {
            name: 'Approval Home session',
            host: 'tester.local',
            path: '/approval',
            machineId: 'machine-approval',
          },
        }),
      },
    };
    machineFixturesByServerId = {
      'server-approval': {
        'machine-approval': createMachineFixture({
          id: 'machine-approval',
          metadata: {
            displayName: 'Approval Home workstation',
            host: 'approval.local',
            platform: 'darwin',
            happyCliVersion: '0.0.0-test',
            happyHomeDir: '/Users/tester/.happy-dev',
            homeDir: '/Users/tester',
          },
        }),
      },
    };
    const { ApprovalDetailScreen } = await import('./ApprovalDetailScreen');

    const screen = await renderScreen(
      <ApprovalDetailScreen artifactId="artifact-1" />,
    );

    await waitForHomeGovernance(() => expect(readRenderedText(screen)).toContain('Approval Home workstation'));
    expect(readRenderedText(screen)).toContain('Approval Home session');
    expect(readRenderedText(screen)).toContain('/approval');
    expect(readRenderedText(screen)).not.toContain('Active Home session');

    await act(async () => {
      await screen.pressByTestIdAsync('approvals.open-session');
    });

    expect(pushSpy).toHaveBeenCalledWith(
      `/session/session-1?serverId=${encodeURIComponent(account.serverId)}`,
    );
  });

  it('keeps approval actions available for an authorized locked Session without exposing cached title or path', async () => {
    currentArtifact = await createCurrentApprovalArtifact('server-approval');
    expect(JSON.parse(currentArtifact.body).executionOriginV1).toMatchObject({ sessionId: 'session-1' });
    sessionFixturesByServerId = {
      'server-approval': {
        'session-1': createSessionFixture({
          id: 'session-1',
          encryptionMode: 'e2ee',
          encryptedContentAvailability: 'encrypted_access_pending',
          metadata: {
            name: 'Private cached title',
            host: 'tester.local',
            path: '/Users/private/secret-project',
            homeDir: '/Users/private',
            machineId: 'machine-approval',
          },
        }),
      },
    };
    machineFixturesByServerId = {
      'server-approval': {
        'machine-approval': createMachineFixture({ id: 'machine-approval' }),
      },
    };
    const { ApprovalDetailScreen } = await import('./ApprovalDetailScreen');

    const screen = await renderScreen(
      <ApprovalDetailScreen artifactId="artifact-1" />,
    );

    await waitForHomeGovernance(() => expect(readRenderedText(screen)).toContain('detailPages.approval.requesterYou'));
    expect(readRenderedText(screen)).not.toContain('Private cached title');
    expect(readRenderedText(screen)).not.toContain('secret-project');
    // The fixture's request is the person's own (UI origin): the locked Session is context, never the requester.
    expect(readRenderedText(screen)).toContain('detailPages.approval.requesterYou');
    expect(readRenderedText(screen)).not.toContain('detailPages.approval.sessionOnHome');
    expect(screen.findByTestId('approvals.approve')?.props.disabled).toBe(
      false,
    );
    expect(screen.findByTestId('approvals.reject')?.props.disabled).toBe(false);
  });

  it('does not read the active Home session when a bare approval session id is ambiguous', async () => {
    sessionFixtures = {
      'session-1': createSessionFixture({
        id: 'session-1',
        metadata: {
          name: 'Wrong active Home session',
          host: 'tester.local',
          path: '/active',
          machineId: 'machine-target',
        },
      }),
    };
    sessionFixturesByServerId = {
      'server-active': sessionFixtures,
      'server-other': {
        'session-1': createSessionFixture({
          id: 'session-1',
          metadata: {
            name: 'Other Home session',
            host: 'tester.local',
            path: '/other',
            machineId: 'machine-target',
          },
        }),
      },
    };
    await prepareApprovalFixture();
    // Only the two Home-owned list projections are loaded; there is no opened
    // Session record establishing authority for this unscoped legacy request.
    storage.setState({ sessions: {} });
    const { ApprovalDetailScreen } = await import('./ApprovalDetailScreen');

    const screen = await renderScreen(
      <ApprovalDetailScreen artifactId="artifact-1" />,
    );

    expect(readRenderedText(screen)).not.toContain('Wrong active Home session');
    expect(readRenderedText(screen)).not.toContain('Other Home session');
    expect(screen.findByTestId('approvals.open-session')).toBeNull();
  });

  it('asks for a Project setup by machine name and the setup review facts, never by ids or three decisions', async () => {
    await prepareApprovalFixture();
    currentArtifact = await createBuiltInApprovalArtifact({ actionId: 'projects.prepare', summary: 'Set up a project',
      actionArgs: { workspace: { serverId: account.serverId, machineId: 'machine-target', workspaceId: 'ws-8e7638ae', rootPath: '/home/happier/tidewater' }, phase: 'setup' } });
    const { ApprovalDetailScreen } = await import('./ApprovalDetailScreen');
    const screen = await renderScreen(<ApprovalDetailScreen artifactId="artifact-1" />);

    const text = readRenderedText(screen);
    expect(text).toContain('projects.authoring.sessionAsk');
    expect(text).toContain('Rebound workstation');
    expect(screen.findByTestId('approvals.project-command')).not.toBeNull();
    expect(screen.findHostByTestId('approvals.project-command.checkout')?.props.children).toBe('/home/happier/tidewater');
    for (const raw of ['ws-8e7638ae', 'machine-target', 'Qualified checkout', 'Preparation phase']) expect(text).not.toContain(raw);
    expect(screen.findByTestId('approvals.approve')).not.toBeNull();
    expect(screen.findByTestId('approvals.reject')).not.toBeNull();
    expect(screen.findByTestId('approvals.cancel')).toBeNull();
  });

  it('shows the requested source checkout in a Script approval sent to a worker', async () => {
    await prepareApprovalFixture();
    currentArtifact = await createBuiltInApprovalArtifact({
      actionId: 'projects.script.run',
      explicitRequest: true,
      summary: 'Run the tests',
      actionArgs: {
        workspace: { serverId: account.serverId, machineId: 'machine-target', workspaceId: 'tidewater-checkout', rootPath: '/home/happier/tidewater' },
        selection: { kind: 'named', name: 'test' },
        choice: { kind: 'workers', destination: { kind: 'machine', machineId: 'worker-target' } },
      },
    });
    const { ApprovalDetailScreen } = await import('./ApprovalDetailScreen');
    const screen = await renderScreen(<ApprovalDetailScreen artifactId="artifact-1" />);

    expect(screen.findHostByTestId('approvals.project-command.checkout')?.props.children).toBe('/home/happier/tidewater');
    expect(screen.findHostByTestId('approvals.project-command.where')?.props.children).toBe('worker-target');
    expect(readRenderedText(screen)).not.toContain('tidewater-checkout');
    expect(screen.findByTestId('approvals.approve')).not.toBeNull();
  });

  it('places the primary approve action before the reject action', async () => {
    const { ApprovalDetailScreen } = await import('./ApprovalDetailScreen');

    const screen = await renderScreen(
      <ApprovalDetailScreen artifactId="artifact-1" />,
    );

    const testIdOrder = collectRenderedTestIds(screen.tree.toJSON());

    expect(testIdOrder.indexOf('approvals.approve')).toBeGreaterThanOrEqual(0);
    expect(testIdOrder.indexOf('approvals.reject')).toBeGreaterThanOrEqual(0);
    expect(testIdOrder.indexOf('approvals.approve')).toBeLessThan(
      testIdOrder.indexOf('approvals.reject'),
    );
  });

  it('fetches the artifact body when the route opens without a cached artifact', async () => {
    currentArtifact = null;
    const { ApprovalDetailScreen } = await import('./ApprovalDetailScreen');

    const screen = await renderScreen(
      <ApprovalDetailScreen artifactId="artifact-1" />,
    );

    expect(artifactReads('artifact-1').length).toBeGreaterThan(0);
    expect(screen).toBeTruthy();
  });

  it('fetches the artifact body when only a header-only artifact with a null body is cached', async () => {
    currentArtifact = {
      ...createApprovalArtifact(),
      body: null,
    };
    const { ApprovalDetailScreen } = await import('./ApprovalDetailScreen');

    const screen = await renderScreen(
      <ApprovalDetailScreen artifactId="artifact-1" />,
    );

    expect(artifactReads('artifact-1').length).toBeGreaterThan(0);
    expect(screen).toBeTruthy();
  });

  it('shows an error state when loading a missing approval artifact fails', async () => {
    currentArtifact = null;
    const { ApprovalDetailScreen } = await import('./ApprovalDetailScreen');

    const screen = await renderScreen(
      <ApprovalDetailScreen artifactId="artifact-1" />,
    );

    const text = readRenderedText(screen);
    expect(artifactReads('artifact-1').length).toBeGreaterThan(0);
    expect(text).toContain('approvals.loadError');
    expect(screen.findAllByType(await loadActivitySpinner())).toHaveLength(0);
    expect(screen.findByTestId('approvals.retry')).not.toBeNull();

    const readsBeforeRetry = artifactReads('artifact-1').length;
    await screen.pressByTestIdAsync('approvals.retry');
    await waitForHomeGovernance(() => expect(artifactReads('artifact-1').length).toBeGreaterThan(readsBeforeRetry));
  });

  it('shows retained encrypted approvals as locked without refetching them as missing bodies', async () => {
    currentArtifact = {
      id: 'artifact-1',
      title: null,
      header: null,
      body: undefined,
      headerVersion: 3,
      bodyVersion: 4,
      seq: 5,
      createdAt: 1,
      updatedAt: 2,
      isDecrypted: false,
      storageMode: 'e2ee',
      availability: {
        kind: 'locked',
        reason: 'encryption_material_unavailable',
      },
    };
    const { ApprovalDetailScreen } = await import('./ApprovalDetailScreen');

    const screen = await renderScreen(
      <ApprovalDetailScreen artifactId="artifact-1" />,
    );

    expect(storage.getState().artifacts['artifact-1']).toMatchObject({
      isDecrypted: false,
      availability: { kind: 'locked', reason: 'encryption_material_unavailable' },
    });
    expect(artifactReads('artifact-1')).toHaveLength(0);
    expect(readRenderedText(screen)).toContain(
      'settingsAccount.secretKeyMissing',
    );
    expect(screen.findAllByType(await loadActivitySpinner())).toHaveLength(0);
  });

  it('routes approval decisions to the approval Home without mutating another Home’s duplicate Session', async () => {
    currentArtifact = await createCurrentApprovalArtifact('server-approval');
    approvalHomeFixture = {
      kind: 'resolved',
      serverIdentityId: 'srv_approval_home_a',
      profile: {
        id: 'server-approval',
        serverIdentityId: 'srv_approval_home_a',
        name: '',
      },
    };
    const { ApprovalDetailScreen } = await import('./ApprovalDetailScreen');

    const screen = await renderScreen(
      <ApprovalDetailScreen artifactId="artifact-1" />,
    );

    await act(async () => {
      await screen.pressByTestIdAsync('approvals.approve');
    });

    expect(JSON.parse(homes.artifacts(account.serverId).readPlainBody('artifact-1')!)).toMatchObject({
      decision: { kind: 'approve' }, executionOriginV1: JSON.parse(currentArtifact.body).executionOriginV1,
    });
    expect(artifactWrites().every(request => request.serverUrl === 'https://provider-settings-account.test')).toBe(true);
    for (const homeId of Object.values(homeIds).filter(id => id !== account.serverId)) {
      expect(homes.artifacts(homeId).list()).toEqual([]);
    }
  });

  it('shows the visual being approved through the same renderer as the reply', async () => {
    const { createSessionSurfaceNoteDocumentV1 } = await import('@happier-dev/protocol/sessions/board');
    currentArtifact = await createBuiltInApprovalArtifact({ actionId: 'session.board.item.upsert', summary: 'Show a visual',
      actionArgs: { sessionId: 'session-1', itemId: 'release-plan', expectedItemRevision: null, destination: 'transcript',
        item: { v: 1, title: 'Release plan', frame: 'card', height: { mode: 'auto', fallback: 'regular' }, source: { kind: 'declarative',
          document: createSessionSurfaceNoteDocumentV1('Ship the payment retries on Thursday.') } } } });
    const { ApprovalDetailScreen } = await import('./ApprovalDetailScreen');
    const screen = await renderScreen(<ApprovalDetailScreen artifactId="artifact-1" />);

    const visual = screen.findByTestId('approvals.visual');
    expect(visual).not.toBeNull();
    expect(screen.getTextContent()).toContain('Ship the payment retries on Thursday.');
  });

  it('names the asking Session once, in Requested by, when the visual is for that same Session', async () => {
    currentArtifact = await createBuiltInApprovalArtifact({ actionId: 'session.board.item.upsert', summary: 'Show a visual',
      actionArgs: { sessionId: 'session-1', itemId: 'release-plan', expectedItemRevision: null, destination: 'transcript',
        item: { v: 1, title: 'Release plan', frame: 'card', height: { mode: 'auto', fallback: 'regular' }, source: { kind: 'declarative', document: { version: 1, root: { kind: 'markdown', text: 'Plan' } } } } } });
    const { ApprovalDetailScreen } = await import('./ApprovalDetailScreen');
    const screen = await renderScreen(<ApprovalDetailScreen artifactId="artifact-1" />);
    const card = screen.tree.root.findAll(node => node.props?.anatomy === 'page' && Array.isArray(node.props?.presentation?.rows))[0];
    const rows = (card?.props.presentation.rows ?? []) as readonly Record<string, unknown>[];
    expect(rows.length).toBeGreaterThan(0);
    // The exact identity stays one disclosure away; the readable rows do not repeat the requester.
    expect(rows.find(row => row.path === 'sessionId')).toMatchObject({ technical: true });
  });

  it('says the recorded answer while the request still reads open, and offers no second answer', async () => {
    const base = JSON.parse((await createCurrentApprovalArtifact('server-approval')).body);
    const request = ApprovalRequestV2Schema.parse({ ...base, requestedSurface: 'agent',
      ...(await createSignedRequesterApprovalOrigin(base.actionId, base.actionArgs)) });
    currentArtifact = { id: 'artifact-1', ownerAccountId: 'bot-owner', header: buildApprovalRequestArtifactHeaderV1(request), body: JSON.stringify(request) };
    daemonReply = { ok: true, result: { status: 'rejected' } };
    approvalHomeFixture = {
      kind: 'resolved',
      serverIdentityId: 'srv_approval_home_a',
      profile: {
        id: 'server-approval',
        serverIdentityId: 'srv_approval_home_a',
        name: '',
      },
    };
    // The exact remote host accepts the decision before its Artifact projection catches up.
    const { ApprovalDetailScreen } = await import('./ApprovalDetailScreen');
    const screen = await renderScreen(
      <ApprovalDetailScreen artifactId="artifact-1" />,
    );
    const { resolveApprovalReplayRoute } = await import('@/sync/ops/actions/defaultActionExecutor');
    const route = resolveApprovalReplayRoute(request);
    const origin = request.executionOriginV1;
    const routeEvidence = JSON.stringify({ route, accountServerId: account.serverId,
      signedOrigin: { serverId: origin.serverId, serverIdentityId: origin.serverIdentityId } });
    expect(route, routeEvidence).toMatchObject({
      serverIdentityId: origin.serverIdentityId, originServerId: origin.serverId,
    });
    expect(resolveServerProfileScopeIdForIdentifier(route?.serverId), routeEvidence)
      .toBe(resolveServerProfileScopeIdForIdentifier(account.serverId));

    await act(async () => {
      await screen.pressByTestIdAsync('approvals.reject');
    });

    // The decision owner accepted the answer; the stored request has not caught up yet.
    const { Modal } = await import('@/modal');
    expect(Modal.alert).not.toHaveBeenCalled();
    expect(daemonDecisions()).toEqual([expect.objectContaining({ params: expect.objectContaining({ artifactId: 'artifact-1', decision: 'reject' }) })]);
    expect(JSON.parse(homes.artifacts(account.serverId).readPlainBody('artifact-1')!).status).toBe('open');
    expect(approvalItem(screen, 'approvals.status')?.props.detail).toBe(
      'approvals.status.rejected',
    );
    expect(screen.findByTestId('approvals.actions')).toBeNull();
  });

  it('decides a requester-bound request in place from its Discussion card through the same decision Action', async () => {
    const actionArgs = { sessionId: 'session-1', title: 'Release 0.3' };
    const base = JSON.parse((await createBuiltInApprovalArtifact({ actionId: 'session.title.set', actionArgs,
      summary: 'Rename the session to Release 0.3', serverId: 'server-approval' })).body);
    const request = ApprovalRequestV2Schema.parse({ ...base, requestedSurface: 'agent',
      ...(await createSignedRequesterApprovalOrigin(base.actionId, base.actionArgs)) });
    currentArtifact = { id: 'artifact-1', ownerAccountId: 'bot-owner', header: buildApprovalRequestArtifactHeaderV1(request), body: JSON.stringify(request) };
    daemonReply = { ok: true, result: { status: 'executed' } };
    approvalHomeFixture = { kind: 'resolved', serverIdentityId: 'srv_approval_home_a',
      profile: { id: 'server-approval', serverIdentityId: 'srv_approval_home_a', name: '' } };
    const { ApprovalRequesterThreadCard } = await import('./ApprovalRequesterThreadCard');
    const screen = await renderScreen(<ApprovalRequesterThreadCard serverId="server-approval" approval={{
      artifact: { ...currentArtifact, headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1, isDecrypted: true } as DecryptedArtifact,
      parsed: { family: 'built_in', request }, subject: request.requesterConfirmation!, requestRef: 'received-question', originMessageId: 'message-1',
    }} />);

    // The decision is offered on the card itself; the standalone page is only a link away.
    expect(screen.findByTestId('approval-requester-thread-review')).toBeNull();
    expect(screen.findByTestId('approval-requester-thread-open')).not.toBeNull();
    // The refusal reads the bar's one word, not a per-surface variant.
    expect(decisionButton(screen, 'approval-requester-thread-decline')?.props.title).toBe('approvals.reject');
    await act(async () => {
      await screen.pressByTestIdAsync('approval-requester-thread-approve');
    });

    const { Modal } = await import('@/modal');
    expect(Modal.alert).not.toHaveBeenCalled();
    expect(pushSpy).not.toHaveBeenCalled();
    expect(daemonDecisions()).toEqual([expect.objectContaining({ method: `session-1:${RPC_METHODS.APPROVAL_REQUEST_DECIDE}`,
      params: { artifactId: 'artifact-1', sessionId: 'session-1', decision: 'approve' } })]);
    // The accepted answer settles the card in place as its receipt.
    expect(screen.findByTestId('approval-requester-thread-receipt-confirmed_pending')).not.toBeNull();
    expect(screen.findByTestId('approval-requester-thread-approve')).toBeNull();
  });

  it('executes approval decisions even when the web confirm modal resolves false (ModalProvider unavailable)', async () => {
    modalConfirmResult = false;
    currentArtifact = await createCurrentApprovalArtifact('server-approval');
    approvalHomeFixture = {
      kind: 'resolved',
      serverIdentityId: 'srv_approval_home_a',
      profile: {
        id: 'server-approval',
        serverIdentityId: 'srv_approval_home_a',
        name: '',
      },
    };
    const { ApprovalDetailScreen } = await import('./ApprovalDetailScreen');

    const screen = await renderScreen(
      <ApprovalDetailScreen artifactId="artifact-1" />,
    );

    await act(async () => {
      await screen.pressByTestIdAsync('approvals.approve');
    });

    expect(JSON.parse(homes.artifacts(account.serverId).readPlainBody('artifact-1')!)).toMatchObject({ decision: { kind: 'approve' } });
  });

  it('renders legacy external session.title.set requests without offering an unsafe approval replay', async () => {
    currentArtifact = createSessionTitleApprovalArtifact('server-approval');
    const { ApprovalDetailScreen } = await import('./ApprovalDetailScreen');

    const screen = await renderScreen(
      <ApprovalDetailScreen artifactId="artifact-1" />,
    );

    const text = readRenderedText(screen);
    expect(text).toContain('Set session title');
    expect(text).toContain('New title from MCP');
    // The Session reference row is titled by what it names, never by its id.
    expect(text).not.toContain('Session id');
    expect(text).toContain('Title');

    expect(screen.findByTestId('approvals.approve')?.props.disabled).toBe(true);
    expect(screen.findByTestId('approvals.reject')?.props.disabled).toBe(false);
    await screen.pressByTestIdAsync('approvals.approve');
    expect(clientExecutionEffects()).toHaveLength(0);
  });
});
