import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { SavedSecretCatalogCorruptEntryV1, SavedSecretCatalogEntryV1 } from '@happier-dev/protocol';

import {
    applySavedSecretCatalogFailure,
    applySavedSecretCatalogPage,
    beginSavedSecretCatalogLoad,
    getSavedSecretCatalogSnapshot,
    invalidateSavedSecretCatalog,
    removeDeletedSavedSecretCatalogResource,
    resolveSavedSecretReference,
    resetSavedSecretCatalogSnapshotsForTests,
} from './savedSecretCatalogSnapshot';

const scope = { serverId: 'home-a', accountId: 'account-a' } as const;

function sharedEntry(overrides?: Partial<SavedSecretCatalogEntryV1>): SavedSecretCatalogEntryV1 {
    return {
        ref: 'happier:shared-secret:v1:resource-a',
        source: 'shared_resource',
        relationship: 'recipient',
        name: 'Team API key',
        kind: 'apiKey',
        encryptionMode: null,
        owner: null,
        accessSources: [],
        audience: null,
        ownerAccountId: 'owner-a',
        revision: 1,
        materialStatus: 'ready',
        capabilities: { use: true, rename: false, rotate: false, manageAccess: false, delete: false },
        ...overrides,
    };
}

describe('savedSecretCatalogSnapshot', () => {
    beforeEach(() => resetSavedSecretCatalogSnapshotsForTests());

    it('resolves an extant reserved-reference personal record before shared catalog interpretation', () => {
        const ref = 'happier:shared-secret:v1:legacy-personal';
        const personal = [{
            id: ref,
            name: 'Legacy personal',
            kind: 'token' as const,
            encryptedValue: { _isSecretValue: true as const, value: 'exact-personal-value' },
            createdAt: 1,
            updatedAt: 7,
        }];

        expect(resolveSavedSecretReference(scope, personal, ref)).toMatchObject({
            kind: 'personal',
            status: 'ready',
            secret: personal[0],
        });
    });

    it('hydrates corrupt catalog results separately from selectable entries', () => {
        const corruptEntries: readonly SavedSecretCatalogCorruptEntryV1[] = [{
            materialStatus: 'resource_corrupt',
            relationship: 'owner',
            repair: { kind: 'delete_resource', resourceId: 'opaque-row-id', expectedRevision: 7 },
        }, {
            materialStatus: 'resource_corrupt',
            relationship: 'recipient',
            repair: null,
        }];

        applySavedSecretCatalogPage({
            scope,
            entries: [sharedEntry()],
            corruptEntries,
            observedAt: 10,
        });

        expect(getSavedSecretCatalogSnapshot(scope)).toMatchObject({
            data: [expect.objectContaining({ ref: 'happier:shared-secret:v1:resource-a' })],
            corruptEntries,
        });
        applySavedSecretCatalogPage({ scope, entries: [sharedEntry()],
            corruptEntries: [corruptEntries[1]!], observedAt: 11 });
        expect(getSavedSecretCatalogSnapshot(scope)?.corruptEntries).toEqual([corruptEntries[1]]);
    });

    it('keeps legacy cleanup diagnostics independent of usable resource material and retains them through a failed refresh', () => {
        const ref = 'happier:shared-secret:v1:resource-a';
        const page = {
            scope,
            entries: [sharedEntry()],
            materializedSecrets: [{ id: ref, name: 'Shared key', kind: 'apiKey' as const,
                encryptedValue: { _isSecretValue: true as const, value: 'opened-value' }, createdAt: 1, updatedAt: 1 }],
            legacyImport: { status: 'pending' as const, reason: 'source-uncharacterized' as const },
            observedAt: 10,
        };
        applySavedSecretCatalogPage(page);
        expect(getSavedSecretCatalogSnapshot(scope)).toMatchObject({ status: 'ready', legacyImport: page.legacyImport });
        expect(resolveSavedSecretReference(scope, [], ref)).toMatchObject({ status: 'ready', secret: { id: ref } });

        beginSavedSecretCatalogLoad(scope);
        applySavedSecretCatalogFailure({ scope, error: { kind: 'unreachable', retryable: true } });
        expect(getSavedSecretCatalogSnapshot(scope)).toMatchObject({ legacyImport: page.legacyImport, materializedSecrets: [] });

        applySavedSecretCatalogPage({ ...page, legacyImport: { status: 'complete' as const }, observedAt: 11 });
        expect(getSavedSecretCatalogSnapshot(scope)).toMatchObject({ status: 'ready', legacyImport: { status: 'complete' } });
        expect(resolveSavedSecretReference(scope, [], ref)).toMatchObject({ status: 'ready', secret: { id: ref } });
    });

    it('preserves last-known rows while refreshing and after a retryable failure', () => {
        applySavedSecretCatalogPage({ scope, entries: [sharedEntry()], observedAt: 10 });
        const first = getSavedSecretCatalogSnapshot(scope)?.data?.[0];

        invalidateSavedSecretCatalog(scope);
        beginSavedSecretCatalogLoad(scope);
        expect(getSavedSecretCatalogSnapshot(scope)).toMatchObject({
            status: 'refreshing',
            stale: true,
            data: [first],
        });

        applySavedSecretCatalogFailure({
            scope,
            error: { kind: 'unreachable', retryable: true },
        });
        expect(getSavedSecretCatalogSnapshot(scope)).toMatchObject({
            status: 'error',
            stale: true,
            data: [first],
        });
    });

    it('removes only the deleted resource from its exact Account/Home catalog', () => {
        const otherAccount = { ...scope, accountId: 'account-b' };
        const otherHome = { ...scope, serverId: 'home-b' };
        const page = { entries: [sharedEntry(), sharedEntry({ ref: 'happier:shared-secret:v1:retained' })], observedAt: 10 };
        for (const target of [scope, otherAccount, otherHome]) applySavedSecretCatalogPage({ ...page, scope: target });
        const accountBSnapshot = getSavedSecretCatalogSnapshot(otherAccount);
        const homeBSnapshot = getSavedSecretCatalogSnapshot(otherHome);

        removeDeletedSavedSecretCatalogResource(scope, 'resource-a');
        expect(getSavedSecretCatalogSnapshot(scope)?.data?.map(entry => entry.ref)).toEqual(['happier:shared-secret:v1:retained']);
        expect(getSavedSecretCatalogSnapshot(otherAccount)).toBe(accountBSnapshot);
        expect(getSavedSecretCatalogSnapshot(otherHome)).toBe(homeBSnapshot);
        const afterDelete = getSavedSecretCatalogSnapshot(scope);
        removeDeletedSavedSecretCatalogResource(scope, 'resource-a');
        expect(getSavedSecretCatalogSnapshot(scope)).toBe(afterDelete);
    });

    it('drops opened material immediately on invalidation while retaining repairable metadata', () => {
        applySavedSecretCatalogPage({
            scope,
            entries: [sharedEntry()],
            materializedSecrets: [{
                id: 'happier:shared-secret:v1:resource-a',
                name: 'Shared key',
                kind: 'apiKey',
                encryptedValue: { _isSecretValue: true, value: 'opened-value' },
                createdAt: 1,
                updatedAt: 1,
            }],
            observedAt: 10,
        });

        invalidateSavedSecretCatalog(scope);

        expect(getSavedSecretCatalogSnapshot(scope)).toMatchObject({
            stale: true,
            materializedSecrets: [],
            data: [expect.objectContaining({ ref: 'happier:shared-secret:v1:resource-a' })],
        });
    });

    it('withdraws opened material at the start of every authorization refresh', () => {
        applySavedSecretCatalogPage({
            scope,
            entries: [sharedEntry()],
            materializedSecrets: [{
                id: 'happier:shared-secret:v1:resource-a',
                name: 'Shared key',
                kind: 'apiKey',
                encryptedValue: { _isSecretValue: true, value: 'opened-value' },
                createdAt: 1,
                updatedAt: 1,
            }],
            observedAt: 10,
        });

        beginSavedSecretCatalogLoad(scope);

        expect(getSavedSecretCatalogSnapshot(scope)).toMatchObject({
            status: 'refreshing',
            materializedSecrets: [],
            data: [expect.objectContaining({ ref: 'happier:shared-secret:v1:resource-a' })],
        });
    });

    it('keeps unchanged entries referentially stable and replaces changed readiness', () => {
        applySavedSecretCatalogPage({ scope, entries: [sharedEntry()], observedAt: 10 });
        const first = getSavedSecretCatalogSnapshot(scope)?.data?.[0];

        applySavedSecretCatalogPage({ scope, entries: [sharedEntry()], observedAt: 11 });
        expect(getSavedSecretCatalogSnapshot(scope)?.data?.[0]).toBe(first);

        applySavedSecretCatalogPage({
            scope,
            entries: [sharedEntry({ materialStatus: 'access_removed', capabilities: { use: false, rename: false, rotate: false, manageAccess: false, delete: false } })],
            observedAt: 12,
        });
        expect(getSavedSecretCatalogSnapshot(scope)?.data?.[0]).not.toBe(first);
        expect(getSavedSecretCatalogSnapshot(scope)?.data?.[0]?.materialStatus).toBe('access_removed');
    });

    it('withdraws retained metadata when the Home authoritatively refuses access', () => {
        applySavedSecretCatalogPage({ scope, entries: [sharedEntry()], observedAt: 10 });
        applySavedSecretCatalogFailure({
            scope,
            error: { kind: 'unauthorized', retryable: false },
        });

        expect(getSavedSecretCatalogSnapshot(scope)).toMatchObject({
            status: 'error',
            stale: true,
            data: null,
            reachability: 'unauthorized',
        });
    });

    it('resolves a shared-only ref through the current catalog and fingerprints its revision', () => {
        const ref = 'happier:shared-secret:v1:resource-a';
        applySavedSecretCatalogPage({
            scope,
            entries: [sharedEntry()],
            materializedSecrets: [{
                id: ref,
                name: 'Shared key',
                kind: 'apiKey',
                encryptedValue: { _isSecretValue: true, value: 'opened-value' },
                createdAt: 1,
                updatedAt: 1,
            }],
            observedAt: 10,
        });

        expect(resolveSavedSecretReference(scope, [], ref)).toMatchObject({
            kind: 'shared_resource',
            status: 'ready',
            revision: 1,
            fingerprint: `shared:${ref}:1`,
            secret: { id: ref, updatedAt: 1 },
        });
        applySavedSecretCatalogPage({
            scope,
            entries: [sharedEntry({ revision: 2 })],
            materializedSecrets: [{
                id: ref,
                name: 'Shared key',
                kind: 'apiKey',
                encryptedValue: { _isSecretValue: true, value: 'rotated-value' },
                createdAt: 1,
                updatedAt: 2,
            }],
            observedAt: 11,
        });
        expect(resolveSavedSecretReference(scope, [], ref).fingerprint).toBe(`shared:${ref}:2`);
    });

    it.each([
        ['refreshing', () => beginSavedSecretCatalogLoad(scope)],
        ['stale', () => invalidateSavedSecretCatalog(scope)],
    ])('retains shared identity but fails closed while the catalog is %s', (_label, makeUnavailable) => {
        const ref = 'happier:shared-secret:v1:resource-a';
        applySavedSecretCatalogPage({
            scope,
            entries: [sharedEntry()],
            materializedSecrets: [{
                id: ref,
                name: 'Shared key',
                kind: 'apiKey',
                encryptedValue: { _isSecretValue: true, value: 'opened-value' },
                createdAt: 1,
                updatedAt: 1,
            }],
            observedAt: 10,
        });
        makeUnavailable();

        expect(resolveSavedSecretReference(scope, [], ref)).toMatchObject({
            kind: 'shared_resource',
            ref,
            status: 'temporarily_unavailable',
            secret: null,
        });
    });

    it('preserves terminal shared catalog status and does not cross Home scope', () => {
        const ref = 'happier:shared-secret:v1:resource-a';
        applySavedSecretCatalogPage({
            scope,
            entries: [sharedEntry({
                materialStatus: 'access_removed',
                capabilities: { use: false, rename: false, rotate: false, manageAccess: false, delete: false },
            })],
            observedAt: 10,
        });

        expect(resolveSavedSecretReference(scope, [], ref)).toMatchObject({
            kind: 'shared_resource',
            status: 'access_removed',
            secret: null,
        });
        expect(resolveSavedSecretReference(
            { serverId: 'home-b', accountId: 'account-a' },
            [],
            ref,
        )).toMatchObject({
            kind: 'shared_resource',
            status: 'temporarily_unavailable',
            secret: null,
        });
    });

    it('synthesizes access removal only from an authoritative current empty catalog', () => {
        const ref = 'happier:shared-secret:v1:resource-a';
        applySavedSecretCatalogPage({ scope, entries: [], observedAt: 10 });

        expect(resolveSavedSecretReference(scope, [], ref)).toMatchObject({
            kind: 'shared_resource',
            status: 'access_removed',
            entry: null,
            secret: null,
            revision: null,
            fingerprint: null,
        });

        beginSavedSecretCatalogLoad(scope);
        expect(resolveSavedSecretReference(scope, [], ref).status).toBe('temporarily_unavailable');
        applySavedSecretCatalogFailure({
            scope,
            error: { kind: 'unreachable', retryable: true },
        });
        expect(resolveSavedSecretReference(scope, [], ref).status).toBe('temporarily_unavailable');
    });
});
