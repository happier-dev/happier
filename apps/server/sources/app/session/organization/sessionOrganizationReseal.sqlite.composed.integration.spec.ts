import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AccountEncryptionMigrateSessionOrganizationDirectiveSchema } from '@happier-dev/protocol/account/encryptionMigrate';
import type { SessionOrganizationContentEnvelope } from '@happier-dev/protocol/sessions/organization/content';
import { db } from '@/storage/db';
import { inTx } from '@/storage/inTx';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { createSignedAccountContentBinding } from '@/testkit/accountEncryption';
import { acquireSessionOrganizationMutationAdmissionInTx } from './changes';
import {
    migrateSessionOrganizationAccountEncryptionInTx,
    matchSessionOrganizationAccountEncryptionMigrationPostStateInTx,
    readSessionOrganizationAccountEncryptionMigrationInventoryInTx,
} from './sessionOrganizationAccountEncryptionMigration';
import {
    buildSessionOrganizationAccountEncryptionMigrationDirective,
    openSessionOrganizationDisplayEnvelope,
    prepareSessionOrganizationDisplayEnvelope,
} from '../../../../../ui/sources/sync/ops/sessionOrganization/sessionOrganizationDisplayEnvelope';

// Real Account crypto, including a genuinely keyless Plain source/target.
const keyCredentials = { token: 'test-token', secret: Buffer.alloc(32, 7).toString('base64url') };
const plainCredentials = { token: 'test-token' };
const appearanceValue = { color: { kind: 'custom', hex: '#123456' } };

describe('UI to Server Session Organization Account-mode resealing', () => {
    let harness: LightSqliteHarness;
    beforeAll(async () => {
        harness = await createLightSqliteHarness({ tempDirPrefix: 'happier-organization-reseal-' });
    });
    afterAll(async () => { await harness?.close(); });

    it('fails closed for appearance source-mode mismatches and unavailable or unreadable E2EE material', async () => {
        const plain = { t: 'plain' as const, v: appearanceValue };
        const encrypted = await prepareSessionOrganizationDisplayEnvelope({
            credentials: keyCredentials, accountMode: 'e2ee', value: appearanceValue,
        });
        const inventory = (display: SessionOrganizationContentEnvelope) => ({
            version: 7, folders: [], tags: [], labels: [],
            sessionAppearances: [{ sessionId: 'appearance-only', display }],
        });
        await expect(buildSessionOrganizationAccountEncryptionMigrationDirective({
            inventory: inventory(plain), toMode: 'plain', sourceCredentials: plainCredentials, targetCredentials: null,
        })).rejects.toThrow('source mode');
        await expect(buildSessionOrganizationAccountEncryptionMigrationDirective({
            inventory: inventory(encrypted), toMode: 'plain', sourceCredentials: plainCredentials, targetCredentials: null,
        })).rejects.toThrow('source content');
        await expect(buildSessionOrganizationAccountEncryptionMigrationDirective({
            inventory: inventory(encrypted), toMode: 'plain',
            sourceCredentials: { token: 'test-token', secret: Buffer.alloc(32, 8).toString('base64url') }, targetCredentials: null,
        })).rejects.toThrow('unreadable');
        for (const targetCredentials of [null, plainCredentials]) {
            await expect(buildSessionOrganizationAccountEncryptionMigrationDirective({
                inventory: inventory(plain), toMode: 'e2ee', sourceCredentials: plainCredentials, targetCredentials,
            })).rejects.toThrow(/material is unavailable/);
        }
        await expect(buildSessionOrganizationAccountEncryptionMigrationDirective({
            inventory: inventory({ t: 'encrypted', c: 'malformed' }), toMode: 'plain',
            sourceCredentials: keyCredentials, targetCredentials: null,
        })).rejects.toThrow('unreadable');
    });

    it.each([
        { toMode: 'e2ee', mixed: false },
        { toMode: 'e2ee', mixed: true },
        { toMode: 'plain', mixed: false },
        { toMode: 'plain', mixed: true },
    ] as const)('reseals appearances with $mixed mixed inventory to $toMode', async ({ toMode, mixed }) => {
        const sourceMode = toMode === 'plain' ? 'e2ee' : 'plain';
        const account = await db.account.create({ data: {
            encryptionMode: sourceMode,
            ...(sourceMode === 'e2ee' ? createSignedAccountContentBinding() : {}),
        } });
        const sourceDisplay = (value: unknown) => prepareSessionOrganizationDisplayEnvelope({
            credentials: sourceMode === 'plain' ? plainCredentials : keyCredentials,
            accountMode: sourceMode, value,
        });
        const appearanceDisplay = await sourceDisplay(appearanceValue);
        const session = await db.session.create({ data: {
            accountId: account.id, tag: randomUUID(), metadata: '{}', archivedAt: new Date(),
        } });
        await db.sessionAppearance.create({ data: {
            accountId: account.id, sessionId: session.id, displayDbValue: JSON.stringify(appearanceDisplay),
        } });
        await db.sessionOrganizationCheckpoint.create({ data: { accountId: account.id, version: 7 } });
        if (mixed) {
            await db.sessionOrganizationFolder.create({ data: {
                accountId: account.id, folderKey: 'folder', folderHash: 'folder',
                displayDbValue: JSON.stringify(await sourceDisplay({ name: 'Folder' })),
            } });
            await db.sessionOrganizationTag.create({ data: {
                accountId: account.id, tagKey: 'tag', tagHash: 'tag',
                displayDbValue: JSON.stringify(await sourceDisplay({ label: 'Tag' })),
            } });
            await db.sessionOrganizationLabel.create({ data: {
                accountId: account.id, labelKind: 'workspace', scopeKey: 'workspace', scopeHash: 'workspace',
                displayDbValue: JSON.stringify(await sourceDisplay({ label: 'Workspace' })),
            } });
        }
        const inventory = await inTx(tx => readSessionOrganizationAccountEncryptionMigrationInventoryInTx({ tx, accountId: account.id }));
        const directive = AccountEncryptionMigrateSessionOrganizationDirectiveSchema.parse(
            await buildSessionOrganizationAccountEncryptionMigrationDirective({
                inventory, toMode,
                sourceCredentials: sourceMode === 'plain' ? plainCredentials : keyCredentials,
                targetCredentials: toMode === 'plain' ? null : keyCredentials,
            }),
        );
        // This is the real Server's exact inventory/CAS refusal before the fix:
        // not_empty for appearances only, migration_incomplete for mixed records.
        await inTx(async tx => {
            await acquireSessionOrganizationMutationAdmissionInTx(tx, account.id);
            expect(await migrateSessionOrganizationAccountEncryptionInTx({ tx, accountId: account.id, toMode, directive }))
                .toEqual({ status: 'applied' });
            expect(await matchSessionOrganizationAccountEncryptionMigrationPostStateInTx({ tx, accountId: account.id, toMode, directive }))
                .toEqual({ status: 'matched' });
        });
        const stored = await inTx(tx => readSessionOrganizationAccountEncryptionMigrationInventoryInTx({ tx, accountId: account.id }));
        expect(stored.version).toBe(8);
        expect(stored.sessionAppearances).toHaveLength(1);
        const verifyDisplay = async (display: SessionOrganizationContentEnvelope, value: unknown) => {
            expect(display.t).toBe(toMode === 'plain' ? 'plain' : 'encrypted');
            expect((await openSessionOrganizationDisplayEnvelope({
                credentials: toMode === 'plain' ? plainCredentials : keyCredentials, envelope: display,
            })).displayState).toEqual({ status: 'available', value });
        };
        await verifyDisplay(stored.sessionAppearances![0]!.display, appearanceValue);
        if (mixed) {
            await verifyDisplay(stored.folders[0]!.display, { name: 'Folder' });
            await verifyDisplay(stored.tags[0]!.display, { label: 'Tag' });
            await verifyDisplay(stored.labels[0]!.display, { label: 'Workspace' });
        }
    });
});
