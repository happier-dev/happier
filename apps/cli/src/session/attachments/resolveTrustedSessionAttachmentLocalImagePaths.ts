import { createHash } from 'node:crypto';
import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';

import { readAttachmentEnvelopeLocalImagePaths } from '@happier-dev/protocol/runtime/input/structuredInputV1';
import { readSessionAttachmentEnvelopeRecordsV1 } from '@happier-dev/protocol/runtime/input/structuredInputV1';
import type { BrowserScreenshotMediaReferenceV1, SessionImageMediaReferenceV1, PluginSessionAccessScope } from '@happier-dev/protocol';
import { hasPluginSessionAccess } from '@happier-dev/protocol/sessions/pluginAccess';
import { normalizeSessionAttachmentUploadPath } from '@happier-dev/protocol/runtime/input/structuredInputV1';
import { configuration } from '@/configuration';

import {
    normalizeSessionMediaMimeType,
    sniffSessionMediaMimeType,
} from '@/session/media/mime';

function readString(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
}

function normalizeAttachmentPath(value: unknown): string | null {
    const rawPath = readString(value);
    return rawPath ? rawPath.replace(/[\\]+/g, '/') : null;
}

function readSha256(value: unknown): string | null {
    const candidate = readString(value);
    return candidate && /^[a-f0-9]{64}$/i.test(candidate) ? candidate.toLowerCase() : null;
}

function readSizeBytes(value: unknown): number | null {
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function resolveAttachmentPath(cwd: string, uploadPath: string): string {
    return path.isAbsolute(uploadPath) ? uploadPath : path.resolve(cwd, uploadPath);
}

export async function readVerifiedSessionAttachmentLocalImage(params: Readonly<{
    cwd: string;
    uploadPath: string;
    sha256: string;
    sizeBytes: number | null;
    maxBytes?: number;
}>): Promise<Buffer | null> {
    try {
        const absolutePath = resolveAttachmentPath(params.cwd, params.uploadPath);
        const fileStat = await stat(absolutePath);
        if (!fileStat.isFile()) return null;
        if (params.sizeBytes !== null && fileStat.size !== params.sizeBytes) return null;
        if (params.maxBytes !== undefined && fileStat.size > params.maxBytes) return null;
        const content = await readFile(absolutePath);
        if (params.sizeBytes !== null && content.byteLength !== params.sizeBytes) return null;
        if (params.maxBytes !== undefined && content.byteLength > params.maxBytes) return null;
        return createHash('sha256').update(content).digest('hex') === params.sha256 ? content : null;
    } catch {
        return null;
    }
}

export type SessionStructuredImageInputVerification =
    | Readonly<{
        status: 'verified';
        bytes: Buffer;
        mimeType: string;
        filename: string;
    }>
    | Readonly<{ status: 'untrusted' }>
    | Readonly<{ status: 'invalid' }>;

export class SessionMediaUnavailableError extends Error {
    readonly code: string;
    constructor(code = 'session_media_unavailable', message = 'Image bytes are unavailable or outside the current Session') {
        super(message);
        this.code = code;
    }
}

export class BrowserMediaUnavailableError extends SessionMediaUnavailableError {
    constructor() { super('browser_media_unavailable', 'Browser screenshot bytes are unavailable or outside the current Session'); }
}

/** One reference-to-image projection for MCP and the Agent dispatch owner. */
export function sessionMediaToStructuredImageInput(media: SessionImageMediaReferenceV1) {
    if (!media.file) throw new SessionMediaUnavailableError();
    return {
        id: `session-media:${media.mediaId}`, kind: 'localImage' as const, path: media.file.path,
        mimeType: media.file.mimeType, sha256: media.file.sha256, sizeBytes: media.sizeBytes,
        provenance: { kind: 'sessionMediaArtifact' as const, sessionId: media.file.sessionId, storage: media.file.storage },
    };
}

export function browserMediaToStructuredImageInput(media: BrowserScreenshotMediaReferenceV1) {
    if (!media.file) throw new BrowserMediaUnavailableError();
    const image = sessionMediaToStructuredImageInput(media);
    return { ...image, id: `browser-media:${media.mediaId}`,
        provenance: { ...image.provenance, kind: 'browserSessionMedia' as const } };
}

export async function verifySessionStructuredImageInput(params: Readonly<{
    cwd: string;
    sessionId?: string;
    image: Readonly<Record<string, unknown>>;
    maxBytes: number;
    /** Required only at plugin disclosure; the host resolves every fact. */
    pluginAccess?: Readonly<{
        scopes: readonly PluginSessionAccessScope[];
        session: Readonly<{ id: string; machineId?: string; projectId?: string }>;
        accountEncryptionMode: 'plain' | 'e2ee';
        sessionEncryptionMode: 'plain' | 'e2ee';
    }>;
}>): Promise<SessionStructuredImageInputVerification> {
    if (params.pluginAccess && (
        params.sessionId !== params.pluginAccess.session.id
        || params.pluginAccess.accountEncryptionMode !== params.pluginAccess.sessionEncryptionMode
        || !hasPluginSessionAccess({ scopes: params.pluginAccess.scopes, session: params.pluginAccess.session, access: 'read' })
    )) return { status: 'untrusted' };
    const provenance = params.image.provenance;
    if (
        params.image.kind !== 'localImage'
        || !provenance
        || typeof provenance !== 'object'
        || Array.isArray(provenance)
    ) {
        return { status: 'untrusted' };
    }
    const source = provenance as Record<string, unknown>;
    const browser = source.kind === 'browserSessionMedia';
    const artifact = source.kind === 'sessionMediaArtifact';
    if (!browser && !artifact && source.kind !== 'sessionAttachmentUpload') return { status: 'untrusted' };
    let cwd = params.cwd;
    let uploadPath = normalizeSessionAttachmentUploadPath(params.image.path);
    if (browser || artifact) {
        if (!params.sessionId || source.sessionId !== params.sessionId
            || (source.storage !== 'session' && source.storage !== 'daemon')) return { status: 'untrusted' };
        cwd = source.storage === 'daemon' ? configuration.happyHomeDir : params.cwd;
        const candidate = normalizeAttachmentPath(params.image.path);
        const bucket = `.happier/uploads/artifacts/${params.sessionId}/`;
        if (candidate?.startsWith(bucket) && !candidate.includes('\0')
            && !candidate.split('/').some((segment) => segment === '.' || segment === '..')) {
            uploadPath = candidate;
            try {
                const root = await realpath(cwd);
                const actual = await realpath(path.resolve(cwd, candidate));
                const relative = path.relative(path.resolve(root, bucket), actual);
                if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return { status: 'untrusted' };
            } catch { return { status: 'untrusted' }; }
        } else if (artifact || source.storage === 'daemon') {
            return { status: 'untrusted' };
        }
    }
    const sha256 = readSha256(params.image.sha256);
    const sizeBytes = readSizeBytes(params.image.sizeBytes);
    if (!uploadPath || !sha256 || sizeBytes === null) return { status: 'untrusted' };
    const bytes = await readVerifiedSessionAttachmentLocalImage({
        cwd,
        uploadPath,
        sha256,
        sizeBytes,
        maxBytes: params.maxBytes,
    });
    if (!bytes) return { status: 'untrusted' };
    const mimeType = sniffSessionMediaMimeType(bytes);
    if (!mimeType?.startsWith('image/')) return { status: 'invalid' };
    const declaredMimeType = normalizeSessionMediaMimeType(params.image.mimeType);
    if (params.image.mimeType !== undefined && declaredMimeType !== mimeType) return { status: 'invalid' };
    return Object.freeze({
        status: 'verified' as const,
        bytes,
        mimeType,
        filename: path.posix.basename(uploadPath),
    });
}

export async function resolveTrustedSessionAttachmentLocalImagePaths(params: Readonly<{
    cwd: string;
    metadata: unknown;
}>): Promise<ReadonlySet<string>> {
    const trusted = new Set<string>();
    const candidatePaths = readAttachmentEnvelopeLocalImagePaths(params.metadata);
    if (candidatePaths.size === 0) return trusted;

    for (const attachment of readSessionAttachmentEnvelopeRecordsV1(params.metadata)) {
        const normalizedPath = normalizeAttachmentPath(attachment.path);
        if (!normalizedPath || !candidatePaths.has(normalizedPath)) continue;
        const sha256 = readSha256(attachment.sha256);
        if (!sha256) continue;
        const sizeBytes = readSizeBytes(attachment.sizeBytes);
        if (await readVerifiedSessionAttachmentLocalImage({
            cwd: params.cwd,
            uploadPath: normalizedPath,
            sha256,
            sizeBytes,
        }) !== null) {
            trusted.add(normalizedPath);
        }
    }

    return trusted;
}
