import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';

import {
    readAttachmentEnvelopeLocalImagePaths,
    readSessionAttachmentEnvelopeRecordsV1,
} from '@happier-dev/protocol';

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
        return createHash('sha256').update(content).digest('hex') === params.sha256 ? content : null;
    } catch {
        return null;
    }
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
