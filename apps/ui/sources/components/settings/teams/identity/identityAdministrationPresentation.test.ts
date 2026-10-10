import { describe, expect, it } from 'vitest';
import type { TeamIdentityConnectionV1 } from '@happier-dev/protocol/teams';

import { t } from '@/text';

import {
    identityConnectionMode,
    identityProviderKindLabel,
    identityConnectionTestStatus,
    workosConnectionStatusLabel,
    workosConnectionStrategyLabel,
    sortIdentityConnectionsForAdministration,
    workosSetupSteps,
} from './identityAdministrationPresentation';

function connection(overrides: Partial<TeamIdentityConnectionV1>): TeamIdentityConnectionV1 {
    return {
        v: 1,
        id: 'connection-1',
        teamId: 'team-1',
        provider: { id: 'provider-1', kind: 'oidc', displayName: 'Engineering OIDC' },
        externalReference: { v: 1, kind: 'oidc' },
        settings: { v: 1, kind: 'oidc', allowedUsers: [], allowedEmailDomains: [], groupsAny: [], groupsAll: [] },
        enabled: true,
        firstEnabledAt: 1,
        revision: 1,
        state: 'connected',
        allowedActions: [],
        lastObservation: { v: 1, kind: 'oidc' },
        lastSuccessfulTest: null,
        createdAt: 1,
        updatedAt: 1,
        ...overrides,
    };
}

describe('identityAdministrationPresentation', () => {
    it('orders by administrator-facing name and never by changing status', () => {
        const alpha = connection({
            id: 'alpha',
            state: 'needs_attention',
            provider: { id: 'p1', kind: 'oidc', displayName: 'Alpha' },
        });
        const zulu = connection({
            id: 'zulu',
            state: 'connected',
            provider: { id: 'p2', kind: 'oidc', displayName: 'Zulu' },
        });

        expect(sortIdentityConnectionsForAdministration([zulu, alpha]).map((item) => item.id)).toEqual(['alpha', 'zulu']);
        expect(sortIdentityConnectionsForAdministration([
            { ...zulu, state: 'prohibited' },
            { ...alpha, state: 'connected' },
        ]).map((item) => item.id)).toEqual(['alpha', 'zulu']);
    });

    it('describes OIDC Group claims as sign-in-time refresh rather than directory management', () => {
        expect(identityConnectionMode(connection({}))).toBe('sign_in_only');
        expect(identityConnectionMode(connection({
            settings: {
                v: 1,
                kind: 'oidc',
                allowedUsers: [],
                allowedEmailDomains: [],
                groupsAny: ['engineering'],
                groupsAll: [],
            },
        }))).toBe('sign_in_time_groups');
    });

    it('distinguishes a current test from historical test evidence', () => {
        expect(identityConnectionTestStatus(connection({ lastSuccessfulTest: null }))).toBe('required');
        expect(identityConnectionTestStatus(connection({
            lastSuccessfulTest: {
                at: 1,
                runtimeFingerprint: 'runtime-a',
                current: false,
            },
        }))).toBe('stale');
        expect(identityConnectionTestStatus(connection({
            lastSuccessfulTest: {
                at: 1,
                runtimeFingerprint: 'runtime-a',
                current: true,
            },
        }))).toBe('current');
    });

    it('projects provider and WorkOS values through localized presentation instead of raw wire values', () => {
        expect(identityProviderKindLabel('workos_sso')).toBe(t('identityAdministration.providerWorkosSso'));
        expect(workosConnectionStrategyLabel('SAML')).toBe(t('identityAdministration.workosStrategySaml'));
        expect(workosConnectionStatusLabel('active')).toBe(t('identityAdministration.active'));
        expect(workosConnectionStrategyLabel('future_strategy')).toBe(t('identityAdministration.workosStrategyOther'));
        expect(workosConnectionStatusLabel('future_status')).toBe(t('identityAdministration.workosStatusUnknown'));
    });

    it('derives the WorkOS setup steps from the projection alone, with exactly one current step', () => {
        const workos = (overrides: Partial<TeamIdentityConnectionV1>) => connection({
            provider: { id: 'provider-workos', kind: 'workos_sso', displayName: 'WorkOS SSO' },
            externalReference: { v: 1, kind: 'workos_sso', organizationId: null, connectionId: null },
            settings: { v: 1, kind: 'workos_sso' },
            lastObservation: null,
            enabled: false,
            firstEnabledAt: null,
            state: 'setting_up',
            ...overrides,
        });
        const states = (value: TeamIdentityConnectionV1) => workosSetupSteps(value)?.map((step) => `${step.id}:${step.state}`);

        expect(states(workos({}))).toEqual(['portal:current', 'choose:upcoming', 'test:upcoming', 'enable:upcoming']);
        expect(states(workos({
            externalReference: { v: 1, kind: 'workos_sso', organizationId: 'org-1', connectionId: null },
        }))).toEqual(['portal:done', 'choose:current', 'test:upcoming', 'enable:upcoming']);
        expect(states(workos({
            externalReference: { v: 1, kind: 'workos_sso', organizationId: 'org-1', connectionId: 'conn-1' },
            lastSuccessfulTest: { at: 1, runtimeFingerprint: 'f', current: false },
        }))).toEqual(['portal:done', 'choose:done', 'test:current', 'enable:upcoming']);
        expect(states(workos({
            externalReference: { v: 1, kind: 'workos_sso', organizationId: 'org-1', connectionId: 'conn-1' },
            lastSuccessfulTest: { at: 1, runtimeFingerprint: 'f', current: true },
        }))).toEqual(['portal:done', 'choose:done', 'test:done', 'enable:current']);
        // An enabled connection has finished setup; a non-WorkOS connection never had these steps.
        expect(workosSetupSteps(workos({
            externalReference: { v: 1, kind: 'workos_sso', organizationId: 'org-1', connectionId: 'conn-1' },
            enabled: true,
            state: 'connected',
        }))).toBeNull();
        expect(workosSetupSteps(connection({}))).toBeNull();
    });
});
