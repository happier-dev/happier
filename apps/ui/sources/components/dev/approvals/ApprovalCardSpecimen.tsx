import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import type { Href } from 'expo-router';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { buildApprovalPreviewSummary } from '@happier-dev/protocol/actions/actionExecutor';
import type { ApprovalRequest } from '@happier-dev/protocol/approvals/approvalRequestV1';
import { buildApprovalRequestArtifactHeaderV1 } from '@happier-dev/protocol/approvals/approvalArtifactHeaderV1';
import { createInboxApprovalArtifactFixture } from '@/dev/testkit/fixtures/inboxFixtures';

import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { AgentInputPermissionRequests } from '@/components/sessions/agentInput/components/AgentInputPermissionRequests';
import { SessionTranscriptSourceProvider } from '@/components/sessions/transcript/source/SessionTranscriptSourceContext';
import { createReadOnlySessionTranscriptSource } from '@/components/sessions/transcript/source/readOnlySessionTranscriptSource';
import type { SessionTranscriptSource } from '@/components/sessions/transcript/source/types';
import type { OpenApprovalAttentionArtifactForSession } from '@/sync/domains/artifacts/approvalArtifacts';
import { createMachineFixture, createMachineMetadataFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { publishMachineInventoryForTest } from '@/dev/testkit/harness/machinePresence';
import { useActiveServerAccountScope, storage } from '@/sync/domains/state/storage';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { PAGE_LIST_METRICS } from '@/components/ui/lists/pageListMetrics';
import { ApprovalPromptCard } from '@/components/tools/shell/approvals/ApprovalPromptCard';

const SESSION_ID = 'dev-approval-card';
const NO_PERMISSIONS = Object.freeze([]);
const NO_LOCATIONS = new Map<string, null>();
const noop = () => {};

export const APPROVAL_CARD_SCENES = ['open', 'facts', 'failed', 'earlierFailures', 'names', 'choices', 'clear', 'technical', 'translated', 'projectCommand', 'delivery', 'code', 'acquire', 'acquireWithoutSignIn'] as const;
export type ApprovalCardScene = (typeof APPROVAL_CARD_SCENES)[number];

const SCRIPT_MACHINE = createMachineFixture({ id: '67cffe92-bd4e-4b28-8512-706b1cc4ab77',
  metadata: createMachineMetadataFixture({ displayName: 'Studio runner' }) });

const PAGE = 'https://en.wikipedia.org/wiki/Price_point';

/** The waiting and failed Browser open an Agent asks for, and a request with a longer list of facts. */
function sceneApproval(scene: Exclude<ApprovalCardScene, 'earlierFailures' | 'delivery'>, scope: ServerAccountScope): ApprovalRequest {
  // A current request, as an Agent's ask is stored today: it carries the origin it replays from.
  const origin = (actionId: string) => ({
    v: 1 as const,
    authority: 'account_automation' as const,
    surface: 'agent' as const,
    caller: { kind: 'session' as const, sessionId: SESSION_ID, starterDepth: 0, turnDepth: 0 },
    accountId: scope.accountId,
    serverId: scope.serverId,
    sessionId: SESSION_ID,
    actionId,
    requestId: `dev-approval-card-${scene}`,
  });
  const base = {
    v: 2 as const,
    createdAtMs: 1,
    updatedAtMs: 1,
    requestedSurface: 'agent' as const,
    createdBy: { surface: 'agent' as const, sessionId: SESSION_ID },
  };
  if (scene === 'projectCommand') {
    const actionArgs = { workspace: { serverId: scope.serverId, workspaceId: 'dev-script-checkout',
      machineId: SCRIPT_MACHINE.id, rootPath: '/workspace/project' },
      selection: { kind: 'named', name: 'build release' }, choice: { kind: 'primary' } };
    return { ...base, actionId: 'projects.script.run', actionArgs, status: 'open',
      summary: buildApprovalPreviewSummary(getActionSpec('projects.script.run'), actionArgs),
      executionOriginV1: origin('projects.script.run') } as ApprovalRequest;
  }
  // An Agent's managed Create; `acquire` carries the reviewed sign-in effect, `acquireWithoutSignIn` is an older preview.
  if (scene === 'acquire' || scene === 'acquireWithoutSignIn') {
    const actionArgs = { selection: { kind: 'one-off', homeId: scope.serverId, launch: {
      provider: { pluginId: 'happier.machine.lima', localId: 'vm' }, schemaVersion: 1, name: 'Build box', choices: {} },
      retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false }, enrollmentIdentity: { kind: 'guestProcess', role: 'sandbox' } };
    const summary = buildApprovalPreviewSummary(getActionSpec('machines.managed.acquire'), actionArgs);
    return { ...base, actionId: 'machines.managed.acquire', actionArgs, status: 'open', summary,
      preview: { actionId: 'machines.managed.acquire', actionArgs, summary,
        ...(scene === 'acquire' ? { accountSignIn: 'requester_confirms' } : {}) },
      executionOriginV1: origin('machines.managed.acquire') } as ApprovalRequest;
  }
  const fieldScenes = {
    names: { actionId: 'artifact.delete', actionArgs: {
      artifactId: 'pricing-page-copy-notes', expectedRevision: { headerVersion: 1, bodyVersion: 1 },
    } },
    choices: { actionId: 'artifact.list', actionArgs: { sort: 'updated_desc' } },
    clear: { actionId: 'artifact.folder.set', actionArgs: {
      artifactId: 'pricing-page-copy-notes', folderId: null, expectedRevision: 1,
    } },
    technical: { actionId: 'browser.view.open', actionArgs: {
      commandId: 'open-pricing', browserSessionId: 'pricing', viewId: 'pricing-view', kind: 'openView',
      platform: 'web', focus: true, target: { targetId: 'pricing-page', kind: 'externalUrl', url: PAGE },
    } },
    translated: { actionId: 'artifact.public_link.create', actionArgs: { artifactId: 'pricing-page-copy-notes' } },
    // A setting key no declaration names: the exact key, in the code face.
    code: { actionId: 'settings.get', actionArgs: { anchor: 'experiments.transcriptDucking' } },
  } as const;
  if (scene in fieldScenes) {
    const fields = fieldScenes[scene as keyof typeof fieldScenes];
    return { ...base, ...fields, summary: buildApprovalPreviewSummary(getActionSpec(fields.actionId), fields.actionArgs), status: 'open', executionOriginV1: origin(fields.actionId) } as ApprovalRequest;
  }
  const open = {
    ...base,
    executionOriginV1: origin('browser.workspace.open'),
    actionId: 'browser.workspace.open',
    summary: 'Open en.wikipedia.org in the Browser',
    actionArgs: {
      scopeId: SESSION_ID,
      commandId: 'open-price-point',
      target: { kind: 'externalUrl', targetId: 'price-point', url: PAGE },
    },
  };
  if (scene === 'open') return { ...open, status: 'open' } as ApprovalRequest;
  if (scene === 'failed')
    return {
      ...open,
      status: 'failed',
      decision: { kind: 'approve', decidedAtMs: 2 },
      execution: {
        executedAtMs: 3,
        ok: false,
        errorCode: 'runtime_action_disabled',
        error: 'runtime_action_disabled:browser:browser_view_unavailable',
      },
    } as ApprovalRequest;
  return {
    ...base,
    status: 'open',
    executionOriginV1: origin('artifact.public_link.create'),
    actionId: 'artifact.public_link.create',
    summary: 'Share Pricing page copy notes by public link',
    actionArgs: {
      artifactId: 'pricing-page-copy-notes',
      expiresAt: 1795400000000,
      maxUses: 50,
      isConsentRequired: true,
      networkOff: false,
      preserveExisting: true,
      audience: 'anonymous',
    },
  } as ApprovalRequest;
}

/**
 * An Agent's approved `machines.list` at its call, settled with each receipt the record can carry: the result held
 * for a person-stopped Session, not sent to a deleted one, of unknown outcome, and delivered (quiet).
 */
function deliveryRequests(scope: ServerAccountScope): readonly OpenApprovalAttentionArtifactForSession[] {
  const actionArgs = {};
  const settled = (id: string, delivery: unknown): OpenApprovalAttentionArtifactForSession => {
    const approval = {
      v: 2, createdAtMs: 1, updatedAtMs: 4, requestedSurface: 'agent', createdBy: { surface: 'agent', sessionId: SESSION_ID },
      origin: { kind: 'transcript_tool_call', sessionId: SESSION_ID, toolCallId: `dev-call-${id}` },
      actionId: 'machines.list', actionArgs, summary: buildApprovalPreviewSummary(getActionSpec('machines.list'), actionArgs),
      executionOriginV1: { v: 1, authority: 'account_automation', surface: 'agent',
        caller: { kind: 'session', sessionId: SESSION_ID, starterDepth: 0, turnDepth: 0 },
        accountId: scope.accountId, serverId: scope.serverId, sessionId: SESSION_ID,
        actionId: 'machines.list', requestId: `dev-approval-card-delivery-${id}` },
      status: 'executed', decision: { kind: 'approve', decidedAtMs: 2 },
      execution: { executedAtMs: 3, ok: true, result: { machines: [] } },
      delivery,
    } as unknown as ApprovalRequest;
    return { artifact: { ...createInboxApprovalArtifactFixture({ id: `dev-approval-card-delivery-${id}`,
      serverId: scope.serverId, actionId: approval.actionId, title: approval.summary }),
      header: buildApprovalRequestArtifactHeaderV1(approval), body: JSON.stringify(approval) }, approval };
  };
  return [
    settled('held', { status: 'held', localId: 'approval-result:dev-held', code: 'session_input_target_unavailable',
      failureCause: { phase: 'session.message.send', errorClass: 'Error', errorCode: 'held_by_person', httpStatus: null } }),
    settled('not-sent', { status: 'rejected', code: 'session_input_target_unavailable', effectAttempted: false,
      failureCause: { phase: 'approval.result.delivery', errorClass: 'Error', errorCode: 'session_input_target_unavailable', httpStatus: null } }),
    settled('unsure', { status: 'outcomeUnknown', localId: 'approval-result:dev-unsure', code: 'session_input_settlement_outcome_unknown' }),
    settled('delivered', { status: 'accepted', localId: 'approval-result:dev-delivered' }),
  ];
}

/** The tray's requests: one per scene, or for `earlierFailures` two settled failures above a waiting request. */
function sceneRequests(scene: ApprovalCardScene, scope: ServerAccountScope): readonly OpenApprovalAttentionArtifactForSession[] {
  const entry = (id: string, approval: ApprovalRequest): OpenApprovalAttentionArtifactForSession => ({
    artifact: { ...createInboxApprovalArtifactFixture({ id: `dev-approval-card-${id}`,
      serverId: scope.serverId, actionId: approval.actionId, title: approval.summary }),
      header: buildApprovalRequestArtifactHeaderV1(approval), body: JSON.stringify(approval) },
    approval,
  });
  if (scene === 'delivery') return deliveryRequests(scope);
  if (scene !== 'earlierFailures') return [entry(scene, sceneApproval(scene, scope))];
  const notRun = {
    ...sceneApproval('facts', scope),
    status: 'failed',
    decision: { kind: 'approve', decidedAtMs: 2 },
    execution: { executedAtMs: 3, ok: false, errorCode: 'approval_stale', error: 'approval_stale' },
  } as ApprovalRequest;
  return [entry('failed', sceneApproval('failed', scope)), entry('not-run', notRun), entry('open', sceneApproval('open', scope))];
}

function useSpecimenTranscriptSource(): SessionTranscriptSource {
  const router = useRouter();
  return React.useMemo(
    () => ({
      ...createReadOnlySessionTranscriptSource({
        sessionId: SESSION_ID,
        messages: [],
        agentState: null,
        metadata: null,
        reducerState: null,
        interaction: { canSendMessages: true, canApprovePermissions: true },
        // Decisions go nowhere: the specimen shows the card, it never answers a real request.
        actions: {
          respondToPermission: async () => {},
          answerUserAction: async () => {},
          abort: async () => {},
          submitMessage: async () => {},
        },
      }),
      navigate: (route: string) => router.push(route as Href),
    }),
    [router],
  );
}

/**
 * Dev-only: the composer's approval tray at the foot of the page, as a phone shows it, drawn by the real tray and the
 * real approval card. `scene=open` a waiting Browser open, `facts` a request with a longer list of facts, `failed` an
 * approved Browser open whose effect was refused, `earlierFailures` two settled failures folded above a waiting request. `room` is the height the composer leaves the tray.
 */
export function ApprovalCardSpecimen(
  props: Readonly<{ scene: ApprovalCardScene; roomPx: number }>,
) {
  const scope = useActiveServerAccountScope();
  const source = useSpecimenTranscriptSource();
  React.useEffect(() => {
    if (props.scene !== 'projectCommand' || !scope) return;
    const machines = Object.values(storage.getState().machines);
    void publishMachineInventoryForTest(scope, [...machines.filter(machine => machine.id !== SCRIPT_MACHINE.id), SCRIPT_MACHINE]);
  }, [props.scene, scope]);
  const requests = React.useMemo<
    readonly OpenApprovalAttentionArtifactForSession[]
  >(
    () =>
      scope ? sceneRequests(props.scene, scope) : [],
    [props.scene, scope],
  );
  if (!scope) return null;
  return (
    <View style={styles.page} testID="dev-approval-card">
      <View style={styles.tray}>
        <SessionTranscriptSourceProvider source={source}>
          {props.scene === 'delivery' ? (
            // Settled requests live at their call in the transcript, not in the tray: the row's own inline card.
            <View style={styles.transcriptCards}>
              {requests.map((request) => (
                <ApprovalPromptCard key={request.artifact.id} chrome="inline" artifact={request.artifact}
                  approval={request.approval} sessionId={SESSION_ID} canApprovePermissions />
              ))}
            </View>
          ) : <AgentInputPermissionRequests
            sessionId={SESSION_ID}
            permissionRequests={NO_PERMISSIONS}
            approvalRequests={requests}
            permissionLocationsById={NO_LOCATIONS}
            approvalLocationsByArtifactId={NO_LOCATIONS}
            metadata={null}
            canApprovePermissions
            maxHeightPx={props.roomPx}
            maxHeightCeilingPx={props.roomPx}
            presentation="oneAtATime"
            onContentSizeChange={noop}
            onLayout={noop}
            onScroll={noop}
          />}
        </SessionTranscriptSourceProvider>
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  page: {
    flex: 1,
    justifyContent: 'flex-end',
    backgroundColor: theme.colors.background.canvas,
    padding: theme.space.s16,
  },
  transcriptCards: {
    gap: theme.space.s16,
  },
  tray: {
    width: '100%',
    maxWidth: PAGE_LIST_METRICS.columnMaxWidthPx.reading,
    alignSelf: 'center',
    paddingHorizontal: theme.space.s8,
  },
}));
