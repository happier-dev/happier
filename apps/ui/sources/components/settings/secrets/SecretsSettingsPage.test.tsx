import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SavedSecretCatalogCorruptEntryV1, SavedSecretCatalogEntryV1 } from '@happier-dev/protocol';

import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { act } from 'react-test-renderer';
import { installSettingsViewCommonModuleMocks } from '@/components/settings/settingsViewTestHelpers';
import type { SavedSecret } from '@/sync/domains/settings/savedSecretTypes';
import { createAccountTokenForTests, createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { sealSecretsDeep } from '@/sync/encryption/secretSettings';
import { createDeferred } from '@/dev/testkit/hooks/createDeferred';

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

const { SecretsSettingsPage } = await import('./SecretsSettingsPage');
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

describe('SecretsSettingsPage', () => {
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
        const { screen } = await renderPage({ personalSecrets: [], sharedEntries: [full, limited], ...handlers });
        await screen.pressByTestIdAsync(`saved-secret:${full.ref}:header`);
        await screen.pressByTestIdAsync(`saved-secret:${limited.ref}:header`);

        for (const id of ['rotate', 'rename', 'manageAccess', 'delete']) {
            expect(screen.findByTestId(`saved-secret:${full.ref}:${id}`)).toBeTruthy();
            expect(screen.findByTestId(`saved-secret:${limited.ref}:${id}`)).toBeFalsy();
        }
        await screen.pressByTestIdAsync(`saved-secret:${full.ref}:manageAccess`);
        expect(handlers.onManageAccessShared).toHaveBeenCalledWith(full);
    });

    it('offers the one conversion out of each secret\'s current mode, and only where the screen allows it', async () => {
        const e2ee = ownedEntry({ ref: 'happier:shared-secret:v1:e2ee', encryptionMode: 'e2ee' });
        const plain = ownedEntry({ ref: 'happier:shared-secret:v1:plain', encryptionMode: 'plain' });
        const onMakeSharedHomeManaged = vi.fn();
        const { screen } = await renderPage({ personalSecrets: [], sharedEntries: [e2ee, plain], onMakeSharedHomeManaged });
        await screen.pressByTestIdAsync(`saved-secret:${e2ee.ref}:header`);
        await screen.pressByTestIdAsync(`saved-secret:${plain.ref}:header`);

        // No handler for the other direction, so the Home-managed secret offers no conversion.
        expect(screen.findByTestId(`saved-secret:${plain.ref}:convertMode`)).toBeFalsy();
        await screen.pressByTestIdAsync(`saved-secret:${e2ee.ref}:convertMode`);
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
});

function AccessProbe() {
    return React.createElement('View', { testID: 'access-probe' });
}

function CreateProbe() {
    return React.createElement('View', { testID: 'create-probe' });
}
