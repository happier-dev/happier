import { describe, expect, it, onTestFinished } from 'vitest';
import { createStore } from 'zustand/vanilla';
import { mergeThemeProfileDocumentEdit, parseThemeProfileDocument } from '@happier-dev/protocol/account/settings/themeProfiles';
import { createPlainArtifactHomeFixture } from '@/dev/testkit/harness/artifactStoreBoundary';
import { captureLazyActionAccountContext } from '@/sync/ops/actions/actionAccountContext';
import { createArtifactsDomain, type ArtifactsDomain } from '@/sync/store/domains/artifacts';
import type { ArtifactDataKeyCacheEntry } from '@/sync/engine/artifacts/syncArtifacts';
import { isArtifactInventoryLoaded } from '@/sync/domains/artifacts/artifactInventory';
import { createThemeProfileArtifactAdapter } from './themeProfileArtifactAdapter';
import { createThemeProfileLibrary } from './themeProfileLibrary';
import { ThemeProfileArtifactHeaderSchema } from '@happier-dev/protocol/account/settings/themeProfileArtifact';

describe('captured theme Artifact adapter', () => {
    it('loads headers, demands one retained body and preserves siblings through addressed CAS and Undo', async () => {
        const home = await createPlainArtifactHomeFixture('https://theme-artifacts.test', { currentAccount: true });
        const account = await captureLazyActionAccountContext(home.home.id);
        onTestFinished(async () => { account.dispose(); await home.dispose(); });
        const { encryption } = await account.resolveAccountEncryption();
        const store = createStore<ArtifactsDomain>((set, get) => createArtifactsDomain({ set, get }));
        const captured = { credentials: account.credentials, request: account.request, readTransport: account.readTransport,
            serverId: account.serverId, ownerAccountId: account.accountId, encryption, artifactDataKeys: new Map<string, ArtifactDataKeyCacheEntry>() };
        const adapter = () => {
            const before = store.getState().artifacts;
            return createThemeProfileArtifactAdapter({ ...captured, readArtifacts: () => store.getState().artifacts,
                applyArtifacts: rows => store.getState().applyArtifacts(rows),
                applyInventory: (rows, source) => store.getState().applyArtifacts(rows, source ? before : undefined, ['theme_profile.v1'], source),
                deleteArtifact: id => store.getState().deleteArtifact(id),
                isLoaded: () => isArtifactInventoryLoaded(store.getState(), ['theme_profile.v1']) });
        };
        const library = (artifacts: ReturnType<typeof adapter>) => createThemeProfileLibrary({ artifacts,
            now: () => Date.parse('2026-11-16T12:00Z'), createId: () => '33333333-3333-4333-8333-333333333333',
            readSelection: () => ({ light: null, dark: null }), writeSelection: () => {} });
        const document = (id: string) => {
            const parsed = parseThemeProfileDocument({ schemaVersion: 2, id, name: id, createdAt: 'old', updatedAt: 'old',
                base: { light: 'light', dark: 'dark' }, overrides: { light: {}, dark: {} }, assetAppearance: 'dark',
                style: { futurePresentation: { glow: true } }, css: '.surface { color: red; }'.repeat(1000) });
            if (!parsed.ok) throw new Error('Invalid fixture');
            return parsed.document;
        };
        const first = '11111111-1111-4111-8111-111111111111';
        const sibling = '22222222-2222-4222-8222-222222222222';
        await library(adapter()).save({ document: document(first) }).catch(error => {
            const row = store.getState().artifacts[first];
            const header = ThemeProfileArtifactHeaderSchema.safeParse(row?.rawHeader ?? row?.header);
            const parsed = row?.isDecrypted && typeof row.body === 'string' ? parseThemeProfileDocument(JSON.parse(row.body)) : null;
            throw new Error(JSON.stringify({ id: row?.id, owner: row?.ownerAccountId, expectedOwner: account.accountId,
                access: row?.access, sourceServerId: row?.sourceServerId, expectedServer: account.serverId,
                decrypted: row?.isDecrypted, bodyType: typeof row?.body,
                header: header.success ? 'valid' : header.error.issues,
                document: parsed?.ok ? { id: parsed.document.profile.id } : parsed }), { cause: error });
        });
        await library(adapter()).save({ document: document(sibling) });
        expect(JSON.parse(home.boundary.readPlainBody(first)!)).toMatchObject({ schemaVersion: 2, style: { futurePresentation: { glow: true } } });
        // A fresh retained-client projection starts without any opened bodies.
        store.setState({ ...createArtifactsDomain({ set: store.setState, get: store.getState }) }, true);
        const cold = library(adapter());
        const coldStart = home.requests.length;
        const applied = await cold.keep({ document: document(first), mode: 'dark' });
        expect(applied.change.changedIds).toEqual([]);
        await cold.undo(applied.undo!);
        expect(home.boundary.read(first)).not.toBeNull();
        expect(home.requests.slice(coldStart).filter(request => request.path.startsWith('/v1/artifacts')))
            .toMatchObject([{ method: 'POST', path: '/v1/artifacts' }]);
        store.setState({ ...createArtifactsDomain({ set: store.setState, get: store.getState }) }, true);
        const fresh = adapter();
        const readsBefore = home.requests.length;
        await fresh.load();
        expect(fresh.list()).toHaveLength(2);
        expect(Object.values(store.getState().artifacts).every(row => row.body === undefined)).toBe(true);
        expect(home.requests.slice(readsBefore).every(request => !/^\/v1\/artifacts\/[^/?]+$/.test(request.path))).toBe(true);
        const demanded = await library(fresh).get({ kind: 'artifact', id: first });
        expect(demanded?.raw.schemaVersion).toBe(2);
        const writesBefore = home.requests.filter(request => request.method === 'POST' && request.path === `/v1/artifacts/${first}`).length;
        await library(fresh).save({ document: demanded! });
        expect(home.requests.filter(request => request.method === 'POST' && request.path === `/v1/artifacts/${first}`)).toHaveLength(writesBefore);
        home.boundary.beforeNextUpdate(async () => {
            const current = home.boundary.read(first)!;
            home.boundary.replaceStoredRow({ ...current, bodyVersion: current.bodyVersion + 1 });
        });
        await expect(library(fresh).save({ document: mergeThemeProfileDocumentEdit(demanded!, { name: 'Conflicting edit' }) })).rejects.toThrow();
        expect(JSON.parse(home.boundary.readPlainBody(first)!).name).toBe(first);
        const keptLibrary = library(fresh);
        const kept = await keptLibrary.keep({ document: document('33333333-3333-4333-8333-333333333333'), mode: 'dark' });
        const row = home.boundary.read(kept.entry!.id)!;
        home.boundary.replaceStoredRow({ ...row, bodyVersion: row.bodyVersion + 1 });
        await expect(keptLibrary.undo(kept.undo!)).rejects.toThrow();
        expect(home.boundary.read(kept.entry!.id)).not.toBeNull();
        expect(home.boundary.read(sibling)).not.toBeNull();
    });
});
