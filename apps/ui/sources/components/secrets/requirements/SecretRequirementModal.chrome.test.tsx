import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { createPassThroughModule } from '@/dev/testkit/mocks/components';
import {
    findTestInstanceByTypeContainingText,
    pressTestInstanceAsync,
} from '@/dev/testkit';
import { createStorageModuleStub } from '@/dev/testkit/mocks/storage';
import type { AIBackendProfile } from '@/sync/domains/profiles/profileCompatibility';

const sharedEntries = [{
    ref: 'happier:shared-secret:v1:shared-a', source: 'shared_resource', relationship: 'recipient',
    name: 'Team key', kind: 'apiKey', ownerAccountId: 'owner-a', revision: 1, materialStatus: 'ready',
    capabilities: { use: true, rename: false, rotate: false, manageAccess: false, delete: false },
}] as const;
let observedSharedEntries: unknown;
let observedListProps: Record<string, unknown> = {};

// Parameterized copy keeps its params, so the machine a message names is observable.
// These factories are hoisted before the static testkit's imports reach text.
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock());
vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());

vi.mock('@expo/vector-icons', () => ({
    Ionicons: () => null,
}));

vi.mock('react-native-safe-area-context', () => ({
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

vi.mock('@/sync/domains/server/serverProfiles', async (importOriginal) =>
    (await import('@/dev/testkit/mocks/serverProfiles')).createPartialServerProfilesModuleMock(importOriginal, {
        overrides: { getActiveServerId: () => '' },
    }));

vi.mock('@/hooks/machine/useMachineEnvPresence', () => ({
    useMachineEnvPresence: () => ({
        isLoading: false,
        isPreviewEnvSupported: false,
        meta: {},
    }),
}));

const machineState = vi.hoisted(() => ({ value: null as null | { id: string; metadata: Record<string, unknown> } }));
const renderedItemTitles = vi.hoisted(() => [] as string[]);

vi.mock('@/sync/domains/state/storage', () => ({
    ...createStorageModuleStub({
        useServerScopedMachine: () => machineState.value,
    }),
}));

vi.mock('@/utils/sessions/machineUtils', async (importOriginal) => ({
    ...await importOriginal<typeof import('@/utils/sessions/machineUtils')>(),
    isMachineOnline: () => false,
}));

vi.mock('@/components/secrets/SecretsList', () => ({
    SecretsList: (props: { sharedEntries?: unknown }) => {
        observedSharedEntries = props.sharedEntries;
        observedListProps = props;
        return null;
    },
}));

const catalogPersonalSecrets = [{ id: 'personal-record', name: 'My key', kind: 'apiKey' as const,
    encryptedValue: { _isSecretValue: true as const, value: 'sk-personal' }, createdAt: 1, updatedAt: 1 }];
vi.mock('@/components/secrets/useSavedSecretCatalog', () => ({
    useSavedSecretCatalog: () => ({
        sharedEntries,
        personalSecrets: catalogPersonalSecrets,
        personalMutationsAvailable: true,
        personalMutations: {
            create: vi.fn(),
            rename: vi.fn(),
            rotate: vi.fn(),
            delete: vi.fn(),
        },
    }),
}));

vi.mock('@/components/ui/lists/ItemList', () => ({
    ItemListStatic: ({ children }: { children?: React.ReactNode }) => React.createElement('ItemListStatic', null, children ?? null),
}));

vi.mock('@/components/ui/lists/ItemGroup', () => ({
    ItemGroup: ({ children }: { children?: React.ReactNode }) => React.createElement('ItemGroup', null, children ?? null),
}));

vi.mock('@/components/ui/lists/Item', () => ({
    Item: (props: { title?: unknown }) => {
        if (typeof props.title === 'string') renderedItemTitles.push(props.title);
        return null;
    },
}));

vi.mock('@/components/ui/forms/dropdown/DropdownMenu', () => ({
    DropdownMenu: (props: { items?: ReadonlyArray<{ title?: unknown }> }) => {
        for (const item of props.items ?? []) {
            if (typeof item.title === 'string') renderedItemTitles.push(item.title);
        }
        return null;
    },
}));

vi.mock('@/components/ui/scroll/useScrollEdgeFades', () => ({
    useScrollEdgeFades: () => ({
        onViewportLayout: () => {},
        onContentSizeChange: () => {},
        onScroll: () => {},
    }),
}));

vi.mock('@/components/ui/scroll/ScrollEdgeFades', () => ({
    ScrollEdgeFades: () => null,
}));

vi.mock('@/components/ui/scroll/ScrollEdgeIndicators', () => ({
    ScrollEdgeIndicators: () => null,
}));

vi.mock('@/components/ui/text/Text', () => ({
    ...createPassThroughModule(['Text', 'TextInput']),
}));

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('SecretRequirementModal', () => {
    it('names an unnamed machine as unnamed, never by its id, in the machine check', async () => {
        const { renderScreen } = await import('@/dev/testkit');
        const { SecretRequirementModal } = await import('./SecretRequirementModal');
        machineState.value = { id: 'f98b860d-63e0-436e', metadata: {} };
        renderedItemTitles.length = 0;
        try {
            await renderScreen(
                React.createElement(SecretRequirementModal, {
                    profile: ({ id: 'p1', name: 'Profile' } satisfies Pick<AIBackendProfile, 'id' | 'name'>) as unknown as AIBackendProfile,
                    secretEnvVarName: 'OPENAI_API_KEY',
                    machineId: 'f98b860d-63e0-436e',
                    defaultSecretId: null,
                    onResolve: () => {},
                    onClose: () => {},
                }),
            );
            const machineCheck = renderedItemTitles.find((title) => title.startsWith('profiles.requirements.machineEnvStatus.'));
            expect(machineCheck).toContain('machine=machine.unnamedMachine');
            expect(renderedItemTitles.join('\n')).not.toContain('f98b860d');
        } finally {
            machineState.value = null;
        }
    });

    it('drives modal card chrome when setChrome is provided', async () => {
        const { renderScreen } = await import('@/dev/testkit');
        const { SecretRequirementModal } = await import('./SecretRequirementModal');

        const setChrome = vi.fn();

        await renderScreen(
            React.createElement(SecretRequirementModal, {
                profile: ({ id: 'p1', name: 'Profile' } satisfies Pick<AIBackendProfile, 'id' | 'name'>) as unknown as AIBackendProfile,
                secretEnvVarName: 'OPENAI_API_KEY',
                machineId: null,
                defaultSecretId: null,
                onResolve: () => {},
                onClose: () => {},
                setChrome,
            }),
        );

        expect(setChrome).toHaveBeenCalledWith(
            expect.objectContaining({
                kind: 'card',
            }),
        );
    });

    it('lists personal keys from the Saved Secret catalog, and manages them only where the surface allows', async () => {
        const { renderScreen } = await import('@/dev/testkit');
        const { SecretRequirementModal } = await import('./SecretRequirementModal');
        const profile = ({ id: 'p5', name: 'Profile' } satisfies Pick<AIBackendProfile, 'id' | 'name'>) as unknown as AIBackendProfile;
        await renderScreen(React.createElement(SecretRequirementModal, {
            profile, secretEnvVarName: 'OPENAI_API_KEY', machineId: null, defaultSecretId: null,
            variant: 'defaultForProfile', allowManage: true, onResolve: () => {}, onClose: () => {},
        }));
        // A key created through the catalog's personal Actions is the record the list shows.
        expect(observedListProps.secrets).toBe(catalogPersonalSecrets);
        expect(observedListProps.allowAdd).toBe(true);
        expect(observedListProps.onCreatePersonal).toBeTypeOf('function');
        await renderScreen(React.createElement(SecretRequirementModal, {
            profile, secretEnvVarName: 'OPENAI_API_KEY', machineId: null, defaultSecretId: null,
            variant: 'defaultForProfile', onResolve: () => {}, onClose: () => {},
        }));
        expect(observedListProps.secrets).toBe(catalogPersonalSecrets);
        expect(observedListProps.allowAdd).toBe(false);
        expect(observedListProps.onCreatePersonal).toBeUndefined();
    });

    it('picks a secret without managing it, and leads to Secrets settings for that', async () => {
        const { renderScreen } = await import('@/dev/testkit');
        const { SecretRequirementModal } = await import('./SecretRequirementModal');
        const profile = ({ id: 'p6', name: 'Profile' } satisfies Pick<AIBackendProfile, 'id' | 'name'>) as unknown as AIBackendProfile;
        renderedItemTitles.length = 0;
        await renderScreen(React.createElement(SecretRequirementModal, {
            profile, secretEnvVarName: 'OPENAI_API_KEY', machineId: null, defaultSecretId: null,
            allowManage: true, onResolve: () => {}, onClose: () => {},
        }));
        expect(observedListProps.onSelectId).toBeTypeOf('function');
        expect(observedListProps.onRenamePersonal).toBeUndefined();
        expect(observedListProps.onRotatePersonal).toBeUndefined();
        expect(observedListProps.onDeletePersonal).toBeUndefined();
        expect(renderedItemTitles).toContain('profiles.requirements.manageSavedSecrets');
    });

    it('feeds Profile requirements from the same shared catalog as other pickers', async () => {
        const { renderScreen } = await import('@/dev/testkit');
        const { SecretRequirementModal } = await import('./SecretRequirementModal');

        await renderScreen(React.createElement(SecretRequirementModal, {
            profile: ({ id: 'p2', name: 'Profile' } satisfies Pick<AIBackendProfile, 'id' | 'name'>) as unknown as AIBackendProfile,
            secretEnvVarName: 'OPENAI_API_KEY', machineId: null, defaultSecretId: null,
            variant: 'defaultForProfile', onResolve: () => {}, onClose: () => {},
        }));

        expect(observedSharedEntries).toBe(sharedEntries);
    });

    it('lets a ready shared secret become a Profile default', async () => {
        const { renderScreen } = await import('@/dev/testkit');
        const { SecretRequirementModal } = await import('./SecretRequirementModal');
        const onResolve = vi.fn();
        const onSetDefaultSecretId = vi.fn();

        await renderScreen(React.createElement(SecretRequirementModal, {
            profile: ({ id: 'p4', name: 'Profile' } satisfies Pick<AIBackendProfile, 'id' | 'name'>) as unknown as AIBackendProfile,
            secretEnvVarName: 'OPENAI_API_KEY', machineId: null, defaultSecretId: null,
            variant: 'defaultForProfile', onResolve, onSetDefaultSecretId, onClose: () => {},
        }));

        // The list must not disable shared rows for a Profile default: that was
        // the retired 0.2-coexistence hold on persisted Profile references.
        expect(observedListProps.allowSharedSelection).not.toBe(false);
        await React.act(async () => {
            (observedListProps.onSelectId as (id: string) => void)('happier:shared-secret:v1:shared-a');
        });
        expect(onSetDefaultSecretId).toHaveBeenCalledWith('happier:shared-secret:v1:shared-a');
        expect(onResolve).toHaveBeenCalledWith({
            action: 'selectSaved', envVarName: 'OPENAI_API_KEY',
            secretId: 'happier:shared-secret:v1:shared-a', setDefault: true,
        });
    });

    it('announces Use once as a button and titles the route screen as a page', async () => {
        const { renderScreen } = await import('@/dev/testkit');
        const { SecretRequirementModal } = await import('./SecretRequirementModal');
        const { PageHeader } = await import('@/components/ui/layout/PageHeader');
        const screen = await renderScreen(React.createElement(SecretRequirementModal, {
            profile: ({ id: 'p4', name: 'Profile' } satisfies Pick<AIBackendProfile, 'id' | 'name'>) as unknown as AIBackendProfile,
            secretEnvVarName: 'OPENAI_API_KEY', machineId: null, defaultSecretId: null,
            sessionOnlySecretValueByEnvVarName: { OPENAI_API_KEY: 'value' },
            layoutVariant: 'screen',
            onResolve: vi.fn(),
            onClose: vi.fn(),
        }));
        const submit = findTestInstanceByTypeContainingText(
            screen,
            'Pressable',
            'profiles.requirements.actions.useOnceButton',
        );
        expect(submit?.props.role ?? submit?.props.accessibilityRole).toBe('button');
        // The page header titles the screen with the profile it is for; leaving is the navigation's Back, not a close of its own.
        expect(screen.tree.findByType(PageHeader).props).toMatchObject({ title: 'profiles.requirements.modalTitle', description: 'Profile' });
        expect(screen.tree.findAll((node) => node.props.accessibilityLabel === 'common.close')).toHaveLength(0);
    });

    it('returns an Enter Once value without normalizing opaque whitespace', async () => {
        const { renderScreen } = await import('@/dev/testkit');
        const { SecretRequirementModal } = await import('./SecretRequirementModal');
        const onResolve = vi.fn();
        const screen = await renderScreen(React.createElement(SecretRequirementModal, {
            profile: ({ id: 'p3', name: 'Profile' } satisfies Pick<AIBackendProfile, 'id' | 'name'>) as unknown as AIBackendProfile,
            secretEnvVarName: 'OPENAI_API_KEY', machineId: null, defaultSecretId: null,
            sessionOnlySecretValueByEnvVarName: { OPENAI_API_KEY: '   ' },
            onResolve,
            onClose: vi.fn(),
        }));
        const submit = findTestInstanceByTypeContainingText(
            screen,
            'Pressable',
            'profiles.requirements.actions.useOnceButton',
        );
        expect(submit?.props.disabled).toBe(false);

        await pressTestInstanceAsync(submit, 'use once button');

        expect(onResolve).toHaveBeenCalledWith({
            action: 'enterOnce',
            envVarName: 'OPENAI_API_KEY',
            value: '   ',
        });
    });
});
