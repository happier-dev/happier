import {
    CONNECTED_PRESENTATION_ACCOUNT_KV_KEY_V1,
    CONNECTED_ACKNOWLEDGEMENTS_ACCOUNT_KV_KEY_V1,
    ConnectedPresentationContentV1Schema,
    ConnectedAcknowledgementsContentV1Schema,
    StoredConnectedPresentationContentV1Schema,
    StoredConnectedAcknowledgementsContentV1Schema,
    StoredConnectedPresentationRecordV1Schema,
    StoredConnectedAcknowledgementsRecordV1Schema,
    connectedEntitySubjectKeyV1,
    connectedAcknowledgementSubjectKeyV1,
    openConnectedPresentationContentV1,
    openConnectedAcknowledgementsContentV1,
    assertConnectedPresentationContentForModeV1,
    assertConnectedAcknowledgementsContentForModeV1,
    type StoredConnectedPresentationContentV1,
    type StoredConnectedAcknowledgementsContentV1,
    type ConnectedPresentationRowMutationV1,
    type ConnectedAcknowledgementsRowMutationV1,
} from '@happier-dev/protocol/connect/connectedAccountPresentationRowsV1';
import { markAccountChanged } from '@/app/changes/markAccountChanged';
import {
    readReservedAccountScopedKvRowInTx,
    mutateReservedAccountScopedKvRowInTx,
    type ReservedAccountScopedKvRowDomain,
} from '@/app/kv/reservedAccountScopedKvRow';
import type { Tx } from '@/storage/inTx';
import { acquireAccountEncryptionTransitionFenceInTx } from '@/app/encryption/accountEncryptionTransition';
import { listAllQualifiedConnectedAccountsInTx } from '@/app/api/routes/connect/qualifiedConnectedAccounts/credentialRepository';
import { listAllQualifiedConnectedAccountGroupsInTx } from '@/app/api/routes/connect/qualifiedConnectedAccounts/groupRepository';

export const connectedPresentationRowDomain: ReservedAccountScopedKvRowDomain<StoredConnectedPresentationContentV1> = {
    label: 'Connected presentation catalog',
    parseStoredEnvelope(value) {
        const parsed = StoredConnectedPresentationContentV1Schema.safeParse(value);
        return parsed.success ? parsed.data : null;
    },
    parseCandidateEnvelope(value) {
        const parsed = ConnectedPresentationContentV1Schema.safeParse(value);
        return parsed.success ? parsed.data : null;
    },
    parseMigrationStoredEnvelope(value) {
        const envelope = StoredConnectedPresentationContentV1Schema.safeParse(value);
        if (!envelope.success) return null;
        if (envelope.data.t === 'encrypted') return envelope.data;
        const record = StoredConnectedPresentationRecordV1Schema.safeParse(envelope.data.v);
        return record.success ? { t: 'plain', v: record.data } : null;
    },
    assertEnvelopeForMode: assertConnectedPresentationContentForModeV1,
};

export const connectedAcknowledgementsRowDomain: ReservedAccountScopedKvRowDomain<StoredConnectedAcknowledgementsContentV1> = {
    label: 'Connected acknowledgements catalog',
    parseStoredEnvelope(value) {
        const parsed = StoredConnectedAcknowledgementsContentV1Schema.safeParse(value);
        return parsed.success ? parsed.data : null;
    },
    parseCandidateEnvelope(value) {
        const parsed = ConnectedAcknowledgementsContentV1Schema.safeParse(value);
        return parsed.success ? parsed.data : null;
    },
    parseMigrationStoredEnvelope(value) {
        const envelope = StoredConnectedAcknowledgementsContentV1Schema.safeParse(value);
        if (!envelope.success) return null;
        if (envelope.data.t === 'encrypted') return envelope.data;
        const record = StoredConnectedAcknowledgementsRecordV1Schema.safeParse(envelope.data.v);
        return record.success ? { t: 'plain', v: record.data } : null;
    },
    assertEnvelopeForMode: assertConnectedAcknowledgementsContentForModeV1,
};

export function markConnectedPresentationRowChangedInTx(tx: Tx, input: Readonly<{ accountId: string; revision: number }>): Promise<number> {
    return markAccountChanged(tx, { accountId: input.accountId, kind: 'account', entityId: CONNECTED_PRESENTATION_ACCOUNT_KV_KEY_V1,
        hint: { connectedMetadata: true, domain: 'presentation', revision: input.revision } });
}

export function markConnectedAcknowledgementsRowChangedInTx(tx: Tx, input: Readonly<{ accountId: string; revision: number }>): Promise<number> {
    return markAccountChanged(tx, { accountId: input.accountId, kind: 'account', entityId: CONNECTED_ACKNOWLEDGEMENTS_ACCOUNT_KV_KEY_V1,
        hint: { connectedMetadata: true, domain: 'acknowledgements', revision: input.revision } });
}

export async function readConnectedPresentationRowInTx(tx: Tx, input: Readonly<{ accountId: string }>) {
    const row = await readReservedAccountScopedKvRowInTx(tx, { ...input,
        physicalKey: CONNECTED_PRESENTATION_ACCOUNT_KV_KEY_V1, domain: connectedPresentationRowDomain });
    return row.status === 'present' ? { status: 'present' as const, revision: row.revision, content: row.envelope } : row;
}

export async function readConnectedAcknowledgementsRowInTx(tx: Tx, input: Readonly<{ accountId: string }>) {
    const row = await readReservedAccountScopedKvRowInTx(tx, { ...input,
        physicalKey: CONNECTED_ACKNOWLEDGEMENTS_ACCOUNT_KV_KEY_V1, domain: connectedAcknowledgementsRowDomain });
    return row.status === 'present' ? { status: 'present' as const, revision: row.revision, content: row.envelope } : row;
}

async function admitConnectedMetadataMutationInTx<TEnvelope>(tx: Tx, input: Readonly<{
    accountId: string; expectedRevision: number | 'absent'; sourceSettingsVersion?: number;
    content: TEnvelope | null; domain: ReservedAccountScopedKvRowDomain<TEnvelope>;
}>) {
    const fence = await acquireAccountEncryptionTransitionFenceInTx(tx, input.accountId);
    if (fence.status === 'account_not_found') return { status: 'account-not-found' as const };
    if (fence.status === 'account_inconsistent') return { status: 'account-inconsistent' as const, reason: fence.reason };
    if (input.content !== null) {
        try { input.domain.assertEnvelopeForMode(input.content, fence.account.currentness.encryptionMode); }
        catch { return { status: 'account-mode-mismatch' as const }; }
    }
    if (input.expectedRevision === 'absent') {
        if (input.sourceSettingsVersion === undefined || input.content === null) {
            throw new Error('Connected metadata initialization requires captured source currentness');
        }
        if (fence.account.settingsVersion !== input.sourceSettingsVersion) {
            return { status: 'settings-conflict' as const, revision: fence.account.settingsVersion };
        }
    } else if (input.sourceSettingsVersion !== undefined) {
        throw new Error('Only connected metadata initialization admits a source Settings version');
    }
    return { status: 'ready' as const };
}

/** Initializes or edits the Account's presentation catalog; credential tables retain their own authority. */
export async function mutateConnectedPresentationRowInTx(tx: Tx, input: ConnectedPresentationRowMutationV1 & Readonly<{ accountId: string }>) {
    const admitted = await admitConnectedMetadataMutationInTx(tx, { ...input, domain: connectedPresentationRowDomain });
    if (admitted.status !== 'ready') return admitted;
    if (input.content?.t === 'plain') {
        const previous = await readConnectedPresentationRowInTx(tx, { accountId: input.accountId });
        if (previous.status !== 'present' && previous.status !== 'absent' && previous.status !== 'deleted') return previous;
        const opened = previous.status === 'present'
            ? openConnectedPresentationContentV1({ content: previous.content, mode: 'plain', material: null }) : null;
        if (opened && opened.status !== 'opened') return { status: 'invalid-stored-content' as const };
        const previousLabels = new Map(opened ? opened.record.entries.map(entry => [connectedEntitySubjectKeyV1(entry.subject), entry.label]) : []);
        const changed = input.content.v.entries.filter(entry => previousLabels.get(connectedEntitySubjectKeyV1(entry.subject)) !== entry.label);
        const [accounts, groups] = await Promise.all([
            changed.some(entry => entry.subject.kind === 'account') ? listAllQualifiedConnectedAccountsInTx(tx, { accountId: input.accountId }) : [],
            changed.some(entry => entry.subject.kind === 'group') ? listAllQualifiedConnectedAccountGroupsInTx(tx, { accountId: input.accountId }) : [],
        ]);
        const owned = new Set([
            ...accounts.map(account => connectedEntitySubjectKeyV1({ kind: 'account', account: account.ref })),
            ...groups.map(group => connectedEntitySubjectKeyV1({ kind: 'group', service: group.ref.service, groupId: group.ref.groupId })),
        ]);
        if (changed.some(entry => !owned.has(connectedEntitySubjectKeyV1(entry.subject)))) {
            return { status: 'invalid-stored-content' as const, reason: 'subject-not-owned' };
        }
    }
    return mutateReservedAccountScopedKvRowInTx(tx, { accountId: input.accountId,
        physicalKey: CONNECTED_PRESENTATION_ACCOUNT_KV_KEY_V1, expectedRevision: input.expectedRevision,
        envelope: input.content, domain: connectedPresentationRowDomain,
        markChanged: ({ tx: changeTx, revision }) => markConnectedPresentationRowChangedInTx(changeTx, { accountId: input.accountId, revision }) });
}

/** Account and exact-Machine warning scopes stay in this Account-owned catalog. */
export async function mutateConnectedAcknowledgementsRowInTx(tx: Tx, input: ConnectedAcknowledgementsRowMutationV1 & Readonly<{ accountId: string }>) {
    const admitted = await admitConnectedMetadataMutationInTx(tx, { ...input, domain: connectedAcknowledgementsRowDomain });
    if (admitted.status !== 'ready') return admitted;
    if (input.content?.t === 'plain') {
        const previous = await readConnectedAcknowledgementsRowInTx(tx, { accountId: input.accountId });
        if (previous.status !== 'present' && previous.status !== 'absent' && previous.status !== 'deleted') return previous;
        const opened = previous.status === 'present'
            ? openConnectedAcknowledgementsContentV1({ content: previous.content, mode: 'plain', material: null }) : null;
        if (opened && opened.status !== 'opened') return { status: 'invalid-stored-content' as const };
        const oldAcknowledgements = new Map(opened
            ? opened.record.entries.map(entry => [connectedAcknowledgementSubjectKeyV1(entry.subject), entry.acknowledged]) : []);
        const changedAdoptions = input.content.v.entries.filter(entry => entry.subject.kind === 'adoption'
            && oldAcknowledgements.get(connectedAcknowledgementSubjectKeyV1(entry.subject)) !== entry.acknowledged);
        if (changedAdoptions.length > 0) {
            const groups = await listAllQualifiedConnectedAccountGroupsInTx(tx, { accountId: input.accountId });
            const owned = new Set(groups.map(group => connectedEntitySubjectKeyV1({ kind: 'group', service: group.ref.service, groupId: group.ref.groupId })));
            if (changedAdoptions.some(entry => entry.subject.kind === 'adoption' && !owned.has(connectedEntitySubjectKeyV1({
                kind: 'group', service: entry.subject.service, groupId: entry.subject.groupId,
            })))) return { status: 'invalid-stored-content' as const, reason: 'subject-not-owned' };
        }
    }
    // Encrypted subject ownership and installed Agent identity are checked by the captured client inventory.
    return mutateReservedAccountScopedKvRowInTx(tx, { accountId: input.accountId,
        physicalKey: CONNECTED_ACKNOWLEDGEMENTS_ACCOUNT_KV_KEY_V1, expectedRevision: input.expectedRevision,
        envelope: input.content, domain: connectedAcknowledgementsRowDomain,
        markChanged: ({ tx: changeTx, revision }) => markConnectedAcknowledgementsRowChangedInTx(changeTx, { accountId: input.accountId, revision }) });
}
