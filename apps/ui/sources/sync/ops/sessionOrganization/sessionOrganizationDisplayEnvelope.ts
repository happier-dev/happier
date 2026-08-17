import {
    openAccountScopedBlobCiphertext,
    sealAccountScopedBlobCiphertext,
    SessionOrganizationContentEnvelopeSchema,
    type AccountEncryptionMigrateSessionOrganizationDirective,
    type SessionOrganizationAccountEncryptionMigrationInventory,
    type SessionOrganizationContentEnvelope,
    type SessionOrganizationDisplayState as ProtocolSessionOrganizationDisplayState,
    type SessionOrganizationFolder,
    type SessionOrganizationLabel,
    type SessionOrganizationSnapshot,
    type SessionOrganizationTag,
} from '@happier-dev/protocol';

import { createEncryptionFromAuthCredentials } from '@/auth/encryption/createEncryptionFromAuthCredentials';
import {
    isTokenOnlyAuthCredentials,
    type AuthCredentials,
} from '@/auth/storage/tokenStorage';
import { getRandomBytes } from '@/platform/cryptoRandom';
import { fetchAccountEncryptionMode } from '@/sync/api/account/apiAccountEncryptionMode';
import type {
    SessionOrganizationDisplayState,
    UiSessionOrganizationFolder,
    UiSessionOrganizationLabel,
    UiSessionOrganizationSnapshot,
    UiSessionOrganizationTag,
} from '@/sync/domains/session/organization/types';

type PlainSessionOrganizationDisplayEnvelope = Extract<SessionOrganizationContentEnvelope, { t: 'plain' }>;
type EncryptedSessionOrganizationDisplayEnvelope = Extract<SessionOrganizationContentEnvelope, { t: 'encrypted' }>;

const SESSION_ORGANIZATION_DISPLAY_KIND = 'session_organization_display';

function sealDisplayPayload(params: Readonly<{
    machineKey: Uint8Array;
    payload: unknown;
}>): string {
    return sealAccountScopedBlobCiphertext({
        kind: SESSION_ORGANIZATION_DISPLAY_KIND,
        material: { type: 'dataKey', machineKey: params.machineKey },
        payload: params.payload,
        randomBytes: getRandomBytes,
    });
}

function openDisplayPayload(params: Readonly<{
    machineKey: Uint8Array;
    ciphertext: string;
}>): Readonly<
    | { status: 'opened'; value: unknown }
    | { status: 'unreadable' }
> {
    const opened = openAccountScopedBlobCiphertext({
        kind: SESSION_ORGANIZATION_DISPLAY_KIND,
        material: { type: 'dataKey', machineKey: params.machineKey },
        ciphertext: params.ciphertext,
    });
    return opened
        ? { status: 'opened', value: opened.value }
        : { status: 'unreadable' };
}

async function getAccountMachineKey(credentials: AuthCredentials): Promise<Uint8Array> {
    const encryption = await createEncryptionFromAuthCredentials(credentials);
    return encryption.getContentPrivateKey();
}

async function getAccountMachineKeyForRead(credentials: AuthCredentials): Promise<Uint8Array | null> {
    return isTokenOnlyAuthCredentials(credentials)
        ? null
        : await getAccountMachineKey(credentials);
}

function plainEnvelope(value: unknown): PlainSessionOrganizationDisplayEnvelope {
    return SessionOrganizationContentEnvelopeSchema.parse({
        t: 'plain',
        v: value,
    }) as PlainSessionOrganizationDisplayEnvelope;
}

function mapProtocolUnavailableDisplayState(
    state: ProtocolSessionOrganizationDisplayState | undefined,
): SessionOrganizationDisplayState | null {
    return state
        ? {
            status: 'locked',
            reason: state.reason,
        }
        : null;
}

export type OpenSessionOrganizationDisplayEnvelopeResult = Readonly<{
    envelope: SessionOrganizationContentEnvelope | null;
    displayState: SessionOrganizationDisplayState;
}>;

export async function prepareSessionOrganizationDisplayEnvelope(params: Readonly<{
    credentials: AuthCredentials;
    value: unknown;
}>): Promise<SessionOrganizationContentEnvelope> {
    const mode = await fetchAccountEncryptionMode(params.credentials);
    if (mode.mode === 'plain') {
        return plainEnvelope(params.value);
    }
    const machineKey = await getAccountMachineKey(params.credentials);
    return {
        t: 'encrypted',
        c: sealDisplayPayload({ machineKey, payload: params.value }),
    };
}

export async function prepareSessionOrganizationDisplayEnvelopeForWrite(params: Readonly<{
    credentials: AuthCredentials;
    envelope: SessionOrganizationContentEnvelope | null | undefined;
}>): Promise<SessionOrganizationContentEnvelope | null> {
    if (!params.envelope) return null;
    if (params.envelope.t === 'encrypted') return params.envelope;
    return prepareSessionOrganizationDisplayEnvelope({
        credentials: params.credentials,
        value: params.envelope.v,
    });
}

export async function openSessionOrganizationDisplayEnvelope(params: Readonly<{
    credentials: AuthCredentials;
    envelope: SessionOrganizationContentEnvelope | null | undefined;
}>): Promise<OpenSessionOrganizationDisplayEnvelopeResult> {
    const envelope = params.envelope ?? null;
    if (!envelope) {
        return {
            envelope: null,
            displayState: { status: 'available', value: null },
        };
    }
    if (envelope.t === 'plain') {
        return {
            envelope,
            displayState: { status: 'available', value: envelope.v },
        };
    }
    const machineKey = await getAccountMachineKeyForRead(params.credentials);
    if (!machineKey) {
        return {
            envelope,
            displayState: {
                status: 'locked',
                reason: 'account_key_unavailable',
            },
        };
    }
    const value = openDisplayPayload({
        machineKey,
        ciphertext: (envelope as EncryptedSessionOrganizationDisplayEnvelope).c,
    });
    return value.status === 'unreadable'
        ? {
            envelope,
            displayState: {
                status: 'locked',
                reason: 'content_unreadable',
            },
        }
        : {
            envelope,
            displayState: {
                status: 'available',
                value: value.value,
            },
        };
}

function openDisplayEnvelopeWithMachineKey(
    machineKey: Uint8Array,
    envelope: SessionOrganizationContentEnvelope | null | undefined,
): OpenSessionOrganizationDisplayEnvelopeResult {
    if (!envelope) {
        return {
            envelope: null,
            displayState: { status: 'available', value: null },
        };
    }
    if (envelope.t === 'plain') {
        return {
            envelope,
            displayState: { status: 'available', value: envelope.v },
        };
    }
    const value = openDisplayPayload({ machineKey, ciphertext: envelope.c });
    return value.status === 'unreadable'
        ? {
            envelope,
            displayState: {
                status: 'locked',
                reason: 'content_unreadable',
            },
        }
        : {
            envelope,
            displayState: {
                status: 'available',
                value: value.value,
            },
        };
}

export async function buildSessionOrganizationAccountEncryptionMigrationDirective(
    params: Readonly<{
        inventory: SessionOrganizationAccountEncryptionMigrationInventory;
        sourceCredentials: AuthCredentials;
        targetCredentials: AuthCredentials | null;
        toMode: 'plain' | 'e2ee';
    }>,
): Promise<AccountEncryptionMigrateSessionOrganizationDirective> {
    const rows = [
        ...params.inventory.folders.map((row) => ({
            kind: 'folder' as const,
            row,
        })),
        ...params.inventory.tags.map((row) => ({
            kind: 'tag' as const,
            row,
        })),
        ...params.inventory.labels.map((row) => ({
            kind: 'label' as const,
            row,
        })),
    ];
    if (rows.length === 0) return { action: 'assert_empty' };
    const expectedSourceEnvelopeType = params.toMode === 'plain'
        ? 'encrypted'
        : 'plain';
    if (rows.some(({ row }) =>
        row.display.t !== expectedSourceEnvelopeType)) {
        throw new Error(
            'Session Organization migration inventory does not match the source mode',
        );
    }

    const sourceMachineKey = rows.some(
        ({ row }) => row.display.t === 'encrypted',
    )
        ? await getAccountMachineKeyForRead(params.sourceCredentials)
        : null;
    if (
        rows.some(({ row }) => row.display.t === 'encrypted')
        && !sourceMachineKey
    ) {
        throw new Error(
            'Account encryption material is unavailable for Session Organization source content',
        );
    }
    if (params.toMode === 'e2ee' && !params.targetCredentials) {
        throw new Error(
            'Account encryption material is unavailable for Session Organization target content',
        );
    }
    const targetMachineKey = params.toMode === 'e2ee'
        ? await getAccountMachineKey(params.targetCredentials!)
        : null;

    const reseal = (
        envelope: SessionOrganizationContentEnvelope,
    ): SessionOrganizationContentEnvelope => {
        const sourceValue = envelope.t === 'plain'
            ? { status: 'opened' as const, value: envelope.v }
            : openDisplayPayload({
                machineKey: sourceMachineKey!,
                ciphertext: envelope.c,
            });
        if (sourceValue.status === 'unreadable') {
            throw new Error(
                'Session Organization source display content is unreadable',
            );
        }
        return params.toMode === 'plain'
            ? plainEnvelope(sourceValue.value)
            : {
                t: 'encrypted',
                c: sealDisplayPayload({
                    machineKey: targetMachineKey!,
                    payload: sourceValue.value,
                }),
            };
    };

    return {
        action: 'migrate',
        expectedVersion: params.inventory.version,
        folders: params.inventory.folders.map((folder) => ({
            folderId: folder.folderId,
            expectedDisplay: folder.display,
            display: reseal(folder.display),
        })),
        tags: params.inventory.tags.map((tag) => ({
            tagId: tag.tagId,
            expectedDisplay: tag.display,
            display: reseal(tag.display),
        })),
        labels: params.inventory.labels.map((label) => ({
            labelKind: label.labelKind,
            scopeKey: label.scopeKey,
            expectedDisplay: label.display,
            display: reseal(label.display),
        })),
    };
}

export async function openSessionOrganizationFolderDisplay(params: Readonly<{
    credentials: AuthCredentials;
    folder: SessionOrganizationFolder;
}>): Promise<UiSessionOrganizationFolder> {
    const unavailableDisplayState = mapProtocolUnavailableDisplayState(params.folder.displayState);
    if (unavailableDisplayState) {
        return {
            ...params.folder,
            displayState: unavailableDisplayState,
        };
    }
    const opened = await openSessionOrganizationDisplayEnvelope({
        credentials: params.credentials,
        envelope: params.folder.display,
    });
    return {
        ...params.folder,
        display: opened.envelope,
        displayState: opened.displayState,
    };
}

export async function openSessionOrganizationTagDisplay(params: Readonly<{
    credentials: AuthCredentials;
    tag: SessionOrganizationTag;
}>): Promise<UiSessionOrganizationTag> {
    const unavailableDisplayState = mapProtocolUnavailableDisplayState(params.tag.displayState);
    if (unavailableDisplayState) {
        return {
            ...params.tag,
            displayState: unavailableDisplayState,
        };
    }
    const opened = await openSessionOrganizationDisplayEnvelope({
        credentials: params.credentials,
        envelope: params.tag.display,
    });
    return {
        ...params.tag,
        display: opened.envelope,
        displayState: opened.displayState,
    };
}

export async function openSessionOrganizationLabelDisplay(params: Readonly<{
    credentials: AuthCredentials;
    label: SessionOrganizationLabel;
}>): Promise<UiSessionOrganizationLabel> {
    const unavailableDisplayState = mapProtocolUnavailableDisplayState(params.label.displayState);
    if (unavailableDisplayState) {
        return {
            ...params.label,
            displayState: unavailableDisplayState,
        };
    }
    const opened = await openSessionOrganizationDisplayEnvelope({
        credentials: params.credentials,
        envelope: params.label.display,
    });
    return {
        ...params.label,
        display: opened.envelope,
        displayState: opened.displayState,
    };
}

export async function openSessionOrganizationSnapshotDisplayEnvelopes(params: Readonly<{
    credentials: AuthCredentials;
    snapshot: SessionOrganizationSnapshot;
}>): Promise<UiSessionOrganizationSnapshot> {
    const hasEncryptedDisplay = params.snapshot.folders.some(
        (folder) => !folder.displayState && folder.display?.t === 'encrypted',
    )
        || params.snapshot.tags.some(
            (tag) => !tag.displayState && tag.display?.t === 'encrypted',
        )
        || params.snapshot.labels.some(
            (label) => !label.displayState && label.display?.t === 'encrypted',
        );
    const machineKey = hasEncryptedDisplay
        ? await getAccountMachineKeyForRead(params.credentials)
        : null;
    const open = (
        envelope: SessionOrganizationContentEnvelope | null,
    ): OpenSessionOrganizationDisplayEnvelopeResult => {
        if (envelope?.t === 'encrypted' && !machineKey) {
            return {
                envelope,
                displayState: {
                    status: 'locked',
                    reason: 'account_key_unavailable',
                },
            };
        }
        return machineKey
            ? openDisplayEnvelopeWithMachineKey(machineKey, envelope)
            : {
                envelope,
                displayState: {
                    status: 'available',
                    value: envelope?.t === 'plain' ? envelope.v : null,
                },
            };
    };
    const folders = params.snapshot.folders.map((folder) => {
        const unavailableDisplayState = mapProtocolUnavailableDisplayState(folder.displayState);
        const opened = unavailableDisplayState
            ? { envelope: folder.display, displayState: unavailableDisplayState }
            : open(folder.display);
        return {
            ...folder,
            display: opened.envelope,
            displayState: opened.displayState,
        };
    });
    const tags = params.snapshot.tags.map((tag) => {
        const unavailableDisplayState = mapProtocolUnavailableDisplayState(tag.displayState);
        const opened = unavailableDisplayState
            ? { envelope: tag.display, displayState: unavailableDisplayState }
            : open(tag.display);
        return {
            ...tag,
            display: opened.envelope,
            displayState: opened.displayState,
        };
    });
    const labels = params.snapshot.labels.map((label) => {
        const unavailableDisplayState = mapProtocolUnavailableDisplayState(label.displayState);
        const opened = unavailableDisplayState
            ? { envelope: label.display, displayState: unavailableDisplayState }
            : open(label.display);
        return {
            ...label,
            display: opened.envelope,
            displayState: opened.displayState,
        };
    });

    return {
        ...params.snapshot,
        folders,
        tags,
        labels,
    };
}
