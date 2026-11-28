import * as React from 'react';
import type { ApprovalRequest } from '@happier-dev/protocol/approvals/approvalRequestV1';
import { resolveAgentIdFromSessionMetadata } from '@happier-dev/agents';
import { MetadataSchema } from '@happier-dev/session-core/state';
import type { ReachDecisionV1 } from '@happier-dev/protocol/reach/resolveReachV1';
import type { CapabilityApplyTimingV1 } from '@happier-dev/protocol/reach/capabilityApplyTimingV1';

import {
  pickMostBlockingCapabilityStatus,
  type CapabilityStatus,
} from '@/components/capabilities/status/capabilityStatusPresentation';
import { useSessionTranscriptSource } from '@/components/sessions/transcript/source/SessionTranscriptSourceContext';
import { useSessionCapabilities } from '@/sync/domains/capabilities/session/useSessionCapabilities';
import { useArtifact, useMachineDisplayNamesById } from '@/sync/domains/state/storage';
import { useMcpServerCatalogForServer } from '@/components/settings/mcpServers/useMcpServersSettings';
import { mcpServerDisplayName } from '@/components/settings/mcpServers/collection/mcpServerCollectionModel';
import { resolveReachV1 } from '@happier-dev/protocol/reach/resolveReachV1';
import type { DecryptedArtifact } from '@/sync/domains/artifacts/artifactTypes';
import { t } from '@/text';

import { readCapabilityEnableApproval } from './capabilityEnableApprovalModel';
import {
  CapabilityEnableApprovalView,
  CapabilityEnableDecisionBar,
  describeCapabilityEnableSettled,
  type CapabilityEnableApprovalViewModel,
} from './CapabilityEnableApprovalView';
import { useCapabilityEnableApproval } from './useCapabilityEnableApproval';
import {
  useSessionCapabilitiesDetail,
  type SheetTarget,
} from './useSessionCapabilitiesChip';

export { readCapabilityEnableApproval };

function describeTiming(
  timing: CapabilityApplyTimingV1 | null | undefined,
): string | null {
  switch (timing?.t) {
    case 'applied_now':
      return t('capabilities.session.ask.readyNow');
    case 'next_turn':
      return t('capabilities.session.ask.joinsAfterTurn');
    case 'restart_to_apply':
      return t('capabilities.session.ask.nextStart');
    case 'new_sessions_only':
      return t('capabilities.session.apply.newSessionsOnly', {
        item: '',
        machine: '',
      });
    default:
      return null;
  }
}

/**
 * The Agent enable request's model and decisions, for every surface that draws it (the card in the tray and
 * transcript, and Inbox Details). One `useCapabilityEnableApproval` controller decides; this only joins its
 * inputs from the canonical owners (P8 U8.5, INV-4, D33).
 */
export function useCapabilityEnableApprovalModel(
    props: Readonly<{
      artifact: Pick<DecryptedArtifact, 'id' | 'header'>;
      approval: ApprovalRequest;
      sessionId: string;
      /** The request's Home; the transcript source's, or the approval's on Details. */
      serverId: string | null;
    }>,
) {
    const request = readCapabilityEnableApproval(props.approval);
    const serverId = props.serverId;
    const session = useSessionCapabilities(props.sessionId, undefined, {
      serverId,
    });
    const { demandPreview } = session;
    // The card is the demand: it needs the item's name, deciding rule and timing now.
    React.useEffect(() => {
      demandPreview();
    }, [demandPreview]);
    const parsedMetadata = React.useMemo(
      () => MetadataSchema.safeParse(session.metadata),
      [session.metadata],
    );
    const metadata = parsedMetadata.success ? parsedMetadata.data : null;
    const machineId = metadata?.machineId ?? null;
    const machineIds = React.useMemo(
      () => (machineId ? [machineId] : []),
      [machineId],
    );
    const machineName =
      useMachineDisplayNamesById(machineIds)[machineId ?? ''] ??
      t('common.machine');
    const modelInput = React.useMemo(
      () => ({
        view: session.preview
          ? { ...session.preview, pendingApply: session.pendingApply }
          : null,
        selection: session.selection,
        applyState: {
          pendingApply: session.pendingApply,
          applyTiming: session.applyTiming,
        },
        state:
          session.status === 'ready'
            ? ('ready' as const)
            : session.status === 'unavailable'
              ? ('error' as const)
              : ('resolving' as const),
        readOnly: true,
        change: null,
      }),
      [
        session.preview,
        session.pendingApply,
        session.applyTiming,
        session.selection,
        session.status,
      ],
    );
    const target = React.useMemo<SheetTarget>(
      () => ({ sessionId: props.sessionId, metadata: session.metadata }),
      [props.sessionId, session.metadata],
    );
    const noop = React.useCallback(() => {}, []);
    const { detail } = useSessionCapabilitiesDetail(
      serverId,
      true,
      noop,
      target,
      modelInput,
      machineName,
    );

    const kind =
      request?.kind === 'skill' ? ('skill' as const) : ('mcp_server' as const);
    const items =
      kind === 'skill'
        ? session.preview?.skills.items
        : session.preview?.mcp.items;
    const item = request
      ? (items?.find((entry) => entry.id === request.id) ?? null)
      : null;
    // An item that is off for this session may be absent from its preview: name it from the library or catalog,
    // as Details does, and resolve its deciding rule from the same rules and context the sheet uses.
    const libraryArtifact = useArtifact(!item && request?.kind === 'skill' ? request.id : '');
    const libraryTitle = libraryArtifact?.header?.kind === 'prompt_bundle.v2' && libraryArtifact.header.bundleSchemaId === 'skills.skill_md_v1'
      ? libraryArtifact.title ?? libraryArtifact.header.title ?? null : null;
    const catalog = useMcpServerCatalogForServer(!item && request?.kind === 'mcp_server' ? serverId : null, !item && request?.kind === 'mcp_server');
    const catalogServer = request?.kind === 'mcp_server' ? catalog.value?.servers.find((server) => server.id === request.id) ?? null : null;
    const fallbackTitle = libraryTitle ?? (catalogServer ? mcpServerDisplayName(catalogServer) : null);
    const itemTitle = item ? (item.title ?? item.name) : fallbackTitle ?? (request?.id ?? '');
    const itemKnown = item !== null || fallbackTitle !== null;
    const agentId =
      request?.agentId ??
      (metadata ? resolveAgentIdFromSessionMetadata(metadata) : null);
    // The request always names its Agent; the Session's Agent is the fallback for an older request.
    const agentName = agentId ? detail.names.agentName(agentId) : '';
    const itemRules = request && !item ? detail.rules(kind, request.id) : null;
    const decidedBy: ReachDecisionV1['decidedBy'] = item ? item.decidedBy ?? null
      : itemRules && detail.context ? resolveReachV1(itemRules, detail.context).decidedBy : null;
    const enable = useCapabilityEnableApproval({
      artifact: props.artifact,
      approval: props.approval,
      sessionId: props.sessionId,
      decidedBy,
      projectKey: detail.context?.projectKey ?? null,
      machineId,
      itemTitle,
      agentName,
      names: detail.names,
    });

    const statuses: readonly CapabilityStatus[] =
      request && itemKnown
        ? kind === 'skill'
          ? detail.skillStatus(request.id)
          : detail.mcpStatus(request.id)
        : [];
    const mostBlocking = pickMostBlockingCapabilityStatus(statuses);
    const blockingFix =
      mostBlocking &&
      (mostBlocking.kind === 'signin' ||
        mostBlocking.kind === 'expired' ||
        mostBlocking.kind === 'more_access' ||
        mostBlocking.kind === 'key')
        ? (mostBlocking.fix ?? null)
        : null;
    const timing = describeTiming(
      kind === 'skill' ? session.applyTiming?.skills : session.applyTiming?.mcp,
    );
    const place = enable.alwaysWrite?.place;
    const placeName =
      place?.t === 'project'
        ? detail.names.projectName(place.projectKey)
        : place?.t === 'machine'
          ? detail.names.machineName(place.machineId)
          : place?.t === 'workspace'
            ? detail.names.folderLabel(place.machineId, place.workspaceRoot)
            : null;
    const settled = describeCapabilityEnableSettled({
      approvalStatus: props.approval.status,
      snapshot: enable.state,
      itemTitle,
      agentName,
      placeName,
      timing,
      undoSession: enable.undoSession,
      undoAlways: () => enable.undoAlways?.(),
      retryAlways: () => enable.retryAlways?.(),
    });

    const model: CapabilityEnableApprovalViewModel = {
      title:
        itemKnown && enable.title
          ? enable.title
          : props.approval.summary || t('approvals.untitled'),
      reason: enable.reason,
      offLine: itemKnown
        ? placeName
          ? t('capabilities.session.ask.offIn', {
              item: itemTitle,
              place: placeName,
            })
          : t('capabilities.session.ask.offHere', { item: itemTitle })
        : null,
      alwaysLine:
        enable.alwaysLabel && placeName
          ? enable.alwaysWrite?.agentId
            ? t('capabilities.session.ask.alwaysTurnsOnAgent', {
                always: enable.alwaysLabel,
                agent: detail.names.agentName(enable.alwaysWrite.agentId),
                place: placeName,
              })
            : t(place?.t === 'project' ? 'capabilities.session.ask.alwaysTurnsOn' : 'capabilities.session.ask.alwaysTurnsOnMachine', {
                always: enable.alwaysLabel,
                place: placeName,
              })
          : null,
      cost: request && itemKnown ? (detail.cost?.(kind, request.id) ?? null) : null,
      timing,
      connected: statuses.some((status) => status.kind === 'connected'),
      allowLabel: t('capabilities.session.ask.allowSession'),
      alwaysLabel: enable.alwaysLabel,
      blocking: blockingFix
        ? {
            label: t('capabilities.session.ask.signIn', { item: itemTitle }),
            onPress: blockingFix.onPress,
          }
        : null,
      settled,
      decisionError:
        enable.state?.status === 'decision_failed'
          ? t('capabilities.session.ask.decisionFailed', { item: itemTitle })
          : null,
      deciding: enable.state?.status === 'deciding',
    };
    return { model, choose: enable.choose };
}

/**
 * The incumbent approval card's body for an Agent asking to turn on a skill or MCP server for its session
 * (lab xi Q): three decisions, the consequence in words, and one settled line with Undo.
 */
export const CapabilityEnableApproval = React.memo(function CapabilityEnableApproval(props: Readonly<{
    artifact: Pick<DecryptedArtifact, 'id' | 'header'>;
    approval: ApprovalRequest;
    sessionId: string;
    chrome: 'card' | 'inline';
    /** False when the viewer cannot decide here (inactive, read-only, Home unavailable). */
    decisionsAvailable: boolean;
    headerAccessory?: React.ReactNode;
}>) {
    const transcriptSource = useSessionTranscriptSource();
    const { model, choose } = useCapabilityEnableApprovalModel({ artifact: props.artifact, approval: props.approval,
        sessionId: props.sessionId, serverId: transcriptSource.serverId ?? null });
    return (
        <CapabilityEnableApprovalView
            model={model}
            chrome={props.chrome}
            decisionsAvailable={props.decisionsAvailable && (props.approval.status === 'open' || model.deciding)}
            headerAccessory={props.headerAccessory}
            onChoose={choose ? (choice) => { void choose(choice); } : undefined}
        />
    );
});

/**
 * Inbox Details answers the same request with the same three decisions and controller as the card (lab xi Q;
 * FIX38 §3): Allow for this session · Always in <place> · Not now, plus Details' own Dismiss. Settles into the
 * card's one line with Undo.
 */
export function CapabilityEnableDetailsDecisions(props: Readonly<{
    artifact: Pick<DecryptedArtifact, 'id' | 'header'>;
    approval: ApprovalRequest;
    sessionId: string;
    serverId: string | null;
    /** Home unavailable, read-only or a decision in flight elsewhere on the page. */
    disabled: boolean;
    onDismiss?: () => void;
}>) {
    const { model, choose } = useCapabilityEnableApprovalModel(props);
    // A canceled request is already answered by the page's Status row; the card, not Details, carries its settled line.
    if (props.approval.status === 'canceled') return null;
    if (!model.deciding && (props.approval.status === 'open' ? !choose : !model.settled)) return null;
    return <CapabilityEnableDecisionBar model={model} choose={choose ?? (() => undefined)} disabled={props.disabled} onDismiss={props.onDismiss} />;
}
