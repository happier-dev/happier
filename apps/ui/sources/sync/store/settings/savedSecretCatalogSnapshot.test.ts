import { beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';

import type { SavedSecretCatalogCorruptEntryV1, SavedSecretCatalogEntryV1 } from '@happier-dev/protocol/account/settings/savedSecretCatalogV1';
import { sealSavedSecretResourceStoredContentV1 } from '@happier-dev/protocol/account/settings/savedSecretResourceContentV1';
import { materializeSavedSecretResources } from '@/sync/engine/settings/materializeSavedSecretResources';

import {
    applySavedSecretCatalogFailure,
    applySavedSecretCatalogPage,
    applyAcknowledgedSavedSecretCatalogEntry,
    beginSavedSecretCatalogLoad,
    getSavedSecretCatalogSnapshot,
    readSavedSecretCatalogEntry,
    readSavedSecretCatalogName,
    getMaterializedSavedSecret,
    getMaterializedSavedSecrets,
    getUsableSavedSecrets,
    invalidateSavedSecretCatalog,
    removeDeletedSavedSecretCatalogResource,
    resolveSavedSecretReference,
    resetSavedSecretCatalogSnapshotsForTests,
    subscribeSavedSecretCatalogSnapshots,
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

    it('returns only a typed display name or unavailable reason, including acknowledged withdrawal during refresh', () => {
        const entry = sharedEntry();
        applySavedSecretCatalogPage({ scope, entries: [entry], observedAt: 1,
            materializedSecrets: [{ id: entry.ref, name: 'Team API key', kind: 'apiKey', createdAt: 1, updatedAt: 1,
                encryptedValue: { _isSecretValue: true, value: 'constructed-not-for-display' } }] });
        expect(readSavedSecretCatalogName(scope, entry.ref)).toEqual({ status: 'ready', name: entry.name, resolving: false });
        expect(readSavedSecretCatalogName(scope, 'happier:shared-secret:v1:unknown')).toEqual({ status: 'unavailable', name: null, resolving: false,
            reason: { kind: 'reference_unavailable', retryable: false } });
        removeDeletedSavedSecretCatalogResource(scope, 'resource-a', 1);
        expect(readSavedSecretCatalogName(scope, entry.ref)).toEqual({ status: 'unavailable', name: null, resolving: false,
            reason: { kind: 'reference_unavailable', retryable: false } });
        beginSavedSecretCatalogLoad(scope);
        expect(readSavedSecretCatalogName(scope, entry.ref)).toEqual({ status: 'unavailable', name: null, resolving: false,
            reason: { kind: 'reference_unavailable', retryable: false } });
        const other = sharedEntry({ ref: 'happier:shared-secret:v1:resource-b', revision: 2 });
        applyAcknowledgedSavedSecretCatalogEntry(scope, other, true);
        expect(readSavedSecretCatalogName(scope, entry.ref).resolving).toBe(false);
        const error = { kind: 'forbidden' as const, code: 'home_access_refused', retryable: false };
        applySavedSecretCatalogFailure({ scope, error });
        expect(readSavedSecretCatalogName(scope, entry.ref)).toEqual({ status: 'unavailable', name: null, resolving: false, reason: error });
    });

    it('settles an undisclosed name without inventing a display label and publishes its later availability once', () => {
        const entry = sharedEntry({ name: null, kind: null, materialStatus: 'preparing_encrypted_access' });
        applySavedSecretCatalogPage({ scope, entries: [entry], observedAt: 1 });
        const unavailable = readSavedSecretCatalogName(scope, entry.ref);
        expect(unavailable).toEqual({ status: 'unavailable', name: null, resolving: false,
            reason: { kind: 'reference_unavailable', retryable: false } });
        expect(readSavedSecretCatalogEntry(scope, entry.ref)).toEqual(entry);
        const notify = vi.fn();
        onTestFinished(subscribeSavedSecretCatalogSnapshots(notify, { scope, refs: [entry.ref] }));
        for (let observedAt = 2; observedAt < 12; observedAt += 1) {
            applySavedSecretCatalogPage({ scope, entries: [{ ...entry }], observedAt });
        }
        expect(readSavedSecretCatalogName(scope, entry.ref)).toBe(unavailable);
        expect(notify).toHaveBeenCalledTimes(0);
        applySavedSecretCatalogPage({ scope, entries: [{ ...entry, name: 'Available name', kind: 'token', materialStatus: 'ready' }], observedAt: 12 });
        expect(readSavedSecretCatalogName(scope, entry.ref)).toEqual({ status: 'ready', name: 'Available name', resolving: false });
        expect(notify).toHaveBeenCalledTimes(1);
    });

    it('keeps selected references idle across identical publications and unrelated Secrets or Homes at constructed scale', () => {
        // Constructed stress shape, not an observed Account census.
        const entries = Array.from({ length: 3007 }, (_, index) => sharedEntry({
            ref: `happier:shared-secret:v1:resource-${index}`,
        }));
        const selected = entries[3006]!;
        applySavedSecretCatalogPage({ scope, entries, observedAt: 1 });
        const ready = getSavedSecretCatalogSnapshot(scope);
        const publications = vi.fn();
        onTestFinished(subscribeSavedSecretCatalogSnapshots(publications));
        const notify = vi.fn(() => resolveSavedSecretReference(scope, [], selected.ref, { includeMaterial: false }));
        onTestFinished(subscribeSavedSecretCatalogSnapshots(notify, { scope, refs: [selected.ref] }));
        for (let observedAt = 2; observedAt < 12; observedAt += 1) {
            applySavedSecretCatalogPage({ scope, entries: entries.map(entry => ({ ...entry })), observedAt });
        }
        expect(publications).toHaveBeenCalledTimes(0);
        expect(getSavedSecretCatalogSnapshot(scope)?.data).toBe(ready?.data);
        expect(getSavedSecretCatalogSnapshot(scope)?.lastObservedAt).toBe(11);
        applySavedSecretCatalogPage({ scope, entries: entries.map((entry, index) => index === 0
            ? { ...entry, revision: 2, name: 'Unrelated rename' } : entry), observedAt: 12 });
        applySavedSecretCatalogPage({ scope: { ...scope, serverId: 'home-b' }, entries, observedAt: 12 });
        expect(notify).toHaveBeenCalledTimes(0);

        applyAcknowledgedSavedSecretCatalogEntry(scope, { ...selected, revision: 2, name: 'Selected rename' }, true);
        expect(notify).toHaveBeenCalledTimes(1);
        expect(notify.mock.results.at(-1)?.value).toMatchObject({ revision: 2, entry: { name: 'Selected rename' } });
        applyAcknowledgedSavedSecretCatalogEntry(scope, { ...selected, revision: 3, name: 'Selected rename' }, true);
        expect(notify).toHaveBeenCalledTimes(2);
        expect(notify.mock.results.at(-1)?.value).toMatchObject({ revision: 3 });
        removeDeletedSavedSecretCatalogResource(scope, 'resource-3006', 3);
        expect(notify).toHaveBeenCalledTimes(3);
        expect(notify.mock.results.at(-1)?.value).toMatchObject({ entry: null, secret: null });
    });

    it('settles missing references, deduplicates changed selections, and withdraws every indexed fact on refusal', () => {
        const first = sharedEntry();
        const second = sharedEntry({ ref: 'happier:shared-secret:v1:resource-b' });
        const notify = vi.fn();
        const stop = subscribeSavedSecretCatalogSnapshots(notify, { scope, refs: [first.ref, second.ref] });
        onTestFinished(stop);
        expect(readSavedSecretCatalogName(scope, first.ref)).toEqual({ status: 'loading', name: null, resolving: true });
        beginSavedSecretCatalogLoad(scope);
        expect(notify).toHaveBeenCalledTimes(0);
        applySavedSecretCatalogPage({ scope, entries: [], observedAt: 1 });
        expect(notify).toHaveBeenCalledTimes(1);
        expect(readSavedSecretCatalogName(scope, first.ref)).toEqual({ status: 'unavailable', name: null, resolving: false,
            reason: { kind: 'reference_unavailable', retryable: false } });
        applySavedSecretCatalogPage({ scope, entries: [first, second], observedAt: 2 });
        expect(notify).toHaveBeenCalledTimes(2);
        const name = readSavedSecretCatalogName(scope, first.ref);
        applyAcknowledgedSavedSecretCatalogEntry(scope, { ...first, revision: 2 }, true);
        expect(notify).toHaveBeenCalledTimes(3);
        expect(readSavedSecretCatalogName(scope, first.ref)).toBe(name);
        expect(readSavedSecretCatalogEntry(scope, first.ref)?.revision).toBe(2);
        applySavedSecretCatalogFailure({ scope, error: { kind: 'unauthorized', retryable: false } });
        expect(notify).toHaveBeenCalledTimes(4);
        expect(readSavedSecretCatalogEntry(scope, first.ref)).toBeNull();
        expect(readSavedSecretCatalogName(scope, first.ref)).toEqual({ status: 'unavailable', name: null, resolving: false,
            reason: { kind: 'unauthorized', retryable: false } });
        stop();
        applySavedSecretCatalogPage({ scope, entries: [first, second], observedAt: 3 });
        expect(notify).toHaveBeenCalledTimes(4);
    });

    it('publishes material readiness and currentness while keeping metadata-only references idle', () => {
        const entry = sharedEntry();
        applySavedSecretCatalogPage({ scope, entries: [entry], includesMaterial: false, observedAt: 1 });
        const publications = vi.fn();
        const metadata = vi.fn();
        onTestFinished(subscribeSavedSecretCatalogSnapshots(publications));
        onTestFinished(subscribeSavedSecretCatalogSnapshots(metadata, { scope, refs: [entry.ref] }));
        const material = { id: entry.ref, name: 'Team API key', kind: 'apiKey' as const,
            encryptedValue: { _isSecretValue: true as const, value: 'constructed-value' }, createdAt: 1, updatedAt: 1 };
        applySavedSecretCatalogPage({ scope, entries: [entry], materializedSecrets: [material], observedAt: 2 });
        expect(publications).toHaveBeenCalledTimes(1);
        expect(metadata).toHaveBeenCalledTimes(0);
        expect(getMaterializedSavedSecret(scope, entry.ref)).toBe(material);
        applySavedSecretCatalogPage({ scope, entries: [entry], materializedSecrets: [{ ...material }], observedAt: 3 });
        expect(publications).toHaveBeenCalledTimes(1);
        expect(getMaterializedSavedSecret(scope, entry.ref)).toBe(material);
        expect(getSavedSecretCatalogSnapshot(scope)?.lastObservedAt).toBe(3);
        invalidateSavedSecretCatalog(scope);
        expect(publications).toHaveBeenCalledTimes(2);
        expect(metadata).toHaveBeenCalledTimes(0);
        expect(getMaterializedSavedSecret(scope, entry.ref)).toBeNull();
        expect(resolveSavedSecretReference(scope, [], entry.ref).status).toBe('temporarily_unavailable');
    });

    it('retains equal page and lifecycle snapshots without notifying and publishes real freshness changes', () => {
        const notify = vi.fn();
        const unsubscribe = subscribeSavedSecretCatalogSnapshots(notify);
        onTestFinished(unsubscribe);
        const page = () => ({ scope, entries: [sharedEntry()], observedAt: 10 });
        applySavedSecretCatalogPage(page());
        const ready = getSavedSecretCatalogSnapshot(scope);
        applySavedSecretCatalogPage(page());
        expect(getSavedSecretCatalogSnapshot(scope)).toBe(ready);
        expect(notify).toHaveBeenCalledTimes(1);
        beginSavedSecretCatalogLoad(scope);
        const refreshing = getSavedSecretCatalogSnapshot(scope);
        beginSavedSecretCatalogLoad(scope);
        expect(getSavedSecretCatalogSnapshot(scope)).toBe(refreshing);
        expect(notify).toHaveBeenCalledTimes(2);
        applySavedSecretCatalogFailure({ scope, error: { kind: 'unreachable', retryable: true } });
        const failed = getSavedSecretCatalogSnapshot(scope);
        applySavedSecretCatalogFailure({ scope, error: { kind: 'unreachable', retryable: true } });
        expect(getSavedSecretCatalogSnapshot(scope)).toBe(failed);
        expect(notify).toHaveBeenCalledTimes(3);
        applySavedSecretCatalogPage({ ...page(), observedAt: 11 });
        expect(getSavedSecretCatalogSnapshot(scope)?.lastObservedAt).toBe(11);
        expect(notify).toHaveBeenCalledTimes(4);
    });

    it.each(['delete', 'empty refresh', 'failed revalidation'] as const)('rejects a delayed update receipt after %s without restoring material', phase => {
        const entry = sharedEntry({ revision: 5 });
        applySavedSecretCatalogPage({ scope, entries: [entry], observedAt: 10 });
        removeDeletedSavedSecretCatalogResource(scope, 'resource-a');
        if (phase !== 'delete') applySavedSecretCatalogPage({ scope, entries: [], observedAt: 11 });
        if (phase === 'failed revalidation') {
            beginSavedSecretCatalogLoad(scope);
            applySavedSecretCatalogFailure({ scope, error: { kind: 'unreachable', retryable: true } });
        }
        const deleted = getSavedSecretCatalogSnapshot(scope);
        applyAcknowledgedSavedSecretCatalogEntry(scope, { ...entry, revision: 4, name: 'Late update' }, true);
        applyAcknowledgedSavedSecretCatalogEntry(scope, entry, true);
        expect(getSavedSecretCatalogSnapshot(scope)).toBe(deleted);
        expect(getSavedSecretCatalogSnapshot(scope)?.data).toEqual([]);
        expect(resolveSavedSecretReference(scope, [], entry.ref).secret).toBeNull();
    });

    it('retains admitted inventory evidence through an empty refresh and orders independent Account receipts', () => {
        const entry = sharedEntry({ revision: 10 });
        applySavedSecretCatalogPage({ scope, entries: [entry], observedAt: 10 });
        applySavedSecretCatalogPage({ scope, entries: [], observedAt: 11 });
        const empty = getSavedSecretCatalogSnapshot(scope);
        applyAcknowledgedSavedSecretCatalogEntry(scope, { ...entry, revision: 6 }, true);
        applyAcknowledgedSavedSecretCatalogEntry(scope, { ...entry, revision: 11 }, false);
        expect(getSavedSecretCatalogSnapshot(scope)).toBe(empty);
        const otherScope = { ...scope, accountId: 'other-account' };
        applyAcknowledgedSavedSecretCatalogEntry(otherScope, { ...entry, revision: 6 }, true);
        expect(getSavedSecretCatalogSnapshot(otherScope)?.data).toMatchObject([{ revision: 6 }]);
        applyAcknowledgedSavedSecretCatalogEntry(scope, { ...entry, revision: 11 }, true);
        const acknowledged = getSavedSecretCatalogSnapshot(scope);
        applyAcknowledgedSavedSecretCatalogEntry(scope, { ...entry, revision: 11, name: 'Duplicate' }, true);
        applyAcknowledgedSavedSecretCatalogEntry(scope, entry, true);
        expect(getSavedSecretCatalogSnapshot(scope)).toBe(acknowledged);
        expect(acknowledged).toMatchObject({ stale: true, materializedSecrets: [], data: [{ revision: 11 }] });
    });

    it('admits authoritative recreation without allowing a late pre-delete update to publish', () => {
        const entry = sharedEntry({ revision: 5 });
        applySavedSecretCatalogPage({ scope, entries: [entry], observedAt: 10 });
        removeDeletedSavedSecretCatalogResource(scope, 'resource-a');
        const recreated = sharedEntry({ revision: 1, name: 'Recreated resource' });
        applySavedSecretCatalogPage({ scope, entries: [recreated], observedAt: 11 });
        const current = getSavedSecretCatalogSnapshot(scope);
        applyAcknowledgedSavedSecretCatalogEntry(scope, { ...entry, revision: 4 }, true);
        expect(getSavedSecretCatalogSnapshot(scope)).toBe(current);
        expect(current?.data).toEqual([recreated]);
    });

    it('clears ordering evidence after authoritative refusal before a replacement inventory', () => {
        const entry = sharedEntry({ revision: 10 });
        applySavedSecretCatalogPage({ scope, entries: [entry], observedAt: 10 });
        applySavedSecretCatalogFailure({ scope, error: { kind: 'unauthorized', retryable: false } });
        applySavedSecretCatalogPage({ scope, entries: [], observedAt: 11 });
        applyAcknowledgedSavedSecretCatalogEntry(scope, { ...entry, revision: 2 }, true);
        expect(getSavedSecretCatalogSnapshot(scope)?.data).toMatchObject([{ revision: 2 }]);
    });

    it('uses the admitted delete revision when the removed resource was not in the displayed inventory', () => {
        applySavedSecretCatalogPage({ scope, entries: [], observedAt: 10 });
        removeDeletedSavedSecretCatalogResource(scope, 'resource-a', 5);
        const deleted = getSavedSecretCatalogSnapshot(scope);
        applyAcknowledgedSavedSecretCatalogEntry(scope, sharedEntry({ revision: 4 }), true);
        applyAcknowledgedSavedSecretCatalogEntry(scope, sharedEntry({ revision: 5 }), true);
        expect(getSavedSecretCatalogSnapshot(scope)).toBe(deleted);

        applySavedSecretCatalogPage({ scope, entries: [sharedEntry({ revision: 6 })], observedAt: 11 });
        const newer = getSavedSecretCatalogSnapshot(scope);
        removeDeletedSavedSecretCatalogResource(scope, 'resource-a', 5);
        removeDeletedSavedSecretCatalogResource(scope, 'resource-a', 6, false);
        expect(getSavedSecretCatalogSnapshot(scope)).toBe(newer);
    });

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

    it('retains metadata status during refresh without making stale credential material usable', () => {
        const entry = sharedEntry();
        applySavedSecretCatalogPage({ scope, entries: [entry], observedAt: 10 });
        invalidateSavedSecretCatalog(scope);
        beginSavedSecretCatalogLoad(scope);
        expect(resolveSavedSecretReference(scope, [], entry.ref)).toMatchObject({
            status: 'temporarily_unavailable', displayStatus: 'ready', secret: null,
        });
        applySavedSecretCatalogFailure({ scope, error: { kind: 'unreachable', retryable: true } });
        const failed = resolveSavedSecretReference(scope, [], entry.ref);
        expect(failed.status).toBe('temporarily_unavailable');
        expect(failed.displayStatus ?? failed.status).toBe('temporarily_unavailable');
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

    it('keeps current opened material usable during an unchanged-revision refresh', async () => {
        const entry = sharedEntry({ encryptionMode: 'plain' });
        const materialized = await materializeSavedSecretResources({
            resources: [{
                resourceId: 'resource-a', encryptionMode: 'plain', entry,
                storedContent: sealSavedSecretResourceStoredContentV1({ resourceId: 'resource-a', mode: 'plain',
                    content: { v: 1, name: entry.name!, kind: 'apiKey', value: 'opened-value' } }),
                recipientEnvelope: null,
            }],
            decryptDataKeyEnvelope: async () => null,
        });
        applySavedSecretCatalogPage({
            scope,
            ...materialized,
            observedAt: 10,
        });

        const material = getMaterializedSavedSecrets(scope);
        beginSavedSecretCatalogLoad(scope);
        beginSavedSecretCatalogLoad(scope);

        expect(getSavedSecretCatalogSnapshot(scope)).toMatchObject({
            status: 'refreshing',
            stale: false,
            error: null,
            materializedSecrets: material,
            data: [expect.objectContaining({ ref: 'happier:shared-secret:v1:resource-a' })],
        });
        const ref = material[0]!.id;
        expect(resolveSavedSecretReference(scope, [], ref)).toMatchObject({ status: 'ready', secret: material[0], revision: 1 });
        expect(getMaterializedSavedSecret(scope, ref)).toBe(material[0]);
        expect(getMaterializedSavedSecrets(scope)).toBe(material);
        expect(getUsableSavedSecrets(scope, [])).toEqual(material);
        for (const otherScope of [{ ...scope, accountId: 'account-b' }, { ...scope, serverId: 'home-b' }]) {
            expect(resolveSavedSecretReference(otherScope, [], ref).secret).toBeNull();
            expect(getMaterializedSavedSecrets(otherScope)).toEqual([]);
        }

        applyAcknowledgedSavedSecretCatalogEntry(scope, sharedEntry({ revision: 2 }), true);
        beginSavedSecretCatalogLoad(scope);
        expect(resolveSavedSecretReference(scope, [], ref)).toMatchObject({ status: 'temporarily_unavailable', revision: 2, secret: null });
        expect(getMaterializedSavedSecrets(scope)).toEqual([]);
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

    it('keeps every unchanged content field identical through an invalidated equal reload', () => {
        const page = (observedAt: number) => ({ scope, entries: [sharedEntry()], observedAt,
            corruptEntries: [{ materialStatus: 'resource_corrupt' as const, relationship: 'recipient' as const, repair: null }],
            legacyImport: { status: 'pending' as const, reason: 'source-uncharacterized' as const } });
        applySavedSecretCatalogPage(page(10));
        const settled = getSavedSecretCatalogSnapshot(scope)!;
        invalidateSavedSecretCatalog(scope);
        beginSavedSecretCatalogLoad(scope);
        applySavedSecretCatalogPage(page(11));
        const reloaded = getSavedSecretCatalogSnapshot(scope)!;
        expect(reloaded).toMatchObject({ status: 'ready', stale: false, lastObservedAt: 11 });
        expect(reloaded.data).toBe(settled.data);
        expect(reloaded.corruptEntries).toBe(settled.corruptEntries);
        expect(reloaded.legacyImport).toBe(settled.legacyImport);
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
        ['stale', () => invalidateSavedSecretCatalog(scope)],
        ['failed refresh', () => applySavedSecretCatalogFailure({ scope, error: { kind: 'unreachable', retryable: true } })],
        ['revoked', () => applySavedSecretCatalogFailure({ scope, error: { kind: 'unauthorized', retryable: false } })],
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
        beginSavedSecretCatalogLoad(scope);

        expect(resolveSavedSecretReference(scope, [], ref)).toMatchObject({
            kind: 'shared_resource',
            ref,
            status: 'temporarily_unavailable',
            secret: null,
        });
        expect(getMaterializedSavedSecrets(scope)).toEqual([]);
        expect(getMaterializedSavedSecret(scope, ref)).toBeNull();
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
