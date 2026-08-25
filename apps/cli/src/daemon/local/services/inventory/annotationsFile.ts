import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { z } from 'zod';

import { configuration } from '@/configuration';
import { logger } from '@/ui/logger';
import { writeJsonAtomic } from '@/utils/fs/writeJsonAtomic';

import type {
    LocalServiceInventoryAnnotationStore,
    LocalServiceInventoryAnnotationsV1,
} from './registry';

export const LOCAL_SERVICE_INVENTORY_ANNOTATIONS_FILE = 'local-service-inventory-annotations-v1.json';

const StoredLabelSchema = z.object({
    id: z.string().min(1),
    text: z.string().min(1),
    source: z.enum(['user', 'plugin']),
    updatedAt: z.number().int().nonnegative(),
}).strict();

const ForgottenSuppressionSchema = z.object({
    forgottenAt: z.number().int().nonnegative(),
    runIdentity: z.union([
        z.object({
            kind: z.literal('process'),
            pid: z.number().int(),
            processStartTimeMs: z.number().int().nonnegative().nullable(),
        }).strict(),
        z.object({ kind: z.literal('unattributed') }).strict(),
    ]),
}).strict();

const AnnotationsSchema = z.object({
    v: z.literal(1),
    labelsByFallbackKey: z.array(z.tuple([z.string().min(1), z.array(StoredLabelSchema)])),
    forgottenFallbackKeys: z.array(z.tuple([z.string().min(1), ForgottenSuppressionSchema])),
}).strict();

export function resolveLocalServiceInventoryAnnotationsPath(happyHomeDir?: string): string {
    return join(happyHomeDir ?? configuration.happyHomeDir, LOCAL_SERVICE_INVENTORY_ANNOTATIONS_FILE);
}

/**
 * File-backed store for the user-authored inventory annotations (tunnels audit §4.8).
 *
 * Uses the daemon's existing local-state owners — the configuration-owned home directory and the
 * shared atomic JSON writer — rather than introducing another store. Nothing here is shared with
 * the server or any database, so this is machine-local user content, not a compatibility surface.
 *
 * Reads are synchronous because the registry is constructed synchronously during daemon startup.
 * Writes are atomic and fire-and-forget: losing the newest label to a crash mid-write is
 * recoverable by renaming again, whereas blocking a scan on disk I/O is not worth it. A malformed
 * or unreadable file yields no annotations rather than failing daemon startup.
 */
export function createLocalServiceInventoryAnnotationsFileStore(input: Readonly<{
    path?: string;
}> = {}): LocalServiceInventoryAnnotationStore {
    const path = input.path ?? resolveLocalServiceInventoryAnnotationsPath();
    return {
        read() {
            let raw: string;
            try {
                raw = readFileSync(path, 'utf-8');
            } catch {
                // No annotations yet (or unreadable): the user simply has none.
                return null;
            }
            try {
                const parsed = AnnotationsSchema.safeParse(JSON.parse(raw));
                if (!parsed.success) {
                    logger.debug('[DAEMON RUN] Local-service inventory annotations file is invalid; ignoring it');
                    return null;
                }
                return parsed.data as LocalServiceInventoryAnnotationsV1;
            } catch {
                logger.debug('[DAEMON RUN] Local-service inventory annotations file is corrupt; ignoring it');
                return null;
            }
        },
        write(annotations) {
            void writeJsonAtomic(path, annotations).catch((error) => {
                logger.debug('[DAEMON RUN] Failed to persist local-service inventory annotations', error);
            });
        },
    };
}
