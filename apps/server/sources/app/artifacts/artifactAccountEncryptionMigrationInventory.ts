import type { ArtifactAccountEncryptionMigrationInventoryV1, ArtifactAccountEncryptionMigrationOwnershipV1 } from '@happier-dev/protocol';
import type { Tx } from '@/storage/inTx';
import { resolveEffectiveAccountEncryptionModeFromAccountRow } from '@/app/encryption/accountEncryptionMode';
import { qualifyPluginArtifactAccountEncryptionMigrationInTx } from '@/app/plugins/availability/operations';
import { artifactClassificationFromRelations } from './artifactClassification';
import { readArtifactAccountEncryptionMigrationRowsInTx } from './artifactWriteService';
import { openArtifactStoredContentPair, openArtifactStoredContentBytes } from './artifactStoredContent';

/** The transition census also owns pagination; ordinary Artifact readers remain unchanged. */
export async function readArtifactAccountEncryptionMigrationInventoryInTx(params: Readonly<{
    tx: Tx; accountId: string; afterId?: string; limit: number;
}>): Promise<ArtifactAccountEncryptionMigrationInventoryV1 | null> {
    const account = await params.tx.account.findUnique({ where: { id: params.accountId }, select: { encryptionMode: true } });
    const mode = account && resolveEffectiveAccountEncryptionModeFromAccountRow(account);
    if (!mode || mode.status !== 'ready') return null;
    const census = await readArtifactAccountEncryptionMigrationRowsInTx(params.tx, params.accountId, { afterId: params.afterId, take: params.limit + 1 });
    const items: ArtifactAccountEncryptionMigrationInventoryV1['items'] = [];
    for (const row of census.slice(0, params.limit)) {
        const classification = artifactClassificationFromRelations(row, params.accountId);
        if (classification.kind === 'invalid') return null;
        const content = { accountId: params.accountId, artifactId: row.id, mode: mode.mode, dataEncryptionKey: row.dataEncryptionKey };
        const opened = openArtifactStoredContentPair({ ...content, header: row.header, body: row.body });
        if (!opened) return null;
        const revisions: ArtifactAccountEncryptionMigrationInventoryV1['items'][number]['revisions'] = [];
        const envelopes = [{ ...opened, dataEncryptionKey: row.dataEncryptionKey }];
        for (const revision of row.revisions) {
            const body = openArtifactStoredContentBytes({ ...content, field: 'body', content: revision.body });
            if (!body) return null;
            revisions.push({ bodyVersion: revision.bodyVersion, body: Buffer.from(body).toString('base64') });
            envelopes.push({ header: opened.header, body, dataEncryptionKey: row.dataEncryptionKey });
        }
        const ownership: ArtifactAccountEncryptionMigrationOwnershipV1 | null = classification.kind === 'ordinary'
            ? { kind: 'ordinary' }
            : await qualifyPluginArtifactAccountEncryptionMigrationInTx({ tx: params.tx, accountId: params.accountId,
                artifactId: row.id, uiRelease: row.pluginUiArtifact?.release ?? null, packageRelease: row.packageAssetRelease, envelopes });
        if (!ownership) return null;
        items.push({ id: row.id, ownership, header: Buffer.from(opened.header).toString('base64'), headerVersion: row.headerVersion,
            body: Buffer.from(opened.body).toString('base64'), bodyVersion: row.bodyVersion,
            dataEncryptionKey: Buffer.from(row.dataEncryptionKey).toString('base64'), revisions });
    }
    return { ownerAccountId: params.accountId, encryptionMode: mode.mode, items,
        nextCursor: census.length > params.limit ? items.at(-1)!.id : null };
}
