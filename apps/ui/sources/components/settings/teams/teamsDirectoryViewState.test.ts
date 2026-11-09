import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { FeaturesResponseSchema } from '@happier-dev/protocol/features/payload/featuresResponseSchema';
import type { TeamSummaryV1 } from '@happier-dev/protocol/teams';

import type { TeamsDirectorySnapshot } from '@/sync/store/teams/teamsSnapshots';
import { resolveTeamsSettingsAdmission } from '@/sync/domains/teams/teamsSettingsAdmission';
import { renderScreen } from '@/dev/testkit';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';

import { resolveTeamsDirectoryViewState, teamsUnavailableHomeReason, teamsUnavailableHomeStateKind } from './teamsDirectoryViewState';

function team(id: string, name: string, overrides?: Partial<TeamSummaryV1>): TeamSummaryV1 {
    return {
        id,
        name,
        description: null,
        logo: null,
        archivedAt: null,
        recovery: null,
        policy: {
            v: 1,
            sessionCreationPolicy: 'private_default',
            externalSharingPolicy: 'allowed',
            defaultSessionHistoryAccess: 'from_membership',
            admissionMode: 'invite_only',
            authenticationPolicy: null,
        },
        viewerRole: 'member',
        capabilities: {
            viewTeam: true,
            viewRoster: true,
            manageSettings: false,
            managePolicy: false,
            manageMembers: false,
            manageGroups: false,
            manageInvitations: false,
            manageOwners: false,
            manageAuthentication: false,
            archiveTeam: false,
            restoreTeam: false,
            leave: false,
        },
        admission: { historyChoice: { admin: 'choice', member: 'choice', guest: 'hidden' } },
        counts: null,
        ...overrides,
    };
}

function snapshot(
    serverId: string,
    data: readonly TeamSummaryV1[] | null,
    overrides?: Partial<TeamsDirectorySnapshot>,
): TeamsDirectorySnapshot {
    return {
        scope: { serverId, accountId: `account-${serverId}` },
        queryKey: 'v1:member:active',
        status: 'ready',
        data,
        nextCursor: null,
        lastObservedAt: 10,
        stale: false,
        reachability: 'reachable',
        error: null,
        ...overrides,
    };
}

const HOME_NAMES: Readonly<Record<string, string>> = { alpha: 'Alpha', beta: 'Beta' };

describe('resolveTeamsDirectoryViewState', () => {
    it('rebuilds only changed row projections in a 400-Team directory', () => {
        const teams = Array.from({ length: 400 }, (_, i) => team(`team-${i}`, `Team ${i}`));
        const input = {
            homes: [{ serverId: 'alpha', state: 'capable' as const }],
            homeNamesByServerId: HOME_NAMES,
            snapshotsByServerId: { alpha: snapshot('alpha', teams) },
        };
        const initial = resolveTeamsDirectoryViewState(input);
        const changed = teams.map((row, i) => i === 200 ? { ...row, name: 'Renamed' } : row);
        const next = resolveTeamsDirectoryViewState({ ...input,
            snapshotsByServerId: { alpha: snapshot('alpha', changed) },
        }, initial);
        expect(next.rows.filter((row, i) => row !== initial.rows[i])).toHaveLength(1);
        expect(next.rows[200]?.team.name).toBe('Renamed');
        const refreshed = resolveTeamsDirectoryViewState({ ...input,
            snapshotsByServerId: { alpha: snapshot('alpha', changed, { lastObservedAt: 20 }) },
        }, next);
        expect(refreshed.rows).toBe(next.rows);
        const reordered = resolveTeamsDirectoryViewState({ ...input,
            snapshotsByServerId: { alpha: snapshot('alpha', [...changed].reverse()) },
        }, next);
        expect(reordered.rows[0]).toBe(next.rows[399]);
        const renamedHome = resolveTeamsDirectoryViewState({ ...input,
            homeNamesByServerId: { alpha: 'Renamed Home' },
            snapshotsByServerId: { alpha: snapshot('alpha', changed) },
        }, next);
        expect(renamedHome.rows.every((row) => row.homeName === 'Renamed Home')).toBe(true);
    });

    it('renders an offline Home with the shared unavailable glyph and working recovery', async () => {
        const state = resolveTeamsDirectoryViewState({
            homes: [{ serverId: 'alpha', state: 'capable' }],
            homeNamesByServerId: HOME_NAMES,
            snapshotsByServerId: {
                alpha: snapshot('alpha', null, { status: 'error', error: { kind: 'unreachable', retryable: true } }),
            },
        });
        const home = state.unavailableHomes[0]!;
        const retry = vi.fn();
        const screen = await renderScreen(React.createElement(SurfaceStateCard, {
            testID: 'teams-offline-home',
            size: 'line',
            kind: teamsUnavailableHomeStateKind(home),
            title: home.homeName,
            reason: teamsUnavailableHomeReason(home),
            action: home.retryable ? { testID: 'teams-retry', label: 'Retry', onPress: retry } : undefined,
        }));
        try {
            expect(screen.findAll((node) => node.props.name === 'cloud-slash').length).toBeGreaterThan(0);
            await screen.pressByTestIdAsync('teams-retry');
            expect(retry).toHaveBeenCalledOnce();
        } finally {
            await screen.unmount();
        }
    });

    it('settles a server failure without claiming transport loss or keeping initial skeletons', () => {
        const state = resolveTeamsDirectoryViewState({
            homes: [{ serverId: 'alpha', state: 'capable' }],
            homeNamesByServerId: HOME_NAMES,
            snapshotsByServerId: { alpha: snapshot('alpha', null, { status: 'error', error: { kind: 'unknown', retryable: true } }) },
        });
        expect(state.unavailableHomes).toEqual([{ serverId: 'alpha', homeName: 'Alpha', reason: 'error', retryable: true }]);
        expect(state.kind).toBe('ready');
    });

    it('names a Teams read the person turned off in Settings, Actions, with no retry that cannot help', () => {
        const state = resolveTeamsDirectoryViewState({
            homes: [{ serverId: 'alpha', state: 'capable' }],
            homeNamesByServerId: HOME_NAMES,
            snapshotsByServerId: { alpha: snapshot('alpha', null, { status: 'error', error: { kind: 'unknown', retryable: false, code: 'action_disabled' } }) },
        });
        expect(state.unavailableHomes).toEqual([{ serverId: 'alpha', homeName: 'Alpha', reason: 'turned_off', retryable: false }]);
        expect(teamsUnavailableHomeReason(state.unavailableHomes[0]!)).toContain('Settings → Actions');
        expect(teamsUnavailableHomeStateKind(state.unavailableHomes[0]!)).toBe('unavailable');
    });

    it('presents a failed HTTP feature probe as a load error while keeping Teams unadmitted', () => {
        const admission = resolveTeamsSettingsAdmission({
            serverIds: ['alpha'],
            snapshotsByServerId: { alpha: { status: 'error', reason: 'response_status', httpStatus: 503 } },
            settings: { experiments: false, featureToggles: {} },
        });
        const state = resolveTeamsDirectoryViewState({
            homes: admission.homes,
            homeNamesByServerId: HOME_NAMES,
            snapshotsByServerId: {},
        });

        expect(state.rows).toHaveLength(0);
        expect(state.unavailableHomes).toEqual([{ serverId: 'alpha', homeName: 'Alpha', reason: 'error', retryable: true }]);
        expect(teamsUnavailableHomeStateKind(state.unavailableHomes[0]!)).toBe('error');
    });
    it('flattens capable Homes into addressed rows that carry their exact Home', () => {
        const state = resolveTeamsDirectoryViewState({
            homes: [
                { serverId: 'alpha', state: 'capable' },
                { serverId: 'beta', state: 'capable' },
            ],
            homeNamesByServerId: HOME_NAMES,
            snapshotsByServerId: {
                alpha: snapshot('alpha', [team('t1', 'Acme')]),
                beta: snapshot('beta', [team('t2', 'Globex')]),
            },
        });

        expect(state.rows.map((row) => [row.address.serverId, row.address.teamId])).toEqual([
            ['alpha', 't1'],
            ['beta', 't2'],
        ]);
        expect(state.rows.map((row) => row.homeName)).toEqual(['Alpha', 'Beta']);
        expect(state.multiHome).toBe(true);
        expect(state.kind).toBe('ready');
    });

    it('keeps a reachable Home rendered and reports the unreachable one as partial', () => {
        const state = resolveTeamsDirectoryViewState({
            homes: [
                { serverId: 'alpha', state: 'capable' },
                { serverId: 'beta', state: 'capable' },
            ],
            homeNamesByServerId: HOME_NAMES,
            snapshotsByServerId: {
                alpha: snapshot('alpha', [team('t1', 'Acme')]),
                beta: snapshot('beta', null, {
                    status: 'error',
                    reachability: 'unreachable',
                    error: { kind: 'unreachable', retryable: true },
                    lastObservedAt: null,
                }),
            },
        });

        expect(state.kind).toBe('ready');
        expect(state.rows).toHaveLength(1);
        expect(state.partial).toBe(true);
        expect(state.unavailableHomes.map((home) => [home.serverId, home.reason])).toEqual([
            ['beta', 'offline'],
        ]);
    });

    it('settles a Home whose saved credential is unreadable on its own retryable reason, never loading', () => {
        const state = resolveTeamsDirectoryViewState({
            homes: [{ serverId: 'alpha', state: 'unresolved', reason: 'credential_unreadable' }],
            homeNamesByServerId: HOME_NAMES,
            snapshotsByServerId: {},
        });

        // `kind` stays 'loading' until any Home answers (as for an offline
        // Home); the row's own settled reason is what keeps the screen honest.
        expect(state.unavailableHomes).toEqual([
            expect.objectContaining({ serverId: 'alpha', reason: 'credential_unreadable', retryable: true }),
        ]);
    });

    it('keeps a capable Home rendered and reports an unsupported selected Home as update-required', () => {
        const admission = resolveTeamsSettingsAdmission({
            settings: { experiments: false, featureToggles: {} },
            serverIds: ['alpha', 'beta'],
            snapshotsByServerId: {
                alpha: {
                    status: 'ready',
                    features: FeaturesResponseSchema.parse({
                        features: { teams: { enabled: true } },
                        capabilities: {},
                    }),
                },
                beta: { status: 'unsupported', reason: 'invalid_payload' },
            },
        });
        const state = resolveTeamsDirectoryViewState({
            homes: admission.homes,
            homeNamesByServerId: HOME_NAMES,
            snapshotsByServerId: { alpha: snapshot('alpha', [team('t1', 'Acme')]) },
        });

        expect(admission.admitted).toBe(true);
        expect(state.kind).toBe('ready');
        expect(state.rows.map((row) => row.address.serverId)).toEqual(['alpha']);
        expect(state.partial).toBe(true);
        expect(state.unavailableHomes).toEqual([{
            serverId: 'beta',
            homeName: 'Beta',
            reason: 'unsupported',
            retryable: false,
        }]);
    });

    it('retains the last known rows of an offline Home and marks them stale rather than blanking', () => {
        const state = resolveTeamsDirectoryViewState({
            homes: [{ serverId: 'alpha', state: 'capable' }],
            homeNamesByServerId: HOME_NAMES,
            snapshotsByServerId: {
                alpha: snapshot('alpha', [team('t1', 'Acme')], {
                    status: 'error',
                    stale: true,
                    reachability: 'unreachable',
                    error: { kind: 'unreachable', retryable: true },
                }),
            },
        });

        expect(state.rows).toHaveLength(1);
        expect(state.stale).toBe(true);
        // A Home that still has rows on screen is not reported as missing.
        expect(state.unavailableHomes).toEqual([]);
        expect(state.partial).toBe(true);
    });

    it('separates archived Teams from the active section', () => {
        const state = resolveTeamsDirectoryViewState({
            homes: [{ serverId: 'alpha', state: 'capable' }],
            homeNamesByServerId: HOME_NAMES,
            snapshotsByServerId: {
                alpha: snapshot('alpha', [
                    team('t1', 'Acme'),
                    team('t2', 'Retired', { archivedAt: 42 }),
                ]),
            },
        });

        expect(state.rows.map((row) => row.address.teamId)).toEqual(['t1']);
        expect(state.archivedRows.map((row) => row.address.teamId)).toEqual(['t2']);
    });

    it('reports loading only while nothing has been observed anywhere', () => {
        const loading = resolveTeamsDirectoryViewState({
            homes: [{ serverId: 'alpha', state: 'capable' }],
            homeNamesByServerId: HOME_NAMES,
            snapshotsByServerId: {
                alpha: snapshot('alpha', null, { status: 'loading', lastObservedAt: null }),
            },
        });
        expect(loading.kind).toBe('loading');

        const observed = resolveTeamsDirectoryViewState({
            homes: [
                { serverId: 'alpha', state: 'capable' },
                { serverId: 'beta', state: 'capable' },
            ],
            homeNamesByServerId: HOME_NAMES,
            snapshotsByServerId: {
                alpha: snapshot('alpha', [team('t1', 'Acme')]),
                beta: snapshot('beta', null, { status: 'loading', lastObservedAt: null }),
            },
        });
        expect(observed.kind).toBe('ready');
    });

    it('is empty only when every capable Home actually answered with no Teams', () => {
        const state = resolveTeamsDirectoryViewState({
            homes: [{ serverId: 'alpha', state: 'capable' }],
            homeNamesByServerId: HOME_NAMES,
            snapshotsByServerId: { alpha: snapshot('alpha', []) },
        });
        expect(state.kind).toBe('empty');

        const notEmpty = resolveTeamsDirectoryViewState({
            homes: [
                { serverId: 'alpha', state: 'capable' },
                { serverId: 'beta', state: 'capable' },
            ],
            homeNamesByServerId: HOME_NAMES,
            snapshotsByServerId: {
                alpha: snapshot('alpha', []),
                beta: snapshot('beta', null, {
                    status: 'error',
                    reachability: 'unreachable',
                    error: { kind: 'unreachable', retryable: true },
                    lastObservedAt: null,
                }),
            },
        });
        // One Home said "none" and the other said nothing at all; claiming the
        // user has no Teams would be a false statement about the second Home.
        expect(notEmpty.kind).toBe('ready');
        expect(notEmpty.partial).toBe(true);
    });

    it('never admits a Home the feature decision did not admit', () => {
        const state = resolveTeamsDirectoryViewState({
            homes: [
                { serverId: 'alpha', state: 'capable' },
                { serverId: 'beta', state: 'disabled' },
            ],
            homeNamesByServerId: HOME_NAMES,
            snapshotsByServerId: {
                alpha: snapshot('alpha', [team('t1', 'Acme')]),
                // A stale snapshot from before the Home disabled Teams must not
                // resurrect its rows.
                beta: snapshot('beta', [team('t2', 'Globex')]),
            },
        });

        expect(state.rows.map((row) => row.address.serverId)).toEqual(['alpha']);
        expect(state.unavailableHomes).toEqual([]);
    });

    it('reports a still-unresolved Home as loading rather than offline', () => {
        const state = resolveTeamsDirectoryViewState({
            homes: [
                { serverId: 'alpha', state: 'capable' },
                { serverId: 'beta', state: 'unresolved', reason: 'loading' },
            ],
            homeNamesByServerId: HOME_NAMES,
            snapshotsByServerId: { alpha: snapshot('alpha', [team('t1', 'Acme')]) },
        });

        expect(state.unavailableHomes.map((home) => [home.serverId, home.reason])).toEqual([
            ['beta', 'loading'],
        ]);
        expect(state.partial).toBe(true);
    });

});
