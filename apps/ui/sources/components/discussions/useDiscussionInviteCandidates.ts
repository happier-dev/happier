import { useSessionRecordingVisibility } from '@/hooks/session/useSessionListRecordingPrivacy';
import * as React from 'react';
import type { DiscussionParticipantRoster } from './useDiscussionParticipantManagement';
import type { ExecutableParticipantPickerOption } from '@/components/sessions/authoring/executableParticipantPicker';
import { useSessionAccessDirectory } from '@/components/sessions/access/useSessionAccessDirectory';
import type { SessionAccessCandidateRowModel, SessionAccessGrantOperationModel } from '@/components/sessions/access/sessionAccessEditorTypes';
import type { SessionCollaborationAvailability } from '@/hooks/session/useSessionCollaborationAvailability';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import type { TeamAddress } from '@/sync/domains/teams/teamAddress';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { useSessionListQuerySourceState } from '@/sync/domains/session/listing/useSessionListQuerySourceState';
import type { SessionListQueryHomeState } from '@/sync/domains/session/listing/sessionListQueryController';
import { resolveSessionListQueryPresentation } from '@/sync/domains/session/listing/sessionListIndexPresentation';
import { useSettlingHomeServerId } from '@/components/navigation/connectionStatus/HomeReachabilityGate';
import { readableSessionDisplayTitle, useSessionDisplayTitles } from '@/utils/sessions/sessionDisplayTitle';
import { useSessionListRowsByServerId, useSessionDisplayNameProjections, type SessionDisplayNameSource } from '@/sync/domains/state/storage';
import { getSessionWorkContext, getSessionWorkContextParts } from '@/utils/sessions/sessionUtils';
import { resolveSessionListRenderableMeaningfulActivityAt } from '@/sync/domains/session/listing/sessionListRenderableSorting';
import { readSessionListRowsForServerId } from '@/sync/domains/session/listing/sessionListRowStateLookup';
import { buildDiscussionInviteCandidates, type DiscussionInviteCandidate } from './discussionInviteCandidates';
import { useSessionReadiness } from '@/components/sessions/model/useSessionReadiness';

const NO_OPERATIONS: Readonly<Record<string, SessionAccessGrantOperationModel>> = Object.freeze({});
const NO_TEAMS = Object.freeze([]);
const ACCOUNT_ONLY = Object.freeze(['account'] as const);
const NO_MODELS: readonly ExecutableParticipantPickerOption[] = Object.freeze([]);
const sessionContextLabel = (source: SessionDisplayNameSource | null) => source ? getSessionWorkContext(source, source.serverId) : null;
const sessionAgentId = (source: SessionDisplayNameSource | null) => source ? getSessionWorkContextParts(source, source.serverId).agentId : null;
const sessionMachineId = (source: SessionDisplayNameSource | null) => source ? getSessionWorkContextParts(source, source.serverId).machineId : null;
const sessionTitleReadable = (source: SessionDisplayNameSource | null) => readableSessionDisplayTitle(source) !== null;

/**
 * What the Session listing is doing, read through the one presentation owner of the query's Home state
 * (`resolveSessionListQueryPresentation`, the Sessions pane's own): nothing while the picker is closed or
 * its Account retired, `loading` until a first page lands or the Home settles, `failed` when it could
 * not be read, then `ready`. A continuation exists only while the owner holds a cursor, and a read that
 * failed after rows were applied keeps them (`pageFailed`); recovery belongs to the query source.
 */
function readSessionChoices(input: Readonly<{
    enabled: boolean;
    serverId: string;
    state: SessionListQueryHomeState | null;
    coverageComplete: boolean;
    rowCount: number;
    settlingHomeServerId: string | null;
}>) {
    if (!input.enabled) return { status: 'idle' as const, hasMore: false, loadingMore: false, pageFailed: false };
    const { state } = input;
    const presentation = resolveSessionListQueryPresentation({ selectedServerIds: [input.serverId],
        statesByServerId: { [input.serverId]: state ?? undefined }, coverageComplete: input.coverageComplete,
        retainedRowCount: input.rowCount, settlingHomeServerId: input.settlingHomeServerId });
    const applied = state !== null && state.appliedQueryKey !== null;
    const hasMore = applied && ((state.hasNext && state.nextCursor !== null) || (state.attentionHasNext && state.attentionNextCursor !== null));
    if (presentation.kind === 'initial_loading') {
        return { status: 'loading' as const, hasMore: false, loadingMore: false, pageFailed: false };
    }
    const unavailable = presentation.kind === 'error' || presentation.kind === 'partial';
    if (unavailable && input.rowCount === 0) {
        return { status: 'failed' as const, hasMore: false, loadingMore: false, pageFailed: false };
    }
    return { status: 'ready' as const, hasMore, loadingMore: applied && state.phase === 'loading',
        pageFailed: unavailable };
}

/**
 * Mount only while Invite/New participant selection is demanded. Home people search and optional
 * Team roster reuse the shared collaboration directory; existing Sessions/Bots use the ordinary
 * exact-Home listing owner. Models arrive from U4's ordinary authoring picker after user setup,
 * never a separate model inventory. This hook performs reads only, not invitation or setup.
 * Build that optional model choice with buildExecutableModelParticipantSelectionFromAuthoringDraft
 * and buildExecutableParticipantPickerOption, preserving the ordinary selected setup/readiness.
 * People resolve(query, signal) and both loadMore/retry pairs keep their source owner's pagination;
 * `sessions.complete` is required before treating the loaded Session choices as the whole roster, and
 * `sessions.status`/`hasMore`/`pageFailed` say whether the listing is still loading, failed, or has more.
 */
export function useDiscussionInviteCandidates(input: Readonly<{
    accountLifetime: ServerAccountScopeLifetime;
    availability: SessionCollaborationAvailability;
    enabled: boolean;
    roster?: DiscussionParticipantRoster | null;
    teamAddress?: TeamAddress;
    modelOptions?: readonly ExecutableParticipantPickerOption[];
    /** Only the opened/highlighted detail demands readiness, never every roster candidate. */
    readinessSessionId?: string | null;
}>) {
    const { accountLifetime, availability } = input;
    const { scope } = accountLifetime;
    const subscribe = React.useCallback((notify: () => void) => {
        const registration = accountLifetime.onRetire(notify);
        return () => registration.dispose();
    }, [accountLifetime]);
    const current = React.useSyncExternalStore(subscribe, accountLifetime.isCurrent, accountLifetime.isCurrent);
    const enabled = input.enabled && current && availability === 'available';
    const readinessSessionId = input.readinessSessionId ?? '';
    const readiness = useSessionReadiness({ accountLifetime, sessionId: readinessSessionId,
        enabled: enabled && Boolean(readinessSessionId) });
    const teamMatches = !input.teamAddress || areServerProfileIdentifiersEquivalent(input.teamAddress.serverId, scope.serverId);
    const directory = useSessionAccessDirectory({ scope, availability, enabled: enabled && teamMatches,
        contextTeams: NO_TEAMS, operations: NO_OPERATIONS, revision: 0,
        principalKinds: ACCOUNT_ONLY, ...(input.teamAddress ? { teamAddress: input.teamAddress } : {}) });
    const homes = React.useMemo(() => enabled ? [{ serverId: scope.serverId, queryMembership: 'rowOnly' as const,
        query: { v: 1 as const, storage: 'active' as const, includeInactive: true, scope: 'all_accessible' as const,
            attention: 'any' as const, audiences: [], tagIds: [] } }] : [], [enabled, scope.serverId]);
    const source = useSessionListQuerySourceState({ enabled, homes });
    const homeIds = React.useMemo(() => enabled ? [scope.serverId] : [], [enabled, scope.serverId]);
    const rowsByHome = useSessionListRowsByServerId(homeIds);
    const isSessionVisible = useSessionRecordingVisibility(enabled);
    const rows = readSessionListRowsForServerId(rowsByHome, scope.serverId);
    const addresses = React.useMemo(() => (source.byServerId[scope.serverId] ?? []).flatMap(item =>
        item.type === 'session' && isSessionVisible({ serverId: scope.serverId, sessionId: item.sessionId })
            ? [{ serverId: scope.serverId, sessionId: item.sessionId }] : []), [isSessionVisible, scope.serverId, source.byServerId]);
    const labels = useSessionDisplayTitles(addresses);
    const titleReadability = useSessionDisplayNameProjections(addresses, sessionTitleReadable);
    const contexts = useSessionDisplayNameProjections(addresses, sessionContextLabel);
    const agentIds = useSessionDisplayNameProjections(addresses, sessionAgentId);
    const machineIds = useSessionDisplayNameProjections(addresses, sessionMachineId);
    const sessions = React.useMemo(() => addresses.map((address, index) => {
        const row = rows?.[address.sessionId];
        return { address, label: labels[index] ?? null, titleReadable: titleReadability[index] === true,
            bot: row?.metadata?.bot?.kind === 'bot',
            contextLabel: contexts[index] ?? null, agentId: agentIds[index] ?? null, machineId: machineIds[index] ?? null,
            lastActivityAt: row ? resolveSessionListRenderableMeaningfulActivityAt(row) : null,
            access: row?.access ?? null,
            readiness: address.sessionId === readinessSessionId ? readiness.readiness : null,
            repair: address.sessionId === readinessSessionId ? readiness.repair : null };
    }), [addresses, agentIds, contexts, labels, machineIds, titleReadability, readiness.readiness, readiness.repair, readinessSessionId, rows]);
    const modelOptions = input.modelOptions ?? NO_MODELS;
    const previousCandidates = React.useRef<Readonly<{
        accountLifetime: ServerAccountScopeLifetime;
        candidates: readonly DiscussionInviteCandidate[];
    }> | null>(null);
    const project = React.useCallback((people: readonly SessionAccessCandidateRowModel[], previous?: readonly DiscussionInviteCandidate[]) => accountLifetime.isCurrent()
        ? buildDiscussionInviteCandidates({ scope, people, sessions, modelOptions, roster: input.roster }, previous) : [],
    [accountLifetime, input.roster, modelOptions, scope, sessions]);
    const peopleSource = directory.sections.find(section => section.kind === 'account');
    const resolvePeople = React.useCallback(async (query: string, signal: AbortSignal) => {
        if (!enabled || !teamMatches || !accountLifetime.isCurrent() || signal.aborted || !peopleSource?.resolveCandidates) return [];
        const controller = new AbortController();
        const abort = () => controller.abort();
        signal.addEventListener('abort', abort, { once: true });
        const retirement = accountLifetime.onRetire(abort);
        try {
            const rows = await peopleSource.resolveCandidates(query, controller.signal);
            return controller.signal.aborted || !accountLifetime.isCurrent() ? [] : project(rows).filter(candidate => candidate.kind === 'account');
        } catch (error) {
            if (controller.signal.aborted || !accountLifetime.isCurrent()) return [];
            throw error;
        } finally {
            retirement.dispose();
            signal.removeEventListener('abort', abort);
        }
    }, [accountLifetime, enabled, peopleSource, project, teamMatches]);
    const candidates = React.useMemo(() => enabled ? project(peopleSource?.candidates ?? [],
        previousCandidates.current?.accountLifetime === accountLifetime ? previousCandidates.current.candidates : undefined) : [],
    [accountLifetime, enabled, peopleSource?.candidates, project]);
    React.useLayoutEffect(() => { previousCandidates.current = { accountLifetime, candidates }; }, [accountLifetime, candidates]);
    const sessionState = source.statesByServerId[scope.serverId] ?? null;
    const settlingHomeServerId = useSettlingHomeServerId();
    const choices = React.useMemo(() => readSessionChoices({ enabled, serverId: scope.serverId, state: sessionState,
        coverageComplete: source.coverageComplete, rowCount: addresses.length, settlingHomeServerId }),
    [addresses.length, enabled, scope.serverId, sessionState, settlingHomeServerId, source.coverageComplete]);
    return React.useMemo(() => ({ candidates,
        people: { status: peopleSource?.status ?? 'idle', error: peopleSource?.error, hasMore: enabled && (peopleSource?.hasMore ?? false),
            loadingMore: peopleSource?.loadingMore ?? false, resolverKey: peopleSource?.resolverKey,
            resolve: resolvePeople, loadMore: () => { if (enabled && accountLifetime.isCurrent()) directory.loadMore('account'); },
            retry: () => { if (enabled && accountLifetime.isCurrent()) directory.retry('account'); } },
        sessions: { state: sessionState, complete: enabled && source.coverageComplete, ...choices,
            loadMore: async () => { if (enabled && accountLifetime.isCurrent()) await source.loadNext(); },
            retry: async () => {
                if (!enabled || !accountLifetime.isCurrent()) return;
                await source.retry();
            } },
    }), [accountLifetime, candidates, choices, directory, enabled, peopleSource, resolvePeople, scope.serverId, sessionState, source]);
}

export type DiscussionInviteCandidateSource = ReturnType<typeof useDiscussionInviteCandidates>;
