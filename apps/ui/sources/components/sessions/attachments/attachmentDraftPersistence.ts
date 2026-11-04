import { Platform } from 'react-native';
import { z } from 'zod/mini';
import { encodeBase64, decodeBase64 } from '@/encryption/base64';
import { resolveDeviceLocalSettingsSecretsKey } from '@/auth/storage/deviceLocalSecretKey';
import { encryptSecretString, decryptSecretString, EncryptedStringSchema } from '@/sync/encryption/secretSettings';
import { getPersistenceStorage } from '@/sync/domains/state/persistenceStorage';
import { readBrowserRecord, writeBrowserRecord, deleteBrowserRecord } from '@/sync/domains/state/browserRecordStorage';
import { serverAccountScopedStorageKey, type ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import type { AttachmentsUploadFileSource, AttachmentUploadSource } from '@/sync/domains/attachments/attachmentsUploadFileSource';
import type { AttachmentDraft } from './attachmentDraftModel';
import { t } from '@/text';

const metadata = { name: z.string(), mimeType: z.optional(z.nullable(z.string())) };
const fileSchema = z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('memory'), ...metadata, base64: z.string() }),
    z.object({ kind: z.literal('capture'), ...metadata, captureRef: z.string(), content: z.enum(['prepared', 'source']) }),
    z.object({ kind: z.literal('native'), ...metadata, uri: z.string() }),
]);
const sourceSchema = z.union([fileSchema, z.object({ kind: z.literal('folder'), name: z.string(),
    entries: z.array(z.object({ relativePath: z.string(), source: fileSchema })), directories: z.optional(z.array(z.string())) })]);
// The single-envelope writer ran on dev devices before per-source storage landed.
const recordSchema = z.discriminatedUnion('v', [
    z.object({ v: z.literal(1), key: z.string(), drafts: z.array(z.object({ id: z.string(), source: sourceSchema })) }),
    z.object({ v: z.literal(2), key: z.string(), drafts: z.array(z.object({ id: z.string() })) }),
]);
const sourceRecordSchema = z.object({ key: z.string(), id: z.string(), source: sourceSchema });
type SavedFile = z.infer<typeof fileSchema>;
type SavedSource = z.infer<typeof sourceSchema>;

// Upload progress and retries do not re-read or re-encode immutable source bytes.
const savedFiles = new WeakMap<AttachmentsUploadFileSource, Promise<SavedFile>>();
const savedSources = new WeakMap<AttachmentUploadSource, SavedSource>();
// The memory owner serializes writes per draft. Retain identities, never whole-record ciphertext.
const persistedSources = new Map<string, Map<string, AttachmentUploadSource>>();
function saveFile(source: AttachmentsUploadFileSource): Promise<SavedFile> {
    const existing = savedFiles.get(source);
    if (existing) return existing;
    const preparation = (async (): Promise<SavedFile> => {
        const name = source.kind === 'web' ? source.file.name : source.name;
        const mimeType = source.kind === 'web' ? source.file.type : source.mimeType;
        if (source.kind === 'native') return { kind: 'native', uri: source.uri, name, mimeType };
        if (source.kind === 'memory' && source.savedFile) return { ...source.savedFile, name, mimeType };
        const bytes = source.kind === 'memory' ? source.bytes : new Uint8Array(await source.file.arrayBuffer());
        return { kind: 'memory', name, mimeType, base64: encodeBase64(bytes) };
    })();
    savedFiles.set(source, preparation);
    return preparation;
}
async function saveSource(source: AttachmentUploadSource): Promise<SavedSource> {
    const saved = savedSources.get(source);
    if (saved) return saved;
    return source.kind === 'folder' ? { kind: 'folder', name: source.name,
        entries: await Promise.all(source.entries.map(async entry => ({ ...entry, source: await saveFile(entry.source) }))),
        ...(source.directories ? { directories: [...source.directories] } : {}) } : saveFile(source);
}

async function restoreFile(source: SavedFile): Promise<AttachmentsUploadFileSource> {
    let bytes: Uint8Array;
    if (source.kind === 'memory') bytes = decodeBase64(source.base64);
    else if (source.kind === 'capture') {
        const native = await import('@/desktop/capture/nativeCapture');
        bytes = await (source.content === 'prepared' ? native.readPreparedCapturePng(source.captureRef) : native.readCaptureSource(source.captureRef));
    } else {
        const { readAttachmentFileBytes } = await import('@/sync/domains/attachments/prepareAttachmentPayloads');
        bytes = await readAttachmentFileBytes(source);
    }
    return { kind: 'memory', name: source.name, mimeType: source.mimeType, bytes,
        ...(source.kind === 'memory' ? {} : { savedFile: source.kind === 'capture'
            ? { kind: 'capture', captureRef: source.captureRef, content: source.content } : { kind: 'native', uri: source.uri } }),
        ...(source.mimeType?.startsWith('image/') ? { previewUri: `data:${source.mimeType};base64,${encodeBase64(bytes)}` } : {}) };
}
async function restoreSource(source: SavedSource): Promise<AttachmentUploadSource> {
    return source.kind === 'folder' ? { kind: 'folder', name: source.name, mimeType: 'inode/directory',
        entries: await Promise.all(source.entries.map(async entry => ({ ...entry, source: await restoreFile(entry.source) }))),
        ...(source.directories ? { directories: source.directories } : {}) } : restoreFile(source);
}

function recordKey(key: string, scope: ServerAccountScope): string {
    return `${serverAccountScopedStorageKey('composer-attachment-sources-v1', scope)}:${key}`;
}
function sourceKey(storageKey: string, id: string): string {
    return `${storageKey}:source:${encodeURIComponent(id)}`;
}
function readRecord(key: string): Promise<string | undefined> {
    return Platform.OS === 'web' ? readBrowserRecord(key) : Promise.resolve(getPersistenceStorage().getString(key));
}
async function writeRecord(key: string, value: string): Promise<void> {
    if (Platform.OS === 'web') await writeBrowserRecord(key, value);
    else getPersistenceStorage().set(key, value);
}
async function deleteRecord(key: string): Promise<void> {
    if (Platform.OS === 'web') await deleteBrowserRecord(key);
    else getPersistenceStorage().delete(key);
}
function openRecord(raw: string, secret: Uint8Array): unknown {
    const opened = decryptSecretString(EncryptedStringSchema.parse(JSON.parse(raw)), secret);
    if (opened === null) throw new Error('Attachment recovery record could not be opened');
    return JSON.parse(opened);
}
export async function readAttachmentDraftRecord(key: string, scope: ServerAccountScope): Promise<readonly AttachmentDraft[]> {
    const storageKey = recordKey(key, scope);
    const raw = await readRecord(storageKey);
    if (!raw) return [];
    const secret = await resolveDeviceLocalSettingsSecretsKey(scope);
    if (!secret) throw new Error('Attachment recovery key is unavailable');
    const record = recordSchema.parse(openRecord(raw, secret));
    if (record.key !== key) throw new Error('Attachment recovery record belongs to another draft');
    const drafts = record.v === 1 ? record.drafts : await Promise.all(record.drafts.map(async ({ id }) => {
        const rawSource = await readRecord(sourceKey(storageKey, id));
        if (!rawSource) throw new Error('Attachment recovery source record is missing');
        const saved = sourceRecordSchema.parse(openRecord(rawSource, secret));
        if (saved.key !== key || saved.id !== id) throw new Error('Attachment recovery source belongs to another draft');
        return saved;
    }));
    const restored = await Promise.all(drafts.map(async draft => {
        try {
            const source = await restoreSource(draft.source);
            savedSources.set(source, draft.source);
            return { id: draft.id, source, status: 'pending' as const };
        }
        catch {
            // Keep the occurrence visible and unsendable; never reinterpret a missing file as an empty image.
            const source: AttachmentUploadSource = draft.source.kind === 'folder'
                ? { kind: 'folder', name: draft.source.name, mimeType: 'inode/directory', entries: [] }
                : { kind: 'memory', name: draft.source.name, mimeType: draft.source.mimeType, bytes: new Uint8Array(),
                    ...(draft.source.kind === 'capture' ? { savedFile: { kind: 'capture', captureRef: draft.source.captureRef, content: draft.source.content } } : {}),
                    ...(draft.source.kind === 'native' ? { savedFile: { kind: 'native', uri: draft.source.uri } } : {}) };
            savedSources.set(source, draft.source);
            return { id: draft.id, source, status: 'error' as const, errorCode: 'attachment_source_missing',
                error: t('attachments.alerts.sourceMissingBody') };
        }
    }));
    persistedSources.set(storageKey, record.v === 2 ? new Map(restored.map(draft => [draft.id, draft.source])) : new Map());
    return restored;
}
export async function writeAttachmentDraftRecord(key: string, scope: ServerAccountScope, drafts: readonly AttachmentDraft[]): Promise<void> {
    const storageKey = recordKey(key, scope);
    const previous = persistedSources.get(storageKey) ?? new Map<string, AttachmentUploadSource>();
    if (drafts.length === 0) {
        await deleteRecord(storageKey);
        await Promise.all([...previous.keys()].map(id => deleteRecord(sourceKey(storageKey, id))));
        persistedSources.delete(storageKey);
        return;
    }
    const secret = await resolveDeviceLocalSettingsSecretsKey(scope);
    if (!secret) throw new Error('Attachment recovery key is unavailable');
    const next = new Map(drafts.map(draft => [draft.id, draft.source]));
    await Promise.all(drafts.map(async draft => {
        if (previous.get(draft.id) === draft.source) return;
        const source = await saveSource(draft.source);
        await writeRecord(sourceKey(storageKey, draft.id), JSON.stringify(encryptSecretString(JSON.stringify({ key, id: draft.id, source }), secret)));
    }));
    const record = { v: 2, key, drafts: drafts.map(draft => ({ id: draft.id })) };
    const sealed = JSON.stringify(encryptSecretString(JSON.stringify(record), secret));
    await writeRecord(storageKey, sealed);
    persistedSources.set(storageKey, next);
    await Promise.all([...previous.keys()].filter(id => !next.has(id)).map(id => deleteRecord(sourceKey(storageKey, id))));
}
