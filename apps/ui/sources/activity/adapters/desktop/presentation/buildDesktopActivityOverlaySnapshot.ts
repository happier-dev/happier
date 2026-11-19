import type { ActivityOverviewSnapshot, SessionActivityAttention } from '@/activity/attention/activityAttentionTypes';
import type { ActivitySurfacePolicy } from '@/activity/attention/resolveActivitySurfacePolicy';
import { buildActivitySurfaceCountsViewModel } from '@/activity/presentation/buildActivitySurfaceCountsViewModel';
import {
    buildActivitySurfaceViewModels,
    resolvePrimaryActivitySurfaceTarget,
    type ActivitySurfaceCandidatePrivacyModeResolver,
} from '@/activity/presentation/buildActivitySurfaceViewModel';
import type { ActivitySurfaceSessionViewModel } from '@/activity/presentation/activitySurfaceViewModels';
import { resolveActivitySurfaceSlots } from '@/activity/selection/resolveActivitySurfaceSlots';
import { t } from '@/text';
import { readSessionListIdentityFacts } from '@/components/sessions/shell/SessionListIdentity';
import { readSessionBotFaceFacts } from '@/components/sessions/bots/face/sessionBotFaceFacts';
import { readSessionListPresentationDisplay } from '@/sync/domains/session/listing/sessionListRenderableSessionProjection';
import { resolveSessionContextLine } from '@/sync/domains/session/presentation/sessionContextPresentation';
import { sessionAddressKey } from '@/sync/domains/session/sessionAddress';
import { getSettledMachineDisplayName, type MachineNameSource } from '@/utils/sessions/machineDisplayNames';
import type { SessionAddress } from '@/sync/domains/session/sessionAddress';
import type { NotchBotFaces, PinnedDesktopOverlayConversation } from './notchBotTypes';

import type { DesktopActivityOverlaySource } from '../runtime/useDesktopActivityOverlaySource';
import type { DesktopOverlayPolicy } from '../runtime/resolveDesktopOverlayPolicy';
import { resolveDesktopOverlaySelectionSpec } from '../runtime/resolveDesktopOverlaySelectionSpec';
import { buildDesktopActivityOverlayCompletionSnapshots } from './snapshot/buildDesktopActivityOverlayCompletionSnapshots';
import { buildDesktopActivityOverlayOverviewFromSource } from './snapshot/buildDesktopActivityOverlayOverviewFromSource';
import { buildDesktopActivityOverlayQuotaSummarySnapshots } from './snapshot/buildDesktopActivityOverlayQuotaSummarySnapshots';
import { buildDesktopActivityOverlayRequestSnapshots } from './snapshot/buildDesktopActivityOverlayRequestSnapshots';
import type {
    DesktopActivityOverlayRequestSnapshot,
    DesktopActivityOverlaySnapshot,
    DesktopActivityOverlaySnapshotLabels,
    DesktopActivityOverlaySessionSnapshot,
} from './snapshot/desktopActivityOverlaySnapshotTypes';

export type {
    DesktopActivityOverlayCompletionStateSnapshot,
    DesktopActivityOverlayQuotaSummarySnapshot,
    DesktopActivityOverlayRequestSnapshot,
    DesktopActivityOverlaySnapshot,
    DesktopActivityOverlaySnapshotLabels,
    DesktopActivityOverlaySnapshotState,
    DesktopActivityOverlaySessionSnapshot,
} from './snapshot/desktopActivityOverlaySnapshotTypes';

function buildDesktopActivityOverlaySnapshotLabels(): DesktopActivityOverlaySnapshotLabels {
    return {
        sessionsTitle: t('tabs.sessions'),
        emptyTitle: t('components.emptySessionsTablet.noActiveSessions'),
    };
}

export type DesktopActivityOverlayMachineDisplays = Readonly<Record<string, Readonly<Record<string, MachineNameSource>>>>;

/**
 * Where an asking Session runs: its project and Machine, plus whatever else its context says. The Machine
 * name comes from the same resolver as the Machine pickers, told apart only from the other listed Machines
 * (owner 11-19: the "· 2f4e" suffix appears only when two listed Machines share a name). Null when neither
 * is known, so the row keeps its ordinary context line.
 */
function resolveAskerContextLine(
    candidate: SessionActivityAttention,
    machineId: string | null | undefined,
    machineDisplays: DesktopActivityOverlayMachineDisplays[string] | undefined,
    listedMachines: readonly MachineNameSource[],
    showHome: boolean,
): string | null {
    const machine = machineId ? machineDisplays?.[machineId] : undefined;
    const machineName = machine ? getSettledMachineDisplayName(machine, listedMachines) : null;
    if (!machineName && !candidate.context?.workspace) return null;
    const context = resolveSessionContextLine(candidate.context, { showWorkspace: true, showHome });
    return [context, machineName].filter(Boolean).join(' · ');
}

/**
 * The where-line facts decided once for the whole rendered list (owner 11-19): the Home speaks only when the
 * listed Sessions span more than one Home, and a Machine is told apart only from the other listed Machines.
 */
function resolveDesktopActivityOverlayListWhere(
    candidates: readonly SessionActivityAttention[],
    machineDisplaysByServerId: DesktopActivityOverlayMachineDisplays | undefined,
): Readonly<{ showHome: boolean; listedMachinesByServerId: ReadonlyMap<string, readonly MachineNameSource[]> }> {
    const homes = new Set<string | null>();
    const listed = new Map<string, MachineNameSource[]>();
    for (const candidate of candidates) {
        const serverId = candidate.address?.serverId ?? candidate.serverId ?? candidate.session.serverId ?? null;
        homes.add(serverId);
        const machineId = readSessionListIdentityFacts(candidate.session, candidate.presentationSource).machineId;
        const machine = serverId && machineId ? machineDisplaysByServerId?.[serverId]?.[machineId] : undefined;
        if (!serverId || !machine) continue;
        const machines = listed.get(serverId) ?? [];
        if (!machines.includes(machine)) machines.push(machine);
        listed.set(serverId, machines);
    }
    return { showHome: homes.size > 1, listedMachinesByServerId: listed };
}

function buildDesktopActivityOverlaySessionSnapshots(
    sessionViewModels: readonly ActivitySurfaceSessionViewModel[],
    candidates: readonly SessionActivityAttention[],
    requests: readonly DesktopActivityOverlayRequestSnapshot[],
    machineDisplaysByServerId: DesktopActivityOverlayMachineDisplays | undefined,
    where: ReturnType<typeof resolveDesktopActivityOverlayListWhere>,
): readonly DesktopActivityOverlaySessionSnapshot[] {
    // A request snapshot exists only where the privacy gates let the ask itself show, so that one
    // decision also admits saying where it comes from.
    const askingKeys = new Set(requests.flatMap(request => request.serverId
        ? [sessionAddressKey({ serverId: request.serverId, sessionId: request.sessionId })] : []));
    const candidateByAddress = new Map<string, SessionActivityAttention>();
    for (const candidate of candidates) {
        if (candidate.address) {
            candidateByAddress.set(sessionAddressKey(candidate.address), candidate);
        }
    }

    const resolveLegacyCandidate = (sessionId: string): SessionActivityAttention | undefined => {
        const matches = candidates.filter((candidate) => candidate.sessionId === sessionId);
        return matches.length === 1 ? matches[0] : undefined;
    };

    return sessionViewModels.map((viewModel) => {
        const candidate = viewModel.serverId
            ? candidateByAddress.get(sessionAddressKey({
                serverId: viewModel.serverId,
                sessionId: viewModel.sessionId,
            }))
            : resolveLegacyCandidate(viewModel.sessionId);
        const identity = candidate ? readSessionListIdentityFacts(candidate.session, candidate.presentationSource) : null;
        const askerContext = candidate && viewModel.serverId
            && askingKeys.has(sessionAddressKey({ serverId: viewModel.serverId, sessionId: viewModel.sessionId }))
            ? resolveAskerContextLine(candidate, identity?.machineId, machineDisplaysByServerId?.[viewModel.serverId],
                where.listedMachinesByServerId.get(viewModel.serverId) ?? [], where.showHome)
            : null;
        return {
            sessionId: viewModel.sessionId,
            serverId: viewModel.serverId,
            title: viewModel.title,
            subtitle: askerContext ?? viewModel.contextLine ?? viewModel.subtitle ?? null,
            statusText: viewModel.statusText ?? null,
            previewText: viewModel.previewText ?? null,
            attentionState: viewModel.attentionState,
            active: (candidate?.presentationSource?.lifecycle.active ?? candidate?.session.active) === true,
            updatedAt: viewModel.updatedAt,
            tone: candidate?.workStatus.tone ?? 'neutral',
            ...identity,
            botFace: candidate ? readSessionBotFaceFacts(candidate.presentationSource
                ? readSessionListPresentationDisplay(candidate.presentationSource) : candidate.session, viewModel.serverId ?? null) : null,
        };
    });
}

export function buildDesktopActivityOverlaySnapshot(params: Readonly<{
    source: DesktopActivityOverlaySource;
    sourceOverview?: ActivityOverviewSnapshot;
    activityPolicy: ActivitySurfacePolicy;
    desktopPolicy: DesktopOverlayPolicy;
    previousPrimaryAddress?: SessionAddress | null;
    previousPrimaryChangedAtMs?: number | null;
    nowMs?: number;
    resolveCandidatePrivacyMode?: ActivitySurfaceCandidatePrivacyModeResolver;
    bots?: NotchBotFaces;
    conversation?: PinnedDesktopOverlayConversation | null;
    pinnedCandidate?: SessionActivityAttention;
    machineDisplaysByServerId?: DesktopActivityOverlayMachineDisplays;
}>): DesktopActivityOverlaySnapshot {
    const nowMs = params.nowMs ?? Date.now();
    const overview = params.sourceOverview ?? buildDesktopActivityOverlayOverviewFromSource({
        source: params.source,
        nowMs,
    });
    const selectionSpec = resolveDesktopOverlaySelectionSpec(params.desktopPolicy);
    const desktopTiming = overview.candidates[0]?.surfaceTiming?.desktopOverlay;
    const slots = resolveActivitySurfaceSlots({
        overview,
        selection: {
            ...selectionSpec,
            dwellMs: desktopTiming?.dwellMs ?? selectionSpec.dwellMs,
            staleAfterMs: desktopTiming?.staleAfterMs ?? selectionSpec.staleAfterMs,
        },
        previousPrimaryAddress: params.previousPrimaryAddress ?? null,
        previousPrimaryChangedAtMs: params.previousPrimaryChangedAtMs ?? null,
        nowMs,
    });
    const pinnedCandidate = params.conversation ? params.pinnedCandidate : undefined;
    // The pinned header reads this same row projection even outside the overview slots.
    const presentedCandidates = pinnedCandidate && !slots.selectedSessions.includes(pinnedCandidate)
        ? [...slots.selectedSessions, pinnedCandidate] : slots.selectedSessions;
    const where = resolveDesktopActivityOverlayListWhere(presentedCandidates, params.machineDisplaysByServerId);
    const selectedSessions = buildActivitySurfaceViewModels({
        candidates: presentedCandidates,
        showHome: where.showHome,
        policy: params.activityPolicy,
        showMachinePath: true,
        // Expanded detail uses the admitted privacy policy, never the retired collapsed-preview preference.
        showPreviewText: true,
        nowMs,
        resolveCandidatePrivacyMode: params.resolveCandidatePrivacyMode,
    });
    const requestSnapshots = buildDesktopActivityOverlayRequestSnapshots({
        candidates: presentedCandidates,
        audienceScopes: params.source.audienceScopes,
        resolveCandidatePrivacyMode: params.resolveCandidatePrivacyMode,
    });
    const desktopSessions = buildDesktopActivityOverlaySessionSnapshots(
        selectedSessions,
        presentedCandidates,
        [...requestSnapshots.permissionRequests, ...requestSnapshots.userQuestions],
        params.machineDisplaysByServerId,
        where,
    );
    const quotaSummaries = buildDesktopActivityOverlayQuotaSummarySnapshots(params.source.quotaSummaries);
    const completionStates = buildDesktopActivityOverlayCompletionSnapshots({
        candidates: slots.selectedSessions,
        sessionViewModels: selectedSessions,
        nowMs,
    });
    const state = slots.selectedSessions.length > 0 ? 'content' : 'idle';

    return {
        version: 1,
        generatedAt: nowMs,
        state,
        counts: overview.counts,
        summaryCounts: buildActivitySurfaceCountsViewModel(overview.counts),
        primary: desktopSessions[0] ?? null,
        sessions: desktopSessions,
        bots: params.bots ?? { faces: [], overflowCount: 0 },
        conversation: params.conversation ?? null,
        permissionRequests: requestSnapshots.permissionRequests,
        userQuestions: requestSnapshots.userQuestions,
        quotaSummaries,
        completionStates,
        defaultTarget: resolvePrimaryActivitySurfaceTarget(
            params.activityPolicy,
            desktopSessions[0]?.sessionId ?? null,
            desktopSessions[0]?.serverId ?? null,
        ),
        labels: buildDesktopActivityOverlaySnapshotLabels(),
    };
}
