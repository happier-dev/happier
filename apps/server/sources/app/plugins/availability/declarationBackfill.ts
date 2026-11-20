import { compactReleaseLessDeclarations, isSplitReleaseLessDeclaration, readReleaseLessDeclarationsV2 } from './currentDeclaration';
import { createCanonicalJsonSigningInput } from '@happier-dev/protocol/crypto/canonicalJson';
import type { db } from '@/storage/db';

/** Validate body references after schema deployment and compact inline declarations before activation. */
export async function backfillPluginDeclarations(client: Pick<typeof db, 'accountPluginIntent'>, apply = false) {
    let cursor: string | undefined;
    let scanned = 0, converted = 0, conflicts = 0, unsupported = 0, incomplete = 0;
    let beforeBytes = 0, afterBytes = 0;
    for (;;) {
        // One potentially large document at a time; no new batch/cap policy.
        const row = await client.accountPluginIntent.findFirst({
            where: cursor === undefined ? {} : { id: { gt: cursor } }, orderBy: { id: 'asc' },
            select: {
                id: true, pluginId: true, revision: true, updatedAt: true, releaseLessDeclaration: true,
                declarationBodies: { select: { declarationDigest: true } },
            },
        });
        if (!row) break;
        cursor = row.id;
        const raw = row.releaseLessDeclaration;
        if (isSplitReleaseLessDeclaration(raw)) {
            const expanded = readReleaseLessDeclarationsV2(raw, row.pluginId);
            const digests = new Set<string>(expanded.machines.map(entry => entry.declaration.manifestDigestSha256));
            if (expanded.legacyDeclaration) digests.add(expanded.legacyDeclaration.manifestDigestSha256);
            if (digests.size === 0 || digests.size !== row.declarationBodies.length
                || row.declarationBodies.some(body => !digests.has(body.declarationDigest))) incomplete++;
            continue;
        }
        if (row.declarationBodies.length > 0) {
            incomplete++;
            continue;
        }
        if (raw === null) continue;
        scanned++;
        const original = JSON.stringify(row.releaseLessDeclaration);
        const expanded = readReleaseLessDeclarationsV2(row.releaseLessDeclaration, row.pluginId);
        if (typeof raw !== 'object' || Array.isArray(raw)
            || ('schemaVersion' in raw && raw.schemaVersion !== 2 && raw.schemaVersion !== 3)
            || (expanded.machines.length === 0 && expanded.legacyDeclaration === null)
            || ('legacyDeclaration' in raw && raw.legacyDeclaration !== null && expanded.legacyDeclaration === null)
            || ('machines' in raw && (!Array.isArray(raw.machines) || raw.machines.length !== expanded.machines.length))) {
            unsupported++;
            continue; // Never silently discard an unrecognized historical row.
        }
        const compact = compactReleaseLessDeclarations(raw, row.pluginId);
        beforeBytes += Buffer.byteLength(original);
        afterBytes += Buffer.byteLength(JSON.stringify(compact));
        if (createCanonicalJsonSigningInput(raw) === createCanonicalJsonSigningInput(compact)) continue;
        if (apply) {
            const result = await client.accountPluginIntent.updateMany({
                // Existing revision CAS protects a concurrent intent transition.
                where: { id: row.id, revision: row.revision },
                data: { releaseLessDeclaration: JSON.parse(JSON.stringify(compact)), updatedAt: row.updatedAt },
            });
            if (result.count === 0) { conflicts++; continue; }
        }
        converted++;
    }
    return { scanned, converted, conflicts, unsupported, incomplete, beforeBytes, afterBytes };
}
