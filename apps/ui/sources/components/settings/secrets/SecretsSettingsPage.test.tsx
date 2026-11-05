import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SavedSecretCatalogCorruptEntryV1, SavedSecretCatalogEntryV1 } from '@happier-dev/protocol/account/settings/savedSecretCatalogV1';

import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { act } from 'react-test-renderer';
import { installSettingsViewCommonModuleMocks } from '@/components/settings/settingsViewTestHelpers';
import type { SavedSecret } from '@/sync/domains/settings/savedSecretTypes';
import { createAccountTokenForTests, createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { sealSecretsDeep } from '@/sync/encryption/secretSettings';
import { createDeferred } from '@/dev/testkit/hooks/createDeferred';
import { applySavedSecretCatalogPage, beginSavedSecretCatalogLoad, invalidateSavedSecretCatalog,
    resetSavedSecretCatalogSnapshotsForTests, resolveSavedSecretReference } from '@/sync/store/settings/savedSecretCatalogSnapshot';

import type { SecretsSettingsPageProps } from './SecretsSettingsPage';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

installSettingsViewCommonModuleMocks();
const homeHarness = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homeHarness);

beforeEach(async () => {
    await homeHarness.reset();
    const { invalidateAccountEncryptionModeCache } = await import('@/sync/api/account/apiAccountEncryptionMode');
    invalidateAccountEncryptionModeCache();
});

afterEach(() => {
    standardCleanup();
    resetSavedSecretCatalogSnapshotsForTests();
});

const PERSONAL: SavedSecret = {
    id: 'personal-a',
    name: 'Work OpenAI',
    kind: 'apiKey',
    encryptedValue: { _isSecretValue: true, value: 'sk-never-rendered' },
    createdAt: 1,
    updatedAt: 1,
};

function ownedEntry(overrides: Partial<SavedSecretCatalogEntryV1> = {}): SavedSecretCatalogEntryV1 {
    return {
        ref: 'happier:shared-secret:v1:shared-a', source: 'shared_resource', relationship: 'owner',
        name: 'Deploy key', kind: 'token', encryptionMode: 'e2ee', owner: null, accessSources: [],
        audience: { accounts: [{ accountId: 'b' } as never], teams: [], groups: [] },
        ownerAccountId: 'owner-a', revision: 2, materialStatus: 'ready',
        capabilities: { use: true, rename: true, rotate: true, manageAccess: true, delete: true },
        ...overrides,
    } as SavedSecretCatalogEntryV1;
}

const { SecretsSettingsPage, SecretUsedBySection } = await import('./SecretsSettingsPage');
const { InjectedAuthProvider } = await import('@/auth/context/AuthContext');

async function renderPage(overrides: Partial<SecretsSettingsPageProps> = {}, accountId?: string) {
    const props: SecretsSettingsPageProps = {
        personalSecrets: [PERSONAL],
        sharedEntries: [] as SavedSecretCatalogEntryV1[],
        corruptEntries: [] as SavedSecretCatalogCorruptEntryV1[],
        // The page reads only the resolved status; the rest of a resolution is irrelevant here.
        resolveSharedReference: (ref: string) => ({ ref, kind: 'shared_resource', status: 'ready' }) as unknown as ReturnType<SecretsSettingsPageProps['resolveSharedReference']>,
        sharedCatalogStale: false,
        sharedCatalogStatus: 'ready',
        onRenamePersonal: vi.fn(async () => true),
        onRotatePersonal: vi.fn(async () => true),
        onDeletePersonal: vi.fn(async () => true),
        sharedMutationsDisabled: false,
        approvalId: null,
        onAdd: vi.fn(),
        onCancelAdd: vi.fn(),
        createEditor: null,
        accessEditor: null,
        ...overrides,
    };
    const screen = await renderScreen(
        <InjectedAuthProvider credentials={accountId ? { token: createAccountTokenForTests(accountId) } : null}>
            <SecretsSettingsPage {...props} />
        </InjectedAuthProvider>,
    );
    return { screen, props };
}

describe('SecretUsedBySection', () => {
    const rowsOf = (screen: Awaited<ReturnType<typeof renderScreen>>) => screen.findAll((node) => node.props.testID === 'used-by:row' && node.props.title !== undefined);

    it('links a named Provider to its own page and a family without a name to its page', async () => {
        const onOpen = vi.fn();
        const screen = await renderScreen(<SecretUsedBySection testID="used-by" onOpen={onOpen} usedBy={[
            { owner: 'provider', path: 'p.apiKey', referrer: { kind: 'provider', id: 'pc_work', displayName: 'Studio models' } },
            { owner: 'mcp', path: 'mcp.a' },
        ]} />);
        expect(rowsOf(screen).length).toBeGreaterThan(0);
        await act(async () => { rowsOf(screen)[0]!.props.onPress(); });
        expect(onOpen).toHaveBeenLastCalledWith('/(app)/settings/providers/pc_work');
        await act(async () => { rowsOf(screen).at(-1)!.props.onPress(); });
        expect(onOpen).toHaveBeenLastCalledWith('/settings/mcp');
    });

    it('shows one thing that reads the secret through two fields as one row', async () => {
        const provider = { kind: 'provider' as const, id: 'pc_work', displayName: 'Studio models' };
        const screen = await renderScreen(<SecretUsedBySection testID="used-by" usedBy={[
            { owner: 'provider', path: 'p.apiKey', referrer: provider },
            { owner: 'provider', path: 'p.other', referrer: provider },
        ]} />);
        expect(rowsOf(screen).map((node) => node.props.title)).toEqual(['Studio models']);
    });

    it('preserves distinct referrers with equal labels and unidentified reference paths', async () => {
        const screen = await renderScreen(<SecretUsedBySection testID="used-by" usedBy={[
            { owner: 'connectedAccountCredential', path: 'credentials.a', referrer: { kind: 'connectedAccountCredential', id: 'a', displayName: 'Work' } },
            { owner: 'connectedAccountCredential', path: 'credentials.b', referrer: { kind: 'connectedAccountCredential', id: 'b', displayName: 'Work' } },
            { owner: 'profile', path: 'profiles.a', referrer: { kind: 'profile', id: 'a', displayName: 'Work' } },
            { owner: 'profile', path: 'profiles.b', referrer: { kind: 'profile', id: 'b', displayName: 'Work' } },
            { owner: 'mcp', path: 'mcp.a' },
            { owner: 'mcp', path: 'mcp.b' },
        ]} />);
        expect(rowsOf(screen)).toHaveLength(6);
    });

    it('never presents unknown coverage as not used, and gives no row a dead link', async () => {
        const unknown = await renderScreen(<SecretUsedBySection testID="used-by" usedBy={null} />);
        const empty = await renderScreen(<SecretUsedBySection testID="used-by" usedBy={[]} />);
        const titleOf = (screen: Awaited<ReturnType<typeof renderScreen>>) => screen.findAll((node) => node.props.testID === 'used-by' && node.props.title !== undefined)[0]!.props.title;
        expect(titleOf(unknown)).not.toBe(titleOf(empty));
        const unidentified = await renderScreen(<SecretUsedBySection testID="used-by" onOpen={vi.fn()} usedBy={[{ owner: 'unknown', path: 'future.carrier' }]} />);
        expect(rowsOf(unidentified)[0]!.props.onPress).toBeUndefined();
    });
});

describe('SecretsSettingsPage', () => {
    it('opens a listed secret as its own page, and shows the page the Credentials rail selected', async () => {
        const first = ownedEntry();
        const second = ownedEntry({ ref: 'happier:shared-secret:v1:shared-b', name: 'Registry token' });
        const onOpenSecret = vi.fn();
        const { screen, props } = await renderPage({ personalSecrets: [], sharedEntries: [first, second], onOpenSecret });
        await screen.pressByTestIdAsync(`saved-secret:${second.ref}:header`);
        expect(onOpenSecret).toHaveBeenCalledWith(second.ref);

        await screen.update(<SecretsSettingsPage {...props} selectedRef={first.ref} />);
        expect(pageHeader(screen, first.ref)?.props.title).toBe(first.name);
        // The page replaces the list rather than expanding a row inside it.
        expect(screen.findByTestId(`saved-secret:${second.ref}:header`)).toBeFalsy();
        await screen.update(<SecretsSettingsPage {...props} selectedRef={second.ref} />);
        expect(pageHeader(screen, second.ref)?.props.title).toBe('Registry token');
    });

    it('keeps last-known row status while the catalog refresh withholds usable material', async () => {
        const entry = ownedEntry();
        const scope = { serverId: 'refresh-home', accountId: 'owner-a' };
        applySavedSecretCatalogPage({ scope, entries: [entry], observedAt: 1 });
        invalidateSavedSecretCatalog(scope);
        beginSavedSecretCatalogLoad(scope);
        const { screen } = await renderPage({ personalSecrets: [], sharedEntries: [entry], sharedCatalogStatus: 'refreshing',
            sharedCatalogStale: true, resolveSharedReference: ref => resolveSavedSecretReference(scope, [], ref) });
        const header = screen.findAll(row => row.props.testID === `saved-secret:${entry.ref}:header`
            && typeof row.props.subtitle === 'string')[0];
        expect(header?.props.subtitle).not.toContain('secrets.catalog.status.temporarily_unavailable');
        expect(header?.props.subtitleLeading).toBeUndefined();
    });
    it.each(['plain', 'e2ee'] as const)('discloses personal storage from the %s Account even when the device seals the value', async (mode) => {
        const accountId = `personal-storage-${mode}`;
        await homeHarness.addHome({
            name: 'Secrets Home', serverUrl: `https://secret-storage-${mode}.test`, accountId,
            accountEncryptionMode: mode,
        });
        const locallySealed = sealSecretsDeep({ ...PERSONAL, id: 'personal-sealed' }, new Uint8Array(32).fill(7));
        expect(locallySealed.encryptedValue.encryptedValue?.t).toBe('enc-v1');
        expect(locallySealed.encryptedValue.value).toBeUndefined();
        const shared = ownedEntry({ encryptionMode: mode === 'plain' ? 'e2ee' : 'plain' });
        const { screen } = await renderPage({ personalSecrets: [PERSONAL, locallySealed], sharedEntries: [shared] }, accountId);
        const label = mode === 'plain' ? 'secretsSettings.storagePlain' : 'secretsSettings.storageE2ee';
        const otherLabel = mode === 'plain' ? 'secretsSettings.storageE2ee' : 'secretsSettings.storagePlain';
        await vi.waitFor(() => {
            for (const secret of [PERSONAL, locallySealed]) {
                const header = screen.findAll((row) => row.props.testID === `saved-secret:${secret.id}:header` && typeof row.props.subtitle === 'string')[0];
                expect(header?.props.subtitle).toContain(label);
                expect(header?.props.subtitle).not.toContain(otherLabel);
            }
        });
        const sharedHeader = screen.findAll((row) => row.props.testID === `saved-secret:${shared.ref}:header` && typeof row.props.subtitle === 'string')[0];
        expect(sharedHeader?.props.subtitle).toContain(otherLabel);
        await screen.pressByTestIdAsync(`saved-secret:${locallySealed.id}:header`);
        expect(screen.findAll((row) => row.props.title === 'secretsSettings.storageTitle' && typeof row.props.subtitle === 'string')
            .some((row) => row.props.subtitle.startsWith(`${label}.`))).toBe(true);
        expect(screen.getTextContent()).not.toContain('sk-never-rendered');
        expect(screen.getTextContent()).not.toContain(locallySealed.encryptedValue.encryptedValue!.c);
    });

    it('withdraws the old Account storage disclosure when the mode owner invalidates it', async () => {
        const accountId = 'personal-storage-transition';
        const serverId = await homeHarness.addHome({
            name: 'Secrets Home', serverUrl: 'https://secret-storage-transition.test', accountId,
            accountEncryptionMode: 'plain',
        });
        const { screen } = await renderPage({}, accountId);
        const header = () => screen.findAll((row) => row.props.testID === `saved-secret:${PERSONAL.id}:header` && typeof row.props.subtitle === 'string')[0];
        await vi.waitFor(() => expect(header()?.props.subtitle).toContain('secretsSettings.storagePlain'));
        const response = createDeferred<void>();
        homeHarness.answer(serverId, '/v1/account/encryption', {
            body: { mode: 'e2ee', updatedAt: 2 }, respondAfter: response.promise,
        });
        const { invalidateAccountEncryptionModeCache } = await import('@/sync/api/account/apiAccountEncryptionMode');
        await act(async () => { invalidateAccountEncryptionModeCache(); });
        expect(header()?.props.subtitle).not.toContain('secretsSettings.storagePlain');
        expect(header()?.props.subtitle).not.toContain('secretsSettings.storageE2ee');
        await act(async () => { response.resolve(); });
        await vi.waitFor(() => expect(header()?.props.subtitle).toContain('secretsSettings.storageE2ee'));
    });

    it('never renders a secret value, and runs each personal operation from the expanded row', async () => {
        const { screen, props } = await renderPage({ onSharePersonal: vi.fn() });

        expect(screen.getTextContent()).not.toContain('sk-never-rendered');
        await screen.pressByTestIdAsync('saved-secret:personal-a:header');
        await screen.pressByTestIdAsync('saved-secret:personal-a:replace');
        expect(props.onRotatePersonal).not.toHaveBeenCalled();
        await act(async () => { screen.changeTextByTestId('saved-secret:personal-a:edit-input', 'replacement-secret'); });
        await screen.pressByTestIdAsync('saved-secret:personal-a:edit-save');
        await screen.pressByTestIdAsync('saved-secret:personal-a:rename');
        await act(async () => { screen.changeTextByTestId('saved-secret:personal-a:edit-input', 'Renamed key'); });
        await screen.pressByTestIdAsync('saved-secret:personal-a:edit-save');
        await screen.pressByTestIdAsync('saved-secret:personal-a:share');
        await screen.pressByTestIdAsync('saved-secret:personal-a:delete');

        expect(props.onRotatePersonal).toHaveBeenCalledWith(PERSONAL, 'replacement-secret');
        expect(props.onRenamePersonal).toHaveBeenCalledWith(PERSONAL, 'Renamed key');
        expect(props.onSharePersonal).toHaveBeenCalledWith(PERSONAL);
        expect(props.onDeletePersonal).toHaveBeenCalledWith(PERSONAL);
        expect(screen.getTextContent()).not.toContain('sk-never-rendered');
    });

    it('offers only the operations an owned shared secret\'s projected capabilities allow', async () => {
        const handlers = {
            onRenameShared: vi.fn(), onRotateShared: vi.fn(), onManageAccessShared: vi.fn(), onDeleteShared: vi.fn(),
        };
        const full = ownedEntry();
        const limited = ownedEntry({
            ref: 'happier:shared-secret:v1:shared-b',
            capabilities: { use: true, rename: false, rotate: false, manageAccess: false, delete: false },
        });
        const { screen, props } = await renderPage({ personalSecrets: [], sharedEntries: [full, limited], ...handlers, selectedRef: full.ref });
        for (const id of ['rotate', 'manageAccess', 'delete']) expect(screen.findByTestId(`saved-secret:${full.ref}:${id}`)).toBeTruthy();
        expect(moreMenuIds(screen)).toEqual(['rename']);
        await screen.pressByTestIdAsync(`saved-secret:${full.ref}:manageAccess`);
        expect(handlers.onManageAccessShared).toHaveBeenCalledWith(full);

        await screen.update(<SecretsSettingsPage {...props} selectedRef={limited.ref} />);
        for (const id of ['rotate', 'manageAccess', 'delete']) expect(screen.findByTestId(`saved-secret:${limited.ref}:${id}`)).toBeFalsy();
        expect(moreMenuIds(screen)).toEqual([]);
    });

    it('offers the one conversion out of each secret\'s current mode, and only where the screen allows it', async () => {
        const e2ee = ownedEntry({ ref: 'happier:shared-secret:v1:e2ee', encryptionMode: 'e2ee' });
        const plain = ownedEntry({ ref: 'happier:shared-secret:v1:plain', encryptionMode: 'plain' });
        const onMakeSharedHomeManaged = vi.fn();
        const { screen, props } = await renderPage({ personalSecrets: [], sharedEntries: [e2ee, plain], onMakeSharedHomeManaged, selectedRef: plain.ref });
        // No handler for the other direction, so the Home-managed secret offers no conversion.
        expect(moreMenuIds(screen)).not.toContain('convert');
        await screen.update(<SecretsSettingsPage {...props} selectedRef={e2ee.ref} />);
        expect(moreMenuIds(screen)).toContain('convert');
        await act(async () => moreMenu(screen)?.props.onSelect('convert'));
        expect(onMakeSharedHomeManaged).toHaveBeenCalledWith(e2ee);
    });

    it('shows corrupt secrets as information and offers the owner\'s delete as the only repair', async () => {
        const owner = {
            materialStatus: 'resource_corrupt', relationship: 'owner',
            repair: { kind: 'delete_resource', resourceId: 'opaque-owner-row', expectedRevision: 9 },
        } as const satisfies SavedSecretCatalogCorruptEntryV1;
        const recipient = {
            materialStatus: 'resource_corrupt', relationship: 'recipient', repair: null,
        } as const satisfies SavedSecretCatalogCorruptEntryV1;
        const onDeleteCorruptShared = vi.fn();
        const { screen } = await renderPage({ corruptEntries: [owner, recipient], onDeleteCorruptShared });

        expect(screen.findByTestId('saved-secret-corrupt:owner:0')).toBeTruthy();
        expect(screen.findByTestId('saved-secret-corrupt:recipient:0')).toBeTruthy();
        expect(screen.findByTestId('saved-secret-corrupt:recipient:0:delete')).toBeFalsy();
        await screen.pressByTestIdAsync('saved-secret-corrupt:owner:0:delete');
        expect(onDeleteCorruptShared).toHaveBeenCalledWith(owner);
    });

    it('says a secret\'s trouble with the shared status glyph, not a dot and a word in the line', async () => {
        const removed = ownedEntry({ materialStatus: 'access_removed' });
        const recipient = ownedEntry({ ref: 'happier:shared-secret:v1:shared-b', relationship: 'recipient', materialStatus: 'update_required' });
        const ready = ownedEntry({ ref: 'happier:shared-secret:v1:shared-c', name: 'Staging key' });
        const { screen } = await renderPage({ personalSecrets: [], sharedEntries: [removed, recipient, ready],
            resolveSharedReference: ref => ({ ref, kind: 'shared_resource',
                status: ref === removed.ref ? 'access_removed' : ref === recipient.ref ? 'update_required' : 'ready' }) as never });
        const glyph = (ref: string) => screen.findAll(node => node.props.testID === `saved-secret:${ref}:status` && node.props.status !== undefined)[0];
        expect(glyph(removed.ref)?.props.status).toBe('revoked');
        expect(glyph(recipient.ref)?.props.status).toBe('update');
        expect(glyph(removed.ref)?.props.label).toBe('secrets.catalog.status.access_removed');
        const header = screen.findAll(row => row.props.testID === `saved-secret:${removed.ref}:header` && typeof row.props.subtitle === 'string')[0];
        expect(header?.props.subtitle).not.toContain('secrets.catalog.status.access_removed');
        expect(header?.props.subtitleLeading).toBeUndefined();
        expect(glyph(ready.ref)).toBeUndefined();
    });

    it('opens the access editor inside the secret\'s own row, and the create editor in a draft row', async () => {
        const accessElement = <React.Fragment key="access"><AccessProbe /></React.Fragment>;
        const { screen } = await renderPage({
            onSharePersonal: vi.fn(),
            accessEditor: { key: PERSONAL.id, element: accessElement },
            createEditor: <CreateProbe />,
        });

        // The row with the open access editor is expanded without being pressed.
        expect(screen.findByTestId('access-probe')).toBeTruthy();
        expect(screen.findByTestId('saved-secret-draft')).toBeTruthy();
        expect(screen.findByTestId('create-probe')).toBeTruthy();
        // While adding, the section's Add is not offered a second time.
        expect(screen.findByTestId('saved-secret-add')?.props.disabled).toBe(true);
    });

    it('labels passkey and vault-linked rows from the value-free storage fact, never by reading content', async () => {
        const passkey = ownedEntry({ ref: 'happier:shared-secret:v1:passkey-a', name: 'GitHub passkey', kind: 'other',
            audience: { accounts: [], teams: [], groups: [] }, storage: { kind: 'passkey' } });
        const linked = ownedEntry({ ref: 'happier:shared-secret:v1:linked-a', name: 'Stripe key', kind: 'apiKey',
            audience: { accounts: [], teams: [], groups: [] },
            storage: { kind: 'external', provider: { pluginId: 'happier.secret-source.onepassword', localId: 'onepassword' } } });
        const { screen } = await renderPage({ personalSecrets: [], sharedEntries: [passkey, linked], scope: { serverId: 's', accountId: 'owner-a' } as never,
            onRotateShared: vi.fn() });
        const header = (ref: string) => screen.findAll(row => row.props.testID === `saved-secret:${ref}:header`
            && typeof row.props.subtitle === 'string')[0]?.props.subtitle as string;
        expect(header(passkey.ref)).toContain('secretsSettings.kindPasskey');
        expect(header(passkey.ref)).not.toContain('secrets.catalog.kinds.other');
        expect(header(linked.ref)).toContain('secretsSettings.storageLinked');
        const { screen: passkeyPage } = await renderPage({ personalSecrets: [], sharedEntries: [passkey, linked], scope: { serverId: 's', accountId: 'owner-a' } as never,
            onRotateShared: vi.fn(), selectedRef: passkey.ref });
        // A passkey keeps its key: no Replace and no Reveal, and the value row says why.
        expect(passkeyPage.findByTestId(`saved-secret:${passkey.ref}:rotate`)).toBeFalsy();
        expect(passkeyPage.findByTestId(`saved-secret:${passkey.ref}:value`)).toBeFalsy();
        expect(passkeyPage.findAll(row => row.props.subtitle === 'secretsSettings.valuePasskey').length).toBeGreaterThan(0);
        // A passkey is never revealed, so it has no reveal history; a linked secret keeps its own.
        expect(passkeyPage.findByTestId(`saved-secret:${passkey.ref}:history`)).toBeFalsy();
        const { screen: linkedPage } = await renderPage({ personalSecrets: [], sharedEntries: [passkey, linked], scope: { serverId: 's', accountId: 'owner-a' } as never,
            onRotateShared: vi.fn(), selectedRef: linked.ref });
        expect(linkedPage.findByTestId(`saved-secret:${linked.ref}:history`)).toBeTruthy();
        expect(headerMeta(linkedPage, linked.ref)).toContain('secretsSettings.storageLinked');
    });

    it('names the installed source a linked row reads from', async () => {
        const linked = ownedEntry({ ref: 'happier:shared-secret:v1:linked-b', name: 'Deploy token', kind: 'apiKey',
            audience: { accounts: [], teams: [], groups: [] },
            storage: { kind: 'external', provider: { pluginId: 'happier.secret-source.onepassword', localId: 'onepassword' },
                providerLabel: '1Password' } });
        const { screen } = await renderPage({ personalSecrets: [], sharedEntries: [linked], scope: { serverId: 's', accountId: 'owner-a' } as never,
            onRotateShared: vi.fn() });
        const header = screen.findAll(row => row.props.testID === `saved-secret:${linked.ref}:header`
            && typeof row.props.subtitle === 'string')[0]?.props.subtitle as string;
        expect(header).toContain('secretsSettings.storageLinkedTo(provider=1Password)');
        const { screen: page } = await renderPage({ personalSecrets: [], sharedEntries: [linked], scope: { serverId: 's', accountId: 'owner-a' } as never,
            onRotateShared: vi.fn(), selectedRef: linked.ref });
        expect(page.findAll(row => row.props.subtitle === 'secretsSettings.valueLinkedTo(provider=1Password)').length).toBeGreaterThan(0);
        expect(headerMeta(page, linked.ref)).toContain('secretsSettings.storageLinkedTo(provider=1Password)');
    });
});

type RenderedPage = Awaited<ReturnType<typeof renderPage>>['screen'];
/** The secret page's ⋯ menu (its rows render only while open, so read what it offers). */
function moreMenu(screen: RenderedPage) {
    return screen.findAll(node => Array.isArray(node.props.items) && typeof node.props.onSelect === 'function'
        && typeof node.props.trigger === 'function')[0];
}
function moreMenuIds(screen: RenderedPage): string[] {
    return (moreMenu(screen)?.props.items ?? []).map((item: { id: string }) => item.id);
}
/** The facts on the secret page's identity line. */
function headerMeta(screen: RenderedPage, ref: string): string[] {
    return (pageHeader(screen, ref)?.props.meta ?? []).map((fact: { text: string }) => fact.text);
}
/** The secret page's header element (its props, not the host view it renders). */
function pageHeader(screen: RenderedPage, ref: string) {
    return screen.findAll(node => node.props.testID === `saved-secret:${ref}:page-header` && Array.isArray(node.props.meta))[0];
}

function AccessProbe() {
    return React.createElement('View', { testID: 'access-probe' });
}

function CreateProbe() {
    return React.createElement('View', { testID: 'create-probe' });
}
