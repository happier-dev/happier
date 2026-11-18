import { afterEach, describe, expect, it, vi } from 'vitest';
import 'fake-indexeddb/auto';
import { act, renderHook } from '@/dev/testkit';
import { createPlainArtifactHomeFixture, projectArtifactStoredKind } from '@/dev/testkit/harness/artifactStoreBoundary';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, encodePlainArtifactStoredContent } from '@happier-dev/protocol/storage/artifactStoredContent';
import { BOT_TEMPLATE_ARTIFACT_KIND_V1 } from '@happier-dev/protocol/bots/templates/botTemplateV1';
import { deriveArtifactStoredKindV1 } from '@happier-dev/protocol/artifacts/artifactKindV1';
import { useReceivedBotTemplates } from './useReceivedBotTemplates';
import { publishHomeAccountChange, publishHomeAccountChangeWake } from '@/sync/runtime/orchestration/homeAccountChange';
import { planSyncActionsFromChanges, plannedArtifactKinds } from '@/sync/runtime/orchestration/changesPlanner';
import { ARTIFACT_LIST_PAGE_MAX_ITEMS_V1 } from '@happier-dev/protocol/artifacts/artifactListSelectionV1';

vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock());
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock().module);
vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());

let home: Awaited<ReturnType<typeof createPlainArtifactHomeFixture>> | undefined;
afterEach(async () => { await home?.dispose(); home = undefined; });

describe('Store received Bot templates', () => {
    it('reads once for a primary template change and never for a normal Doc across wake, receipt and feed', async () => {
        home = await createPlainArtifactHomeFixture('https://store-received-primary.test', { currentAccount: true });
        const hook = await renderHook(() => useReceivedBotTemplates('', true));
        const listReads = () => home!.requests.filter(request => new URL(request.path, 'https://home.test').pathname === '/v1/artifacts').length;
        await vi.waitFor(() => expect(listReads()).toBe(1));
        await vi.waitFor(() => expect(hook.getCurrent().loading).toBe(false));
        const publishPrimaryChange = async (id: string, header: Record<string, unknown>) => {
            const kinds = [deriveArtifactStoredKindV1(header)];
            const plan = planSyncActionsFromChanges([{ kind: 'artifact', entityId: id, cursor: 1, changedAt: 0,
                hint: { artifactKinds: kinds } }]);
            // Let each real read settle: burst coalescing must not hide duplicate lifecycle deliveries.
            for (const publish of [
                () => publishHomeAccountChangeWake(home!.home.id, { t: 'account-change', changeKinds: ['artifact'],
                    entityIds: [id], artifactKinds: kinds }, 'catch-up-pending'),
                () => publishHomeAccountChange(home!.home.id, [id], { source: 'socket', changesCatchUp: true, changeKinds: ['artifact'] }),
                () => publishHomeAccountChange(home!.home.id, [id], { changeKinds: ['artifact'],
                    artifactKinds: plannedArtifactKinds(plan), feedPageConsumed: true }),
            ]) {
                await act(async () => { publish(); });
                await vi.waitFor(() => expect(hook.getCurrent().loading).toBe(false));
            }
        };
        const beforeDoc = listReads();
        await publishPrimaryChange('unknown-doc', { kind: 'prompt_doc.v2', title: 'A normal Doc' });
        expect.soft(listReads()).toBe(beforeDoc);
        const header = { v: 1, kind: BOT_TEMPLATE_ARTIFACT_KIND_V1, state: 'released', title: 'New share',
            description: '', version: '1.0.0', changelog: '' };
        home.boundary.replaceStoredRow({ id: 'new-share', ownerAccountId: 'another-account', access: 'view', publicAudience: 'none',
            encryptionMode: 'plain', dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
            ...projectArtifactStoredKind(deriveArtifactStoredKindV1(header)), header: encodePlainArtifactStoredContent(header),
            headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 });
        home.boundary.seedAccountGrant('new-share', 'artifact-account', 'view');
        const beforeTemplate = listReads();
        await publishPrimaryChange('new-share', header);
        await vi.waitFor(() => expect(hook.getCurrent().items.map(item => item.source.artifactId)).toEqual(['new-share']));
        expect.soft(listReads() - beforeTemplate).toBe(1);
        // A blocked cursor still has the existing unscoped recovery wake, independent of its feed page.
        await act(async () => { publishHomeAccountChange(home!.home.id, undefined, { source: 'catch-up-pending' }); });
        await vi.waitFor(() => expect(hook.getCurrent().loading).toBe(false));
        expect(listReads() - beforeTemplate).toBe(2);
        await hook.unmount();
    });

    it('keeps loaded pages and unchanged item identities through a relevant refresh', async () => {
        home = await createPlainArtifactHomeFixture('https://store-received-pages.test', { currentAccount: true });
        // Cross the transport owner's real page boundary; no internal list or reader is mocked.
        for (let index = 0; index <= ARTIFACT_LIST_PAGE_MAX_ITEMS_V1; index++) {
            const id = `received-${String(index).padStart(4, '0')}`;
            const header = { v: 1, kind: BOT_TEMPLATE_ARTIFACT_KIND_V1, state: 'released', title: id,
                description: '', version: '1.0.0', changelog: '' };
            home.boundary.replaceStoredRow({ id, ownerAccountId: 'another-account', access: 'view', publicAudience: 'none',
                encryptionMode: 'plain', dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
                ...projectArtifactStoredKind(deriveArtifactStoredKindV1(header)), header: encodePlainArtifactStoredContent(header),
                headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: index + 1 });
            home.boundary.seedAccountGrant(id, 'artifact-account', 'view');
        }
        const listReads = () => home!.requests.filter(request => new URL(request.path, 'https://home.test').pathname === '/v1/artifacts').length;
        const hook = await renderHook(() => useReceivedBotTemplates('', true));
        await vi.waitFor(() => expect(hook.getCurrent().items).toHaveLength(ARTIFACT_LIST_PAGE_MAX_ITEMS_V1));
        expect(listReads()).toBe(1);
        expect(hook.getCurrent().hasNextPage).toBe(true);
        await act(async () => { await hook.getCurrent().nextPage(); });
        expect(hook.getCurrent().items).toHaveLength(ARTIFACT_LIST_PAGE_MAX_ITEMS_V1 + 1);
        expect(listReads()).toBe(2);
        const retained = hook.getCurrent().items;
        const secondPageItem = retained.at(-1)!;
        const changed = home.boundary.read(secondPageItem.source.artifactId)!;
        home.boundary.replaceStoredRow({ ...changed, headerVersion: 2,
            header: encodePlainArtifactStoredContent({ v: 1, kind: BOT_TEMPLATE_ARTIFACT_KIND_V1, state: 'released',
                title: secondPageItem.identity.name, description: '', version: '1.1.0', changelog: 'New release' }) });
        await act(async () => { publishHomeAccountChangeWake(home!.home.id,
            { t: 'account-change', changeKinds: ['artifact'], entityIds: [changed.id] }, 'socket'); });
        await vi.waitFor(() => expect(hook.getCurrent().items.at(-1)?.version).toBe('1.1.0'));
        expect(hook.getCurrent().items).toHaveLength(retained.length);
        expect(hook.getCurrent().items[0]).toBe(retained[0]);
        expect(hook.getCurrent().items.at(-1)).not.toBe(secondPageItem);
        expect(listReads()).toBe(4);
        const refreshed = hook.getCurrent().items;
        await act(async () => { await hook.getCurrent().refresh(); });
        expect(hook.getCurrent().items).toBe(refreshed);
        expect(listReads()).toBe(6);
        await hook.unmount();
    });

    it('follows share, release and revoke pushes with stable received headers and no unrelated or hidden reads', async () => {
        home = await createPlainArtifactHomeFixture('https://store-received-templates.test', { currentAccount: true });
        for (const [id, owner, kind] of [['received', 'another-account', BOT_TEMPLATE_ARTIFACT_KIND_V1],
            ['owned', 'artifact-account', BOT_TEMPLATE_ARTIFACT_KIND_V1], ['draft', 'another-account', BOT_TEMPLATE_ARTIFACT_KIND_V1],
            ['malformed', 'another-account', BOT_TEMPLATE_ARTIFACT_KIND_V1], ['document', 'another-account', 'document']] as const) {
            const header = { v: 1, kind, state: id === 'draft' ? 'draft' : 'released', title: id, description: 'A useful template',
                version: id === 'malformed' ? 'invalid-version' : '1.0.0', changelog: '' };
            home.boundary.replaceStoredRow({ id, ownerAccountId: owner, access: owner === 'artifact-account' ? 'owner' : 'edit',
                publicAudience: 'none', encryptionMode: 'plain', dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
                ...projectArtifactStoredKind(deriveArtifactStoredKindV1(header)), header: encodePlainArtifactStoredContent(header), headerVersion: 1,
                body: encodePlainArtifactStoredContent({ body: 'BODY MUST STAY UNREAD' }), bodyVersion: 1,
                seq: 1, createdAt: 1, updatedAt: 1 });
            if (owner !== 'artifact-account') home.boundary.seedAccountGrant(id, 'artifact-account', 'edit');
        }
        const hook = await renderHook(({ presented }) => useReceivedBotTemplates('', presented), { initialProps: { presented: false } });
        expect(home.requests.filter(request => request.path.startsWith('/v1/artifacts'))).toEqual([]);
        await hook.rerender({ presented: true });
        await vi.waitFor(() => expect(hook.getCurrent().items.map(item => item.source.artifactId)).toEqual(['received']));
        expect(hook.getCurrent().error).not.toBeNull();
        const reads = home.requests.filter(request => request.path.startsWith('/v1/artifacts'));
        expect(reads.some(request => new URL(request.path, 'https://home.test').searchParams.get('audience') === 'received')).toBe(true);
        expect(reads.every(request => !new URL(request.path, 'https://home.test').searchParams.has('includeBody'))).toBe(true);
        expect(reads.some(request => /\/v1\/artifacts\/(?:read|received|owned|document)/.test(request.path))).toBe(false);
        const items = hook.getCurrent().items;
        const beforeUnrelated = home.requests.length;
        await act(async () => {
            publishHomeAccountChangeWake(home!.home.id, { t: 'account-change', changeKinds: ['session'], entityIds: ['session'] }, 'socket');
            publishHomeAccountChangeWake('another-home', { t: 'account-change', changeKinds: ['artifact'], entityIds: ['received'] }, 'socket');
            publishHomeAccountChangeWake(home!.home.id, { t: 'account-change', changeKinds: ['artifact'],
                entityIds: ['unknown-document'], artifactKinds: [deriveArtifactStoredKindV1({ kind: 'document' })] }, 'socket');
        });
        expect(home.requests).toHaveLength(beforeUnrelated);
        const released = home.boundary.read('received')!;
        const newShare = { ...released, id: 'new-share', header: encodePlainArtifactStoredContent({
            v: 1, kind: BOT_TEMPLATE_ARTIFACT_KIND_V1, state: 'released', title: 'New share', description: '', version: '1.0.0', changelog: '' }) };
        home.boundary.replaceStoredRow(newShare);
        home.boundary.seedAccountGrant(newShare.id, 'artifact-account', 'view');
        const beforeShare = home.requests.length;
        await act(async () => { publishHomeAccountChangeWake(home!.home.id,
            { t: 'account-change', changeKinds: ['artifact'], entityIds: [newShare.id],
                artifactKinds: [deriveArtifactStoredKindV1({ kind: BOT_TEMPLATE_ARTIFACT_KIND_V1 })] }, 'socket'); });
        await vi.waitFor(() => expect(hook.getCurrent().items).toHaveLength(2));
        expect(home.requests.slice(beforeShare).filter(request => new URL(request.path, 'https://home.test').pathname === '/v1/artifacts')).toHaveLength(1);
        expect(hook.getCurrent().items.find(item => item.source.artifactId === 'received')).toBe(items[0]);
        const sharedItem = hook.getCurrent().items.find(item => item.source.artifactId === newShare.id);
        home.boundary.replaceStoredRow({ ...released, headerVersion: 2, header: encodePlainArtifactStoredContent({
            v: 1, kind: BOT_TEMPLATE_ARTIFACT_KIND_V1, state: 'released', title: 'received', description: 'A useful template', version: '1.1.0', changelog: 'New release' }) });
        await act(async () => { publishHomeAccountChangeWake(home!.home.id,
            { t: 'account-change', changeKinds: ['artifact'], entityIds: ['received'] }, 'socket'); });
        await vi.waitFor(() => expect(hook.getCurrent().items.find(item => item.source.artifactId === 'received')?.version).toBe('1.1.0'));
        expect(hook.getCurrent().items.find(item => item.source.artifactId === newShare.id)).toBe(sharedItem);
        const updatedItems = hook.getCurrent().items;
        await act(async () => { await hook.getCurrent().refresh(); });
        expect(hook.getCurrent().items).toBe(updatedItems);
        expect(hook.getCurrent().items).not.toBe(items);
        // The Home's post-revocation inventory no longer admits the second share.
        const retained = home.boundary.read('received')!;
        home.boundary.clear();
        home.boundary.replaceStoredRow(retained);
        home.boundary.seedAccountGrant(retained.id, 'artifact-account', 'view');
        await act(async () => { publishHomeAccountChangeWake(home!.home.id,
            { t: 'account-change', changeKinds: ['artifact'], entityIds: [newShare.id] }, 'socket'); });
        await vi.waitFor(() => expect(hook.getCurrent().items.map(item => item.source.artifactId)).toEqual(['received']));
        const readCount = home.requests.filter(request => request.path.startsWith('/v1/artifacts')).length;
        expect(home.requests.filter(request => request.path.startsWith('/v1/artifacts')).every(request =>
            !new URL(request.path, 'https://home.test').searchParams.has('includeBody') && !request.path.startsWith('/v1/artifacts/read'))).toBe(true);
        await hook.rerender({ presented: false });
        await act(async () => {
            publishHomeAccountChangeWake(home!.home.id, { t: 'account-change', changeKinds: ['artifact'], entityIds: ['received'] }, 'socket');
            await hook.getCurrent().refresh();
        });
        expect(home.requests.filter(request => request.path.startsWith('/v1/artifacts'))).toHaveLength(readCount);
        await hook.unmount();
    });
});
