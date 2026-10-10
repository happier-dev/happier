import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import { renderInCollectionLayout, renderScreen, type CollectionLayoutHarnessMode } from '@/dev/testkit';
import {
    installPromptTemplatesCommonModuleMocks,
    promptTemplatesRouterPushSpy,
} from '../templates/promptTemplatesScreenTestHelpers';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const routerReplaceSpy = vi.hoisted(() => vi.fn());
const pathnameState = vi.hoisted(() => ({ value: '/settings/prompts/templates' }));
const modalConfirmMock = vi.hoisted(() => vi.fn(async () => true));

installPromptTemplatesCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            ScrollView: 'ScrollView',
            View: 'View',
            Platform: {
                OS: 'web',
                select: ({ web, default: defaultValue }: { web?: unknown; default?: unknown }) =>
                    web ?? defaultValue,
            },
        });
    },
    unistyles: async () => {
        const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
        return createUnistylesMock({
            theme: {
                colors: {
                    groupped: { background: 'white' },
                    accent: { blue: '#00f' },
                    textSecondary: '#999',
                },
            },
        });
    },
    router: async () => {
        const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
        const routerMock = createExpoRouterMock({
            router: { push: promptTemplatesRouterPushSpy, replace: routerReplaceSpy },
            pathname: () => pathnameState.value,
        });
        return routerMock.module;
    },
    modal: async () => {
        const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        return createModalModuleMock({
            spies: {
                confirm: modalConfirmMock,
                alert: vi.fn(),
            },
        }).module;
    },
    storage: importOriginal => importOriginal(),
});

const { storage } = await import('@/sync/domains/state/storageStore');
const { settingsDefaults } = await import('@/sync/domains/settings/settings');
const { publishAppliedActiveServerSnapshot } = await import('@/sync/runtime/orchestration/appliedActiveServerRuntime');
const { applyPromptLibraryCatalogSnapshot, resetPromptLibraryCatalogSnapshotsForTests } = await import('@/sync/store/settings/promptLibraryCatalogSnapshot');
const { resetPromptLibraryCatalogEngineForTests } = await import('@/sync/engine/settings/promptLibraryCatalogEngine');
const scope = { serverId: 'prompt-collection-home', accountId: 'prompt-collection-account' };

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
}));

vi.mock('@/components/ui/layout/layout', () => ({
    layout: { maxWidth: 1000 },
    useLayoutMaxWidth: () => 1000,
    useLayoutMaxWidthStyle: () => ({ maxWidth: 1000 }),
}));

async function renderIndex(mode: CollectionLayoutHarnessMode) {
    const { PromptCollectionIndex } = await import('./PromptCollectionList');
    return renderInCollectionLayout(<PromptCollectionIndex kind="template" />, mode);
}

describe('PromptCollectionIndex', () => {
    beforeEach(() => {
        resetPromptLibraryCatalogEngineForTests();
        resetPromptLibraryCatalogSnapshotsForTests();
        storage.setState({ settings: settingsDefaults, settingsVersion: 7, settingsScope: scope, profileScope: scope, isDataReady: true });
        publishAppliedActiveServerSnapshot({ serverId: scope.serverId, serverUrl: 'https://prompt-collection.invalid', generation: 1 });
        applyPromptLibraryCatalogSnapshot(scope, { catalog: { status: 'ready', rows: [{ revision: 4,
            record: { key: 'invocations', value: { v: 1, entries: [{ id: 'template-1', token: '/daily', title: 'Daily',
                target: { kind: 'doc', artifactId: 'doc-1' }, behavior: 'insert', allowArgs: false, availableIn: 'global' }] } } }],
            tombstones: [], diagnostics: [] }, rawSettings: {}, sourceSettingsVersion: 7 }, true);
        promptTemplatesRouterPushSpy.mockClear();
        routerReplaceSpy.mockClear();
        pathnameState.value = '/settings/prompts/templates';
    });

    it('beside the rail, lands on an item instead of leaving the detail empty', async () => {
        const screen = await renderIndex('split');

        const redirect = screen.findAllByType('Redirect' as never)[0] as unknown as { props: { href: string } } | undefined;
        expect(redirect?.props.href).toBe('/settings/prompts/templates/template-1');
    });

    it('where no rail shows, lists the templates with their command and adds a draft from the header', async () => {
        const screen = await renderIndex('stacked');

        const row = screen.tree.root.findAll((node) => node.props?.testID === 'promptLibrary.collection.template.row.template-1')[0];
        expect(row?.props.title).toBe('Daily');
        expect(row?.props.subtitle).toBe('/daily');

        await act(async () => {
            screen.findByTestId('promptLibrary.collection.template.add')?.props.onPress();
        });
        expect(promptTemplatesRouterPushSpy).toHaveBeenCalledWith('/settings/prompts/templates/new');
    });
});
