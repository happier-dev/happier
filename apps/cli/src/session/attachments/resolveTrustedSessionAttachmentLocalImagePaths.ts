import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';

import { readAttachmentEnvelopeLocalImagePaths } from '@happier-dev/protocol';

type MetadataRecord = Record<string, unknown>;

function asRecord(value: unknown): MetadataRecord | null {
    return value && typeof value === 'object' && !Array.isArray(value) ? value as MetadataRecord : null;
}

function asRecordArray(value: unknown): MetadataRecord[] {
    return Array.isArray(value) ? value.map(asRecord).filter((entry): entry is MetadataRecord => Boolean(entry)) : [];
}

function readString(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
}

function normalizeAttachmentPath(value: unknown): string | null {
    const rawPath = readString(value);
    return rawPath ? rawPath.replace(/[\\]+/g, '/') : null;
}

function readAttachmentEnvelope(value: MetadataRecord): MetadataRecord[] {
    const happier = asRecord(value.happier);
    if (happier?.kind !== 'attachments.v1') return [];
    const payload = asRecord(happier.payload);
    return asRecordArray(payload?.attachments);
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

async function fileMatchesDeclaredUpload(params: Readonly<{
    cwd: string;
    uploadPath: string;
    sha256: string;
    sizeBytes: number | null;
}>): Promise<boolean> {
    try {
        const absolutePath = resolveAttachmentPath(params.cwd, params.uploadPath);
        const fileStat = await stat(absolutePath);
        if (!fileStat.isFile()) return false;
        if (params.sizeBytes !== null && fileStat.size !== params.sizeBytes) return false;
        const content = await readFile(absolutePath);
        return createHash('sha256').update(content).digest('hex') === params.sha256;
    } catch {
        return false;
    }
}

export async function resolveTrustedSessionAttachmentLocalImagePaths(params: Readonly<{
    cwd: string;
    metadata: unknown;
}>): Promise<ReadonlySet<string>> {
    const metadata = asRecord(params.metadata);
    const trusted = new Set<string>();
    if (!metadata) return trusted;

    const candidatePaths = readAttachmentEnvelopeLocalImagePaths(metadata);
    if (candidatePaths.size === 0) return trusted;

    for (const attachment of readAttachmentEnvelope(metadata)) {
        const normalizedPath = normalizeAttachmentPath(attachment.path);
        if (!normalizedPath || !candidatePaths.has(normalizedPath)) continue;
        const sha256 = readSha256(attachment.sha256);
        if (!sha256) continue;
        const sizeBytes = readSizeBytes(attachment.sizeBytes);
        if (await fileMatchesDeclaredUpload({
            cwd: params.cwd,
            uploadPath: normalizedPath,
            sha256,
            sizeBytes,
        })) {
            trusted.add(normalizedPath);
        }
    }

    return trusted;
}
