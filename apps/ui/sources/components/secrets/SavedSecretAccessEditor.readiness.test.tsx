import * as React from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import { SavedSecretCatalogEntryV1Schema, type SavedSecretResourceEnvelopeCensusRecipientV1 } from '@happier-dev/protocol/account/settings/savedSecretCatalogV1';
import { SharedSavedSecretGrantsSetInputV1Schema } from '@happier-dev/protocol/account/settings/savedSecretResourceActionsV1';
import { computeContentPublicKeyFingerprint } from '@happier-dev/protocol/machines/identity/contentPublicKeyFingerprint';
import { encodeBase64 } from '@/encryption/base64';
import { ActionsSettingsV1Schema } from '@happier-dev/protocol/actions/actionSettings';
import { installApprovalCommonModuleMocks } from '@/components/approvals/approvalsTestHelpers';
import type { SecretSettingsTestHarness } from '@/components/settings/secrets/secretSettingsTestHarness';
import type { ShareSheetActions, ShareSheetModel } from '@/components/sharing/shareSheetTypes';

const announce = vi.hoisted(() => vi.fn());
const confirm = vi.hoisted(() => vi.fn(async () => true));
// Native accessibility, navigation, HTTP and Socket are genuine host boundaries.
installApprovalCommonModuleMocks({ modal: async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock({ spies: { confirm } }).module, reactNative: async () => (await import('@/dev/testkit/mocks/reactNative'))
    .createReactNativeNativeMock({ platformOS: 'ios' }, { AccessibilityInfo: { announceForAccessibility: announce, isScreenReaderEnabled: async () => false, isReduceMotionEnabled: async () => false, addEventListener: () => ({ remove() {} }) } }) });
vi.mock('expo-crypto', async original => ({ ...await original<typeof import('expo-crypto')>(), randomUUID: (await import('node:crypto')).randomUUID }));
vi.mock('socket.io-client', async original => (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(original));
vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());
vi.mock('@legendapp/list/react-native', async () => (await import('@/dev/testkit/mocks/legendList')).createLegendListModuleMock({ renderItems: true }));
// Load the real module graph after configuring the host boundary, outside each test's budget.
const { renderScreen, standardCleanup, createDeferred } = await import('@/dev/testkit');
const { loadSyncSingletonForTests } = await import('@/dev/testkit/harness/syncSingletonLoader');
const { installDisconnectedServerSocketBoundary } = await import('@/dev/testkit/harness/serverAccountConnectionHarness');
installDisconnectedServerSocketBoundary();
const { createSecretSettingsTestHarness } = await import('@/components/settings/secrets/secretSettingsTestHarness');
const { refreshSavedSecretCatalog, resetSavedSecretCatalogEngineForTests } = await import('@/sync/engine/settings/savedSecretCatalogEngine');
const { getSavedSecretCatalogSnapshot, resetSavedSecretCatalogSnapshotsForTests } = await import('@/sync/store/settings/savedSecretCatalogSnapshot');
const { resetTeamActionClientForTests } = await import('@/sync/ops/teams/teamActionClient');
const { settingsParse } = await import('@/sync/domains/settings/settings');
const { RoundButton } = await import('@/components/ui/buttons/RoundButton');
const { SavedSecretAccessEditor } = await import('./SavedSecretAccessEditor');
const { ShareSheet } = await import('@/components/sharing/ShareSheet');
const { createDocumentShareAdapter } = await import('@/components/sharing/documents/documentShareAdapter');
beforeAll(loadSyncSingletonForTests);
let account: SecretSettingsTestHarness | null = null;
beforeEach(() => { announce.mockClear(); confirm.mockReset().mockResolvedValue(true); resetSavedSecretCatalogEngineForTests(); resetSavedSecretCatalogSnapshotsForTests(); resetTeamActionClientForTests(); });
afterEach(async () => { await standardCleanup(); await account?.dispose(); account = null; });

const contentKey = new Uint8Array(32).fill(11);
const AVAILABLE = { status: 'available', contentPublicKey: encodeBase64(contentKey, 'base64'), contentPublicKeyFingerprint: computeContentPublicKeyFingerprint(contentKey) } as const;
function recipient(accountId: string, firstName: string, readiness: SavedSecretResourceEnvelopeCensusRecipientV1['readiness'], envelopeStatus: 'prepared' | 'missing'): SavedSecretResourceEnvelopeCensusRecipientV1 {
    return { account: { kind: 'account', accountId, name: firstName, firstName, lastName: null, username: null, avatarUrl: null }, readiness, envelopeStatus };
}
async function mount(options: { mode?: 'plain' | 'e2ee'; ask?: boolean; handleRequest?: (path: string, init?: RequestInit) => Promise<Response | null> } = {}) {
    account = await createSecretSettingsTestHarness({ ...options, settings: settingsParse({ actionsSettingsV1: ActionsSettingsV1Schema.parse({ v: 1,
        ...(options.ask ? { actions: { 'secrets.shared.grants.set': { approvalRequiredSurfaces: ['ui'] } } } : { approvalWaivedSurfaces: { 'secrets.shared.grants.set': ['ui'] } }) }) }) });
    const { entry } = await account.addOwnerResource();
    const audience = { accounts: [{ kind: 'account' as const, accountId: 'account-ready', name: 'Ready', firstName: 'Ready', lastName: null, username: null, avatarUrl: null }], teams: [], groups: [] };
    const resource = account.resources[0];
    if (!resource || !('resourceId' in resource)) throw new Error('Expected healthy owner resource');
    account.resources[0] = { ...resource, entry: SavedSecretCatalogEntryV1Schema.parse({ ...entry, audience }) };
    await refreshSavedSecretCatalog(account.scope);
    const decodedRow = getSavedSecretCatalogSnapshot(account.scope)?.data?.find(row => row.ref === entry.ref);
    if (!decodedRow) throw new Error('Expected real decoded catalog row');
    const decoded = decodedRow;
    const closed = vi.fn();
    const converted = vi.fn();
    const scope = account.scope;
    function Host() {
        const [open, setOpen] = React.useState(true);
        return open ? <SavedSecretAccessEditor target={{ kind: 'shared', entry: decoded }} scope={scope}
            onClose={() => { setOpen(false); closed(); }} onSaved={async () => {}} onMakeHomeManaged={converted} /> : null;
    }
    const screen = await renderScreen(<Host />);
    return { screen, closed, converted, account };
}

describe('SavedSecretAccessEditor recipient readiness', () => {
    it.each([false, true])('announces removal only after the grant writer succeeds, preserving pending and refused access (approval=%s)', async ask => {
        const response = createDeferred<Response>();
        let attempts = 0;
        const { screen, closed, account } = await mount({ ask, handleRequest: async (path, init) => {
            if (path !== '/v1/account/saved-secrets/resources/grants') return null;
            const input = SharedSavedSecretGrantsSetInputV1Schema.parse(JSON.parse(String(init?.body)));
            expect(input).toMatchObject({ resourceId: 'resource-a', expectedRevision: 3, accountGrants: [] });
            attempts += 1;
            return attempts === 1 ? response.promise : Response.json({ resourceId: input.resourceId, revision: 4 });
        } });
        await screen.pressByTestIdAsync('saved-secret-access-grant-account:account-ready');
        await screen.pressByTestIdAsync('saved-secret-access-remove:account:account-ready');
        if (ask) {
            confirm.mockResolvedValueOnce(false);
            await screen.pressByTestIdAsync('saved-secret-access-save');
            await vi.waitFor(() => expect(screen.findByTestId('saved-secret-access-failure')).toBeTruthy());
            expect(attempts).toBe(0);
            expect(announce).not.toHaveBeenCalled();
        }
        await screen.pressByTestIdAsync('saved-secret-access-save');
        await vi.waitFor(() => expect(attempts).toBe(1));
        try {
            expect(screen.findAllByType(RoundButton).find(button => button.props.testID === 'saved-secret-access-save')?.props.loading).toBe(true);
            expect(announce).not.toHaveBeenCalled();
            expect(closed).not.toHaveBeenCalled();
        } finally {
            await act(async () => { response.resolve(Response.json({ error: 'resource_changed' }, { status: 409 })); });
        }
        await vi.waitFor(() => expect(screen.findByTestId('saved-secret-access-failure')).toBeTruthy());
        expect(announce).not.toHaveBeenCalled();
        const retainedResource = account.resources[0];
        if (!retainedResource || !('resourceId' in retainedResource)) throw new Error('Expected healthy owner resource');
        expect(retainedResource.entry.audience?.accounts.map(row => row.accountId)).toEqual(['account-ready']);
        await screen.pressByTestIdAsync('saved-secret-access-save');
        await vi.waitFor(() => expect(closed).toHaveBeenCalledOnce());
        expect(screen.findByTestId('saved-secret-access-editor-body')).toBeNull();
        expect(announce).toHaveBeenCalledWith('shareSheet.removedAnnouncement');
        expect(announce).toHaveBeenCalledOnce();
    });

    it('preserves the settled removal announcement for an acknowledged share roster', async () => {
        const noop = () => {};
        const adapter = createDocumentShareAdapter({ artifactId: 'artifact-a', kind: 'workflow-definition.v1',
            grants: [], loading: false, readOnly: false, retryContent: noop });
        const principal = { ref: { kind: 'account', accountId: 'account-ready' }, key: 'account:account-ready',
            displayName: 'Ready', accessibilityLabel: 'Ready' } as const;
        function Host() {
            const [grants, setGrants] = React.useState<ShareSheetModel['grants']>([{ grant: principal.ref, principal,
                level: { kind: 'editable', value: 'view', options: ['view'] }, removal: { kind: 'allowed' }, operation: { kind: 'idle' } }]);
            const actions: ShareSheetActions = { setQuery: noop, retryDirectory: noop, loadMore: noop,
                addPrincipal: noop, retryMutation: noop, setAccessLevel: noop, requestRemove: () => setGrants([]),
                confirmRemove: noop, cancelRemove: noop, explain: noop };
            return <ShareSheet model={{ revision: 1, editable: true, stale: false, owner: null, grants,
                directory: { query: '', sections: [] } }} actions={actions} adapter={adapter} presentation="inline"
                openRowRequest={{ key: principal.key }} testID="document-share-editor" />;
        }
        const screen = await renderScreen(<Host />);
        await screen.pressByTestIdAsync('document-share-remove:account:account-ready');
        expect(announce).toHaveBeenCalledWith('shareSheet.removedAnnouncement');
        expect(announce).toHaveBeenCalledOnce();
    });

    it('tells the owner who can open an E2EE secret and what each recipient needs', async () => {
        const recipients = [recipient('account-a', 'Owner', AVAILABLE, 'prepared'), recipient('account-ready', 'Ready', AVAILABLE, 'prepared'),
            recipient('account-missing', 'Missing', AVAILABLE, 'missing'), recipient('account-plain', 'Plain', { status: 'unavailable', reason: 'plain_account' }, 'missing'),
            recipient('account-setup', 'Setup', { status: 'unavailable', reason: 'encryption_setup_required' }, 'missing')];
        const { screen, converted, account } = await mount({ mode: 'e2ee', handleRequest: async path => path.startsWith('/v1/account/saved-secrets/resources/envelope-census?')
            ? Response.json({ resourceId: 'resource-a', revision: 3, recipients, nextCursor: null }) : null });
        await vi.waitFor(() => expect(screen.findByTestId('saved-secret-recipient:account-plain')).toBeTruthy());
        const subtitle = (id: string) => screen.findAllByTestId(`saved-secret-recipient:${id}`)[0]?.props.subtitle;
        expect(subtitle('account-ready')).toBe('secrets.catalog.status.ready');
        expect(subtitle('account-missing')).toBe('secrets.catalog.status.preparing_encrypted_access');
        expect(subtitle('account-plain')).toBe('secrets.catalog.recipientHomeManagedRequired');
        expect(subtitle('account-setup')).toBe('secrets.catalog.recipientEncryptionSetupRequired');
        expect(screen.findByTestId('saved-secret-recipient:account-a')).toBeNull();
        await screen.pressByTestIdAsync('saved-secret-recipient-make-home-managed');
        expect(converted).toHaveBeenCalledOnce();
        expect(account.request.mock.calls.filter(([, init]) => init?.method === 'POST' && String(init?.body).includes('resource-a'))).toEqual([]);
    });

    it('does not read a census for a Home-managed secret', async () => {
        const { account } = await mount();
        expect(account.request.mock.calls.filter(([url]) => String(url).includes('/envelope-census'))).toEqual([]);
    });
});
