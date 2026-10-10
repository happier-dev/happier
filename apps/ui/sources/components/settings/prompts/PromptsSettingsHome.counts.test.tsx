import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { ProfileRecordV1Schema } from '@happier-dev/protocol/profiles/profileRecordSchemaV1';

// Native rendering and navigation are boundaries; catalog/store/count logic stays real.
vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});
vi.mock('@expo/vector-icons', async () => {
    const { createExpoVectorIconsMock } = await import('@/dev/testkit/mocks/icons');
    return createExpoVectorIconsMock();
});
vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock({ pathname: '/settings/prompts' }).module;
});
const { storage } = await import('@/sync/domains/state/storageStore');
const { Item } = await import('@/components/ui/lists/Item');
const { applyPromptLibraryCatalogSnapshot, beginPromptLibraryCatalogLoad, resetPromptLibraryCatalogSnapshotsForTests }
    = await import('@/sync/store/settings/promptLibraryCatalogSnapshot');
const { applyProfileCatalogSnapshot, beginProfileCatalogLoad, resetProfileCatalogSnapshotsForTests }
    = await import('@/sync/store/settings/profileCatalogSnapshot');
const { resetPromptLibraryCatalogEngineForTests } = await import('@/sync/engine/settings/promptLibraryCatalogEngine');
const { resetProfileCatalogEngineForTests } = await import('@/sync/engine/settings/profileCatalogEngine');
const { t } = await import('@/text');
const scope = { serverId: 'counts-server', accountId: 'counts-account' };
const emptyProfiles = { status: 'ready' as const, records: [], diagnostics: [], source: 'destination' as const,
    authority: 'inactive' as const, control: null, controlRevision: 'absent' as const, referenceGuardRevision: 1 };
const rowIds = ['settings-prompts-library-prompts', 'settings-prompts-library-skills',
    'settings-prompts-templates', 'settings-prompts-stacks', 'settings-prompts-folders'];
let previousState = storage.getState();

beforeEach(async () => {
    installDisconnectedServerSocketBoundary();
    await loadSyncSingletonForTests();
    previousState = storage.getState();
    storage.setState({ settingsScope: null, artifacts: {}, artifactsLoaded: false, isDataReady: false });
});

afterEach(async () => {
    await standardCleanup();
    resetPromptLibraryCatalogEngineForTests();
    resetProfileCatalogEngineForTests();
    resetPromptLibraryCatalogSnapshotsForTests();
    resetProfileCatalogSnapshotsForTests();
    storage.setState(previousState);
});

describe('PromptsSettingsHome catalog counts', () => {
    it('withholds unknown counts, then shows real empty/nonempty answers and preserves known refresh data', async () => {
        const { PromptsSettingsHome } = await import('./PromptsSettingsHome');
        const screen = await renderScreen(<PromptsSettingsHome />);
        const detail = (id: string) => {
            const row = screen.findAllByType(Item).find(row => row.props.testID === id);
            expect(row, id).toBeTruthy();
            return row!.props.detail;
        };
        for (const id of rowIds) expect(detail(id), id).toBeUndefined();

        await act(async () => {
            // Publication uses the canonical readers. Ready absent rows project valid empty records.
            applyPromptLibraryCatalogSnapshot(scope, {
                catalog: { status: 'ready', rows: [], tombstones: [], diagnostics: [] },
                rawSettings: { promptFoldersV1: { v: 1, folders: [{ id: 'existing-folder', name: 'Existing' }] } },
                sourceSettingsVersion: 1,
            }, true);
            applyProfileCatalogSnapshot(scope, emptyProfiles, true);
            storage.setState({ settingsScope: scope, artifactsLoaded: true, isDataReady: true });
        });
        const count = (value: number) => t('promptLibrary.surface.itemCount', { count: value });
        for (const id of rowIds.slice(0, 4)) expect(detail(id), id).toBe(count(0));
        expect(detail('settings-prompts-folders')).toBe(count(1));
        expect(screen.getTextContent()).toContain(count(1));

        await act(async () => {
            for (const [id, kind] of [['doc', 'prompt_doc.v2'], ['skill', 'prompt_bundle.v2']]) {
                storage.getState().updateArtifact({ id, title: id, header: { kind, title: id },
                    headerVersion: 1, createdAt: 1, updatedAt: 1, seq: 1, isDecrypted: true });
            }
        });
        for (const id of rowIds.slice(0, 2)) expect(detail(id), id).toBe(count(1));

        await act(async () => {
            const record = ProfileRecordV1Schema.parse({ v: 1, id: 'profile-counts', enabled: true, secretBindings: {},
                definition: { kind: 'inline', profile: { v: 2, id: 'profile-counts', name: 'Counts profile',
                    extraEnvironmentVariables: [], defaultPermissionModeByTargetKey: {},
                    defaultPersistenceModeByTargetKey: {}, compatibilityByTargetKey: {}, createdAt: 1, updatedAt: 1 } },
                promptStack: [{ id: 'profile-entry', ref: { kind: 'doc', artifactId: 'doc' }, enabled: true, placement: 'system_append' }],
            });
            applyProfileCatalogSnapshot(scope, { ...emptyProfiles, records: [{ record, revision: 1 }] }, true);
        });
        expect(detail('settings-prompts-stacks')).toBe(count(1));

        await act(async () => { beginPromptLibraryCatalogLoad(scope); beginProfileCatalogLoad(scope); });
        expect(detail('settings-prompts-folders')).toBe(count(1));
        expect(detail('settings-prompts-stacks')).toBe(count(1));
        await act(async () => {
            applyPromptLibraryCatalogSnapshot(scope, {
                catalog: { status: 'unavailable', reason: 'unauthorized' }, rawSettings: {}, sourceSettingsVersion: 1,
            }, true);
        });
        for (const id of rowIds.slice(2)) expect(detail(id), id).toBeUndefined();
    });

    it('keeps the neighboring Stacks counts unknown until each source answers and retains them during refresh', async () => {
        const { PromptStacksScreen } = await import('./stacks/PromptStacksScreen');
        const screen = await renderScreen(<PromptStacksScreen />);
        const detail = (id: string) => {
            const row = screen.findAllByType(Item).find(row => row.props.testID === id);
            expect(row, id).toBeTruthy();
            return row!.props.detail;
        };
        const ids = ['promptStacks.coding', 'promptStacks.voice', 'promptStacks.profiles'];
        for (const id of ids) expect(detail(id), id).toBeUndefined();
        await act(async () => {
            applyPromptLibraryCatalogSnapshot(scope, {
                catalog: { status: 'ready', rows: [{ revision: 1, record: { key: 'coding', value: { v: 1, scope: { kind: 'coding' }, entries: [
                    { id: 'coding-entry', ref: { kind: 'doc', artifactId: 'doc' }, enabled: true, placement: 'system_append' },
                ] } } }], tombstones: [], diagnostics: [] }, rawSettings: {}, sourceSettingsVersion: 1,
            }, true);
            storage.setState({ settingsScope: scope });
        });
        expect(detail('promptStacks.coding')).toBe(t('promptLibrary.profileStackCount', { count: 1 }));
        expect(detail('promptStacks.voice')).toBe(t('promptLibrary.profileStackCount', { count: 0 }));
        expect(detail('promptStacks.profiles')).toBeUndefined();
        await act(async () => {
            applyProfileCatalogSnapshot(scope, emptyProfiles, true);
        });
        expect(detail('promptStacks.profiles')).toBe(t('promptLibrary.profileStacksSubtitle', { count: 0 }));
        await act(async () => { beginPromptLibraryCatalogLoad(scope); beginProfileCatalogLoad(scope); });
        expect(detail('promptStacks.coding')).toBe(t('promptLibrary.profileStackCount', { count: 1 }));
        expect(detail('promptStacks.profiles')).toBe(t('promptLibrary.profileStacksSubtitle', { count: 0 }));
        await act(async () => { applyProfileCatalogSnapshot(scope, { ...emptyProfiles, status: 'partial' }, true); });
        expect(detail('promptStacks.profiles')).toBeUndefined();
        await act(async () => { beginProfileCatalogLoad(scope); });
        expect(detail('promptStacks.profiles')).toBeUndefined();
        await act(async () => {
            applyProfileCatalogSnapshot(scope, { status: 'unavailable', reason: 'unauthorized' }, true);
        });
        expect(detail('promptStacks.profiles')).toBeUndefined();
    });
});
