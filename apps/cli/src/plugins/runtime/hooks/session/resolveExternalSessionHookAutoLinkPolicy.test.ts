import { afterEach, describe, expect, it, vi } from 'vitest';

import {
    deriveExternalSessionsAutoLinkSourcePolicyIdV1,
    type AccountSettings,
} from '@happier-dev/protocol';

import {
    isExternalSessionHookAutoLinkPolicyCurrent,
    resolveExternalSessionHookAutoLinkPolicy,
} from './resolveExternalSessionHookAutoLinkPolicy';
import {
    resetActiveAccountSettingsSnapshotForTests,
    setActiveAccountSettingsSnapshot,
} from '@/settings/accountSettings/activeAccountSettingsSnapshot';

const qualifiedIdentity = {
    v: 1,
    agent: {
        pluginId: 'happier.agent.fixture',
        localId: 'fixture',
    },
    source: {
        kind: 'fixture.source',
        contractVersion: 1,
    },
} as const;

afterEach(() => {
    resetActiveAccountSettingsSnapshotForTests();
});

describe('resolveExternalSessionHookAutoLinkPolicy', () => {
    it('fails closed unless the canonical source-derived policy is explicitly enabled', async () => {
        const readAccountScopeKey = () => 'account-scope-test';
        const resolveSourceKeyOwner = vi.fn(async () => ({
            sourceKey: 'fixture.source:canonical',
        }));
        const readAccountSettings = vi.fn<() => AccountSettings | null>(
            () => ({}) as AccountSettings,
        );
        const input = {
            machineId: 'machine-1',
            agentId: 'fixture',
            qualifiedIdentity,
            source: { kind: 'fixture.source', root: '/private/redacted' },
        } as const;

        await expect(resolveExternalSessionHookAutoLinkPolicy(input, {
            readAccountSettings,
            readAccountScopeKey,
            resolveSourceKeyOwner,
        })).resolves.toBeNull();

        const expectedPolicy = await resolveExternalSessionHookAutoLinkPolicy(
            input,
            {
                readAccountSettings: () => ({
                    externalSessionsSettingsV1: {
                        v: 1,
                        keepPassivelyFollowingAfterRestart: false,
                        autoLinkSourcePolicies: [],
                    },
                }) as unknown as AccountSettings,
                readAccountScopeKey,
                resolveSourceKeyOwner,
            },
        );
        expect(expectedPolicy).toBeNull();

        const sourcePolicyId = deriveExternalSessionsAutoLinkSourcePolicyIdV1({
            machineId: input.machineId,
            qualifiedIdentity,
            canonicalResolvedSourceKey: 'fixture.source:canonical',
        });
        await expect(resolveExternalSessionHookAutoLinkPolicy(input, {
            readAccountSettings: () => ({
                externalSessionsSettingsV1: {
                    v: 1,
                    keepPassivelyFollowingAfterRestart: false,
                    autoLinkSourcePolicies: [{
                        machineId: 'machine-1',
                        qualifiedIdentity,
                        sourcePolicyId,
                        enabledAtMs: 1_234,
                    }],
                },
            }) as unknown as AccountSettings,
            readAccountScopeKey,
            resolveSourceKeyOwner,
        })).resolves.toEqual({
            accountScopeKey: 'account-scope-test',
            canonicalResolvedSourceKey: 'fixture.source:canonical',
            sourcePolicyId,
            enabledAtMs: 1_234,
        });
    });

    it('rejects malformed sources and mismatched qualified policy scopes', async () => {
        const resolveSourceKeyOwner = vi.fn(async () => ({
            sourceKey: 'fixture.source:canonical',
        }));

        await expect(resolveExternalSessionHookAutoLinkPolicy({
            machineId: 'machine-1',
            agentId: 'fixture',
            qualifiedIdentity,
            source: { kind: '' },
        }, {
            readAccountSettings: () => null,
            resolveSourceKeyOwner,
        })).resolves.toBeNull();
        expect(resolveSourceKeyOwner).not.toHaveBeenCalled();
    });

    it('revalidates the exact enabled policy generation from canonical account settings', () => {
        const sourcePolicyId = deriveExternalSessionsAutoLinkSourcePolicyIdV1({
            machineId: 'machine-1',
            qualifiedIdentity,
            canonicalResolvedSourceKey: 'fixture.source:canonical',
        });
        let policies: readonly Readonly<{
            machineId: string;
            qualifiedIdentity: typeof qualifiedIdentity;
            sourcePolicyId: string;
            enabledAtMs: number;
        }>[] = [{
            machineId: 'machine-1',
            qualifiedIdentity,
            sourcePolicyId,
            enabledAtMs: 1_234,
        }];
        const readAccountSettings = () => ({
            externalSessionsSettingsV1: {
                v: 1,
                keepPassivelyFollowingAfterRestart: false,
                autoLinkSourcePolicies: policies,
            },
        }) as unknown as AccountSettings;
        const expected = {
            machineId: 'machine-1',
            qualifiedIdentity,
            sourcePolicyId,
            enabledAtMs: 1_234,
            accountScopeKey: 'account-scope-test',
        } as const;

        expect(isExternalSessionHookAutoLinkPolicyCurrent(expected, {
            readAccountSettings,
            readAccountScopeKey: () => 'account-scope-test',
        })).toBe(true);

        policies = [{
            ...policies[0]!,
            enabledAtMs: 1_235,
        }];
        expect(isExternalSessionHookAutoLinkPolicyCurrent(expected, {
            readAccountSettings,
            readAccountScopeKey: () => 'account-scope-test',
        })).toBe(false);

        policies = [];
        expect(isExternalSessionHookAutoLinkPolicyCurrent(expected, {
            readAccountSettings,
            readAccountScopeKey: () => 'account-scope-test',
        })).toBe(false);
    });

    it('binds policy authority to the current account scope across an account switch', async () => {
        const sourcePolicyId = deriveExternalSessionsAutoLinkSourcePolicyIdV1({
            machineId: 'machine-1',
            qualifiedIdentity,
            canonicalResolvedSourceKey: 'fixture.source:canonical',
        });
        const settings = {
            externalSessionsSettingsV1: {
                v: 1,
                keepPassivelyFollowingAfterRestart: false,
                autoLinkSourcePolicies: [{
                    machineId: 'machine-1',
                    qualifiedIdentity,
                    sourcePolicyId,
                    enabledAtMs: 1_234,
                }],
            },
        } as unknown as AccountSettings;
        setActiveAccountSettingsSnapshot({
            source: 'network',
            settings,
            settingsVersion: 1,
            loadedAtMs: 1,
            settingsSecretsReadKeys: [],
            scopeKey: 'account-scope-a',
        });

        const resolved = await resolveExternalSessionHookAutoLinkPolicy({
            machineId: 'machine-1',
            agentId: 'fixture',
            qualifiedIdentity,
            source: { kind: 'fixture.source', root: '/private/redacted' },
        }, {
            resolveSourceKeyOwner: async () => ({
                sourceKey: 'fixture.source:canonical',
            }),
        });
        expect(resolved).toEqual({
            accountScopeKey: 'account-scope-a',
            canonicalResolvedSourceKey: 'fixture.source:canonical',
            sourcePolicyId,
            enabledAtMs: 1_234,
        });

        setActiveAccountSettingsSnapshot({
            source: 'network',
            settings,
            settingsVersion: 1,
            loadedAtMs: 2,
            settingsSecretsReadKeys: [],
            scopeKey: 'account-scope-b',
        });
        expect(isExternalSessionHookAutoLinkPolicyCurrent({
            machineId: 'machine-1',
            qualifiedIdentity,
            sourcePolicyId,
            enabledAtMs: 1_234,
            accountScopeKey: 'account-scope-a',
        })).toBe(false);
    });
});
