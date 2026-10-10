import type {
    SessionAwarenessProjectionV1,
    SessionEffectiveAccessV1,
    SessionViewerProjectionV1,
} from '@happier-dev/protocol';
import { isSessionAwarenessContentReadableV1 } from '@happier-dev/protocol/sessions/awareness/availability';
import { teamDirectoryQueryKeyV1 } from '@happier-dev/protocol/teams';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { getTeamSnapshot, getTeamsDirectorySnapshot, readTeamGroup } from '@/sync/store/teams/teamsSnapshots';
import { resolveSessionAwarenessContentLabel } from '@/sync/domains/session/awareness/sessionAwarenessContentLabels';
import type { ServerProfile } from '@/sync/domains/server/serverProfiles';
import type { SessionAddress } from '@/sync/domains/session/sessionAddress';
import type { SessionListHomeObservation } from '@/sync/domains/session/listing/sessionListHomeObservation';
import { formatSessionPath } from '@/utils/sessions/formatPathRelativeToHome';
import { formatShortRelativeTimeAt } from '@/utils/time/formatShortRelativeTime';
import { t } from '@/text';

export type SessionAudiencePresentation = Readonly<{
    kind: 'direct' | 'team' | 'group';
    label: string;
}>;

/**
 * The single marker explaining why this Session is the viewer's, chosen from the canonical
 * relevance vocabulary in declaration order: responsibility, then Follow, then a direct share.
 */
export type SessionResponsibilityPresentation = Readonly<{
    kind: 'assigned' | 'following' | 'shared_directly';
    label: string;
}>;

export type SessionWorkspacePresentation = Readonly<{
    label: string;
}>;

/**
 * How current this Home's Session list is, projected from the one raw observation the list owner
 * publishes. `unknown` is the honest answer when no observation was supplied — it is neither a
 * promise of currentness nor a warning this projector invented.
 */
export type SessionHomeFreshnessPresentation = Readonly<{
    state: 'current' | 'stale' | 'offline' | 'unknown';
    /** Time of the Home's last successful list observation; `null` until one landed. */
    lastSuccessAt: number | null;
    /** Copy for the muted context line; `null` when a reachable Home needs no words. */
    label: string | null;
    /**
     * "Last updated 18m ago", when the caller supplied a render clock and this Home actually
     * succeeded once. `null` for a current Home, an unobserved Home, or a caller with no clock.
     */
    lastUpdatedLabel: string | null;
}>;

export type SessionContextFacts = Readonly<{
    address: SessionAddress;
    home: Readonly<{
        name: string;
        serverUrl: string | null;
    }> | null;
    /** The access owner's safe identity, labeled by the exact viewer's directory. */
    audience: SessionAudiencePresentation | null;
    responsibility: SessionResponsibilityPresentation | null;
    /** `null` when no awareness projection was supplied, so readability stays unknown. */
    contentAvailability: SessionAwarenessProjectionV1['encryption'] | null;
    workspace: SessionWorkspacePresentation | null;
    freshness: SessionHomeFreshnessPresentation;
}>;

export type SessionContextSegment = Readonly<{
    kind: 'home' | 'freshness' | 'audience' | 'responsibility' | 'content_availability' | 'workspace';
    label: string;
}>;

export type SessionContextPresentation = Readonly<{
    address: SessionAddress;
    segments: readonly SessionContextSegment[];
    contextLine: string | null;
    accessibilityContext: string | null;
    workspace: SessionWorkspacePresentation | null;
    mayShowDecryptedContent: boolean | null;
}>;

export function resolveSessionContextLine(
    presentation: Pick<SessionContextPresentation, 'segments'> | null | undefined,
    options: Readonly<{ showWorkspace: boolean }>,
): string | null {
    if (!presentation) return null;
    const labels = presentation.segments
        .filter((segment) => options.showWorkspace || segment.kind !== 'workspace')
        .map((segment) => normalizeLabel(segment.label))
        .filter((label): label is string => label !== null);
    return labels.length > 0 ? labels.join(' · ') : null;
}

function normalizeLabel(value: string | null | undefined): string | null {
    const label = typeof value === 'string' ? value.trim() : '';
    return label || null;
}

function resolveAudience(params: Readonly<{
    address: SessionAddress;
    audienceContext?: SessionEffectiveAccessV1['audienceContext'];
    audienceScope?: ServerAccountScope | null;
}>): SessionAudiencePresentation | null {
    const context = params.audienceContext;
    const scope = params.audienceScope;
    if (!context || !scope || scope.serverId !== params.address.serverId) return null;
    const address = { serverId: scope.serverId, teamId: context.teamId };
    if (context.kind === 'group') {
        const label = normalizeLabel(readTeamGroup(scope, address, context.groupId)?.name);
        return label ? { kind: 'group', label } : null;
    }
    let team = getTeamSnapshot(scope, address)?.data ?? null;
    for (const archived of ['active', 'archived'] as const) {
        if (team) break;
        const queryKey = teamDirectoryQueryKeyV1({ v: 1, scope: 'member', archived });
        team = getTeamsDirectorySnapshot(scope, queryKey)?.data?.find(row => row.id === context.teamId) ?? null;
    }
    const label = normalizeLabel(team?.name);
    return label ? { kind: 'team', label } : null;
}

/**
 * Whether this viewer may see content-derived context. `null` is the honest answer for a Session
 * whose envelope state was never observed: it is not readable, but it is also not evidence that
 * access is missing.
 */
function resolveMayShowDecryptedContent(
    encryption: SessionAwarenessProjectionV1['encryption'] | null,
): boolean | null {
    if (encryption === null || encryption === 'unknown') return null;
    return isSessionAwarenessContentReadableV1(encryption);
}

/**
 * Home currentness comes from the list owner's authoritative phase, never from elapsed time: a
 * reachable Home is current however long its last page has been valid, and only a Home that could
 * not be reached or refreshed earns a word. This is why there is no staleness timer here — adding
 * one would invent a boundary no owner established (Lane 07.4 §2).
 */
function resolveFreshness(
    observation: SessionListHomeObservation | null | undefined,
): Pick<SessionHomeFreshnessPresentation, 'state' | 'lastSuccessAt'> {
    if (!observation) return { state: 'unknown', lastSuccessAt: null };
    const lastSuccessAt = typeof observation.lastSuccessAt === 'number' && Number.isFinite(observation.lastSuccessAt)
        ? observation.lastSuccessAt
        : null;
    switch (observation.phase) {
        case 'offline': return { state: 'offline', lastSuccessAt };
        case 'error': return { state: 'stale', lastSuccessAt };
        default: return { state: lastSuccessAt === null ? 'unknown' : 'current', lastSuccessAt };
    }
}

function resolveFreshnessLabel(state: SessionHomeFreshnessPresentation['state']): string | null {
    switch (state) {
        case 'offline': return t('session.homeFreshness.offline');
        case 'stale': return t('session.homeFreshness.stale');
        case 'current':
        case 'unknown':
            return null;
    }
}

/**
 * At most one marker. Assignment already implies Follow, so a responsible viewer reads
 * "Assigned to you" and never both markers on the same row (Lane 07.4 §8); a Session someone
 * shared straight with this viewer says so only when no stronger reason already explains it.
 */
function resolveResponsibility(
    viewer: SessionViewerProjectionV1 | null | undefined,
): SessionResponsibilityPresentation | null {
    if (!viewer) return null;
    if (viewer.relevance.reasons.includes('responsible_for_me')) {
        return { kind: 'assigned', label: t('session.responsibilityAssignedToYou') };
    }
    if (viewer.follow.follows) {
        return { kind: 'following', label: t('session.follow.following') };
    }
    if (viewer.relevance.reasons.includes('shared_directly_with_me')) {
        return { kind: 'shared_directly', label: t('session.responsibilitySharedWithYou') };
    }
    return null;
}

/**
 * Builds only facts established by the exact server-qualified address, the canonical awareness
 * projection, and this viewer's own projection. Missing collaboration and crypto evidence stays
 * unknown instead of being reinterpreted as Personal or content-ready.
 *
 * Callers supply raw facts, never formatted context: the workspace label, responsibility wording,
 * and availability copy are resolved here so no surface can grow its own mapping.
 */
export function buildSessionContextFacts(params: Readonly<{
    address: SessionAddress;
    serverProfile?: ServerProfile | null;
    homeName?: string | null;
    /** The canonical projection, already privacy-filtered by its owner. */
    awareness?: SessionAwarenessProjectionV1 | null;
    viewer?: SessionViewerProjectionV1 | null;
    /** Safe server-selected identity; never derive it from sources or directory membership. */
    audienceContext?: SessionEffectiveAccessV1['audienceContext'];
    /** Credential-bound viewer identity for this exact Home. */
    audienceScope?: ServerAccountScope | null;
    /**
     * The workspace display title from the canonical Session workspace-display owner, for surfaces
     * that resolve one. That owner reads only metadata this device actually decrypted, so a locked
     * Session simply has no label — this projector adds no second readiness gate.
     */
    workspaceLabel?: string | null;
    /**
     * Raw Home directory for the incumbent home-relative path formatter. Secondary surfaces must
     * supply the same value Session rows use; omitting it would print an absolute path.
     */
    homeDir?: string | null;
    /**
     * The exact Home's raw list observation from the canonical per-Home list/currentness owner.
     * Secondary surfaces pass the same fact Session rows use so a retained offline Home reads
     * identically everywhere; omitting it leaves currentness `unknown` rather than assumed.
     */
    homeObservation?: SessionListHomeObservation | null;
    /**
     * The caller's existing render clock, used only to say how long ago the Home last succeeded.
     * The freshness state itself never depends on it.
     */
    nowMs?: number;
}>): SessionContextFacts {
    const homeName = normalizeLabel(params.homeName) ?? normalizeLabel(params.serverProfile?.name);
    const encryption = params.awareness?.encryption ?? null;
    // Both workspace inputs are already filtered by their canonical owners: Lane 09A omits
    // `awareness.workspace` unless the caller could open the Session's content, and the Session
    // workspace-display owner produces a label only from decrypted metadata. Re-gating them here
    // would withhold authorized structural context from an authorized locked row (L07-R42).
    const workspacePath = normalizeLabel(params.awareness?.workspace?.path);
    const workspaceLabel = normalizeLabel(params.workspaceLabel)
        ?? (workspacePath
            ? normalizeLabel(formatSessionPath(workspacePath, normalizeLabel(params.homeDir) ?? undefined))
            : null);
    const observed = resolveFreshness(params.homeObservation);
    const freshness: SessionHomeFreshnessPresentation = {
        ...observed,
        label: resolveFreshnessLabel(observed.state),
        lastUpdatedLabel: resolveSessionHomeLastUpdatedLabel(observed, params.nowMs),
    };
    return {
        address: params.address,
        home: homeName
            ? {
                name: homeName,
                serverUrl: normalizeLabel(params.serverProfile?.serverUrl),
            }
            : null,
        audience: resolveAudience(params),
        responsibility: resolveResponsibility(params.viewer),
        contentAvailability: encryption,
        workspace: workspaceLabel ? { label: workspaceLabel } : null,
        freshness: { ...freshness, label: resolveFreshnessLabel(freshness.state) },
    };
}

/**
 * "Last updated 18m ago", when the caller supplied a render clock and the Home actually succeeded
 * once. A Home that never succeeded has nothing to date, and a reachable Home needs no timestamp.
 */
export function resolveSessionHomeLastUpdatedLabel(
    freshness: Pick<SessionHomeFreshnessPresentation, 'state' | 'lastSuccessAt'>,
    nowMs: number | null | undefined,
): string | null {
    if (freshness.state === 'current' || freshness.state === 'unknown') return null;
    if (freshness.lastSuccessAt === null) return null;
    if (typeof nowMs !== 'number' || !Number.isFinite(nowMs)) return null;
    const ago = formatShortRelativeTimeAt(freshness.lastSuccessAt, nowMs);
    return ago ? t('session.homeFreshness.lastUpdated', { ago }) : null;
}

export function projectSessionContextPresentation(
    facts: SessionContextFacts,
): SessionContextPresentation {
    const segments: SessionContextSegment[] = [];
    const push = (kind: SessionContextSegment['kind'], label: string | null | undefined) => {
        const normalized = normalizeLabel(label);
        if (normalized) segments.push({ kind, label: normalized });
    };

    push('home', facts.home?.name);
    // Currentness sits with the Home it qualifies, before the audience and content facts it may
    // be out of date about. A reachable Home contributes nothing here (Lane 07.4 §8).
    push('freshness', facts.freshness.label);
    push('freshness', facts.freshness.lastUpdatedLabel);
    push('audience', facts.audience?.label);
    // Assignment and a direct share are the facts that earn words: neither is visible anywhere
    // else on the row. Follow is a glyph on the surfaces that own the control, and repeating it as
    // copy would say nothing a followed row — or a delivered notification — has not already
    // established (Lane 07.4 §8).
    if (facts.responsibility && facts.responsibility.kind !== 'following') {
        push('responsibility', facts.responsibility.label);
    }
    if (facts.contentAvailability) {
        push('content_availability', resolveSessionAwarenessContentLabel(facts.contentAvailability));
    }
    push('workspace', facts.workspace?.label);

    const contextLine = resolveSessionContextLine({ segments }, { showWorkspace: true });
    return {
        address: facts.address,
        segments,
        contextLine,
        accessibilityContext: contextLine,
        workspace: facts.workspace,
        mayShowDecryptedContent: resolveMayShowDecryptedContent(facts.contentAvailability),
    };
}
