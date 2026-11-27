import { ACCOUNT_SETTING_DEFINITIONS, migrateLegacyScmCommitMessageRunner } from '../../account/settings/accountSettings.js';
import { AccountSettingMutationV1Schema, applyAccountSettingMutationV1, type AccountSettingMutationV1 } from '../../account/settings/accountSettingMutationV1.js';
import { sameStrictJsonValue } from '../../json/strictJsonValue.js';
import { listSecretStringCarrierPathsV1 } from '../../crypto/settingsSecretStringSchemasV1.js';
import { SettingRawValueV1Schema, type SettingsDeclarationMutationReversalV1, type SettingsDeclarationResetExpectedV1 } from '../settingsDeclarationActionFamily.js';

function readRawSettingValue(raw: Readonly<Record<string, unknown>>, key: string) {
    const parsed = SettingRawValueV1Schema.safeParse(Object.hasOwn(raw, key) ? { value: raw[key] } : { unset: true });
    return parsed.success ? parsed.data : null;
}

/** Capture bound keys only; a persistence owner can supply its normalized, acknowledged raw result. */
export function captureSettingMutationV1(raw: Readonly<Record<string, unknown>>, mutation: AccountSettingMutationV1,
    persisted?: Readonly<Record<string, unknown>>) {
    const next = applyAccountSettingMutationV1(raw, mutation);
    if (next.status === 'invalid') return null;
    const beforeSettings = { ...raw };
    migrateLegacyScmCommitMessageRunner(beforeSettings);
    const changes = [];
    for (const { key } of mutation.operations) {
        const before = readRawSettingValue(beforeSettings, key);
        const applied = readRawSettingValue(persisted ?? next.raw, key);
        if (!before || !applied || 'value' in before && !ACCOUNT_SETTING_DEFINITIONS[key].parseMutationValue(before.value).success) return null;
        if (listSecretStringCarrierPathsV1(before).length || listSecretStringCarrierPathsV1(applied).length) return null;
        changes.push({ key, before, applied });
    }
    const only = changes.length === 1 ? changes[0] : undefined;
    return only ? { before: only.before, applied: only.applied } : { changes };
}

/** Bound declarations, rather than receipt authors, decide which Account keys may be restored. */
export function restoreSettingMutationV1(raw: Readonly<Record<string, unknown>>, mutation: AccountSettingMutationV1,
    receipt: SettingsDeclarationMutationReversalV1 | Readonly<{ kind: 'reset'; expected: SettingsDeclarationResetExpectedV1 }>,
    readDeclarationValue?: (raw: Readonly<Record<string, unknown>>) => unknown):
    | Readonly<{ status: 'prepared'; mutation: AccountSettingMutationV1 }>
    | Readonly<{ status: 'invalid' | 'conflict' }> {
    const first = mutation.operations.length === 1 ? mutation.operations[0] : undefined;
    const reset = 'expected' in receipt ? applyAccountSettingMutationV1(raw, mutation) : undefined;
    if (reset?.status === 'invalid') return { status: 'invalid' };
    if ('expected' in receipt && !('changes' in receipt.expected) && readDeclarationValue) {
        if (!first) return { status: 'invalid' };
        const current = readRawSettingValue({ value: readDeclarationValue(raw) }, 'value');
        if (!current || listSecretStringCarrierPathsV1(current).length > 0) return { status: 'invalid' };
        return sameStrictJsonValue(current, receipt.expected)
            ? { status: 'prepared', mutation }
            : { status: 'conflict' };
    }
    const changes = 'expected' in receipt
        ? ('changes' in receipt.expected ? receipt.expected.changes
            : first ? [{ key: first.key, applied: receipt.expected }] : []).map(change => ({ ...change,
                before: readRawSettingValue(reset?.raw ?? raw, change.key) }))
        : 'changes' in receipt ? receipt.changes : first ? [{ key: first.key, before: receipt.before, applied: receipt.applied }] : [];
    if (changes.length !== mutation.operations.length || mutation.operations.some(operation => !changes.some(change => change.key === operation.key))) return { status: 'invalid' };
    if (changes.some(change => !change.before || listSecretStringCarrierPathsV1(change).length > 0)) return { status: 'invalid' };
    if (changes.some(change => !sameStrictJsonValue(readRawSettingValue(raw, change.key), change.applied))) return { status: 'conflict' };
    const restored = AccountSettingMutationV1Schema.safeParse({ operations: changes.map(change =>
        change.before && 'unset' in change.before ? { op: 'reset', key: change.key } : { op: 'set', key: change.key, value: change.before && 'value' in change.before ? change.before.value : undefined }) });
    return restored.success ? { status: 'prepared', mutation: restored.data } : { status: 'invalid' };
}
