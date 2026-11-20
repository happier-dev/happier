import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import {
    changeTextTestInstance,
    createDeferred,
    findTestInstanceByTypeContainingText,
    findTestInstanceByTypeWithProps,
    pressTestInstanceAsync,
    renderScreen,
} from '@/dev/testkit';
import type { SavedSecret } from '@/sync/domains/settings/savedSecretTypes';
import { Modal } from '@/modal';
import { HappyError } from '@/utils/errors/errors';
import type { SavedSecretCatalogEntryV1 } from '@happier-dev/protocol/account/settings/savedSecretCatalogV1';
import { SavedSecretCatalogEntryV1Schema } from '@happier-dev/protocol/account/settings/savedSecretCatalogV1';
import { SecretsList } from './SecretsList';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    // The testkit default serializes parameters as `key(name=value)`, which is
    // what lets a row assert that the projected owner and access source reach
    // the copy rather than only that some key was used.
    return createTextModuleMock();
});

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
}));

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock({
        theme: {
            colors: {
                text: '#000',
                textSecondary: '#666',
                divider: '#ddd',
                surface: '#fff',
                button: { primary: { background: '#00f', tint: '#fff' }, secondary: { tint: '#00f' } },
                input: { background: '#fff', placeholder: '#999', text: '#000' },
                groupped: { sectionTitle: '#333' },
                state: { warning: { foreground: '#a60' } },
            },
        },
    });
});

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock(
        {
                                    Platform: {
                                        OS: 'ios',
                                        select: <T,>(obj: { ios?: T; default?: T }) => obj.ios ?? obj.default,
                                    },
                                    AppState: {
                                        addEventListener: () => ({ remove: () => {} }),
                                    },
                                    Pressable: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
                                        React.createElement('Pressable', props, props.children),
                                    Text: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
                                        React.createElement('Text', props, props.children),
                                    View: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
                                        React.createElement('View', props, props.children),
                                    TextInput: React.forwardRef<{ focus: () => void }, Record<string, unknown>>((props, ref) => {
                                        if (ref && typeof ref === 'object') {
                                            ref.current = { focus: () => {} };
                                        }
                                        return React.createElement('TextInput', props);
                                    }),
                                }
    );
});

vi.mock('@/components/ui/lists/ItemList', () => ({
    ItemList: ({ children }: { children?: React.ReactNode }) => React.createElement(React.Fragment, null, children),
}));

vi.mock('@/components/ui/lists/ItemGroup', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/components/ui/lists/ItemGroup')>();
    return {
        ...actual,
        ItemGroup: ({ children }: { children?: React.ReactNode }) => React.createElement(React.Fragment, null, children),
    };
});

vi.mock('@/components/ui/lists/ItemRowActions', () => ({
    ItemRowActions: (props: Record<string, unknown>) => React.createElement('ItemRowActions', props),
}));

vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock({
        spies: {
            show: vi.fn(),
            prompt: vi.fn(),
            confirm: vi.fn(),
            alert: vi.fn(),
        },
    }).module;
});

async function renderSecretsList(params?: {
    secrets?: SavedSecret[];
    allowAdd?: boolean;
    includeNoneRow?: boolean;
    defaultId?: string | null;
    sharedEntries?: readonly SavedSecretCatalogEntryV1[];
    sharedCatalogError?: import('@/sync/domains/scope/scopedSnapshotFacts').ScopedSnapshotError | null;
    resolveSharedReference?: import('./SecretsList').SecretsListProps['resolveSharedReference'];
    sharedCatalogStale?: boolean;
    onRetrySharedCatalog?: () => void;
    onCreatePersonal?: () => Promise<string | null>;
}) {
    const onCreatePersonal = vi.fn(params?.onCreatePersonal ?? (async () => 'uuid-1'));
    const onRenamePersonal = vi.fn(async () => true);
    const onRotatePersonal = vi.fn(async () => true);
    const onDeletePersonal = vi.fn(async () => true);
    const onAfterAddSelectId = vi.fn<(id: string) => void>();
    const onSelectId = vi.fn<(id: string) => void>();

    const screen = await renderScreen(
        React.createElement(SecretsList, {
            secrets: params?.secrets ?? [],
            onCreatePersonal,
            onRenamePersonal,
            onRotatePersonal,
            onDeletePersonal,
            onAfterAddSelectId,
            onSelectId,
            defaultId: params?.defaultId,
            includeNoneRow: params?.includeNoneRow,
            allowAdd: params?.allowAdd,
            sharedEntries: params?.sharedEntries,
            resolveSharedReference: params?.resolveSharedReference,
            sharedCatalogStale: params?.sharedCatalogStale,
            sharedCatalogError: params?.sharedCatalogError,
            onRetrySharedCatalog: params?.onRetrySharedCatalog,
        }),
    );

    return {
        screen,
        onCreatePersonal,
        onAfterAddSelectId,
        onSelectId,
    };
}

describe('SecretsList', () => {
    beforeEach(() => {
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('states who shared a recipient row and which access carries it', async () => {
        // Picking a shared secret is a decision about whose credential a Session
        // will spend. The Home already projects the recipient-safe owner and the
        // access that grants the row; a row that shows only "Ready" makes two
        // identically named secrets from two different Teams indistinguishable.
        const viaTeam = SavedSecretCatalogEntryV1Schema.parse({
            ref: 'happier:shared-secret:v1:shared-team', source: 'shared_resource', relationship: 'recipient',
            name: 'Deploy key', kind: 'apiKey', encryptionMode: null,
            owner: { kind: 'account', accountId: 'owner-a', firstName: 'Ada', lastName: null, username: null, avatarUrl: null },
            accessSources: [{ kind: 'team', teamId: 'team-1', name: 'Platform' }],
            audience: null, ownerAccountId: null, revision: 2, materialStatus: 'ready',
            capabilities: { use: true, rename: false, rotate: false, manageAccess: false, delete: false },
        });
        const direct = {
            ...viaTeam,
            ref: 'happier:shared-secret:v1:shared-direct',
            accessSources: [{ kind: 'account' }],
        } as const satisfies SavedSecretCatalogEntryV1;

        const { screen } = await renderSecretsList({ sharedEntries: [viaTeam, direct] });

        const rendered = screen.getTextContent();
        expect(rendered).toContain('secrets.catalog.provenance.sharedBy(owner=Ada)');
        expect(rendered).toContain('secrets.catalog.provenance.via(source=Platform)');
        expect(rendered).toContain('secrets.catalog.provenance.direct');
    });

    it('shows a passkey in a value picker as not choosable, since it is not a value', async () => {
        const passkey = SavedSecretCatalogEntryV1Schema.parse({
            ref: 'happier:shared-secret:v1:passkey-a', source: 'shared_resource', relationship: 'owner',
            name: 'GitHub passkey', kind: 'other', encryptionMode: 'e2ee', owner: null, accessSources: [],
            audience: { accounts: [], teams: [], groups: [] }, ownerAccountId: 'owner-a', revision: 1, materialStatus: 'ready',
            capabilities: { use: true, rename: true, rotate: true, manageAccess: true, delete: true },
            storage: { kind: 'passkey' },
        });
        const { screen, onSelectId } = await renderSecretsList({ sharedEntries: [passkey] });
        const row = screen.findAll(node => node.props.testID === `saved-secret:${passkey.ref}` && typeof node.props.subtitle === 'string')[0];
        expect(row?.props.disabled).toBe(true);
        expect(String(row?.props.subtitle)).toContain('secretsSettings.kindPasskey');
        await screen.pressByTestIdAsync(`saved-secret:${passkey.ref}`).catch(() => undefined);
        expect(onSelectId).not.toHaveBeenCalled();
    });

    it('says once that the Home is out of reach instead of repeating it on every shared row', async () => {
        const base = SavedSecretCatalogEntryV1Schema.parse({
            ref: 'happier:shared-secret:v1:a', source: 'shared_resource', relationship: 'owner',
            name: 'Deploy key', kind: 'apiKey', encryptionMode: null, owner: null, accessSources: [],
            audience: null, ownerAccountId: null, revision: 1, materialStatus: 'temporarily_unavailable',
            capabilities: { use: true, rename: true, rotate: true, manageAccess: true, delete: true },
        });
        const entries = [base, { ...base, ref: 'happier:shared-secret:v1:b', name: 'Registry token' },
            { ...base, ref: 'happier:shared-secret:v1:c', name: 'Sentry DSN' }];
        const { screen } = await renderSecretsList({ sharedEntries: entries });

        expect(screen.getTextContent().split('secrets.catalog.status.temporarily_unavailable')).toHaveLength(2);
        expect(screen.findHostByTestId('saved-secret-catalog-unreachable')).not.toBeNull();
    });

    it('presents the typed credential cause and retry step', async () => {
        const { screen } = await renderSecretsList({ sharedCatalogStale: true,
            sharedCatalogError: { kind: 'unknown', code: 'credential_unavailable', retryable: true },
            onRetrySharedCatalog: vi.fn() });
        expect(screen.getTextContent()).toContain('session.startFailure.cause.credential_unavailable');
        expect(screen.getTextContent()).toContain('common.retry');
        expect(screen.getTextContent()).not.toContain('secrets.catalog.operationFailed');
    });

    it('presents a row material cause retained by the snapshot resolver', async () => {
        const { applySavedSecretCatalogPage, resolveSavedSecretReference, resetSavedSecretCatalogSnapshotsForTests } = await import('@/sync/store/settings/savedSecretCatalogSnapshot');
        const entry = SavedSecretCatalogEntryV1Schema.parse({
            ref: 'happier:shared-secret:v1:row-cause', source: 'shared_resource', relationship: 'owner',
            name: 'Row cause', kind: 'apiKey', revision: 1, materialStatus: 'temporarily_unavailable',
            capabilities: { use: false, rename: true, rotate: true, manageAccess: true, delete: true },
        });
        const scope = { serverId: 'row-cause-home', accountId: 'row-cause-account' };
        applySavedSecretCatalogPage({ scope, entries: [entry], observedAt: 1,
            materialErrors: { [entry.ref]: { kind: 'invalid', retryable: false, code: 'credential_unavailable' } } });
        const { screen } = await renderSecretsList({ sharedEntries: [entry],
            resolveSharedReference: ref => resolveSavedSecretReference(scope, [], ref) });
        expect(screen.getTextContent()).toContain('session.startFailure.cause.credential_unavailable');
        expect(screen.findHostByTestId('saved-secret-catalog-unreachable')).toBeNull();
        resetSavedSecretCatalogSnapshotsForTests();
    });

    it('offers a working refresh action when the shared catalog is stale', async () => {
        const onRetrySharedCatalog = vi.fn();
        const { screen } = await renderSecretsList({ sharedCatalogStale: true, onRetrySharedCatalog });

        // What failed leads the notice; Retry is its inline action, not the row's title.
        expect(screen.findHostByTestId('saved-secret-catalog-failed')).not.toBeNull();
        expect(screen.getTextContent()).toContain('secrets.catalog.operationFailed');
        await screen.pressByTestIdAsync('saved-secret-catalog-retry');

        expect(onRetrySharedCatalog).toHaveBeenCalledOnce();
    });

    it('adds a secret via the inline expander without modal prompts', async () => {
        const { screen, onCreatePersonal, onAfterAddSelectId } = await renderSecretsList();

        const addItem = findTestInstanceByTypeContainingText(screen, 'Pressable', 'common.add');
        expect(addItem).toBeTruthy();

        await pressTestInstanceAsync(addItem, 'common.add row');

        const nameInput = findTestInstanceByTypeWithProps(screen, 'TextInput', {
            placeholder: 'secrets.placeholders.nameExample',
        });
        const valueInput = findTestInstanceByTypeWithProps(screen, 'TextInput', {
            placeholder: 'secrets.placeholders.valueExample',
        });
        expect(nameInput).toBeTruthy();
        expect(valueInput).toBeTruthy();

        act(() => {
            changeTextTestInstance(nameInput, 'My Key', 'secret name input');
            changeTextTestInstance(valueInput, '  sk-test\n', 'secret value input');
        });

        const saveButton = findTestInstanceByTypeWithProps(screen, 'Pressable', {
            accessibilityLabel: 'common.save',
        });
        expect(saveButton).toBeTruthy();
        expect(saveButton?.props.disabled).toBe(false);

        await pressTestInstanceAsync(saveButton, 'common.save button');

        expect(onCreatePersonal).toHaveBeenCalledWith({
            name: 'My Key',
            value: '  sk-test\n',
        });
        expect(onAfterAddSelectId).toHaveBeenCalledWith('uuid-1');
    });

    it('keeps an inline create draft after a typed refusal', async () => {
        const { screen, onAfterAddSelectId } = await renderSecretsList({ onCreatePersonal: async () => {
            throw new HappyError('Creation declined', false, { code: 'resource_changed' });
        } });
        await pressTestInstanceAsync(findTestInstanceByTypeContainingText(screen, 'Pressable', 'common.add'), 'add');
        const name = findTestInstanceByTypeWithProps(screen, 'TextInput', { placeholder: 'secrets.placeholders.nameExample' });
        const value = findTestInstanceByTypeWithProps(screen, 'TextInput', { placeholder: 'secrets.placeholders.valueExample' });
        act(() => {
            changeTextTestInstance(name, 'Workspace token', 'name');
            changeTextTestInstance(value, 'dummy-workspace-token', 'value');
        });
        await pressTestInstanceAsync(findTestInstanceByTypeWithProps(screen, 'Pressable', {
            accessibilityLabel: 'common.save',
        }), 'save');
        expect(Modal.alert).toHaveBeenCalledWith('common.error', 'approvals.conflictFailure');
        expect(name?.props.value).toBe('Workspace token');
        expect(onAfterAddSelectId).not.toHaveBeenCalled();
    });

    it.each(['closes', 'cancels adding'] as const)('does not select a late-created secret after its picker %s', async (retirement) => {
        // Creation crosses the Home boundary; the picker may close while that write settles.
        const creation = createDeferred<string | null>();
        const { screen, onAfterAddSelectId } = await renderSecretsList({ onCreatePersonal: () => creation.promise });
        await pressTestInstanceAsync(findTestInstanceByTypeContainingText(screen, 'Pressable', 'common.add'), 'add');
        act(() => {
            changeTextTestInstance(findTestInstanceByTypeWithProps(screen, 'TextInput', {
                placeholder: 'secrets.placeholders.nameExample',
            }), 'Workspace token', 'name');
            changeTextTestInstance(findTestInstanceByTypeWithProps(screen, 'TextInput', {
                placeholder: 'secrets.placeholders.valueExample',
            }), 'dummy-workspace-token', 'value');
        });
        const save = findTestInstanceByTypeWithProps(screen, 'Pressable', { accessibilityLabel: 'common.save' });
        let saving: Promise<void> | undefined;
        act(() => { saving = save?.props.onPress(); });
        if (retirement === 'closes') await act(async () => { screen.unmount(); });
        else await pressTestInstanceAsync(findTestInstanceByTypeWithProps(screen, 'Pressable', {
            accessibilityLabel: 'common.cancel',
        }), 'cancel add');
        await act(async () => { creation.resolve('created-secret'); await saving; });
        expect(onAfterAddSelectId).not.toHaveBeenCalled();
    });

    it('keeps save disabled until both name and value are provided', async () => {
        const { screen } = await renderSecretsList();

        const addItem = findTestInstanceByTypeContainingText(screen, 'Pressable', 'common.add');
        expect(addItem).toBeTruthy();

        await pressTestInstanceAsync(addItem, 'common.add row');

        const nameInput = findTestInstanceByTypeWithProps(screen, 'TextInput', {
            placeholder: 'secrets.placeholders.nameExample',
        });
        const valueInput = findTestInstanceByTypeWithProps(screen, 'TextInput', {
            placeholder: 'secrets.placeholders.valueExample',
        });
        const saveButton = findTestInstanceByTypeWithProps(screen, 'Pressable', {
            accessibilityLabel: 'common.save',
        });

        expect(saveButton?.props.disabled).toBe(true);

        act(() => {
            changeTextTestInstance(nameInput, 'ONLY_NAME', 'secret name input');
        });
        expect(findTestInstanceByTypeWithProps(screen, 'Pressable', { accessibilityLabel: 'common.save' })?.props.disabled).toBe(true);

        act(() => {
            changeTextTestInstance(valueInput, 'has-value', 'secret value input');
        });
        expect(findTestInstanceByTypeWithProps(screen, 'Pressable', { accessibilityLabel: 'common.save' })?.props.disabled).toBe(false);
    });

    it('does not expose add control when adding is disabled', async () => {
        const { screen } = await renderSecretsList({ allowAdd: false });
        expect(findTestInstanceByTypeContainingText(screen, 'Pressable', 'common.add')).toBeUndefined();
    });

    it('moves default secret to the first rendered position', async () => {
        const secrets: SavedSecret[] = [
            {
                id: 'secret-a',
                name: 'Primary',
                kind: 'apiKey',
                encryptedValue: { _isSecretValue: true, value: 'a' },
                createdAt: 1,
                updatedAt: 1,
            },
            {
                id: 'secret-b',
                name: 'Secondary',
                kind: 'apiKey',
                encryptedValue: { _isSecretValue: true, value: 'b' },
                createdAt: 2,
                updatedAt: 2,
            },
        ];

        const { screen } = await renderSecretsList({ secrets, defaultId: 'secret-b', allowAdd: false });
        const textContent = screen.getTextContent();
        expect(textContent.indexOf('Secondary')).toBeGreaterThanOrEqual(0);
        expect(textContent.indexOf('Primary')).toBeGreaterThanOrEqual(0);
        expect(textContent.indexOf('Secondary')).toBeLessThan(textContent.indexOf('Primary'));
    });

    it('exposes stable automation identities for Saved Secret rows and mutation actions', async () => {
        const secret: SavedSecret = {
            id: 'secret-a',
            name: 'Primary',
            kind: 'apiKey',
            encryptedValue: { _isSecretValue: true, value: 'a' },
            createdAt: 1,
            updatedAt: 1,
        };
        const { screen } = await renderSecretsList({ secrets: [secret] });

        expect(screen.findByTestId('saved-secret:secret-a')).toBeTruthy();
        expect(screen.findByTestId('saved-secret-add')).toBeTruthy();
        const editActions = screen.findAllByType('ItemRowActions')
            .find((row) => row.props.title === secret.name);
        expect(editActions?.props.overflowTriggerTestID).toBe('saved-secret:secret-a:more');
        expect(editActions?.props.actions.map((action: { inlineTestID?: string }) => action.inlineTestID))
            .toEqual([
                'saved-secret:secret-a:rename',
                'saved-secret:secret-a:replace',
                'saved-secret:secret-a:delete',
            ]);
    });

    it('selects none row when include-none entry is pressed', async () => {
        const { screen, onSelectId } = await renderSecretsList({ includeNoneRow: true, allowAdd: false });
        const noneItem = findTestInstanceByTypeContainingText(screen, 'Pressable', 'secrets.noneTitle');
        expect(noneItem).toBeTruthy();

        await pressTestInstanceAsync(noneItem, 'secrets.none row');

        expect(onSelectId).toHaveBeenCalledWith('');
    });

    it('lets the None and empty-list instructions wrap instead of cutting them off', async () => {
        const { screen } = await renderSecretsList({ includeNoneRow: true, allowAdd: false });
        const linesOf = (text: string) => screen.findAllByType('Text')
            .filter((node: any) => node.props?.children === text)
            .map((node: any) => node.props.numberOfLines);

        // The rows explain the alternatives to a saved secret; a truncated instruction cannot be followed.
        expect(linesOf('secrets.noneSubtitle')).toEqual([undefined]);
        expect(linesOf('secrets.emptySubtitle')).toEqual([undefined]);
    });

    it('keeps a selected shared secret visible, unavailable and repairable after the Home stops authorizing it', async () => {
        const {
            applySavedSecretCatalogPage,
            resetSavedSecretCatalogSnapshotsForTests,
            resolveSavedSecretReference,
        } = await import('@/sync/store/settings/savedSecretCatalogSnapshot');
        resetSavedSecretCatalogSnapshotsForTests();
        const scope = { serverId: 'home-a', accountId: 'account-a' };
        const ref = 'happier:shared-secret:v1:revoked-a';
        const entry = {
            ref, source: 'shared_resource', relationship: 'recipient',
            name: 'Team key', kind: 'apiKey', ownerAccountId: 'owner-a', revision: 3, materialStatus: 'ready',
            capabilities: { use: true, rename: false, rotate: false, manageAccess: false, delete: false },
            accessSources: [], encryptionMode: 'plain',
        } as unknown as SavedSecretCatalogEntryV1;
        // The real catalog owner: first authorized, then the Home's next
        // authorized answer omits the row after the last grant was removed.
        applySavedSecretCatalogPage({ scope, entries: [entry], observedAt: 1 });
        applySavedSecretCatalogPage({ scope, entries: [], observedAt: 2 });
        const onSelectId = vi.fn<(id: string) => void>();

        const screen = await renderScreen(React.createElement(SecretsList, {
            secrets: [],
            sharedEntries: [],
            includeNoneRow: true,
            selectedId: ref,
            onSelectId,
            resolveSharedReference: (candidate: string) => resolveSavedSecretReference(scope, [], candidate),
        }));

        // The row component itself (a non-pressable row's host view carries
        // only the testID).
        const row = screen.findAllByTestId(`saved-secret:${ref}`)[0];
        expect(row).toBeTruthy();
        expect(row?.props.selected).toBe(true);
        // It says why it cannot be used and cannot be chosen again.
        expect(row?.props.subtitle).toContain('secrets.catalog.status.access_removed');
        expect(row?.props.onPress).toBeUndefined();
        // The list does not claim the account has no secrets while a
        // configured one is still selected.
        expect(screen.findByTestId('saved-secret:empty')).toBeFalsy();
        // Choosing None repairs the binding.
        await pressTestInstanceAsync(
            findTestInstanceByTypeContainingText(screen, 'Pressable', 'secrets.noneTitle'),
            'none row',
        );
        expect(onSelectId).toHaveBeenCalledWith('');
        resetSavedSecretCatalogSnapshotsForTests();
    });
});
