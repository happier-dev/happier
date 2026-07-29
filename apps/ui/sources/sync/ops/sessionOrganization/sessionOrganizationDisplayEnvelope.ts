import {
    openAccountScopedBlobCiphertext,
    sealAccountScopedBlobCiphertext,
    type SessionOrganizationContentEnvelope,
    type SessionOrganizationFolder,
    type SessionOrganizationLabel,
    type SessionOrganizationSnapshot,
    type SessionOrganizationTag,
} from '@happier-dev/protocol';

import { createEncryptionFromAuthCredentials } from '@/auth/encryption/createEncryptionFromAuthCredentials';
import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import { getRandomBytes } from '@/platform/cryptoRandom';
import { fetchAccountEncryptionMode } from '@/sync/api/account/apiAccountEncryptionMode';

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
}>): unknown | null {
    return openAccountScopedBlobCiphertext({
        kind: SESSION_ORGANIZATION_DISPLAY_KIND,
        material: { type: 'dataKey', machineKey: params.machineKey },
        ciphertext: params.ciphertext,
    })?.value ?? null;
}

async function getAccountMachineKey(credentials: AuthCredentials): Promise<Uint8Array> {
    const encryption = await createEncryptionFromAuthCredentials(credentials);
    return encryption.getContentPrivateKey();
}

function plainEnvelope(value: unknown): PlainSessionOrganizationDisplayEnvelope {
    return { t: 'plain', v: value };
}

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
}>): Promise<SessionOrganizationContentEnvelope | null> {
    const envelope = params.envelope;
    if (!envelope) return null;
    if (envelope.t === 'plain') return envelope;
    const machineKey = await getAccountMachineKey(params.credentials);
    const value = openDisplayPayload({
        machineKey,
        ciphertext: (envelope as EncryptedSessionOrganizationDisplayEnvelope).c,
    });
    return value === null ? envelope : plainEnvelope(value);
}

async function openDisplayEnvelopeWithMachineKey(
    machineKey: Uint8Array,
    envelope: SessionOrganizationContentEnvelope | null | undefined,
): Promise<SessionOrganizationContentEnvelope | null> {
    if (!envelope) return null;
    if (envelope.t === 'plain') return envelope;
    const value = openDisplayPayload({ machineKey, ciphertext: envelope.c });
    return value === null ? envelope : plainEnvelope(value);
}

export async function openSessionOrganizationFolderDisplay(params: Readonly<{
    credentials: AuthCredentials;
    folder: SessionOrganizationFolder;
}>): Promise<SessionOrganizationFolder> {
    const display = await openSessionOrganizationDisplayEnvelope({
        credentials: params.credentials,
        envelope: params.folder.display,
    });
    return display === params.folder.display ? params.folder : { ...params.folder, display };
}

export async function openSessionOrganizationTagDisplay(params: Readonly<{
    credentials: AuthCredentials;
    tag: SessionOrganizationTag;
}>): Promise<SessionOrganizationTag> {
    const display = await openSessionOrganizationDisplayEnvelope({
        credentials: params.credentials,
        envelope: params.tag.display,
    });
    return display === params.tag.display ? params.tag : { ...params.tag, display };
}

export async function openSessionOrganizationLabelDisplay(params: Readonly<{
    credentials: AuthCredentials;
    label: SessionOrganizationLabel;
}>): Promise<SessionOrganizationLabel> {
    const display = await openSessionOrganizationDisplayEnvelope({
        credentials: params.credentials,
        envelope: params.label.display,
    });
    return display === params.label.display ? params.label : { ...params.label, display };
}

export async function openSessionOrganizationSnapshotDisplayEnvelopes(params: Readonly<{
    credentials: AuthCredentials;
    snapshot: SessionOrganizationSnapshot;
}>): Promise<SessionOrganizationSnapshot> {
    const hasEncryptedDisplay = params.snapshot.folders.some((folder) => folder.display?.t === 'encrypted')
        || params.snapshot.tags.some((tag) => tag.display?.t === 'encrypted')
        || params.snapshot.labels.some((label) => label.display?.t === 'encrypted');
    if (!hasEncryptedDisplay) return params.snapshot;

    const machineKey = await getAccountMachineKey(params.credentials);
    const folders = await Promise.all(params.snapshot.folders.map(async (folder) => {
        const display = await openDisplayEnvelopeWithMachineKey(machineKey, folder.display);
        return display === folder.display ? folder : { ...folder, display };
    }));
    const tags = await Promise.all(params.snapshot.tags.map(async (tag) => {
        const display = await openDisplayEnvelopeWithMachineKey(machineKey, tag.display);
        return display === tag.display ? tag : { ...tag, display };
    }));
    const labels = await Promise.all(params.snapshot.labels.map(async (label) => {
        const display = await openDisplayEnvelopeWithMachineKey(machineKey, label.display);
        return display === label.display ? label : { ...label, display };
    }));

    return {
        ...params.snapshot,
        folders,
        tags,
        labels,
    };
}
