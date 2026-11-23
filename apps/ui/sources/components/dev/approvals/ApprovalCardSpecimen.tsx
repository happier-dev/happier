import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import type { Href } from 'expo-router';
import type { ApprovalRequest } from '@happier-dev/protocol/approvals/approvalRequestV1';

import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { AgentInputPermissionRequests } from '@/components/sessions/agentInput/components/AgentInputPermissionRequests';
import { SessionTranscriptSourceProvider } from '@/components/sessions/transcript/source/SessionTranscriptSourceContext';
import { createReadOnlySessionTranscriptSource } from '@/components/sessions/transcript/source/readOnlySessionTranscriptSource';
import type { SessionTranscriptSource } from '@/components/sessions/transcript/source/types';
import type { OpenApprovalAttentionArtifactForSession } from '@/sync/domains/artifacts/approvalArtifacts';
import { useActiveServerAccountScope } from '@/sync/domains/state/storage';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { PAGE_LIST_METRICS } from '@/components/ui/lists/pageListMetrics';

const SESSION_ID = 'dev-approval-card';
const NO_PERMISSIONS = Object.freeze([]);
const NO_LOCATIONS = new Map<string, null>();
const noop = () => {};

export const APPROVAL_CARD_SCENES = ['open', 'facts', 'failed', 'earlierFailures'] as const;
export type ApprovalCardScene = (typeof APPROVAL_CARD_SCENES)[number];

const PAGE = 'https://en.wikipedia.org/wiki/Price_point';

/** The waiting and failed Browser open an Agent asks for, and a request with a longer list of facts. */
function sceneApproval(scene: Exclude<ApprovalCardScene, 'earlierFailures'>, scope: ServerAccountScope): ApprovalRequest {
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

/** The tray's requests: one per scene, or for `earlierFailures` two settled failures above a waiting request. */
function sceneRequests(scene: ApprovalCardScene, scope: ServerAccountScope): readonly OpenApprovalAttentionArtifactForSession[] {
  const entry = (id: string, approval: ApprovalRequest): OpenApprovalAttentionArtifactForSession => ({
    artifact: { id: `dev-approval-card-${id}`, header: { title: null, serverId: scope.serverId } },
    approval,
  } as OpenApprovalAttentionArtifactForSession);
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
          <AgentInputPermissionRequests
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
          />
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
  tray: {
    width: '100%',
    maxWidth: PAGE_LIST_METRICS.columnMaxWidthPx.reading,
    alignSelf: 'center',
    paddingHorizontal: theme.space.s8,
  },
}));
