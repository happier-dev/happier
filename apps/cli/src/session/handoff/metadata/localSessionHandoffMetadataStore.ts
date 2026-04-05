import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

type MetadataRecord = Record<string, unknown>;

function asMetadataRecord(value: unknown): MetadataRecord | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return null;
    }
    return value as MetadataRecord;
}

function buildVendorResumeIdFingerprint(vendorResumeId: string): string {
    return createHash('sha256').update(vendorResumeId).digest('hex');
}

type StoredLocalSessionHandoffMetadataRecord = Readonly<{
    vendorResumeId: string;
    exportMetadataOverlay: MetadataRecord;
    updatedAtMs: number;
}>;

export function createLocalSessionHandoffMetadataStore(params: Readonly<{
    activeServerDir: string;
}>) {
    const rootDir = join(params.activeServerDir, 'session-handoff', 'local-metadata');

    const resolveRecordPath = (vendorResumeId: string): string =>
        join(rootDir, `${buildVendorResumeIdFingerprint(vendorResumeId)}.json`);

    return {
        async loadByVendorResumeId(vendorResumeId: string): Promise<MetadataRecord | null> {
            const normalizedVendorResumeId = vendorResumeId.trim();
            if (!normalizedVendorResumeId) {
                return null;
            }

            const raw = await readFile(resolveRecordPath(normalizedVendorResumeId), 'utf8').catch(() => null);
            if (!raw) {
                return null;
            }

            try {
                const parsed = JSON.parse(raw) as StoredLocalSessionHandoffMetadataRecord;
                if (parsed.vendorResumeId !== normalizedVendorResumeId) {
                    return null;
                }
                return asMetadataRecord(parsed.exportMetadataOverlay);
            } catch {
                return null;
            }
        },

        async saveByVendorResumeId(input: Readonly<{
            vendorResumeId: string;
            exportMetadataOverlay: MetadataRecord;
        }>): Promise<void> {
            const normalizedVendorResumeId = input.vendorResumeId.trim();
            if (!normalizedVendorResumeId) {
                return;
            }

            await mkdir(rootDir, { recursive: true });
            await writeFile(
                resolveRecordPath(normalizedVendorResumeId),
                JSON.stringify({
                    vendorResumeId: normalizedVendorResumeId,
                    exportMetadataOverlay: input.exportMetadataOverlay,
                    updatedAtMs: Date.now(),
                } satisfies StoredLocalSessionHandoffMetadataRecord, null, 2),
                'utf8',
            );
        },
    };
}
