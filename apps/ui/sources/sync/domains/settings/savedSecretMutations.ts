import {
    AccountSettingsSavedSecretMutationError,
    applyAccountSettingsSavedSecretMutation,
} from '@happier-dev/protocol';

import type { SavedSecret } from './savedSecretTypes';

function indexUnique(
    secrets: readonly SavedSecret[],
    label: string,
): ReadonlyMap<string, SavedSecret> {
    const byId = new Map<string, SavedSecret>();
    for (const secret of secrets) {
        if (byId.has(secret.id)) {
            throw new AccountSettingsSavedSecretMutationError(
                'saved_secret_invalid',
                `${label} SavedSecret identity is duplicated`,
            );
        }
        byId.set(secret.id, secret);
    }
    return byId;
}

function sameEncryptedValue(left: SavedSecret, right: SavedSecret): boolean {
    return JSON.stringify(left.encryptedValue) === JSON.stringify(right.encryptedValue);
}

/**
 * Converts a legacy whole-array UI proposal into identity-local mutations and
 * replays only those intents against the current CAS winner.
 */
export function applySavedSecretReplacementIntent(input: Readonly<{
    current: Readonly<Record<string, unknown>>;
    base: readonly SavedSecret[];
    proposed: readonly SavedSecret[];
}>): Readonly<{
    settings: Readonly<Record<string, unknown>>;
}> {
    const baseById = indexUnique(input.base, 'Base');
    const proposedById = indexUnique(input.proposed, 'Proposed');
    let settings = input.current;

    const added = input.proposed.filter((secret) => !baseById.has(secret.id));
    for (const secret of [...added].reverse()) {
        const result = applyAccountSettingsSavedSecretMutation(
            settings,
            { kind: 'add', secret },
        );
        settings = result.settings;
    }

    for (const before of input.base) {
        const after = proposedById.get(before.id);
        if (!after) {
            const result = applyAccountSettingsSavedSecretMutation(
                settings,
                {
                    kind: 'delete',
                    secretId: before.id,
                    expectedUpdatedAt: before.updatedAt,
                },
            );
            settings = result.settings;
            continue;
        }
        const nameChanged = before.name !== after.name;
        const valueChanged = !sameEncryptedValue(before, after);
        const unsupportedChanged =
            before.kind !== after.kind
            || before.createdAt !== after.createdAt;
        if (
            unsupportedChanged
            || (nameChanged && valueChanged)
            || (!nameChanged && !valueChanged && before.updatedAt !== after.updatedAt)
        ) {
            throw new AccountSettingsSavedSecretMutationError(
                'saved_secret_invalid',
                'Whole-array SavedSecret proposal contains an unsupported compound change',
            );
        }
        if (!nameChanged && !valueChanged) continue;
        const result = applyAccountSettingsSavedSecretMutation(
            settings,
            nameChanged
                ? {
                    kind: 'rename',
                    secretId: before.id,
                    expectedUpdatedAt: before.updatedAt,
                    name: after.name,
                    updatedAt: after.updatedAt,
                }
                : {
                    kind: 'rotateGlobal',
                    secretId: before.id,
                    expectedUpdatedAt: before.updatedAt,
                    encryptedValue: after.encryptedValue,
                    updatedAt: after.updatedAt,
                },
        );
        settings = result.settings;
    }

    return Object.freeze({
        settings,
    });
}
