import { afterAll, beforeEach, expect, it, vi } from 'vitest';
import { createAccountTokenForTests, createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { createLegacyAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { encodeBase64 } from '@/encryption/base64';
import { openAccountScopedBlobCiphertext, sealAccountScopedBlobCiphertext } from '@happier-dev/protocol/crypto/accountScopedCipher';
import { getBuiltInBackendProfile } from '@happier-dev/protocol/profiles/builtInBackendProfiles';
import { PROFILE_RECORDS_ROUTE_V1, ProfileRecordV1Schema, ProfileRowMutationV1Schema } from '@happier-dev/protocol/profiles/profileRecordV1';
import { ACP_CATALOG_ROWS_ROUTE_V1 } from '@happier-dev/protocol/acp/catalog/catalogRowsV1';
import type { AccountSettingsCleanupV1 } from '@happier-dev/protocol/account/settings/accountSettingsStoredContentEnvelope';

const randomBytes = vi.hoisted(() => vi.fn((length: number) => new Uint8Array(length).fill(4)));
vi.mock('@/platform/cryptoRandom', () => ({ getRandomBytes: randomBytes }));

const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
const { captureLazyActionAccountContext } = await import('@/sync/ops/actions/actionAccountContext');
const { deleteProfileRecordInContext, writeProfileRecordInContext } = await import('@/sync/api/account/apiProfileCatalog');
const { prepareAcpCatalogMutationInContext } = await import('@/sync/api/account/apiAcpCatalog');
beforeEach(async () => { await homes.reset(); installHomeGovernanceBoundaries(homes); });
afterAll(async () => { await homes.reset(); });

async function createCleanupAccount(mismatchedBinding = false) {
    const secret = new Uint8Array(32).fill(43);
    const material = { type: 'legacy' as const, secret };
    const credentials = { token: createAccountTokenForTests('cleanup-account'), secret: encodeBase64(secret, 'base64url') };
    const serverId = await homes.addHome({ name: 'Cleanup', serverUrl: 'https://cleanup-material.example.test',
        accountId: 'cleanup-account', credentials, accountEncryptionMode: 'e2ee' });
    const currentness = createLegacyAccountEncryptionCurrentnessFixture({
        secret: mismatchedBinding ? new Uint8Array(32).fill(44) : secret,
    });
    let baselineReads = 0;
    let finalCurrentnessReads = 0;
    const posted: AccountSettingsCleanupV1[] = [];
    const raw = { favoriteProfiles: ['removed-profile'], profileEnabledById: { 'azure-openai': false },
        acpCatalogSettingsV1: { v: 2, backends: [] }, unrelated: { retained: true } };
    const content = { t: 'encrypted', c: sealAccountScopedBlobCiphertext({ kind: 'account_settings',
        material, payload: raw, randomBytes: length => new Uint8Array(length).fill(7) }) };
    homes.answer(serverId, '/v1/account/encryption/currentness', { select: () => {
        if (baselineReads > 0) finalCurrentnessReads++;
        return { body: currentness };
    } });
    homes.answer(serverId, '/v1/account/encryption', { body: { mode: 'e2ee', updatedAt: 1 } });
    homes.answer(serverId, '/v2/account/settings', { select: () => {
        baselineReads++;
        return { body: { version: 7, content } };
    } });
    homes.answer(serverId, ACP_CATALOG_ROWS_ROUTE_V1, { body: { status: 'absent' } });
    homes.answer(serverId, `POST ${PROFILE_RECORDS_ROUTE_V1}`, { select: input => {
        const mutation = ProfileRowMutationV1Schema.parse(input);
        if (!mutation.settingsCleanup) throw new Error('Expected composite Settings cleanup');
        posted.push(mutation.settingsCleanup);
        return { body: { status: 'updated', revision: 5, cursor: 5, referenceGuardRevision: 5 } };
    } });
    const context = await captureLazyActionAccountContext(serverId);
    await context.resolveAccountEncryption();
    return { context, posted, baselineReads: () => baselineReads, finalCurrentnessReads: () => finalCurrentnessReads,
        open: (cleanup: AccountSettingsCleanupV1) => cleanup.nextSettings.t === 'encrypted'
            ? openAccountScopedBlobCiphertext({ kind: 'account_settings', material, ciphertext: cleanup.nextSettings.c })?.value
            : cleanup.nextSettings.v };
}

for (const entry of ['delete', 'attach'] as const) {
    it.each([false, true])(`${entry} admits Settings cleanup by its full persisted binding (mismatched=%s)`, async mismatched => {
        const home = await createCleanupAccount(mismatched);
        try {
            randomBytes.mockClear();
            const builtin = getBuiltInBackendProfile('azure-openai');
            if (!builtin) throw new Error('Expected current built-in Profile');
            const operation = entry === 'delete'
                ? deleteProfileRecordInContext(home.context, { id: 'removed-profile', expectedRevision: 4,
                    previousDefinition: { kind: 'artifact', artifactId: 'definition' } })
                : writeProfileRecordInContext(home.context, { operation: 'attach-builtin', expectedRevision: 'absent',
                    record: ProfileRecordV1Schema.parse({ v: 1, id: builtin.id, definition: { kind: 'legacy', profile: builtin },
                        enabled: true, promptStack: [], secretBindings: {} }) });
            if (mismatched) {
                await expect(operation).rejects.toMatchObject({ code: 'account_storage_currentness_unavailable',
                    reason: 'encryption-material-unavailable' });
                expect(home.posted).toHaveLength(0);
                expect(randomBytes).not.toHaveBeenCalled();
            } else {
                await expect(operation).resolves.toMatchObject({ status: 'updated' });
                expect(home.posted).toHaveLength(1);
                expect(home.open(home.posted[0]!)).toMatchObject({ unrelated: { retained: true } });
                if (entry === 'delete') expect(home.open(home.posted[0]!)).toMatchObject({ favoriteProfiles: [] });
                else expect(home.open(home.posted[0]!)).toMatchObject({ profileEnabledById: {} });
            }
            expect(home.baselineReads()).toBe(mismatched ? 0 : 1);
            // Admission owns identity; the already-admitted finite cleanup does not re-admit per step.
            expect(home.finalCurrentnessReads()).toBe(0);
        } finally { home.context.dispose(); }
    });
}

it.each([false, true])('admits E2EE ACP source cleanup through the catalog boundary (mismatched=%s)', async mismatched => {
    const home = await createCleanupAccount(mismatched);
    try {
        randomBytes.mockClear();
        const operation = prepareAcpCatalogMutationInContext(home.context, {
            record: { v: 1, definitions: [] }, expectedRevision: 'absent', sourceSettingsVersion: 7,
        });
        if (mismatched) {
            await expect(operation).rejects.toMatchObject({ code: 'account_storage_currentness_unavailable',
                reason: 'encryption-material-unavailable' });
            expect(home.baselineReads()).toBe(0);
            expect(randomBytes).not.toHaveBeenCalled();
            return;
        }
        const mutation = await operation;
        expect(mutation.settingsCleanup).toBeDefined();
        const opened = home.open(mutation.settingsCleanup!);
        expect(opened).toMatchObject({ unrelated: { retained: true } });
        expect(opened).not.toHaveProperty('acpCatalogSettingsV1');
    } finally { home.context.dispose(); }
});
