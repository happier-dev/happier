import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import 'fake-indexeddb/auto';
import { act, renderSettingsView, standardCleanup } from '@/dev/testkit';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { createSecretSettingsTestHarness } from '@/components/settings/secrets/secretSettingsTestHarness';
import { settingsParse } from '@/sync/domains/settings/settings';
import { storage } from '@/sync/domains/state/storage';
import { InjectedAuthProvider } from '@/auth/context/AuthContext';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock().module);
vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());
const router = await vi.hoisted(async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock());
vi.mock('expo-router', () => router.module);
vi.mock('socket.io-client', async original =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(original));
installDisconnectedServerSocketBoundary();
await loadSyncSingletonForTests();
const { SETTINGS_PAGE_CATALOG } = await import('@/components/settings/catalog/pageCatalog');
const { SETTINGS_PAGE_DECLARATIONS } = await import('@/components/settings/catalog/settingsPageDeclarations');
const { FieldValueItem } = await import('@/components/ui/forms/FieldValueItem');
const { DropdownMenu } = await import('@/components/ui/forms/dropdown/DropdownMenu');
const original = storage.getState();
const settingsRoutes = import.meta.glob<{ WorkspaceRouteBody: React.ComponentType }>('../../../app/**/settings/deployments.tsx');
afterEach(() => { standardCleanup(); storage.setState(original, true); router.resetParams(); vi.unstubAllGlobals(); });

describe('deployment defaults pages', () => {
    it.each(['plain', 'e2ee'] as const)('opens the searchable Account preference and saves through Settings Actions (%s)', async mode => {
        const pages = SETTINGS_PAGE_CATALOG.flatMap(root => root.children?.flatMap(group => group.children ?? []) ?? []);
        expect(pages.find(page => page.id === 'deployments')?.route).toBe('/settings/deployments');
        expect(SETTINGS_PAGE_DECLARATIONS.flatMap(page => Object.values(page.settings))
            .some(setting => setting.anchor === 'deployments.creationDefaults')).toBe(true);
        const baseline = settingsParse({ deploymentDefaultsV1: { buildMachineId: 'builder', controllerMachineId: 'controller', retainPreviousDeployments: 0 },
            actionsSettingsV1: { v: 1, actions: { 'settings.set': { disabledSurfaces: ['ui'] } } } });
        const account = await createSecretSettingsTestHarness({ mode, settings: baseline });
        try {
            const route = Object.entries(settingsRoutes).find(([path]) => path.endsWith('/deployments.tsx'));
            expect(route).toBeDefined();
            const { WorkspaceRouteBody: AccountDefaults } = await route![1]();
            const screen = await renderSettingsView(<InjectedAuthProvider credentials={account.credentials}><AccountDefaults /></InjectedAuthProvider>);
            const retention = () => screen.findAllByType(FieldValueItem).find(row => row.props.testID === 'deployment-defaults.retention')!;
            await act(async () => { retention().props.onCommit('2'); });
            expect(account.persistedSettings.deploymentDefaultsV1.retainPreviousDeployments).toBe(0);
            await act(async () => account.replaceSettings(settingsParse({ ...baseline,
                actionsSettingsV1: { v: 1, approvalWaivedSurfaces: { 'settings.set': ['ui'] } } })));
            await act(async () => { retention().props.onCommit('2'); });
            await vi.waitFor(() => expect(account.persistedSettings.deploymentDefaultsV1).toEqual({
                buildMachineId: 'builder', controllerMachineId: 'controller', retainPreviousDeployments: 2 }));
            const builder = () => screen.findAllByType(DropdownMenu).find(row => row.props.testID === 'deployment-defaults.builder')!;
            await act(async () => builder().props.onSelect(''));
            await vi.waitFor(() => expect(account.persistedSettings.deploymentDefaultsV1).toEqual({ controllerMachineId: 'controller', retainPreviousDeployments: 2 }));
        } finally { standardCleanup(); await account.dispose(); }
    });

});
