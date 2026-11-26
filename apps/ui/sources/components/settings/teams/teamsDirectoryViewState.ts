import { resolveHomeDisplayLabel } from '@/components/settings/server/homeDisplayName';
import { getServerProfileById } from '@/sync/domains/server/serverProfiles';
import { isTeamLegacyCredentialRefusalV1, type TeamSummaryV1 } from '@happier-dev/protocol/teams';

import type { TeamsHomeAdmissionEntry } from '@/sync/domains/teams/teamsSettingsAdmission';
import { teamAddressKey, type TeamAddress } from '@/sync/domains/teams/teamAddress';
import type { TeamsDirectorySnapshot } from '@/sync/store/teams/teamsSnapshots';
import type { ScopedSnapshotError } from '@/sync/domains/scope/scopedSnapshotFacts';
import { isActionTurnedOffErrorCode } from '@happier-dev/protocol/actions/actionExecutionResult';
import { t } from '@/text';
import { presentTeamSignInOutdated } from '@/components/teams/entry/teamSignInRequirement';
import type { SurfaceStateKind } from '@/components/ui/surfaces/SurfaceStateCard';

/**
 * What the Teams directory should render for the exact Home set right now.
 *
 * The controlling rule is truthfulness across a partial multi-Home view: a Home
 * that answered keeps its rows on screen through every refresh and failure, and
 * a Home that did not answer is named rather than silently omitted. Claiming
 * "no Teams" while one Home is unreachable would be a false statement about
 * that Home, so emptiness requires every admitted Home to have actually said so.
 */

export type TeamsDirectoryRow = Readonly<{
    /** Navigation and cache identity. A Team ID alone is not addressable. */
    address: TeamAddress;
    team: TeamSummaryV1;
    homeName: string;
}>;

/** Why an admitted Home contributes nothing to the list right now. */
export type TeamsDirectoryUnavailableHome = Readonly<{
    serverId: string;
    homeName: string;
    reason: 'loading' | 'offline' | 'error' | 'denied' | 'sign_in_outdated' | 'unsupported' | 'disabled'
        | 'turned_off' | 'credential_unreadable' | 'invalid_request' | 'cursor_expired' | 'authentication_unavailable';
    retryable: boolean;
}>;

export type TeamsDirectoryViewState = Readonly<{
    /** `loading` only while nothing at all has been observed. */
    kind: 'loading' | 'empty' | 'ready';
    rows: readonly TeamsDirectoryRow[];
    archivedRows: readonly TeamsDirectoryRow[];
    /** Admitted Homes with nothing to show, each with its own honest reason. */
    unavailableHomes: readonly TeamsDirectoryUnavailableHome[];
    /** The list is known to be missing at least one admitted Home's Teams. */
    partial: boolean;
    /**
     * At least one admitted Home has Teams on screen (or said it has none). Until then a failure is
     * the whole page's state, not a gap beside "other Homes", and nothing offers the archive.
     */
    answered: boolean;
    /** At least one shown Home is known to be behind its Home. */
    stale: boolean;
    /** Whether rows should be labelled with their Home. */
    multiHome: boolean;
}>;

export type TeamsDirectoryViewStateInput = Readonly<{
    homes: readonly TeamsHomeAdmissionEntry[];
    homeNamesByServerId: Readonly<Record<string, string | undefined>>;
    snapshotsByServerId: Readonly<Record<string, TeamsDirectorySnapshot | readonly (TeamsDirectorySnapshot | undefined)[] | undefined>>;
}>;

const EMPTY_ROWS: readonly TeamsDirectoryRow[] = Object.freeze([]);
const EMPTY_UNAVAILABLE: readonly TeamsDirectoryUnavailableHome[] = Object.freeze([]);

/**
 * Turns a snapshot failure into the reason a person can act on. `denied` and
 * `unsupported` are the Home's settled answers and are not offered a retry that
 * would ask the same question again.
 */
export function teamsUnavailableReason(
    error: ScopedSnapshotError | null | undefined,
): Readonly<{ reason: TeamsDirectoryUnavailableHome['reason']; retryable: boolean }> {
    if (!error) return { reason: 'loading', retryable: false };
    // The person turned the read off in Settings, Actions: the Home was never asked.
    if (isActionTurnedOffErrorCode(error.code)) return { reason: 'turned_off', retryable: false };
    // Teams refuse a released 0.2 sign-in; signing in again, not a role, is the way forward.
    if (isTeamLegacyCredentialRefusalV1(error.code, error.details)) return { reason: 'sign_in_outdated', retryable: false };
    if (error.code === 'teams_unavailable') return { reason: 'disabled', retryable: false };
    if (error.code === 'invalid_team_input') return { reason: 'invalid_request', retryable: false };
    if (error.code === 'invalid_team_cursor') return { reason: 'cursor_expired', retryable: false };
    if (error.code === 'team_authentication_unavailable') return { reason: 'authentication_unavailable', retryable: false };
    if (error.kind === 'forbidden' || error.kind === 'unauthorized') {
        return { reason: 'denied', retryable: false };
    }
    if (error.kind === 'unsupported') return { reason: 'unsupported', retryable: false };
    return { reason: error.kind === 'unreachable' ? 'offline' : 'error', retryable: error.retryable };
}

export function teamsUnavailableHomeReason(home: Pick<TeamsDirectoryUnavailableHome, 'reason'>): string {
    switch (home.reason) {
        case 'loading': return t('teams.directory.loading');
        case 'denied': return t('errors.permissionDenied');
        case 'sign_in_outdated': return t('teams.errors.signInOutdated');
        case 'unsupported': return t('teams.unavailable.updateRequired');
        case 'disabled': return t('teams.unavailable.disabled');
        case 'turned_off': return t('actionConfirmations.turnedOffReadMessage');
        case 'offline': return t('teams.unavailable.offline');
        case 'error': return t('teams.errors.loadFailed');
        case 'credential_unreadable': return t('homeGovernance.credentialUnreadableTitle');
        case 'invalid_request': return t('homeGovernance.invalidRead');
        case 'cursor_expired': return t('teams.errors.listCursorExpired');
        case 'authentication_unavailable': return t('teams.credentials.externalApi.authenticationUnavailable');
    }
}

/**
 * A Home's failure as the Teams directory says it: a read that simply failed names the Teams, in the
 * same words Share uses for the same read; every other reason is the Home's own.
 */
export function teamsDirectoryHomeReason(home: Pick<TeamsDirectoryUnavailableHome, 'reason'>): string {
    return home.reason === 'error' ? t('teams.errors.teamsLoadFailed') : teamsUnavailableHomeReason(home);
}

/**
 * The way forward for a Home whose answer no retry can change: the setting itself for a read turned off in
 * Settings, Actions; signing in again (the Home's own sign-out in Account settings) for a released 0.2 sign-in.
 */
export function teamsUnavailableHomeSettingsAction(
    home: Pick<TeamsDirectoryUnavailableHome, 'reason' | 'serverId'>,
    open: (href: string) => void,
): Readonly<{ label: string; onPress: () => void }> | undefined {
    if (home.reason === 'sign_in_outdated') return presentTeamSignInOutdated({ code: 'team_forbidden', navigate: open }).action;
    return home.reason === 'turned_off'
        ? { label: t('actionConfirmations.openActionSettings'), onPress: () => open('/settings/actions') }
        : undefined;
}

export function teamsDirectoryHomeAction(
    home: TeamsDirectoryUnavailableHome,
    refresh: () => void,
    navigate: (href: string) => void,
    testIDs: Readonly<{ retry: string; reload: string }>,
) {
    if (home.reason === 'cursor_expired') {
        return { label: t('common.refresh'), onPress: refresh, testID: testIDs.reload };
    }
    if (home.retryable) {
        return { label: t('common.retry'), onPress: refresh, testID: testIDs.retry };
    }
    return teamsUnavailableHomeSettingsAction(home, navigate);
}

/** The directory page and its rail present the same settled Home failure. */
export function teamsUnavailableHomeStateKind(home: Pick<TeamsDirectoryUnavailableHome, 'reason'>): SurfaceStateKind {
    switch (home.reason) {
        case 'loading': return 'loading';
        case 'denied': return 'denied';
        case 'offline': return 'unavailable';
        case 'unsupported':
        case 'disabled':
        case 'authentication_unavailable':
        case 'sign_in_outdated':
        case 'turned_off': return 'unavailable';
        default: return 'error';
    }
}

export function resolveTeamsDirectoryViewState(
    input: TeamsDirectoryViewStateInput,
    previous?: TeamsDirectoryViewState | null,
): TeamsDirectoryViewState {
    const rows: TeamsDirectoryRow[] = [];
    const archivedRows: TeamsDirectoryRow[] = [];
    const unavailableHomes: TeamsDirectoryUnavailableHome[] = [];
    const previousRows = new Map([...previous?.rows ?? [], ...previous?.archivedRows ?? []]
        .map((row) => [teamAddressKey(row.address), row]));

    let admittedHomes = 0;
    let answeredHomes = 0;
    let stale = false;

    for (const home of input.homes) {
        const homeName = (input.homeNamesByServerId[home.serverId] ?? '').trim() || resolveHomeDisplayLabel(getServerProfileById(home.serverId), home.serverId);

        if (home.state === 'disabled') {
            // A settled "no" from the feature decision. The destination itself
            // is admitted by another Home, so this one is simply not listed and
            // any snapshot left from before the change is not resurrected.
            continue;
        }

        admittedHomes += 1;

        if (home.state === 'unsupported') {
            unavailableHomes.push(Object.freeze({
                serverId: home.serverId,
                homeName,
                reason: 'unsupported' as const,
                retryable: false,
            }));
            continue;
        }

        if (home.state === 'unresolved') {
            unavailableHomes.push(Object.freeze({
                serverId: home.serverId,
                homeName,
                reason: home.reason === 'loading'
                    ? 'loading' as const
                    : home.reason === 'unreachable' ? 'offline' as const : home.reason,
                retryable: home.reason !== 'loading',
            }));
            continue;
        }

        const source = input.snapshotsByServerId[home.serverId];
        const snapshots = source === undefined || 'scope' in source ? [source] : source;
        const missing = snapshots.filter((snapshot) => !snapshot?.data);
        // A retained page already has a stale state for a transport failure.
        // An exact refusal still needs words and, if possible, its own recovery.
        const failed = snapshots.find((snapshot) => snapshot?.error
            && (!snapshot.data || snapshot.error.kind !== 'unreachable' && snapshot.error.code != null));
        if (failed || missing.length > 0) {
            // One Home can have answered the active sequence while its archived
            // sequence is still loading or failed. Keep its rows and name the gap.
            const { reason, retryable } = teamsUnavailableReason(failed?.error);
            unavailableHomes.push(Object.freeze({ serverId: home.serverId, homeName, reason, retryable }));
        }

        // The Home has content on screen. It counts as answered even while a
        // refresh is failing, because blanking it would lose real information.
        if (snapshots.some((snapshot) => snapshot?.data)) answeredHomes += 1;
        for (const snapshot of snapshots) {
            if (!snapshot?.data) continue;
            const teams = snapshot.data;
            if (snapshot.stale || snapshot.error !== null) stale = true;
            for (const team of teams) {
                const address = { serverId: home.serverId, teamId: team.id };
                const retained = previousRows.get(teamAddressKey(address));
                const row: TeamsDirectoryRow = retained?.team === team && retained.homeName === homeName
                    ? retained : Object.freeze({
                    address: Object.freeze({ serverId: home.serverId, teamId: team.id }),
                    team,
                    homeName,
                });
                if (team.archivedAt === null) rows.push(row);
                else archivedRows.push(row);
            }
        }
    }

    const partial = unavailableHomes.length > 0 || stale;
    const kind: TeamsDirectoryViewState['kind'] = answeredHomes === 0 && unavailableHomes.every((home) => home.reason === 'loading')
        ? 'loading'
        : rows.length === 0 && archivedRows.length === 0 && answeredHomes === admittedHomes && unavailableHomes.length === 0
            ? 'empty'
            : 'ready';

    const retainRows = (next: readonly TeamsDirectoryRow[], baseline: readonly TeamsDirectoryRow[] | undefined) => (
        baseline && next.length === baseline.length && next.every((row, i) => row === baseline[i])
            ? baseline : next.length > 0 ? Object.freeze(next) : EMPTY_ROWS
    );

    return Object.freeze({
        kind,
        rows: retainRows(rows, previous?.rows),
        archivedRows: retainRows(archivedRows, previous?.archivedRows),
        unavailableHomes: unavailableHomes.length > 0 ? Object.freeze(unavailableHomes) : EMPTY_UNAVAILABLE,
        partial,
        answered: answeredHomes > 0,
        stale,
        multiHome: admittedHomes > 1,
    });
}
