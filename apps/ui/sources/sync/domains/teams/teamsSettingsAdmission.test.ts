import { afterEach, describe, expect, it, vi } from 'vitest';
import { FeaturesResponseSchema, type FeaturesResponse } from '@happier-dev/protocol/features/payload/featuresResponseSchema';

import type { ServerFeaturesSnapshot } from '@/sync/api/capabilities/serverFeaturesClient';

import {
    resolveTeamsDestinationShown,
    resolveTeamsSettingsAdmission as resolveTeamsSettingsAdmissionOwner,
} from './teamsSettingsAdmission';

function resolveTeamsSettingsAdmission(
    params: Omit<Parameters<typeof resolveTeamsSettingsAdmissionOwner>[0], 'settings'>,
) {
    return resolveTeamsSettingsAdmissionOwner({
        ...params,
        settings: { experiments: false, featureToggles: {} },
    });
}

function readySnapshot(teamsEnabled: boolean): ServerFeaturesSnapshot {
    return {
        status: 'ready',
        features: FeaturesResponseSchema.parse({
            features: { teams: { enabled: teamsEnabled } },
            capabilities: {},
        }),
    };
}

/**
 * A payload that never carried a `teams` gate at all. The released parser
 * defaults the gate to disabled, so this shape is only reachable from a
 * pre-schema payload; the cast is confined to this boundary fixture.
 */
function snapshotWithoutTeamsGate(): ServerFeaturesSnapshot {
    return {
        status: 'ready',
        features: { features: { automations: { enabled: true } } } as unknown as FeaturesResponse,
    };
}

describe('resolveTeamsSettingsAdmission', () => {
    afterEach(() => vi.unstubAllEnvs());

    it('withholds Teams when the client build denies it even if a Home enables it', () => {
        vi.stubEnv('EXPO_PUBLIC_HAPPIER_BUILD_FEATURES_DENY', 'teams');
        const admission = resolveTeamsSettingsAdmission({
            serverIds: ['home_a'],
            snapshotsByServerId: { home_a: readySnapshot(true) },
        });

        expect(admission.admitted).toBe(false);
        expect(admission.capableServerIds).toEqual([]);
    });

    it('admits Teams when at least one Home in the exact set enables the canonical feature', () => {
        const admission = resolveTeamsSettingsAdmission({
            serverIds: ['home_a', 'home_b'],
            snapshotsByServerId: {
                home_a: readySnapshot(false),
                home_b: readySnapshot(true),
            },
        });

        expect(admission.admitted).toBe(true);
        expect(admission.capableServerIds).toEqual(['home_b']);
        expect(admission.unresolvedServerIds).toEqual([]);
    });

    it('does not admit Teams when every Home in the exact set reports it disabled', () => {
        const admission = resolveTeamsSettingsAdmission({
            serverIds: ['home_a', 'home_b'],
            snapshotsByServerId: {
                home_a: readySnapshot(false),
                home_b: readySnapshot(false),
            },
        });

        expect(admission.admitted).toBe(false);
        expect(admission.capableServerIds).toEqual([]);
    });

    it('reads an absent gate as disabled instead of admitting on a missing bit', () => {
        const admission = resolveTeamsSettingsAdmission({
            serverIds: ['home_a'],
            snapshotsByServerId: { home_a: snapshotWithoutTeamsGate() },
        });

        expect(admission.admitted).toBe(false);
        expect(admission.homes).toEqual([{ serverId: 'home_a', state: 'disabled' }]);
    });

    it('reads a server without the features endpoint as an older Home without Teams', () => {
        const admission = resolveTeamsSettingsAdmission({
            serverIds: ['home_a'],
            snapshotsByServerId: {
                home_a: { status: 'unsupported', reason: 'endpoint_missing' },
            },
        });

        expect(admission.admitted).toBe(false);
        expect(admission.homes).toEqual([{
            serverId: 'home_a',
            state: 'unsupported',
            reason: 'endpoint_missing',
        }]);
        expect(admission.unresolvedServerIds).toEqual([]);
    });

    it.each([
        ['endpoint_missing' as const, 'endpoint_missing' as const],
        ['invalid_payload' as const, 'misconfigured' as const],
    ])('keeps an unsupported %s Home visible beside a capable Home', (snapshotReason, blockerCode) => {
        const admission = resolveTeamsSettingsAdmission({
            serverIds: ['home_a', 'home_b'],
            snapshotsByServerId: {
                home_a: readySnapshot(true),
                home_b: { status: 'unsupported', reason: snapshotReason },
            },
        });

        expect(admission.admitted).toBe(true);
        expect(admission.capableServerIds).toEqual(['home_a']);
        expect(admission.homes).toEqual([
            { serverId: 'home_a', state: 'capable' },
            { serverId: 'home_b', state: 'unsupported', reason: blockerCode },
        ]);
    });

    it('separates a Home that is merely unreachable from a Home that answered "no"', () => {
        const admission = resolveTeamsSettingsAdmission({
            serverIds: ['home_a', 'home_b'],
            snapshotsByServerId: {
                home_a: { status: 'error', reason: 'network' },
                home_b: readySnapshot(false),
            },
        });

        expect(admission.admitted).toBe(false);
        expect(admission.unresolvedServerIds).toEqual(['home_a']);
        expect(admission.homes).toEqual([
            { serverId: 'home_a', state: 'unresolved', reason: 'unreachable' },
            { serverId: 'home_b', state: 'disabled' },
        ]);
    });

    it('reports a Home whose snapshot has not arrived as loading, never as capable', () => {
        const admission = resolveTeamsSettingsAdmission({
            serverIds: ['home_a'],
            snapshotsByServerId: {},
        });

        expect(admission.admitted).toBe(false);
        expect(admission.homes).toEqual([{ serverId: 'home_a', state: 'unresolved', reason: 'loading' }]);
    });

    it.each([
        { status: 'error', reason: 'response_status', httpStatus: 503 },
        { status: 'error', reason: 'identity_conflict' },
    ] as const)('does not claim a Home is unreachable after a $reason feature probe', (snapshot) => {
        const admission = resolveTeamsSettingsAdmission({
            serverIds: ['home_a'],
            snapshotsByServerId: { home_a: snapshot },
        });

        expect(admission.admitted).toBe(false);
        expect(admission.capableServerIds).toEqual([]);
        expect(admission.homes).toEqual([{ serverId: 'home_a', state: 'unresolved', reason: 'error' }]);
    });

    it('keeps a partial multi-Home view usable: one capable Home admits while another stays explained', () => {
        const admission = resolveTeamsSettingsAdmission({
            serverIds: ['home_a', 'home_b'],
            snapshotsByServerId: {
                home_a: readySnapshot(true),
                home_b: { status: 'error', reason: 'timeout' },
            },
        });

        expect(admission.admitted).toBe(true);
        expect(admission.capableServerIds).toEqual(['home_a']);
        expect(admission.unresolvedServerIds).toEqual(['home_b']);
    });

    it('normalizes and de-duplicates the exact Home set without inventing a Home', () => {
        const admission = resolveTeamsSettingsAdmission({
            serverIds: [' home_a ', 'home_a', '', 'home_b'],
            snapshotsByServerId: { home_a: readySnapshot(true), home_b: readySnapshot(false) },
        });

        expect(admission.homes.map((home) => home.serverId)).toEqual(['home_a', 'home_b']);
    });

    it('is not admitted for an empty Home set', () => {
        const admission = resolveTeamsSettingsAdmission({ serverIds: [], snapshotsByServerId: {} });
        expect(admission.admitted).toBe(false);
        expect(admission.homes).toEqual([]);
    });
});

describe('resolveTeamsDestinationShown', () => {
    it('hides Teams only when every capable Home says this viewer is not shown it', () => {
        const shown = (entries: ReadonlyArray<[string, boolean | undefined]>, capable = entries.map(([id]) => id)) =>
            resolveTeamsDestinationShown({ capableServerIds: capable, showTeamsByServerId: new Map(entries) });

        expect(shown([['a', false]])).toBe(false);
        expect(shown([['a', false], ['b', true]])).toBe(true);
        // Not answered yet, or a Home that predates the answer: a Home that never chose shows Teams.
        expect(shown([['a', false], ['b', undefined]])).toBe(true);
        expect(shown([], ['a'])).toBe(true);
        // No capable Home is the feature admission's answer, not a visibility choice.
        expect(shown([], [])).toBe(false);
    });
});
