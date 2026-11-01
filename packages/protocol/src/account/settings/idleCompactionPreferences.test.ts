import { describe, expect, it } from 'vitest';
import { accountSettingsParse, ACCOUNT_SETTING_DEFINITIONS, resolveIdleCompactionPreference } from './accountSettings.js';
import { buildBackendTargetKeyV2 } from '../../backends/targets/backendTargetRefV2.js';
import { readPortableAccountSettingBindingV1 } from '../../actions/settings/accountSettingBindings.js';
import { readBuiltInSettingDeclarationV1, buildBuiltInAccountSettingMutationV1, resolveBuiltInAccountSettingResetValueV1 } from '../../actions/settings/settingsDeclarations.js';

const target = buildBackendTargetKeyV2({ kind: 'backend', backendId: 'claude' });
const sibling = buildBackendTargetKeyV2({ kind: 'backend', backendId: 'codex' });
const cases = [
    ['agents.idleCompaction', 'sessionIdleCompactionEnabledByTargetKey', false, true],
    ['agents.idleCompaction.minContextTokens', 'sessionIdleCompactionMinContextTokensByTargetKey', 0, 200_000],
    ['agents.idleCompaction.cacheWindowOverrideMs', 'sessionIdleCompactionCacheWindowOverrideMsByTargetKey', 2_147_483_647, 60_000],
] as const;

describe('Account idle compaction preferences', () => {
    it.each(cases)('sets and resets only one target of %s through the existing Settings owner', (anchor, key, value, siblingValue) => {
        const declaration = readBuiltInSettingDeclarationV1(anchor);
        expect(declaration).not.toBeNull();
        if (!declaration) throw new Error('Missing preference declaration');
        const before = accountSettingsParse({ [key]: { [sibling]: siblingValue }, sessionIdleCompactionMinContextTokensByTargetKey: { [sibling]: 25 } });
        const delta = buildBuiltInAccountSettingMutationV1(declaration, before, { agentTargetKey: target, value });
        expect(delta).toEqual({ [key]: { ...before[key], [target]: value } });
        const selected = accountSettingsParse({ ...before, ...delta });
        expect(readPortableAccountSettingBindingV1(declaration)?.read(selected)).toEqual(selected[key]);
        const reset = resolveBuiltInAccountSettingResetValueV1(declaration, target);
        expect(reset.success).toBe(true);
        if (!reset.success) throw new Error('Target reset must be admitted');
        expect(buildBuiltInAccountSettingMutationV1(declaration, selected, reset.value)).toEqual({ [key]: before[key] });
        expect(selected.sessionIdleCompactionMinContextTokensByTargetKey[sibling]).toBe(25);
    });

    it('validates minimums and platform timer windows at the Account mutation boundary', () => {
        const minimum = ACCOUNT_SETTING_DEFINITIONS.sessionIdleCompactionMinContextTokensByTargetKey;
        for (const value of [0, Number.MAX_SAFE_INTEGER]) expect(minimum.parseMutationValue({ [target]: value }).success).toBe(true);
        for (const value of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1]) expect(minimum.parseMutationValue({ [target]: value }).success).toBe(false);
        const window = ACCOUNT_SETTING_DEFINITIONS.sessionIdleCompactionCacheWindowOverrideMsByTargetKey;
        for (const value of [1, 2_147_483_646, 2_147_483_647]) expect(window.parseMutationValue({ [target]: value }).success).toBe(true);
        for (const value of [0, -1, 1.5, 2_147_483_648]) expect(window.parseMutationValue({ [target]: value }).success).toBe(false);
    });

    it('uses descriptor defaults once while preserving explicit false, zero and Automatic', () => {
        const idle = { mode: 'host' as const, defaultEnabled: true, defaultMinContextTokens: 200_000 };
        expect(resolveIdleCompactionPreference({ idle })).toEqual({ enabled: true, minContextTokens: 200_000 });
        expect(resolveIdleCompactionPreference({ idle, enabled: false, minContextTokens: 0, cacheWindowOverrideMs: 1 })).toEqual({ enabled: false, minContextTokens: 0, cacheWindowOverrideMs: 1 });
        expect(resolveIdleCompactionPreference({ idle: { mode: 'native', defaultEnabled: false } })).toEqual({ enabled: false });
    });
});
