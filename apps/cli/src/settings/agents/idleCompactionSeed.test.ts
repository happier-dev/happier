import { describe, expect, it } from 'vitest';
import { accountSettingsParse } from '@happier-dev/protocol/account/settings/accountSettings';
import { buildBackendTargetKeyV2 } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';
import { resolveSessionIdleCompactionSeed, nativeIdleCompactionOpenPreference } from './idleCompactionSeed';

describe('Session idle compaction startup seed', () => {
    const backendTarget = { kind: 'backend', backendId: 'claude' } as const;
    const key = buildBackendTargetKeyV2(backendTarget);
    it('captures false and zero from the existing snapshot without tracking later edits', () => {
        const settings = accountSettingsParse({ sessionIdleCompactionEnabledByTargetKey: { [key]: false },
            sessionIdleCompactionMinContextTokensByTargetKey: { [key]: 0 },
            sessionIdleCompactionCacheWindowOverrideMsByTargetKey: { [key]: 20 } });
        const idle = { mode: 'host', defaultEnabled: true, defaultMinContextTokens: 100 } as const;
        const seed = resolveSessionIdleCompactionSeed({ accountSettings: settings, backendTarget, idle });
        settings.sessionIdleCompactionEnabledByTargetKey[key] = true;
        expect(seed).toEqual({ enabled: false, minContextTokens: 0, cacheWindowOverrideMs: 20 });
        expect(Object.isFrozen(seed)).toBe(true);
    });
    it('uses the same resolver defaults for external targets and omits nondeclaring Agents', () => {
        const external = { kind: 'agent', identity: { pluginId: 'acme.agent', localId: 'review' } } as const;
        expect(resolveSessionIdleCompactionSeed({ accountSettings: {}, backendTarget: external,
            idle: { mode: 'native', defaultEnabled: true, nativeHonorsMinimum: true, defaultMinContextTokens: 200_000 } })).toEqual({ enabled: true, minContextTokens: 200_000 });
        expect(resolveSessionIdleCompactionSeed({ accountSettings: {}, backendTarget })).toBeUndefined();
    });
    it.each(['host', 'native'] as const)('retains user minimums above and below the descriptor default and the optional window in the %s seed', (mode) => {
        const idle = mode === 'host'
            ? { mode, defaultEnabled: true, defaultMinContextTokens: 100 } as const
            : { mode, defaultEnabled: true, nativeHonorsMinimum: true, defaultMinContextTokens: 100 } as const;
        expect(resolveSessionIdleCompactionSeed({ accountSettings: {}, backendTarget, idle }))
            .toEqual({ enabled: true, minContextTokens: 100 });
        for (const minContextTokens of [0, 50, 150]) {
            const settings = accountSettingsParse({ sessionIdleCompactionEnabledByTargetKey: { [key]: false },
                sessionIdleCompactionMinContextTokensByTargetKey: { [key]: minContextTokens },
                sessionIdleCompactionCacheWindowOverrideMsByTargetKey: { [key]: 20 } });
            expect(resolveSessionIdleCompactionSeed({ accountSettings: settings, backendTarget, idle }))
                .toEqual({ enabled: false, minContextTokens, cacheWindowOverrideMs: 20 });
        }
    });
    it('forwards only supported native values and never forwards a window or host operand', () => {
        const preference = resolveSessionIdleCompactionSeed({ accountSettings: accountSettingsParse({
            sessionIdleCompactionEnabledByTargetKey: { [key]: false },
            sessionIdleCompactionMinContextTokensByTargetKey: { [key]: 0 },
            sessionIdleCompactionCacheWindowOverrideMsByTargetKey: { [key]: 50 },
        }), backendTarget, idle: { mode: 'native', defaultEnabled: true } });
        expect(preference).toEqual({ enabled: false, minContextTokens: 0, cacheWindowOverrideMs: 50 });
        expect(nativeIdleCompactionOpenPreference({ mode: 'native', defaultEnabled: true, nativeHonorsMinimum: true }, preference)).toEqual({ enabled: false, minContextTokens: 0 });
        expect(nativeIdleCompactionOpenPreference({ mode: 'native', defaultEnabled: true }, preference)).toEqual({ enabled: false });
        expect(nativeIdleCompactionOpenPreference({ mode: 'host', defaultEnabled: true }, preference)).toBeUndefined();
        expect(nativeIdleCompactionOpenPreference(undefined, undefined)).toBeUndefined();
    });
});
