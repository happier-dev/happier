type ServiceRef = Readonly<{ pluginId: string; localId: string }>;

type SavedAccount = Readonly<{
    ref: Readonly<{ service: ServiceRef; accountId: string }>;
    authenticationModeId: string | null;
    revisionSemantics: 'revisioned' | 'legacy_unfenced';
    credentialRevision: string | null;
    savedSecretResourceIds?: readonly string[];
}>;

export type AccountDirectSaveTarget =
    | Readonly<{ kind: 'save'; account: Readonly<{ service: ServiceRef; accountId: string }>; expectedCredentialRevision?: string }>
    | Readonly<{ kind: 'rotate'; resourceId: string }>
    | Readonly<{ kind: 'unavailable' }>;

/**
 * Where an Account-direct key form saves. Adding creates a new account; re-entering
 * the key of an existing raw (0.2-format) account edits that exact credential
 * through the same Account-direct owner, which converts it to its one Saved Secret
 * record. An account already converted keeps that record: the new key rotates it
 * in place (same id, grants and references), so there is one record per key.
 */
export function resolveAccountDirectSaveTarget(input: Readonly<{
    intent: Readonly<{ kind: 'add' }> | Readonly<{ kind: 'reconnect'; accountId: string }>;
    service: ServiceRef;
    modeId: string;
    accounts: readonly SavedAccount[];
    newAccountId: () => string;
}>): AccountDirectSaveTarget {
    if (input.intent.kind === 'add') return { kind: 'save', account: { service: input.service, accountId: input.newAccountId() } };
    const accountId = input.intent.accountId;
    const current = input.accounts.find(account => account.ref.accountId === accountId
        && account.ref.service.pluginId === input.service.pluginId && account.ref.service.localId === input.service.localId);
    if (!current || current.revisionSemantics !== 'revisioned' || !current.credentialRevision
        || current.authenticationModeId !== input.modeId) return { kind: 'unavailable' };
    const records = current.savedSecretResourceIds ?? [];
    if (records.length > 0) return records.length === 1 ? { kind: 'rotate', resourceId: records[0]! } : { kind: 'unavailable' };
    return { kind: 'save', account: { service: input.service, accountId }, expectedCredentialRevision: current.credentialRevision };
}
