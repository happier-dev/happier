import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  approvalArtifactBodyMatchesHeaderV1,
  buildApprovalRequestArtifactHeaderV1,
  buildTargetActionApprovalArtifactHeaderV1} from '@happier-dev/protocol/approvals/approvalArtifactHeaderV1';
import {
  TargetActionApprovalRequestV1Schema} from '@happier-dev/protocol/approvals/targetActionApprovalRequestV1';
import {
  ApprovalRequestV2Schema,
  type ApprovalRequestV1,
  type ApprovalRequestV2} from '@happier-dev/protocol/approvals/approvalRequestV1';
import {
  computeWorkspaceSyncPolicyDigest,
  WorkspaceSyncConflictResolutionResultV1Schema,
} from '@happier-dev/protocol/sessions/control/handoff/workspaceSyncSchemas';
import {
  type HandoffTargetApprovalConsequenceV1} from '@happier-dev/protocol/sessions/control/handoff/handoffTargetReplacementApprovalV1';
import type { Machine, Session } from '@/sync/domains/state/storageTypes';
import { collectRenderedTestIds } from '@/dev/testkit/render/collectRenderedTestIds';
import { createMachineFixture, createPlainMachineRowFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { createLockedEncryptedSessionByIdResponseFixture, createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { renderScreen as renderUiScreen } from '@/dev/testkit/render/renderScreen';
import { standardCleanup, createRootLayoutFeaturesResponse, createDeferred } from '@/dev/testkit';
import { createProviderSettingsAccountHarness } from '@/dev/testkit/harness/providerSettingsHarness';
import { createAgentApprovalRequest } from '@/dev/testkit/harness/approvalInbox';
import { waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installBrowserRuntimeForTests } from '@/dev/testkit/harness/browserRuntimeHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { installSessionActionRpcBoundary } from '@/dev/testkit/harness/sessionActionRpcBoundary';
import { answerExternalActionAccountForHome } from '@/dev/testkit/harness/externalActionAccountHttpBoundary';
import { encodePlainArtifactStoredContent, decodePlainArtifactStoredContent, ARTIFACT_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol/storage/artifactStoredContent';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { ACTION_OPERATION_RPC_METHODS_V2, type ActionOperationSnapshotV1 } from '@happier-dev/protocol/actions/operations/v1';
import type { Artifact, DecryptedArtifact } from '@/sync/domains/artifacts/artifactTypes';
import { ExternalActionRequestEnvelopeV1Schema, ExternalActionResponseEnvelopeV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { buildApprovalExecutionOriginV1 } from '@happier-dev/protocol/actions/actionExecutor';
import { buildApprovalRequesterConfirmationV1 } from '@happier-dev/protocol/approvals/approvalRequestV1';
import { deriveSessionMessageReplyReturnLocalIdV1 } from '@happier-dev/protocol/sessions/messages/sessionMessageReplyV1';
import { formatSharedSavedSecretRefV1 } from '@happier-dev/protocol/account/settings/savedSecretReferenceV1';
import { SavedSecretCatalogEntryV1Schema } from '@happier-dev/protocol/account/settings/savedSecretCatalogV1';
import type { SavedSecretPickerModal } from '@/components/ui/forms/valueRefs/SavedSecretPickerModal';
import { projectTargetActionApprovalInvocationV1 } from '@happier-dev/protocol/approvals/targetActionApprovalRequestV1';
import { computeExternalActionRequestEnvelopeDigestV1, signExternalActionApprovalInputV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import type { ActionExecutorContext } from '@happier-dev/protocol/actions/executor/types';
import tweetnacl from 'tweetnacl';
import { encodeBase64 } from '@happier-dev/protocol/crypto/base64';
import { installApprovalCommonModuleMocks } from './approvalsTestHelpers';
import { createTriageSelectedPrStartApprovalInput } from '../../../../../packages/plugins/triage/src/sessions/testkit/entrySessionTestkit.test-support';

/** The value beside a facts row's key (the shared approval fields draw label then value). */
type FactNode = { props: { children?: unknown } };
function factValue(host: { findAll: (predicate: (node: FactNode) => boolean) => FactNode[] } | null | undefined): unknown {
    return host?.findAll((node) => typeof node.props.children === 'string').at(-1)?.props.children;
}


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

async function prepareComputerAgentFixture() {
  await prepareApprovalFixture();
  const session = storage.getState().sessions['session-1'];
  if (!session?.metadata) throw new Error('Expected the Computer caller Session');
  installSessionActionFixture({ homes, storage, serverId: account.serverId,
    session: { ...session, metadata: { ...session.metadata, machineId: 'machine-2' } } });
  await answerExternalActionAccountForHome(homes, account.serverId, {
    actionId: 'computer.target.get', machineId: 'machine-2', installationId: 'computer-installation', tokenEpoch: 0,
    execute: (_input, context) => {
      expect(context.invocation).toMatchObject({ surface: 'agent', authority: 'account_automation',
        caller: { kind: 'host' }, defaultSessionId: 'session-1' });
      return { consentGranted: false, sourceId: 'computer:1',
        selectedTarget: { kind: 'window', displayId: ':77', pid: 123, windowId: 456 },
        approvalDisplay: { machineDisplayName: 'Workstation one', requiresTargetSelection: false,
          target: { kind: 'window', title: 'Sign in to Lumen' } } };
    },
  });
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
    externalActionTarget?: ActionExecutorContext['externalActionTarget'];
  }>,
) {
  await prepareApprovalFixture();
  if (input.actionId === 'computer.input' || input.actionId === 'computer.capture') await prepareComputerAgentFixture();
  let sourceContext: Pick<ActionExecutorContext, 'defaultSessionId' | 'defaultSessionMachineId'> = {};
  if (input.sourceSessionId) {
    const { readDisplayMachineIdForSession } = await import('@/sync/ops/sessionMachineTarget');
    const sourceSession = storage.getState().sessions[input.sourceSessionId];
    if (!sourceSession) throw new Error('The source Session must be published before requesting approval');
    const machineId = readDisplayMachineIdForSession({ serverId: account.serverId,
      sessionId: sourceSession.id, metadata: sourceSession.metadata });
    sourceContext = { defaultSessionId: sourceSession.id,
      ...(machineId ? { defaultSessionMachineId: machineId } : {}) };
  }
  const producedId = await createAgentApprovalRequest({ serverId: account.serverId,
    actionId: input.actionId, actionInput: input.actionArgs, actionRequestId: 'request-built-in-1',
    ...sourceContext,
    ...(input.externalActionTarget ? { externalActionTarget: input.externalActionTarget } : {}) });
  const producedBody = homes.artifacts(account.serverId).readPlainBody(producedId);
  if (!producedBody) throw new Error('Expected the agent approval producer to store its request');
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

async function createCurrentApprovalArtifact(serverId = 'server-approval', options: Readonly<{ placedOnMachine?: true }> = {}) {
  return await createBuiltInApprovalArtifact({ actionId: 'session.user_action.answer',
    actionArgs: defaultApprovalArtifactBody.actionArgs, summary: defaultApprovalArtifactBody.summary,
    preview: defaultApprovalArtifactBody.preview, serverId,
    ...(options.placedOnMachine ? { sourceSessionId: 'session-1' } : {}) });
}

async function createSignedRequesterApprovalOrigin(
  actionId: ApprovalRequestV2['actionId'],
  input: unknown,
  requesterAccountId = 'account-1',
  creatorLocalServerId?: string,
) {
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
  const actionRequestAttributionV1 = { requestRef: requestId,
    requester: { serverId: creatorLocalServerId ?? source.serverId, accountId: requesterAccountId },
    persona: { serverId: creatorLocalServerId ?? source.serverId, sessionId: 'session-1' }, origin: null };
  const context: ActionExecutorContext = {
    surface: 'agent', authority: resolveInvocationAuthority({ credential: source.credentialAuthorityKind, surface: 'agent' }),
    serverId: creatorLocalServerId ?? source.serverId, serverIdentityId: source.serverIdentityId,
    runtimeAccountId: source.accountId, actionRequestId: requestId, actionCaller: caller, defaultSessionId: 'session-1',
    callerPermissionMode: 'yolo', sessionInputSource: { sourceSessionId: 'session-1', sourceTurnId: 'turn-1', via: 'action' },
    actionRequestAttributionV1,
    externalActionTarget: target,
    externalActionExecutionAuthorization: { v: 1, token: 'signed-bot-source', binding: {
      serverIdentityId: source.serverIdentityId!, accountId: source.accountId, custodianAccountId: source.accountId,
      machineId: 'machine-exact', installationId, actionId, requestId, target,
      authentication: { kind: 'account', tokenEpoch: 0 },
      requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope),
      sessionActionOrigin: { v: 1, caller, sourceTurnId: 'turn-1', callerPermissionMode: 'yolo', requestId, actionRequestAttributionV1 },
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

async function createDaemonRoutedApprovalArtifact(actionId: 'session.title.set' | 'session.stop' = 'session.title.set') {
  const input = actionId === 'session.title.set'
    ? { sessionId: 'session-1', title: 'Current title' }
    : { sessionId: 'session-1' };
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
      // A local Account proposal retains its invocation; durable replay would
      // require the real exact-daemon provenance produced by the helpers below.
      approvalInputCustody: 'live_only',
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
      resolvePresentUserGatePolicy(action: unknown, authorization: unknown): import('@happier-dev/protocol/plugins/actions/invocation').PluginActionPresentUserGatePolicy;
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
      if (key === 'walkthroughSettings.clearDescription' && typeof params?.machine === 'string') return t(key, { machine: params.machine });
      if (key === 'walkthroughSettings.clearTitle' || key === 'walkthroughSettings.clear') return t(key);
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
      renderCustomModals: true,
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
  if (request.method.endsWith(`:${ACTION_OPERATION_RPC_METHODS_V2.get}`) && retainedSetupOperation) {
    return { kind: 'found', operation: retainedSetupOperation };
  }
  if (request.method.endsWith(`:${RPC_METHODS.DAEMON_COMPUTER_ACTION_EXECUTE}`)) {
    throw new Error('Agent proposal target reads must not use the present-user Computer RPC');
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
let retainedSetupOperation: ActionOperationSnapshotV1 | null = null;

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

function expectSignedTargetDecision(artifactId: string, decision: 'approve' | 'reject', originServerId: string) {
  expect(homes.requestsFor('/v1/actions/approval.request.decide')).toEqual([
    expect.objectContaining({ serverId: account.serverId, input: expect.objectContaining({
      target: { kind: 'machine', machineId: 'machine-exact' },
      input: { artifactId, decision, serverIdentityId: 'srv_approval_home_a', originServerId },
    }) }),
  ]);
  expect(daemonDecisions()).toEqual([]);
}

function expectDaemonDecision(artifactId: string, decision: 'approve' | 'reject', originServerId: string) {
  expect(daemonDecisions()).toEqual([expect.objectContaining({ method: `machine-exact:${RPC_METHODS.APPROVAL_REQUEST_DECIDE}`,
    params: { artifactId, decision, serverIdentityId: 'srv_approval_home_a', originServerId } })]);
  expect(rpcDestinations.filter(request => request.method.endsWith(`:${RPC_METHODS.APPROVAL_REQUEST_DECIDE}`)))
    .toEqual([{ method: `machine-exact:${RPC_METHODS.APPROVAL_REQUEST_DECIDE}`, serverUrl: 'https://provider-settings-account.test' }]);
}

function clientExecutionEffects() {
  return rpcRequests.filter(request => !request.method.endsWith(`:${RPC_METHODS.APPROVAL_REQUEST_DECIDE}`));
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
  const { ModalProvider } = await import('@/modal');
  const screen = await renderUiScreen(<ModalProvider>{React.isValidElement<{ serverId?: string }>(element) && props.serverId && homeIds[props.serverId]
    ? React.cloneElement(element, { serverId: homeIds[props.serverId] }) : element}</ModalProvider>);
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
  retainedSetupOperation = null;
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
await import('@/components/ui/forms/valueRefs/presentSavedSecretReferencePicker');

describe('ApprovalDetailScreen', () => {
  it('opens the shared Saved Secret picker before consenting to a pending Environment binding', async () => {
    await prepareApprovalFixture();
    const selected = { ref: formatSharedSavedSecretRefV1('credential'), resourceRevision: 3 };
    const selectedName = 'Application API credential';
    const { applySavedSecretCatalogPage } = await import('@/sync/store/settings/savedSecretCatalogSnapshot');
    applySavedSecretCatalogPage({
      scope: { serverId: resolveServerProfileScopeIdForIdentifier(account.serverId), accountId: 'account-1' },
      observedAt: 1,
      entries: [SavedSecretCatalogEntryV1Schema.parse({ ref: selected.ref, name: selectedName,
        source: 'shared_resource', relationship: 'recipient', kind: 'apiKey', revision: selected.resourceRevision,
        materialStatus: 'ready', capabilities: { use: true, rename: false, rotate: false, manageAccess: false, delete: false } })],
    });
    const actionArgs = { serverId: account.serverId, environmentId: 'environment', expectedRevision: 7,
      set: [{ purpose: 'variable', name: 'API_TOKEN', phase: 'runtime',
        source: { kind: 'secret', ref: 'person_selects' } }], remove: [] };
    currentArtifact = await createBuiltInApprovalArtifact({ actionId: 'deployments.bindings.set', actionArgs,
      summary: 'Choose the application credential' });
    const { Modal } = await import('@/modal');
    vi.mocked(Modal.show).mockClear();
    const screen = await renderScreen(<approvalDetailScreenModule.ApprovalDetailScreen artifactId="artifact-1" />);
    await vi.waitFor(() => expect(screen.findByTestId('approvals.approve')).not.toBeNull());
    let choosing: Promise<void> | undefined;
    await act(async () => { choosing = screen.pressByTestIdAsync('approvals.approve'); });
    await vi.waitFor(() => expect(Modal.show).toHaveBeenCalledTimes(1));
    const modal = vi.mocked(Modal.show<typeof SavedSecretPickerModal>).mock.calls[0]![0];
    expect(modal).toMatchObject({ props: { referenceSelection: { onSelect: expect.any(Function) } } });
    const pickerProps = modal.props;
    if (!pickerProps || !('referenceSelection' in pickerProps)) throw new Error('Expected Saved Secret reference selection');
    await act(async () => { pickerProps.referenceSelection.onSelect(selected); await choosing; });
    await vi.waitFor(() => expect(readRenderedText(screen)).toContain(selectedName));
    expect(readRenderedText(screen)).not.toContain(selected.ref);
    expect(artifactWrites()).toEqual([]);
    expect(clientExecutionEffects()).toEqual([]);
    expect(homes.requestsFor('/v1/deployments/environments/environment/bindings')).toEqual([]);
  });

  it('reviews a document suggestion as its before and after instead of raw operands', async () => {
    await prepareApprovalFixture();
    const revision = { headerVersion: 1, bodyVersion: 1 };
    const { captureDocPassageV1, docPassageEditTargetV1 } = await import('@happier-dev/protocol/artifacts/artifactPassageV1');
    const { deriveDocCommentDiscussionCreationLocalIdV1 } = await import('@happier-dev/protocol/artifacts/artifactCollaborationActionsV1');
    const { answerDiscussionThreadForTests } = await import('@/dev/testkit/harness/homeGovernanceHarness');
    const { createDiscussionClient } = await import('@/sync/api/discussions/discussionActions');
    const before = 'Alex has agreed to join the early shift, which ends by two.';
    const { createAccountArtifactStoredEnvelope } = await import('@/sync/domains/artifacts/accountArtifactEnvelope');
    const envelope = await createAccountArtifactStoredEnvelope({ mode: 'plain', header: { kind: 'artifact.legacy', title: 'Opening hours' }, body: { body: before } });
    if (!envelope) throw new Error('Expected the Plain Artifact codec');
    const quote = 'join the early shift';
    const start = before.indexOf(quote);
    const passage = captureDocPassageV1({ ref: { kind: 'doc', artifactId: 'doc-private', serverId: account.serverId }, revision,
      source: before, range: { start, end: start + quote.length } });
    currentArtifact = await createBuiltInApprovalArtifact({ actionId: 'doc.edit.propose', summary: 'Propose a document edit',
      actionArgs: {
        target: docPassageEditTargetV1(passage),
        baseRevision: revision, before, after: 'Alex has agreed to help with the morning shift, which ends by three.', reason: 'Clarify the opening hours',
        discussionRef: { serverId: account.serverId, discussionId: 'committed-thread' }, localId: 'suggestion-private',
      } });
    // The approval producer retires its source fixture. Install the receiver's Doc and thread afterwards.
    await prepareApprovalFixture();
    homes.artifacts(account.serverId).replaceStoredRow({ ...envelope, id: 'doc-private', encryptionMode: 'plain', ownerAccountId: 'account-1',
      access: 'owner', publicAudience: 'none', headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 });
    const { tryWriteServerEnabledBitInPlace } = await import('@happier-dev/protocol/features/serverEnabledBit');
    const { primeServerFeaturesSnapshot } = await import('@/sync/api/capabilities/serverFeaturesClient');
    const features = createRootLayoutFeaturesResponse();
    tryWriteServerEnabledBitInPlace(features, 'sharing.session', true);
    tryWriteServerEnabledBitInPlace(features, 'sessions.conversations', true);
    homes.answer(account.serverId, '/v1/features', { body: features });
    homes.answer(account.serverId, '/v1/features/authenticated', { body: features });
    primeServerFeaturesSnapshot({ serverId: account.serverId, snapshot: { status: 'ready', features } });
    const network = answerDiscussionThreadForTests(homes, account.serverId, { accountId: 'account-1', loseCreate: false, loseFirstRejoin: false });
    const client = createDiscussionClient({ scope: { serverId: account.serverId, accountId: 'account-1' }, availability: 'available' });
    const created = await client.create({ title: 'Opening hours',
      creationLocalId: deriveDocCommentDiscussionCreationLocalIdV1({ ref: passage.ref, localId: 'opening-root' }), messageLocalId: 'opening-root',
      anchor: { kind: 'doc', doc: { ref: passage.ref, revision } }, replyTarget: { kind: 'doc_passage', doc: { ref: passage.ref, revision } },
      content: { kind: 'doc_passage_comment', passage, content: { v: 1, parts: [{ t: 'text', text: 'Make this warmer.' }] } } });
    expect(created, JSON.stringify(created)).toMatchObject({ kind: 'succeeded' });
    const thread = network.stored()!;
    // The ordinary tail omits the original selection; the approval must request its thread's first page.
    const tail = { ...thread.firstMessage, id: 'tail-message', seq: 101,
      replyTarget: { kind: 'message' as const, messageId: thread.firstMessage.id } };
    let firstPageReads = 0;
    homes.answer(account.serverId, 'GET /v1/discussions/committed-thread/messages', { select: (_input, request) => {
      const first = new URL(request.url).searchParams.get('afterSeq') === '0';
      if (first) firstPageReads += 1;
      return { body: { messages: first ? [thread.firstMessage] : [tail], hasMoreOlder: !first, messageSeq: 101 } };
    } });
    const screen = await renderScreen(<approvalDetailScreenModule.ApprovalDetailScreen artifactId="artifact-1" />);
    await vi.waitFor(() => expect(screen.findByTestId('approvals.doc-edit-proposal.diff')).not.toBeNull());
    expect(readRenderedText(screen)).toContain('Clarify the opening hours');
    expect(readRenderedText(screen)).toContain('morning shift');
    await vi.waitFor(() => expect(screen.findByTestId('approvals.doc-edit-proposal.note')).not.toBeNull());
    expect(firstPageReads).toBe(1);
    expect(homes.requests.filter(request => request.method === 'GET'
      && new URL(request.path, 'https://fixture.test').pathname === '/v1/discussions')).toHaveLength(0);
    expect(readRenderedText(screen)).not.toContain('suggestion-private');
    expect(screen.findByTestId('approvals.approve')).not.toBeNull();
  });

  it('names the owning Machine and Clear consequences on the shared Require approval page', async () => {
    currentArtifact = await createBuiltInApprovalArtifact({ actionId: 'scm.diffSummary.result.clear',
      summary: 'Clear selected saved change explanations.',
      actionArgs: { results: [{ cwd: '/repo', resultId: 'saved', expectedRevision: 1, comparisonId: 'comparison' }] },
      externalActionTarget: { kind: 'machine', machineId: 'machine-target' } });
    const { ApprovalDetailScreen } = await import('./ApprovalDetailScreen');
    const screen = await renderScreen(<ApprovalDetailScreen artifactId="artifact-1" />);
    const { t } = await vi.importActual<typeof import('@/text')>('@/text');
    expect(readRenderedText(screen)).toContain(t('walkthroughSettings.clearDescription', { machine: 'Rebound workstation' }));
    expect(decisionButton(screen, 'approvals.approve')?.props.title).toBe(t('walkthroughSettings.clear'));
    expect(screen.findByTestId('approvals.reject')).not.toBeNull();
  });
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

  it('hands a private Post to the daemon after the review page unmounts during its fresh Artifact read', async () => {
    const requestLocalId = 'discussion-follow-v1:private-question';
    const acceptedTurnId = 'native-turn-private-question';
    const localId = deriveSessionMessageReplyReturnLocalIdV1({ sessionId: 'session-1', localId: requestLocalId, acceptedTurnId });
    const request = ApprovalRequestV2Schema.parse({ v: 2, status: 'open', createdAtMs: 1, updatedAtMs: 1,
      createdBy: { surface: 'agent', sessionId: 'session-1' }, requestedSurface: 'agent', discussionDraftReview: true,
      executionOriginV1: { v: 1, authority: 'account_automation', surface: 'agent', caller: { kind: 'host' },
        serverId: 'creator-daemon-profile', serverIdentityId: 'srv_approval_home_a', accountId: 'account-1',
        sessionId: 'session-1', machineId: 'machine-exact', actionId: 'discussion.reply', requestId: localId,
        sessionInputSource: { sourceSessionId: 'session-1', sourceInputId: requestLocalId, sourceTurnId: acceptedTurnId, via: 'action',
          discussionAddressing: { discussionId: 'private-discussion', messageId: 'question', throughSeq: 2, participantSessionId: 'session-1' } },
        discussionReplyReturn: { serverId: 'srv_approval_home_a', requestLocalId, acceptedTurnId },
        actionRequestAttributionV1: { requestRef: requestLocalId,
          requester: { serverId: 'srv_approval_home_a', accountId: 'account-1' },
          persona: { serverId: 'srv_approval_home_a', sessionId: 'session-1' },
          origin: { kind: 'discussion', discussion: { serverId: 'srv_approval_home_a', discussionId: 'private-discussion' }, messageId: 'question' } } },
      approval: { flow: 'deferred', result: 'required' },
      actionId: 'discussion.reply', actionArgs: { discussionId: 'private-discussion', localId,
        content: { v: 1, parts: [{ t: 'text', text: 'Private answer' }] },
        replyTarget: { kind: 'message', messageId: 'question' } }, summary: 'Post the answer' });
    currentArtifact = { id: 'private-post-approval', header: buildApprovalRequestArtifactHeaderV1(request), body: JSON.stringify(request) };
    const screen = await renderScreen(<approvalDetailScreenModule.ApprovalDetailScreen artifactId="private-post-approval" />);
    await vi.waitFor(() => expect(screen.findByTestId('approvals.approve')).not.toBeNull());
    const reading = createDeferred<void>();
    const releaseRead = createDeferred<void>();
    let decisionSignal: AbortSignal | null | undefined;
    homes.answer(account.serverId, 'GET /v1/artifacts/private-post-approval', { select: async (_input, incoming) => {
      reading.resolve();
      await releaseRead.promise;
      const response = await homes.artifacts(account.serverId).handle('/v1/artifacts/private-post-approval', incoming.init);
      if (!response) throw new Error('Expected the original private approval');
      return { status: response.status, body: await response.json() };
    } });
    homes.answer(account.serverId, '/v1/actions/approval.request.decide', { select: (input, incoming) => {
      const envelope = ExternalActionRequestEnvelopeV1Schema.parse(input);
      expect(envelope.input).toMatchObject({ artifactId: 'private-post-approval', decision: 'approve' });
      decisionSignal = incoming.signal;
      return { body: ExternalActionResponseEnvelopeV1Schema.parse({ v: 1, actionId: 'approval.request.decide',
        requestId: envelope.requestId, execution: { ok: false, errorCode: 'target_unavailable', error: 'target_unavailable' } }) };
    } });
    try {
      await act(async () => { screen.pressByTestId('approvals.approve'); await reading.promise; });
      await act(async () => { await screen.unmount(); });
    } finally { releaseRead.resolve(); }
    await waitForHomeGovernance(() => {
      expect(homes.requestsFor('/v1/actions/approval.request.decide')).toHaveLength(1);
      expect(decisionSignal).toBeInstanceOf(AbortSignal);
    });
    expect(decisionSignal?.aborted).toBe(false);
    // The genuine daemon refusal proves no publication happened. The page
    // lifetime must not cancel the decision before it reaches that boundary.
    expect(artifactWrites('private-post-approval')).toEqual([]);
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

  it('preserves and presents the typed Workflow refusal from a settled Setup approval', async () => {
    await prepareApprovalFixture();
    const request = ApprovalRequestV2Schema.parse({
      v: 2, status: 'open', createdAtMs: 1, updatedAtMs: 1, createdBy: { surface: 'agent' }, requestedSurface: 'agent',
      actionId: 'machines.setup.apply', summary: 'Set up Machine',
      executionOriginV1: { v: 1, authority: 'account_automation', surface: 'agent', caller: { kind: 'host' },
        serverId: account.serverId, accountId: 'account-1', machineId: 'machine-target',
        actionId: 'machines.setup.apply', requestId: 'setup-review' },
      actionArgs: { homeId: account.serverId, machineId: 'machine-target', targets: [{
        homeId: account.serverId, machineId: 'machine-target', desiredRevision: 0,
        sources: [{ kind: 'direct', setup: {} }], recipePlans: [], exclusions: [],
      }] },
    });
    const { projectApprovalExecutionFailureV2, readApprovalExecutionFailure } =
      await import('@happier-dev/protocol/approvals/approvalExecutionFailure');
    const failure = { ok: false, errorCode: 'target_unavailable', error: 'target_unavailable',
      details: { code: 'target_unavailable', reason: 'target_binding_mismatch' },
      failureCause: { phase: 'workflow.run.start', errorClass: 'Error', errorCode: 'target_unavailable', httpStatus: null },
    } as const;
    const execution = projectApprovalExecutionFailureV2({ request, failure, executedAtMs: 3 });
    const settled = ApprovalRequestV2Schema.parse({ ...request, status: 'failed', updatedAtMs: 3,
      decision: { kind: 'approve', decidedAtMs: 2 }, execution });
    expect(readApprovalExecutionFailure(settled)).toMatchObject(failure);
    currentArtifact = { id: 'setup-refusal', fixtureHomeKey: 'local-A',
      header: buildApprovalRequestArtifactHeaderV1(settled), body: JSON.stringify(settled) };
    const { ApprovalDetailScreen } = await import('./ApprovalDetailScreen');
    const screen = await renderScreen(<ApprovalDetailScreen artifactId={currentArtifact.id} />);
    const { formatWorkflowProblemMessage } = await import('@/components/workflows/presentation/workflowProblemPresentation');
    const { WorkflowActionError } = await import('@/sync/domains/workflows/workflowActionError');
    const reason = formatWorkflowProblemMessage(new WorkflowActionError({ rawCode: failure.errorCode,
      message: failure.error, failure }));
    expect(approvalItem(screen, 'approvals.execution-failure')?.props.subtitle).toBe(reason);
    const { assertApprovalExecutionSucceeded, presentApprovalFailure } =
      await import('@/components/tools/shell/approvals/useApprovalDecisionHandler');
    let caught: unknown;
    try { assertApprovalExecutionSucceeded(execution); } catch (error) { caught = error; }
    expect(presentApprovalFailure(caught)).toEqual({ reason, code: 'target_unavailable' });
  });

  it('presents a recorded template deploy refusal from its typed execution failure without a decision reason', async () => {
    await prepareApprovalFixture();
    // The Home Artifact read is the boundary: this is the CLI-origin record the page receives.
    const request = ApprovalRequestV2Schema.parse({
      v: 2, status: 'failed', createdAtMs: 1, updatedAtMs: 3, createdBy: { surface: 'cli' }, requestedSurface: 'cli',
      actionId: 'deployments.templates.instantiate', summary: 'Publish database',
      executionOriginV1: { v: 1, authority: 'present_user', surface: 'cli', caller: { kind: 'host' },
        serverId: account.serverId, accountId: 'account-1', machineId: 'machine-target',
        actionId: 'deployments.templates.instantiate', requestId: 'publish-database' },
      actionArgs: { mode: 'apply', deploy: { requestKey: 'database-deploy' }, serverId: account.serverId, machineId: 'machine-target', projectSourceId: 'project',
        templateRef: { sourceId: 'apps', itemId: 'database', version: '1',
          ref: { kind: 'content', digest: `sha256:${'a'.repeat(64)}` } },
        environment: { kind: 'create', name: 'Database', requestKey: 'database', protection: 'nonProduction',
          purpose: 'standard', deployerMode: 'managers', controllerMachineId: 'machine-target' },
        target: { kind: 'new', installationId: 'installation' }, destination: { kind: 'stored' }, bindings: [] },
      decision: { kind: 'approve', decidedAtMs: 2 },
      execution: { executedAtMs: 3, ok: false, errorCode: 'action_forbidden', error: 'action_forbidden',
        effectAttempted: true, details: { kind: 'partial', phase: 'deploy', environmentId: 'created-environment', revision: 2,
          targetLinkId: 'created-target', savedSecrets: [], errorCode: 'action_forbidden' } },
    });
    const { readApprovalExecutionFailure } = await import('@happier-dev/protocol/approvals/approvalExecutionFailure');
    expect(readApprovalExecutionFailure(request)).toMatchObject({ errorCode: 'action_forbidden',
      details: { phase: 'deploy', environmentId: 'created-environment', targetLinkId: 'created-target' } });
    currentArtifact = { id: 'artifact-1', header: buildApprovalRequestArtifactHeaderV1(request), body: JSON.stringify(request) };
    const { ApprovalDetailScreen } = await import('./ApprovalDetailScreen');
    const screen = await renderScreen(<ApprovalDetailScreen artifactId={currentArtifact.id} />);

    expect(approvalItem(screen, 'approvals.execution-failure')?.props.subtitle).toBe('errors.permissionDenied');
    expect(readRenderedText(screen)).not.toContain('approvals.failureNoReason');
  });

  it('shows the shared projected recovery in the failed Domain Remove summary', async () => {
    await prepareApprovalFixture();
    const remedy = 'Inspect the selected Cloudflare tunnel and its owned hostname routes, then review the Domain operation again.';
    const request = ApprovalRequestV2Schema.parse({
      v: 2, status: 'failed', createdAtMs: 1, updatedAtMs: 3, createdBy: { surface: 'cli' }, requestedSurface: 'cli',
      actionId: 'deployments.domains.remove', summary: 'Remove deployment domain',
      executionOriginV1: { v: 1, authority: 'present_user', surface: 'cli', caller: { kind: 'host' },
        serverId: account.serverId, accountId: 'account-1', machineId: 'machine-target',
        actionId: 'deployments.domains.remove', requestId: 'remove-domain' },
      actionArgs: { serverId: account.serverId, environmentId: 'environment', domainId: 'domain',
        expectedRevision: 1, expectedDomainRevision: 1, requestKey: 'remove-domain' },
      decision: { kind: 'approve', decidedAtMs: 2 },
      execution: { executedAtMs: 3, ok: false, errorCode: 'invalid_provider_output', error: 'invalid_provider_output',
        effectAttempted: false,
        details: { environmentId: 'environment', domainId: 'domain', step: 'native_execution',
          requiredFact: 'cloudflarePreparation', remedy } },
    });
    currentArtifact = { id: 'artifact-1', header: buildApprovalRequestArtifactHeaderV1(request), body: JSON.stringify(request) };
    const { ApprovalDetailScreen } = await import('./ApprovalDetailScreen');
    const screen = await renderScreen(<ApprovalDetailScreen artifactId={currentArtifact.id} />);

    expect(approvalItem(screen, 'approvals.execution-failure')?.props.subtitle).toBe(remedy);
    expect(readRenderedText(screen)).not.toContain('approvals.failureNoReason');
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
    expect(artifactWrites()).toHaveLength(2);
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
    // This retained live-only proposal has no surviving invocation to publish it.
    expect(decodedArtifactWrite(1).body).toMatchObject({ status: 'failed', execution: {
      ok: false, effectAttempted: false, errorCode: 'approval_origin_unavailable',
      details: { reason: 'live_invocation_unavailable' },
    } });
    expect(readRenderedText(screen)).toContain('approvals.status.failed');
    expect(screen.findByTestId('approvals.approve')).toBeNull();
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

  it('withholds legacy plugin approval when a secret operand hides the effect despite unrelated readable input', async () => {
    const artifact = createTargetActionApprovalArtifact();
    const { approvalInputCustody: _liveCustody, ...legacy } = TargetActionApprovalRequestV1Schema.parse(JSON.parse(artifact.body));
    currentArtifact = { ...artifact, body: JSON.stringify({
      ...legacy,
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

    await waitForHomeGovernance(() => {
      expect(screen.findByTestId(`approvals.${decision}`)).not.toBeNull();
    });
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
    await prepareApprovalFixture();
    homes.answer(account.serverId, '/v1/artifacts/requester-target/access/grants', { body: {
      artifactId: 'requester-target', ownerAccountId: 'bot-owner', access: 'view',
      grants: [{
        principal: { kind: 'account', accountId: 'another-requester' }, accessLevel: 'view',
        createdByAccountId: 'bot-owner', createdAt: 1,
        display: { name: 'QA N3 Bob', username: 'qa-n3b' },
      }],
    } });
    const { ApprovalDetailScreen } = await import('./ApprovalDetailScreen');
    const screen = await renderScreen(<ApprovalDetailScreen artifactId="requester-target" serverId="ui-A" />);
    const received = homes.artifacts(account.serverId).readPlainBody('requester-target');
    expect(storage.getState().artifacts['requester-target']?.access).toBe('view');

    expect(screen.findByTestId('approvals.requester-confirmation.waiting')).not.toBeNull();
    await vi.waitFor(() => expect(readRenderedText(screen)).toContain('QA N3 Bob'));
    expect(readRenderedText(screen)).not.toContain('Another person');
    expect(screen.findByTestId('approvals.actions')).toBeNull();
    expect(screen.findByTestId('approvals.approve')).toBeNull();
    expect(daemonDecisions()).toHaveLength(0);
    expect(artifactWrites()).toHaveLength(0);
    expect(homes.artifacts(account.serverId).readPlainBody('requester-target')).toBe(received);
  });

  it('loads the Account roster for a cached settled requester-bound detail hosted outside the native navigator', async () => {
    const openArtifact = await createRequesterTargetApprovalArtifact('another-requester');
    const open = TargetActionApprovalRequestV1Schema.parse(JSON.parse(openArtifact.body));
    const settled = TargetActionApprovalRequestV1Schema.parse({
      ...open,
      status: 'executed',
      updatedAtMs: 3,
      decision: {
        kind: 'approve',
        decidedAtMs: 2,
        authority: 'present_user',
        decidingAccountId: 'another-requester',
      },
      execution: { executedAtMs: 3, ok: true, result: {} },
    });
    currentArtifact = {
      ...openArtifact,
      header: buildTargetActionApprovalArtifactHeaderV1(settled),
      body: JSON.stringify(settled),
    };
    includeExactApprovalMachine = false;
    machineFixtures = {};
    machineFixturesByServerId = {};
    await prepareApprovalFixture();
    const rosterPath = '/v1/artifacts/requester-target/access/grants';
    homes.answer(account.serverId, rosterPath, { body: {
      artifactId: 'requester-target', ownerAccountId: 'bot-owner', access: 'view',
      grants: [{
        principal: { kind: 'account', accountId: 'another-requester' }, accessLevel: 'view',
        createdByAccountId: 'bot-owner', createdAt: 1,
        display: { name: 'QA N3 Bob', username: 'qa-n3b' },
      }],
    } });
    const { ApprovalDetailScreen } = await import('./ApprovalDetailScreen');
    const navigation = await import('@react-navigation/native');
    const nativeFocus = vi.spyOn(navigation, 'useIsFocused').mockReturnValue(false);
    try {
      const screen = await renderScreen(<ApprovalDetailScreen artifactId="requester-target" serverId="ui-A" />);

      await waitForHomeGovernance(() => {
        expect(homes.requestsFor(rosterPath)).toHaveLength(1);
        expect(readRenderedText(screen)).toContain('QA N3 Bob');
      });
      expect(readRenderedText(screen)).not.toContain('Another person');
      expect(screen.findByTestId('approvals.actions')).toBeNull();
    } finally {
      nativeFocus.mockRestore();
    }
  });

  it('offers the requester-bound decision only to the Account that asked', async () => {
    currentArtifact = await createRequesterTargetApprovalArtifact();
    includeExactApprovalMachine = false;
    machineFixtures = {};
    machineFixturesByServerId = {};
    const { ApprovalDetailScreen } = await import('./ApprovalDetailScreen');
    const screen = await renderScreen(<ApprovalDetailScreen artifactId="requester-target" serverId="ui-A" />);

    await waitForHomeGovernance(() => {
      expect(screen.findByTestId('approvals.requester-confirmation')).not.toBeNull();
      expect(screen.findByTestId('approvals.requester-confirmation.waiting')).toBeNull();
      expect(screen.findByTestId('approvals.approve')).not.toBeNull();
    });
  });

  it.each(['approve', 'reject'] as const)('sends a guest %s decision as the approving Account to another Account’s Machine', async decision => {
    currentArtifact = await createApiTargetActionApprovalArtifact();
    await prepareApprovalFixture();
    // The Home HTTP boundary mints the guest's decision root and the remote
    // boundary opens its real requester carrier; neither substitutes owner credentials.
    let delivered = false;
    const boundary = await answerExternalActionAccountForHome(homes, account.serverId, {
      machineId: 'machine-exact', custodian: { accountId: 'machine-owner-account', displayName: 'Owner' },
      actionId: 'approval.request.decide', tokenEpoch: 0, requesterInvocation: 'credentials',
      execute: (input, context) => {
        expect(input).toEqual({ artifactId: currentArtifact.id, decision,
          serverIdentityId: 'srv_approval_home_a', originServerId: 'srv_approval_home_a' });
        expect(context.requesterAccountContext.token === homes.findByServerUrl('https://provider-settings-account.test')!.token).toBe(true);
        delivered = true;
        commitRemoteArtifact(remoteArtifact);
        return { status: decision === 'approve' ? 'executed' : 'rejected' };
      },
    });
    await account.publishMachines(account.serverId, [createMachineFixture({ ...boundary.machine,
      metadata: createMachineFixture().metadata, daemonState: null })]);
    const request = TargetActionApprovalRequestV1Schema.parse(JSON.parse(currentArtifact.body));
    const settled = TargetActionApprovalRequestV1Schema.parse({ ...request,
      status: decision === 'approve' ? 'executed' : 'rejected', updatedAtMs: 3,
      decision: { kind: decision, decidedAtMs: 2 },
      ...(decision === 'approve' ? { execution: { executedAtMs: 3, ok: true, result: {} } } : {}),
    });
    remoteArtifact = { ...currentArtifact, header: buildTargetActionApprovalArtifactHeaderV1(settled), body: JSON.stringify(settled) };
    const { ApprovalDetailScreen } = await import('./ApprovalDetailScreen');
    const screen = await renderScreen(<ApprovalDetailScreen artifactId={currentArtifact.id} />);

    await waitForHomeGovernance(() => {
      expect(screen.findByTestId(`approvals.${decision}`)).not.toBeNull();
      expect(screen.findByTestId(`approvals.${decision}`)?.props.disabled).toBe(false);
    });

    await screen.pressByTestIdAsync(`approvals.${decision}`);

    expect(delivered).toBe(true);
    expect(homes.requestsFor('/v1/actions/approval.request.decide')).toHaveLength(1);
    expect(daemonDecisions()).toEqual([]);
    expect(JSON.parse(homes.artifacts(account.serverId).readPlainBody(currentArtifact.id)!)).toMatchObject({
      status: settled.status, decision: { kind: decision },
    });
    expect(screen.findByTestId('approvals.actions')).toBeNull();
    expect(artifactWrites()).toHaveLength(0);
  });

  it('routes an API target-action approval to its stamped daemon instead of mutating the Artifact locally', async () => {
    currentArtifact = await createApiTargetActionApprovalArtifact();
    const { ApprovalDetailScreen } = await import('./ApprovalDetailScreen');
    const screen = await renderScreen(
      <ApprovalDetailScreen artifactId="target-api-artifact-1" />,
    );

    await screen.pressByTestIdAsync('approvals.approve');

    expectSignedTargetDecision('target-api-artifact-1', 'approve', TargetActionApprovalRequestV1Schema.parse(JSON.parse(currentArtifact.body)).executionOriginV1!.serverId);
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

    expectSignedTargetDecision('target-api-artifact-1', 'reject', TargetActionApprovalRequestV1Schema.parse(JSON.parse(currentArtifact.body)).executionOriginV1!.serverId);
    expect(artifactWrites()).toHaveLength(0);
    expect(clientExecutionEffects()).toHaveLength(0);
  });

  it.each(['approval_stale', 'action_failed'] as const)('refreshes a typed %s target refusal and only alerts non-stale failures', async (errorCode) => {
    currentArtifact = await createApiTargetActionApprovalArtifact();
    const request = TargetActionApprovalRequestV1Schema.parse({
      ...JSON.parse(currentArtifact.body), status: 'failed', updatedAtMs: 2,
      decision: { kind: 'approve', decidedAtMs: 2 },
      execution: { executedAtMs: 2, ok: false, errorCode, error: 'Current policy differs' },
    });
    const failedArtifact = { ...currentArtifact, header: buildTargetActionApprovalArtifactHeaderV1(request), body: JSON.stringify(request) };
    daemonReply = { ok: false, errorCode, error: 'Current policy differs' };
    remoteArtifact = failedArtifact;
    const { ApprovalDetailScreen } = await import('./ApprovalDetailScreen');
    const screen = await renderScreen(<ApprovalDetailScreen artifactId="target-api-artifact-1" />);
    await screen.pressByTestIdAsync('approvals.approve');

    if (errorCode === 'approval_stale') expect(approvalItem(screen, 'approvals.execution-failure')?.props.subtitle).toBe('approvals.staleFailure');
    else expect(approvalItem(screen, 'approvals.execution-failure')).toBeTruthy();
    expect(readRenderedText(screen)).toContain('approvals.status.failed');
    expect(readRenderedText(screen)).not.toContain('approvals.status.approved');
    expect(screen.findByTestId('approvals.approve')).toBeNull();
    expect(screen.findByTestId('approvals.reject')).toBeNull();
    const { Modal } = await import('@/modal');
    if (errorCode === 'approval_stale') expect(Modal.alert).not.toHaveBeenCalled();
    else expect(Modal.alert).toHaveBeenCalled();
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

    expectSignedTargetDecision('target-api-artifact-1', 'approve', TargetActionApprovalRequestV1Schema.parse(JSON.parse(currentArtifact.body)).executionOriginV1!.serverId);
    expect(artifactReads('target-api-artifact-1').length).toBeGreaterThan(1);
    expect(readRenderedText(screen)).toContain('approvals.status.approved');
    expect(screen.findByTestId('approvals.actions')).toBeNull();
  });

  it('executes a signed API-host Account title approval in the approving app while preserving its immutable origin', async () => {
    currentArtifact = await createDaemonRoutedApprovalArtifact();
    const { ApprovalDetailScreen } = await import('./ApprovalDetailScreen');
    const screen = await renderScreen(
      <ApprovalDetailScreen artifactId="daemon-approval-1" />,
    );
    const { createSessionMetadataHttpBoundary } = await import('@/dev/testkit/harness/sessionMetadataHttpBoundary');
    const metadata = createSessionMetadataHttpBoundary(() => storage.getState().sessions);
    for (const path of ['/v2/sessions/session-1', '/v2/sessions/session-1?accessProjectionVersion=1']) {
      homes.answer(account.serverId, path, { select: async (_input, request) => {
        const response = metadata.handle(request.url, request.init);
        if (!response) throw new Error('Expected Session metadata HTTP boundary');
        return { status: response.status, body: await response.json() };
      } });
    }

    expect(artifactWrites()).toHaveLength(0);
    await screen.pressByTestIdAsync('approvals.approve');

    const settled = JSON.parse(homes.artifacts(account.serverId).readPlainBody('daemon-approval-1')!);
    expect(settled, JSON.stringify(settled.execution)).toMatchObject({
      status: 'executed', execution: { ok: true, result: { sessionId: 'session-1', title: 'Current title' } },
      executionOriginV1: JSON.parse(currentArtifact.body).executionOriginV1,
    });
    const persisted = await metadata.handle('https://home.test/v2/sessions/session-1')!.json();
    expect(persisted.session.displayProjectionV1.shared).toMatchObject({
      t: 'plain', v: { display: { summaryText: 'Current title' } },
    });
    const writes = artifactWrites();
    const transitions = writes.map((_, index) => {
      const written = decodedArtifactWrite(index).body;
      return { status: written.status, decision: written.decision?.kind, executed: written.execution?.ok };
    });
    expect(transitions).toEqual([
      { status: 'approved', decision: 'approve', executed: undefined },
      { status: 'executing', decision: 'approve', executed: undefined },
      { status: 'executed', decision: 'approve', executed: true },
    ]);
    expect(homes.requestsFor('/v1/actions/approval.request.decide')).toEqual([]);
    expect(rpcRequests).toEqual([]);
  });

  it('refuses a signed API-host Account title approval whose reviewed input was changed', async () => {
    const artifact = await createDaemonRoutedApprovalArtifact();
    const original = ApprovalRequestV2Schema.parse(JSON.parse(artifact.body));
    const changed = ApprovalRequestV2Schema.parse({ ...original,
      actionArgs: { sessionId: 'session-1', title: 'Unreviewed title' } });
    currentArtifact = { ...artifact, header: buildApprovalRequestArtifactHeaderV1(changed), body: JSON.stringify(changed) };
    const { ApprovalDetailScreen } = await import('./ApprovalDetailScreen');
    const screen = await renderScreen(<ApprovalDetailScreen artifactId="daemon-approval-1" />);

    await screen.pressByTestIdAsync('approvals.approve');

    const stored = JSON.parse(homes.artifacts(account.serverId).readPlainBody('daemon-approval-1')!);
    expect(stored).toMatchObject({ status: 'approved', executionOriginV1: original.executionOriginV1 });
    expect(stored.execution).toBeUndefined();
    expect(artifactWrites()).toHaveLength(1);
    expect(homes.requestsFor('/v2/sessions/session-1').filter(request => request.input !== null)).toEqual([]);
    expect(clientExecutionEffects()).toEqual([]);
    const { Modal } = await import('@/modal');
    expect(Modal.alert).not.toHaveBeenCalled();
  });

  it('routes a signed Session stop approval through this device profile to its exact daemon', async () => {
    currentArtifact = await createDaemonRoutedApprovalArtifact('session.stop');
    const origin = ApprovalRequestV2Schema.parse(JSON.parse(currentArtifact.body)).executionOriginV1;
    const { ApprovalDetailScreen } = await import('./ApprovalDetailScreen');
    const screen = await renderScreen(<ApprovalDetailScreen artifactId="daemon-approval-1" />);

    await screen.pressByTestIdAsync('approvals.approve');

    const decisions = homes.requestsFor('/v1/actions/approval.request.decide');
    expect(decisions).toHaveLength(1);
    expect(decisions[0]).toMatchObject({ serverId: account.serverId, input: {
      target: { kind: 'machine', machineId: 'machine-exact' },
      input: { artifactId: 'daemon-approval-1', decision: 'approve', serverIdentityId: 'srv_approval_home_a',
        originServerId: origin.serverId },
    } });
    expect(JSON.parse(homes.artifacts(account.serverId).readPlainBody('daemon-approval-1')!)).toMatchObject({
      status: 'approved', executionOriginV1: origin,
    });
    expect(artifactWrites()).toHaveLength(1);
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
    currentArtifact = await createDaemonRoutedApprovalArtifact('session.stop');
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
    currentArtifact = await createDaemonRoutedApprovalArtifact('session.stop');
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
    // Home refused dispatch before an effect began; it cannot invent an execution receipt.
    expect(JSON.parse(homes.artifacts(account.serverId).readPlainBody('daemon-approval-1')!))
      .toMatchObject({ status: 'approved', decision: { kind: 'approve' } });
    expect(rpcRequests).toEqual([]);
  });

  it.each([false, true])('renders the host-action approval and delegates consent without a generic Artifact write (explicit Home: %s)', async explicitHome => {
    currentArtifact = createExecutionRunHostActionApprovalArtifact();
    daemonReply = { ok: true, status: 'approved' };
    const { ApprovalDetailScreen } = await import('./ApprovalDetailScreen');
    const screen = await renderScreen(
      <ApprovalDetailScreen artifactId="host-action-artifact-1" {...(explicitHome ? { serverId: 'ui-A' } : {})} />,
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
    expect(artifactWrites()).toHaveLength(0);
    const { Modal } = await import('@/modal');
    expect(vi.mocked(Modal.alert).mock.calls.map(call => call.slice(0, 2))).toEqual([]);
    expect(daemonDecisions()).toHaveLength(1);
    expect(daemonDecisions()[0]).toMatchObject({ method: `session-1:${RPC_METHODS.APPROVAL_REQUEST_DECIDE}`,
      params: { artifactId: 'host-action-artifact-1', decision: 'approve' } });
    expect(rpcDestinations.find(request => request.method === `session-1:${RPC_METHODS.APPROVAL_REQUEST_DECIDE}`))
      .toMatchObject({ serverUrl: 'https://provider-settings-account.test' });
    expect(JSON.parse(homes.artifacts(account.serverId).readPlainBody('host-action-artifact-1')!))
      .toMatchObject({ serverId: 'server-1', status: 'open' });
    expect(screen.findByTestId('approvals.actions')).toBeNull();
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
    const receipt = storage.getState().artifacts['target-artifact-1'];
    expect(JSON.parse(receipt!.body!)).toMatchObject({ ...JSON.parse(authoritative.body), status: 'failed', updatedAtMs: expect.any(Number),
      execution: { ok: false, effectAttempted: false, errorCode: 'approval_origin_unavailable',
        details: { reason: 'live_invocation_unavailable' } } });
    expect(screen.findByTestId('approvals.approve')).toBeNull();
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

  it('resolves an agent Computer target through Account Actions with automation authority and Session context intact', async () => {
    await prepareComputerAgentFixture();
    const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
    const result = await createDefaultActionExecutor().execute('computer.target.get', { machineId: 'machine-2' }, {
      serverId: account.serverId, surface: 'agent', authority: 'account_automation',
      actionCaller: { kind: 'host' },
      defaultSessionId: 'session-1', defaultSessionMachineId: 'machine-2', actionRequestId: 'computer-agent-target',
    });
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true, result: { sourceId: 'computer:1',
      selectedTarget: { kind: 'window', displayId: ':77', pid: 123, windowId: 456 } } });
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
    expect(ApprovalRequestV2Schema.parse(JSON.parse(currentArtifact.body)).executionOriginV1).toMatchObject({
      actionId: 'computer.input', authority: 'account_automation', surface: 'agent',
      caller: { kind: 'host' }, target: { kind: 'machine', machineId: 'machine-2' },
    });
    const text = readRenderedText(screen);
    expect(text).toContain('ana@lumen.dev');
    // This suite's `t` drops params, so read what the page handed the card.
    const card = screen.tree.root.findAll(
      (node) => node.props?.presentation?.machineName === 'Workstation one',
    );
    expect(card.length).toBeGreaterThan(0);
    expect(card[0]!.props.presentation.act).toBe('type');
    expect(card[0]!.props.presentation.target).toEqual({
      kind: 'window',
      title: 'Sign in to Lumen',
    });
  });

  it('asks a first Computer click as the act itself, with the card as its only facts (lab computer CSp)', async () => {
    currentArtifact = await createBuiltInApprovalArtifact({
      actionId: 'computer.input',
      sourceSessionId: 'session-1',
      actionArgs: { machineId: 'machine-2', captureId: 'capture_1', operation: { kind: 'click', x: 412, y: 318 } },
      summary: 'Click Sign in',
      preview: { computerApprovalDisplay: {
        machineDisplayName: 'Workstation one', requiresTargetSelection: false, appName: 'Safari',
        target: { kind: 'window', title: 'Sign in to Lumen' },
      } },
    });
    const { ApprovalDetailScreen } = await import('./ApprovalDetailScreen');
    const screen = await renderScreen(<ApprovalDetailScreen artifactId="artifact-1" />);
    expect(screen.findByTestId('approvals.computer-action')).not.toBeNull();
    const header = screen.tree.root.findAll((node) => node.props?.testID === 'approvals.header' && node.props?.title !== undefined);
    // One act line: the page asks "Click in {target}?" and the card does not repeat it.
    expect(header[0]!.props.title).toBe('computerUse.approval.actIn');
    expect(readRenderedText(screen)).not.toContain('computerUse.approval.act.click');
    // The card already says what, where and the consequence; the raw operands are not a second list.
    expect(screen.findByTestId('approvals.fields-table')).toBeNull();
    // Nor does the Action's agent-facing description lead the request.
    expect(screen.findByTestId('approvals.preview')).toBeNull();
  });

  it('shows the picture an executed capture produced, on the page that says it ran', async () => {
    currentArtifact = await createBuiltInApprovalArtifact({
      actionId: 'computer.capture',
      sourceSessionId: 'session-1',
      actionArgs: { machineId: 'machine-2' },
      summary: 'Capture computer target',
      preview: { computerApprovalDisplay: {
        machineDisplayName: 'Workstation one', requiresTargetSelection: false, target: { kind: 'display', title: 'primary' },
      } },
      executedResult: {
        target: { kind: 'display', displayId: ':0' }, sourceId: 'computer:1', provider: 'agent-desktop', status: 'captured',
        captureId: 'capture_1',
        geometry: { captureWidth: 1280, captureHeight: 1024, nativeWidth: 1280, nativeHeight: 1024, originX: 0, originY: 0, scaleX: 1, scaleY: 1,
          crop: { x: 0, y: 0, width: 1280, height: 1024 } },
        media: { mediaId: 'media_1', mediaKind: 'image', width: 1280, height: 1024, sizeBytes: 21353,
          file: { sessionId: 'session-1', storage: 'session', path: '.happier/media/capture.png', sha256: 'a'.repeat(64), mimeType: 'image/png' } },
      },
    });
    const { ApprovalDetailScreen } = await import('./ApprovalDetailScreen');
    const screen = await renderScreen(<ApprovalDetailScreen artifactId="artifact-1" />);
    expect(screen.findByTestId('approvals.computer-action')).not.toBeNull();
    expect(screen.tree.root.findAll((node) => typeof node.props?.testID === 'string'
      && node.props.testID.startsWith('approvals.computer-action-crop')).length).toBeGreaterThan(0);
  });

  it('keeps a settled Computer ask to its card, without a second facts list of raw operands', async () => {
    // Keep the actual Computer producer's origin bound to this settled request.
    const artifact = await createBuiltInApprovalArtifact({ actionId: 'computer.input', sourceSessionId: 'session-1',
      actionArgs: { machineId: 'machine-2', captureId: 'capture_1', operation: { kind: 'click', x: 640, y: 400 } }, summary: 'Click' });
    const open = ApprovalRequestV2Schema.parse(JSON.parse(artifact.body));
    const settled = ApprovalRequestV2Schema.parse({ ...open,
      // The stored summary is the Action's agent-facing description (the executor's fallback).
      preview: { summary: 'Send click input against a current capture. Delivery alone does not prove the effect.', computerApprovalDisplay: {
        machineDisplayName: 'Workstation one', requiresTargetSelection: false,
        target: { kind: 'display', title: 'primary' },
      } },
      status: 'rejected', updatedAtMs: 3, decision: { kind: 'reject', decidedAtMs: 2 } });
    currentArtifact = { ...artifact, body: JSON.stringify(settled), header: buildApprovalRequestArtifactHeaderV1(settled) };
    const screen = await renderScreen(<approvalDetailScreenModule.ApprovalDetailScreen artifactId="artifact-1" />);
    expect(screen.findByTestId('approvals.computer-action')).not.toBeNull();
    expect(screen.findByTestId('approvals.fields-table')).toBeNull();
    expect(screen.findByTestId('approvals.preview')).toBeNull();
    const text = readRenderedText(screen);
    expect(text).not.toContain('capture_1');
    expect(text).not.toContain('640');
    // A display reads as the screen, never its display id.
    expect(text).not.toContain('primary');
    const header = screen.tree.root.findAll((node) => node.props?.testID === 'approvals.header' && node.props?.title !== undefined);
    expect(header[0]!.props.title).toBe('computerUse.approval.actOnScreen');
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
    currentArtifact = await createCurrentApprovalArtifact('server-approval', { placedOnMachine: true });
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

    await waitForHomeGovernance(() => expect(screen.findByTestId('approvals.approve')).not.toBeNull());
    expect(readRenderedText(screen)).not.toContain('Private cached title');
    expect(readRenderedText(screen)).not.toContain('secret-project');
    // The agent's proposal remains decidable when the Session's encrypted content is locked.
    expect(JSON.parse(currentArtifact.body).executionOriginV1.surface).toBe('agent');
    expect(screen.findByTestId('approvals.approve')?.props.disabled).toBe(
      false,
    );
    expect(screen.findByTestId('approvals.reject')?.props.disabled).toBe(false);
    expect(screen.findByTestId('approvals.cannot-run')).toBeFalsy();
  });

  it('withholds Approve and says why when no Machine is recorded to run the request, keeping Reject', async () => {
    const artifact = await createCurrentApprovalArtifact('server-approval');
    const produced = ApprovalRequestV2Schema.parse(JSON.parse(artifact.body));
    // A retained unplaced proposal predates the current producer's Machine placement.
    // Model that stored-read boundary with the canonical origin builder, never by breaking a signed origin.
    const request = ApprovalRequestV2Schema.parse({ ...produced, executionOriginV1: buildApprovalExecutionOriginV1({
      actionId: produced.actionId, input: produced.actionArgs, targetSessionId: 'session-1',
      context: { surface: 'agent', authority: 'account_automation', serverId: account.serverId,
        actionRequestId: 'retained-unplaced-request' },
    }) });
    currentArtifact = { ...artifact, header: buildApprovalRequestArtifactHeaderV1(request), body: JSON.stringify(request) };
    expect(JSON.parse(currentArtifact.body).executionOriginV1.machineId).toBeUndefined();
    const { ApprovalDetailScreen } = await import('./ApprovalDetailScreen');

    const screen = await renderScreen(<ApprovalDetailScreen artifactId="artifact-1" />);

    await waitForHomeGovernance(() => expect(screen.findByTestId('approvals.cannot-run')).toBeTruthy());
    expect(readRenderedText(screen)).toContain('approvals.cannotRunNoMachine');
    expect(screen.findByTestId('approvals.approve')?.props).toMatchObject({
      disabled: true, accessibilityHint: 'approvals.cannotRunNoMachine' });
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
    expect(factValue(screen.findHostByTestId('approvals.project-command.rows.row:checkout'))).toBe('/home/happier/tidewater');
    for (const raw of ['ws-8e7638ae', 'machine-target', 'Qualified checkout', 'Preparation phase']) expect(text).not.toContain(raw);
    expect(screen.findByTestId('approvals.approve')).not.toBeNull();
    expect(screen.findByTestId('approvals.reject')).not.toBeNull();
    expect(screen.findByTestId('approvals.cancel')).toBeNull();
  });

  it('withholds remembered setup approval when the retained operation loses its review, without probing again', async () => {
    await prepareApprovalFixture();
    const { actionOperationStore } = await import('@/sync/domains/actionOperations/actionOperationStore');
    const { ActionOperationSnapshotV1Schema } = await import('@happier-dev/protocol/actions/operations/v1');
    const workspace = { serverId: account.serverId, machineId: 'machine-target', workspaceId: 'checkout', rootPath: '/home/happier/tidewater' };
    const digest = 'a'.repeat(64);
    const setupReview = { kind: 'pendingApproval', code: 'project_setup_consent_required', reviewedEffectDigest: digest,
      reviewedEffect: { v: 1, purpose: 'setup', commands: [] } };
    const operation = ActionOperationSnapshotV1Schema.parse({ version: 1, operationId: 'held-setup', revision: 1,
      actionId: 'projects.prepare', state: 'accepted', title: 'Setup', createdAt: 1, cancellation: 'supported',
      scope: { accountId: 'account-1', machineId: workspace.machineId }, setupReview,
      domainRef: { kind: 'projectCommand', purpose: 'setup', serverId: workspace.serverId, machineId: workspace.machineId,
        workspaceRefId: workspace.workspaceId, cwd: workspace.rootPath, sourceWorkspace: workspace } });
    retainedSetupOperation = operation;
    currentArtifact = await createBuiltInApprovalArtifact({ actionId: 'projects.prepare', summary: 'Allow this setup until it changes',
      actionArgs: { workspace, phase: 'setup', consentScope: 'untilChanged', expectedEffectDigest: digest, heldOperationId: 'held-setup' },
      preview: { setupReview } });
    const serverId = resolveServerProfileScopeIdForIdentifier(account.serverId);
    try {
      actionOperationStore.mergeSnapshots({ serverId, snapshots: [operation] });
      const screen = await renderScreen(<approvalDetailScreenModule.ApprovalDetailScreen artifactId="artifact-1" />);
      await vi.waitFor(() => expect(decisionButton(screen, 'approvals.approve')?.props.disabled).toBe(false));
      const reads = rpcRequests.length;
      await act(async () => {
        actionOperationStore.mergeSnapshots({ serverId, snapshots: [{ ...operation, revision: 2, setupReview: undefined }] });
      });
      expect(decisionButton(screen, 'approvals.approve')?.props.disabled).toBe(true);
      expect(screen.findByTestId('approvals.cannot-run')).not.toBeNull();
      // The pushed retained-operation fact is already canonical; presentation needs no new RPC.
      expect(rpcRequests).toHaveLength(reads);
      await act(async () => {
        actionOperationStore.mergeSnapshots({ serverId, snapshots: [{ ...operation, revision: 3 }] });
      });
      expect(decisionButton(screen, 'approvals.approve')?.props.disabled).toBe(false);
      await act(async () => { actionOperationStore.reset(); });
      expect(decisionButton(screen, 'approvals.approve')?.props.disabled).toBe(true);
      expect(rpcRequests).toHaveLength(reads);
    } finally {
      actionOperationStore.reset();
    }
  });

  it.each(['reject', 'cancel'] as const)('reads a deploy review and routes %s through its existing decision owner', async decision => {
    await prepareApprovalFixture();
    const actionArgs = { serverId: account.serverId, environmentId: 'env-api', expectedRevision: 3, requestKey: 'deploy-key-1',
      targetLinkId: 'link-api', expectedTargetLinkRevision: 2, contentArtifactId: 'content-api', contentHeaderVersion: 1, contentBodyVersion: 1 };
    const machineReview = {
      environment: { id: 'env-api', name: 'Production API' },
      revision: { kind: 'repository' as const, sha: '7f3e2b1a90c4d5e6f708192a3b4c5d6e7f801234' },
      replaces: { deploymentId: 'deployment-38', revision: { kind: 'repository' as const, sha: 'b81e0d4c2f9a1b3c4d5e6f708192a3b4c5d6e7f8' } },
      secretBindingNames: ['DATABASE_URL', 'STRIPE_SECRET_KEY'],
      inspection: 'complete' as const,
      services: [
        { name: 'web', replicas: 1, resources: { cpus: null, memory: null }, restartPolicy: 'unless-stopped', healthcheck: 'configured' as const,
          ports: [{ target: 3000, published: 3000, bindAddress: '0.0.0.0', protocol: 'tcp' }], mounts: [] },
        { name: 'worker', replicas: 2, resources: { cpus: null, memory: null }, restartPolicy: null, healthcheck: 'absent' as const, ports: [],
          mounts: [{ type: 'bind', source: '/var/run/docker.sock', target: '/var/run/docker.sock', readOnly: false }] },
      ],
      risks: [{ kind: 'non_loopback_publish' as const, service: 'web' }, { kind: 'docker_socket' as const, service: 'worker' }],
      storage: { warnings: [{ kind: 'concurrent_writers' as const, service: 'worker', target: '/data', replicas: 2 }] },
      ownServer: { rollout: 'recreate' as const, autoRestorePreviousRelease: true },
      target: { engine: 'native' as const, requiresAwakeComputerAndDockerDesktop: false, domains: 'notDetermined' as const },
    };
    currentArtifact = await createBuiltInApprovalArtifact({ actionId: 'deployments.deploy', explicitRequest: true, summary: 'Deploy Production API', actionArgs,
      preview: { actionId: 'deployments.deploy', actionArgs, summary: 'Deploy Production API',
        deploymentReview: { ...machineReview, runtimeMachines: [{ machineId: 'machine-target', review: machineReview }] } } });
    const { ApprovalDetailScreen } = await import('./ApprovalDetailScreen');
    const screen = await renderScreen(<ApprovalDetailScreen artifactId="artifact-1" />);

    const text = readRenderedText(screen);
    // One review section on the shared approval fields, then the one risk callout.
    expect(screen.findByTestId('approvals.deployment-review.fields')).not.toBeNull();
    // The Machine is named, never its id; every service the Compose project starts is a row.
    expect(text).toContain('Rebound workstation');
    expect(text).not.toContain('machine-target');
    // The review replaces the opaque protocol operands (environment and target ids) in the page body.
    expect(text).not.toContain('env-api');
    for (const service of ['web', 'worker']) expect(text).toContain(service);
    // Version, what it replaces and secret names (never values) come from the host's review.
    for (const fact of ['7f3e2b1', 'projects.deployments.review.replacesNote', 'DATABASE_URL', 'STRIPE_SECRET_KEY']) expect(text).toContain(fact);
    // The decision and its consequence lead the page (lab d3); while it waits, the status follows what deploys.
    expect(text.indexOf('projects.deployments.review.decisionDeploy')).toBe(0);
    expect(text.indexOf('projects.deployments.review.consequenceOn')).toBeLessThan(text.indexOf('projects.deployments.review.whatTitle'));
    expect(text.indexOf('projects.deployments.review.whatTitle')).toBeLessThan(text.indexOf('approvals.fieldStatus'));
    expect(decisionButton(screen, 'approvals.approve')?.props.title).toBe('projects.deployments.review.approveDeploy');
    expect(screen.findByTestId('approvals.deployment-review.risks')).not.toBeNull();
    expect(text).toContain('projects.deployments.review.rollouts.recreate');
    // A reviewed deploy is decided on this page, never from a one-tap row.
    expect(screen.findByTestId('approvals.approve')).not.toBeNull();
    expect(clientExecutionEffects()).toHaveLength(0);
    expect(artifactWrites()).toHaveLength(0);
    expect(screen.findByTestId(`approvals.${decision}`)?.props.disabled).toBe(false);
    await screen.pressByTestIdAsync(`approvals.${decision}`);
    const { Modal } = await import('@/modal');
    expect(Modal.alert).not.toHaveBeenCalled();
    expect(decodedArtifactWrite().body).toMatchObject({ status: decision === 'reject' ? 'rejected' : 'canceled' });
    expect(clientExecutionEffects()).toHaveLength(0);
    expect(homes.requestsFor('/v1/actions/deployments.deploy')).toHaveLength(0);
  });

  it('names managed Create native steps when their private Actions are absent from the UI catalog', async () => {
    await prepareApprovalFixture();
    const actionArgs = { selection: { kind: 'preset', homeId: account.serverId, id: 'preset', revision: 1 },
      retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: true,
      enrollmentIdentity: { kind: 'guestProcess', role: 'sandbox' } };
    const hostReviewedChildren = { children: ['acquire', 'bootstrap', 'inspect', 'destroy', 'exec', 'putFile', 'reconcile', 'cleanup'].map(role => ({
      action: { pluginId: 'happier.machine.lima', localId: role === 'putFile' ? 'put-file' : role }, role,
    })) };
    currentArtifact = await createBuiltInApprovalArtifact({ actionId: 'machines.managed.acquire', explicitRequest: true,
      summary: 'Create managed machine', actionArgs, preview: { actionId: 'machines.managed.acquire', actionArgs, hostReviewedChildren } });
    const { ApprovalDetailScreen } = await import('./ApprovalDetailScreen');
    const screen = await renderScreen(<ApprovalDetailScreen artifactId="artifact-1" />);
    const text = readRenderedText(screen);
    for (const title of ['Create machine', 'Prepare Happier installation', 'Inspect machine', 'Delete machine',
      'Run setup command', 'Write setup file', 'Recover machine creation', 'Clean up machine creation']) expect(text).toContain(title);
    expect(text).not.toContain('includedStepUnnamed');
    expect(text).not.toContain('includedStepFromPlugin');
  });

  it('says once where the included steps run when every step runs in the same place', async () => {
    await prepareApprovalFixture();
    const { t } = await import('@/text');
    const { ApprovalDetailScreen } = await import('./ApprovalDetailScreen');
    const actionArgs = { selection: { kind: 'preset', homeId: account.serverId, id: 'preset', revision: 1 },
      retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: true,
      enrollmentIdentity: { kind: 'guestProcess', role: 'sandbox' } };
    const hostReviewedChildren = { children: ['acquire', 'bootstrap', 'inspect'].map(role => ({
      action: { pluginId: 'happier.machine.lima', localId: role }, role })) };
    currentArtifact = await createBuiltInApprovalArtifact({ actionId: 'machines.managed.acquire', explicitRequest: true,
      summary: 'Create managed machine', actionArgs, preview: { actionId: 'machines.managed.acquire', actionArgs, hostReviewedChildren } });
    const created = await renderScreen(<ApprovalDetailScreen artifactId="artifact-1" />);
    const createdText = readRenderedText(created);
    // The place every step shares is said once, above the steps, not repeated beside each one.
    expect(createdText).toContain(t('approvals.includedStepsDescriptionRequestMachine'));
    expect(createdText).not.toContain(t('approvals.includedStepMachineFromRequest'));
    expect(factValue(created.findHostByTestId('approvals.included-steps.rows.row:step.0'))).toBe('Create machine');

    const deployArgs = { serverId: account.serverId, environmentId: 'env-api', expectedRevision: 3, requestKey: 'deploy-key-5',
      targetLinkId: 'link-api', expectedTargetLinkRevision: 2, contentArtifactId: 'content-api', contentHeaderVersion: 1, contentBodyVersion: 1 };
    const sameMachine = { children: [
      { action: { pluginId: 'acme.compose', localId: 'deploy' }, role: 'deploy', input: { machineId: 'machine-2' } },
      { action: { pluginId: 'acme.compose', localId: 'observe' }, role: 'observe', input: { machineId: 'machine-2' } },
    ] };
    currentArtifact = await createBuiltInApprovalArtifact({ actionId: 'deployments.deploy', explicitRequest: true, summary: 'Deploy Production API',
      actionArgs: deployArgs, preview: { actionId: 'deployments.deploy', actionArgs: deployArgs, summary: 'Deploy Production API', hostReviewedChildren: sameMachine } });
    const deployed = await renderScreen(<ApprovalDetailScreen artifactId="artifact-1" />);
    const deployedText = readRenderedText(deployed);
    expect(deployedText).toContain(t('approvals.includedStepsDescriptionOnMachine', { machine: 'Studio laptop' }));
    // Each row is the step alone; its Machine is not repeated beside it.
    expect(factValue(deployed.findHostByTestId('approvals.included-steps.rows.row:step.1'))).not.toBe('Studio laptop');
  });

  it('lists each step a deploy approval also approves by its name and Machine, and nothing when it folds none', async () => {
    await prepareApprovalFixture();
    const actionArgs = { serverId: account.serverId, environmentId: 'env-api', expectedRevision: 3, requestKey: 'deploy-key-3',
      targetLinkId: 'link-api', expectedTargetLinkRevision: 2, contentArtifactId: 'content-api', contentHeaderVersion: 1, contentBodyVersion: 1 };
    const hostReviewedChildren = { children: [
      // Each step's own normalized input owns its Machine routing (no separate target tuple).
      { action: 'projects.inspect', role: 'service.inspect.source', input: { read: { kind: 'setup' },
        workspace: { serverId: account.serverId, machineId: 'machine-target', workspaceId: 'ws-source', rootPath: '/home/happier/tidewater' } } },
      { action: { pluginId: 'acme.compose', localId: 'deploy' }, role: 'deploy', input: { machineId: 'machine-2' } },
      { action: { pluginId: 'acme.compose', localId: 'observe' }, role: 'observe', input: { v: 1 } },
    ] };
    currentArtifact = await createBuiltInApprovalArtifact({ actionId: 'deployments.deploy', explicitRequest: true, summary: 'Deploy Production API', actionArgs,
      preview: { actionId: 'deployments.deploy', actionArgs, summary: 'Deploy Production API', hostReviewedChildren } });
    const { ApprovalDetailScreen } = await import('./ApprovalDetailScreen');
    const { t } = await import('@/text');
    const screen = await renderScreen(<ApprovalDetailScreen artifactId="artifact-1" />);

    expect(screen.findHostByTestId('approvals.included-steps')).not.toBeNull();
    const text = readRenderedText(screen);
    // Each step reads by the name a person knows (never its Action id or role) on the Machine it runs on.
    expect(text).toContain(t('actionPresentation.title', { actionId: 'projects.inspect', source: 'Inspect project definitions' }));
    expect(text).toContain(t('approvals.includedStepUnnamed'));
    expect(factValue(screen.findHostByTestId('approvals.included-steps.rows.row:step.0'))).toBe('Rebound workstation');
    expect(factValue(screen.findHostByTestId('approvals.included-steps.rows.row:step.1'))).toBe('Studio laptop');
    // A step whose input names no Machine runs where the request decides, said the same way as a step whose input comes later.
    expect(factValue(screen.findHostByTestId('approvals.included-steps.rows.row:step.2'))).toBe(t('approvals.includedStepMachineFromRequest'));
    for (const raw of ['service.inspect.source', 'acme.compose', 'ws-source', 'machine-target']) expect(text).not.toContain(raw);
    // What else is approved sits with the facts, before the decision.
    const order = collectRenderedTestIds(screen.tree.toJSON());
    expect(order.indexOf('approvals.included-steps')).toBeGreaterThan(-1);
    expect(order.indexOf('approvals.included-steps')).toBeLessThan(order.indexOf('approvals.approve'));

    currentArtifact = await createBuiltInApprovalArtifact({ actionId: 'deployments.deploy', explicitRequest: true, summary: 'Deploy Production API', actionArgs,
      preview: { actionId: 'deployments.deploy', actionArgs, summary: 'Deploy Production API' } });
    const none = await renderScreen(<ApprovalDetailScreen artifactId="artifact-1" />);
    expect(none.findHostByTestId('approvals.included-steps')).toBeNull();
  });

  it('lists a deploy step whose input comes later on the reviewed Machine or as decided by the request, and never a raw Machine id', async () => {
    await prepareApprovalFixture();
    const actionArgs = { serverId: account.serverId, environmentId: 'env-api', expectedRevision: 3, requestKey: 'deploy-key-4',
      targetLinkId: 'link-api', expectedTargetLinkRevision: 2, contentArtifactId: 'content-api', contentHeaderVersion: 1, contentBodyVersion: 1 };
    const machineReview = {
      environment: { id: 'env-api', name: 'Production API' },
      revision: { kind: 'repository' as const, sha: '7f3e2b1a90c4d5e6f708192a3b4c5d6e7f801234' },
      replaces: null, secretBindingNames: [], inspection: 'complete' as const, services: [], risks: [], storage: { warnings: [] },
      ownServer: { rollout: 'recreate' as const, autoRestorePreviousRelease: true },
      target: { engine: 'native' as const, requiresAwakeComputerAndDockerDesktop: false, domains: 'notDetermined' as const },
    };
    // The deployment common plan folds its role steps before any input exists; the domain owner supplies it later.
    const hostReviewedChildren = { children: [
      { action: { pluginId: 'acme.compose', localId: 'deploy' }, role: 'deploy' },
      { action: { pluginId: 'acme.compose', localId: 'observe' }, role: 'observe', scopeInput: { machineId: 'machine-2' } },
      { action: { pluginId: 'acme.compose', localId: 'observe' }, role: 'probe', scopeInput: { machineId: 'machine-this-home-lacks' } },
    ] };
    const { ApprovalDetailScreen } = await import('./ApprovalDetailScreen');
    const { t } = await import('@/text');
    currentArtifact = await createBuiltInApprovalArtifact({ actionId: 'deployments.deploy', explicitRequest: true, summary: 'Deploy Production API', actionArgs,
      preview: { actionId: 'deployments.deploy', actionArgs, summary: 'Deploy Production API', hostReviewedChildren,
        deploymentReview: { ...machineReview, runtimeMachines: [{ machineId: 'machine-target', review: machineReview }] } } });
    const reviewed = await renderScreen(<ApprovalDetailScreen artifactId="artifact-1" />);
    // Both steps are listed; the one without input runs on the Machine the deploy itself was reviewed for.
    expect(factValue(reviewed.findHostByTestId('approvals.included-steps.rows.row:step.0'))).toBe('Rebound workstation');
    expect(factValue(reviewed.findHostByTestId('approvals.included-steps.rows.row:step.1'))).toBe('Studio laptop');
    expect(readRenderedText(reviewed)).not.toContain('acme.compose');
    // A Machine this Home has no record of reads in words; its id never reaches the page.
    expect(factValue(reviewed.findHostByTestId('approvals.included-steps.rows.row:step.2'))).toBe(t('approvals.machineNotKnown'));
    expect(readRenderedText(reviewed)).not.toContain('machine-this-home-lacks');

    currentArtifact = await createBuiltInApprovalArtifact({ actionId: 'deployments.deploy', explicitRequest: true, summary: 'Deploy Production API', actionArgs,
      preview: { actionId: 'deployments.deploy', actionArgs, summary: 'Deploy Production API', hostReviewedChildren } });
    const unreviewed = await renderScreen(<ApprovalDetailScreen artifactId="artifact-1" />);
    // With no reviewed Machine either, the page says the request decides it instead of hiding the step.
    expect(factValue(unreviewed.findHostByTestId('approvals.included-steps.rows.row:step.0'))).toBe(t('approvals.includedStepMachineFromRequest'));
    expect(factValue(unreviewed.findHostByTestId('approvals.included-steps.rows.row:step.1'))).toBe('Studio laptop');
  });

  it('renders a deploy approval without a structured review exactly as before', async () => {
    await prepareApprovalFixture();
    const actionArgs = { serverId: account.serverId, environmentId: 'env-api', expectedRevision: 3, requestKey: 'deploy-key-2',
      targetLinkId: 'link-api', expectedTargetLinkRevision: 2, contentArtifactId: 'content-api', contentHeaderVersion: 1, contentBodyVersion: 1 };
    currentArtifact = await createBuiltInApprovalArtifact({ actionId: 'deployments.deploy', explicitRequest: true, summary: 'Deploy Production API', actionArgs,
      preview: { actionId: 'deployments.deploy', actionArgs, summary: 'Deploy Production API' } });
    const { ApprovalDetailScreen } = await import('./ApprovalDetailScreen');
    const screen = await renderScreen(<ApprovalDetailScreen artifactId="artifact-1" />);

    expect(screen.findByTestId('approvals.preview')).not.toBeNull();
    expect(screen.findByTestId('approvals.deployment-review.fields')).toBeNull();
    expect(screen.findByTestId('approvals.approve')).not.toBeNull();
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

    expect(factValue(screen.findHostByTestId('approvals.project-command.rows.row:checkout'))).toBe('/home/happier/tidewater');
    expect(factValue(screen.findHostByTestId('approvals.project-command.rows.row:where'))).toBe('worker-target');
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
    currentArtifact = await createCurrentApprovalArtifact('server-approval', { placedOnMachine: true });
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
      ...(await createSignedRequesterApprovalOrigin(base.actionId, base.actionArgs, 'account-1', 'creator-local-home-profile')) });
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

    await waitForHomeGovernance(() => {
      expect(screen.findByTestId('approvals.reject')).not.toBeNull();
    });
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
      kind: 'requester_confirmation',
      artifact: { ...currentArtifact, headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1, isDecrypted: true } as DecryptedArtifact,
      parsed: { family: 'built_in', request }, subject: request.requesterConfirmation!, requestRef: 'received-question', originMessageId: 'message-1',
    }} />);

    // The card opens the shared review in place; the standalone page is only a link away.
    await waitForHomeGovernance(() => {
      expect(screen.findByTestId('approval-requester-thread-review')).not.toBeNull();
      expect(screen.findByTestId('approval-requester-thread-open')).not.toBeNull();
      // The refusal reads the bar's one word, not a per-surface variant.
      expect(decisionButton(screen, 'approval-requester-thread-decline')?.props.title).toBe('approvals.reject');
    });
    await act(async () => {
      await screen.pressByTestIdAsync('approval-requester-thread-review');
    });
    await waitForHomeGovernance(() => expect(screen.findByTestId('approvals.approve')).not.toBeNull());
    await screen.pressByTestIdAsync('approvals.approve');

    const { Modal } = await import('@/modal');
    expect(Modal.alert).not.toHaveBeenCalled();
    expect(pushSpy).not.toHaveBeenCalled();
    expect(daemonDecisions()).toEqual([expect.objectContaining({ method: `session-1:${RPC_METHODS.APPROVAL_REQUEST_DECIDE}`,
      params: { artifactId: 'artifact-1', sessionId: 'session-1', decision: 'approve' } })]);
    // The accepted answer settles the card in place as its receipt.
    expect(screen.findByTestId('approval-requester-thread-receipt-confirmed_pending')).not.toBeNull();
    expect(screen.findByTestId('approval-requester-thread-approve')).toBeNull();
  });

  it('retires a Discussion decision immediately when the recorded approved effect fails', async () => {
    const actionArgs = { sessionId: 'session-1', title: 'Release 0.3' };
    const base = JSON.parse((await createBuiltInApprovalArtifact({ actionId: 'session.title.set', actionArgs,
      summary: 'Rename the session to Release 0.3', serverId: 'server-approval' })).body);
    const request = ApprovalRequestV2Schema.parse({ ...base, requestedSurface: 'agent',
      ...(await createSignedRequesterApprovalOrigin(base.actionId, base.actionArgs)) });
    currentArtifact = { id: 'artifact-1', ownerAccountId: 'bot-owner', header: buildApprovalRequestArtifactHeaderV1(request), body: JSON.stringify(request) };
    daemonReply = { ok: true, result: { status: 'failed', execution: {
      executedAtMs: 2, ok: false, effectAttempted: true,
      errorCode: 'artifact_read_unavailable', error: 'artifact_read_unavailable',
    } } };
    approvalHomeFixture = { kind: 'resolved', serverIdentityId: 'srv_approval_home_a',
      profile: { id: 'server-approval', serverIdentityId: 'srv_approval_home_a', name: '' } };
    const { ApprovalRequesterThreadCard } = await import('./ApprovalRequesterThreadCard');
    const screen = await renderScreen(<ApprovalRequesterThreadCard serverId="server-approval" approval={{
      kind: 'requester_confirmation',
      artifact: { ...currentArtifact, headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1, isDecrypted: true } as DecryptedArtifact,
      parsed: { family: 'built_in', request }, subject: request.requesterConfirmation!, requestRef: 'received-question', originMessageId: 'message-1',
    }} />);

    await waitForHomeGovernance(() => expect(screen.findByTestId('approval-requester-thread-review')).not.toBeNull());
    await screen.pressByTestIdAsync('approval-requester-thread-review');
    await waitForHomeGovernance(() => expect(screen.findByTestId('approvals.approve')).not.toBeNull());
    await screen.pressByTestIdAsync('approvals.approve');

    expect(daemonDecisions()).toHaveLength(1);
    expect(screen.findByTestId('approval-requester-thread-receipt-confirmed_pending')).not.toBeNull();
    expect(screen.findByTestId('approval-requester-thread-approve')).toBeNull();
    expect(screen.findByTestId('approval-requester-thread-decline')).toBeNull();
  });

  it('executes an approval decision without requiring a second web confirmation', async () => {
    modalConfirmResult = false;
    currentArtifact = await createCurrentApprovalArtifact('server-approval', { placedOnMachine: true });
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
