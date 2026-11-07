import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import 'fake-indexeddb/auto';
import { act, renderScreen, standardCleanup } from '@/dev/testkit';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { createSecretSettingsTestHarness } from '@/components/settings/secrets/secretSettingsTestHarness';
import { settingsParse } from '@/sync/domains/settings/settings';
import { storage } from '@/sync/domains/state/storage';
import { InjectedAuthProvider } from '@/auth/context/AuthContext';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';

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
const { FieldValueItem } = await import('@/components/ui/forms/FieldValueItem');
const { DropdownMenu } = await import('@/components/ui/forms/dropdown/DropdownMenu');
const original = storage.getState();
const projectPages = import.meta.glob<{ ProjectDeploymentDefaultsSettings: React.ComponentType<{
    lifetime: ServerAccountScopeLifetime | null; sourceId: string; demand: { mounted: boolean; visible: boolean; focused: boolean };
    environments?: readonly Readonly<{ id: string; title: string }>[]; onOpenEnvironment?: (environmentId: string) => void;
}> }>('./ProjectDeploymentDefaultsSettings.tsx');
const environmentPages = import.meta.glob<typeof import('./DeploymentEnvironmentSettingsPanel')>('./DeploymentEnvironmentSettingsPanel.tsx');
afterEach(() => { standardCleanup(); storage.setState(original, true); router.resetParams(); vi.unstubAllGlobals(); });

describe('Project deployment defaults', () => {
    it('links Environment Settings to the Account defaults page without another defaults editor', async () => {
        const account = await createSecretSettingsTestHarness();
        const { captureLazyActionAccountContext } = await import('@/sync/ops/actions/actionAccountContext');
        const { createDeploymentReadControllerV1 } = await import('@happier-dev/deployments');
        const { createDeploymentEnvironmentDetailV1, createDeploymentEnvironmentHeaderV1 } = await import('@happier-dev/deployment-protocol/testing/v1');
        const { createDeploymentReadTransport } = await import('./deploymentReadTransport');
        const { DeploymentEnvironmentSettingsPanel } = await environmentPages['./DeploymentEnvironmentSettingsPanel.tsx']!();
        const context = await captureLazyActionAccountContext(account.scope.serverId);
        const controller = createDeploymentReadControllerV1({ scope: { ...account.scope, projectSourceId: 'source-app' }, transport: createDeploymentReadTransport(context.accountLifetime) });
        try {
            const detail = createDeploymentEnvironmentDetailV1({ environment: createDeploymentEnvironmentHeaderV1({ serverId: account.scope.serverId }) });
            const screen = await renderScreen(<DeploymentEnvironmentSettingsPanel detail={detail} controller={controller}
                demand={{ mounted: false, visible: false, focused: false }} machineName={id => id} environmentTitle={() => null} />);
            await screen.pressByTestIdAsync('project-deployments.environment.settings.account-defaults');
            expect(router.spies.push).toHaveBeenLastCalledWith({ pathname: '/settings/deployments', params: { serverId: account.scope.serverId } });
            expect(screen.findByTestId('deployment-defaults.retention')).toBeNull();
        } finally { standardCleanup(); controller.retire(); context.dispose(); await account.dispose(); }
    });

    it.each(['plain', 'e2ee'] as const)('opens before an Environment exists and saves/resets through the real Artifact and Project Actions (%s)', async mode => {
        const { ProjectDeploymentDefaultsOutputV1Schema, ProjectDeploymentDefaultsSetInputV1Schema } = await import('@happier-dev/protocol/projects/projectDeploymentDefaultsV1');
        let metadata = ProjectDeploymentDefaultsOutputV1Schema.parse({ ok: true, projectSourceId: 'source-app', sourceRevision: 1, revision: 0, content: null });
        const serverIdentityId = `srv_${'a'.repeat(32)}`;
        const baseline = settingsParse({ deploymentDefaultsV1: { buildMachineId: 'account-builder', controllerMachineId: 'account-controller', retainPreviousDeployments: 7 },
            actionsSettingsV1: { v: 1, approvalWaivedSurfaces: { 'artifact.create': ['ui'], 'projects.deploymentDefaults.set': ['ui'] } } });
        const account = await createSecretSettingsTestHarness({ mode, serverIdentityId, settings: baseline, handleRequest: async (path, init) => {
            if (path.startsWith('/v1/deployments/environments')) return Response.json({ ok: true, items: [], nextCursor: null });
            if (path.startsWith('/v1/projects/sources/source-app')) {
                if (new URL(path, 'https://test.invalid').searchParams.get('serverId') !== serverIdentityId)
                    return Response.json({ ok: false, error: 'source_unavailable' }, { status: 404 });
                return Response.json({ ok: true, canManage: true,
                source: { id: 'source-app', revision: 1, name: 'App', owner: { kind: 'account', accountId: 'account-a' },
                    audience: [], createdByAccountId: 'account-a', defaultRef: 'main' } });
            }
            if (path.startsWith('/v1/projects/source-app/deployment-defaults')) {
                if (init?.method === 'PUT') {
                    const input = ProjectDeploymentDefaultsSetInputV1Schema.parse(JSON.parse(String(init.body)));
                    if (input.serverId !== serverIdentityId) return Response.json({ ok: false, error: 'project_defaults_unavailable' }, { status: 404 });
                    if (!metadata.ok || input.expectedRevision !== metadata.revision || input.expectedSourceRevision !== metadata.sourceRevision)
                        return Response.json({ ok: false, error: 'project_defaults_conflict' }, { status: 409 });
                    metadata = { ...metadata, revision: metadata.revision + 1, content: input.content };
                }
                return Response.json(metadata);
            }
            return null;
        } });
        const { captureLazyActionAccountContext } = await import('@/sync/ops/actions/actionAccountContext');
        const { createDeploymentReadControllerV1 } = await import('@happier-dev/deployments');
        const { createDeploymentReadTransport } = await import('./deploymentReadTransport');
        const { ProjectDeploymentsView } = await import('./ProjectDeploymentsBody');
        const context = await captureLazyActionAccountContext(account.scope.serverId);
        const controller = createDeploymentReadControllerV1({ scope: { ...account.scope, projectSourceId: 'source-app' }, transport: createDeploymentReadTransport(context.accountLifetime) });
        try {
            const screen = await renderScreen(<InjectedAuthProvider credentials={account.credentials}><ProjectDeploymentsView controller={controller} lifetime={context.accountLifetime}
                sourceId="source-app" serverId={account.scope.serverId} accountId={account.scope.accountId}
                demand={{ mounted: true, visible: true, focused: true }} /></InjectedAuthProvider>);
            await vi.waitFor(() => expect(screen.findByTestId('project-deployments.empty')).not.toBeNull());
            expect(screen.findByTestId('project-deployments.empty.settings')).not.toBeNull();
            await screen.pressByTestIdAsync('project-deployments.empty.settings');
            const retention = () => screen.findAllByType(FieldValueItem).find(row => row.props.testID === 'deployment-defaults.retention')!;
            await vi.waitFor(() => expect(retention()?.props.placeholder).toBe('7'));
            await act(async () => retention().props.onCommit('0'));
            await vi.waitFor(() => expect(metadata.ok && metadata.content).toBeTruthy());
            const readPreferences = async () => {
                if (!metadata.ok || !metadata.content) return {};
                const artifact = await context.readArtifactContent(metadata.content.contentArtifactId);
                return JSON.parse(String(artifact?.body)).deploymentDefaults;
            };
            expect(await readPreferences()).toEqual({ retainPreviousDeployments: 0 });
            const controllerChoice = () => screen.findAllByType(DropdownMenu).find(row => row.props.testID === 'deployment-defaults.controller')!;
            await vi.waitFor(() => expect(controllerChoice().props.itemTrigger.itemProps.disabled).toBe(false));
            await act(async () => controllerChoice().props.onSelect('project-controller'));
            await vi.waitFor(async () => expect(await readPreferences()).toEqual({ retainPreviousDeployments: 0, controllerMachineId: 'project-controller' }));
            const beforeRefusal = metadata;
            await act(async () => account.replaceSettings(settingsParse({ ...baseline, actionsSettingsV1: { ...baseline.actionsSettingsV1,
                actions: { 'projects.deploymentDefaults.set': { disabledSurfaces: ['ui'] } } } })));
            await act(async () => retention().props.onCommit('3'));
            await vi.waitFor(() => expect(retention().props.disabled).toBe(false));
            expect(metadata).toEqual(beforeRefusal);
            expect(await readPreferences()).toEqual({ retainPreviousDeployments: 0, controllerMachineId: 'project-controller' });
            await act(async () => account.replaceSettings(baseline));
            await act(async () => retention().props.onCommit(''));
            await vi.waitFor(async () => expect(await readPreferences()).toEqual({ controllerMachineId: 'project-controller' }));
            await vi.waitFor(() => expect(controllerChoice().props.itemTrigger.itemProps.disabled).toBe(false));
            await act(async () => controllerChoice().props.onSelect(''));
            await vi.waitFor(() => expect(metadata.ok && metadata.content).toBeNull());
            expect(account.persistedSettings.deploymentDefaultsV1).toEqual(baseline.deploymentDefaultsV1);
        } finally { standardCleanup(); controller.retire(); context.dispose(); await account.dispose(); }
    });

    it('keeps the Account owner in the defaults Artifact audience when a Team administrator saves', async () => {
        const { ProjectDeploymentDefaultsOutputV1Schema, ProjectDeploymentDefaultsSetInputV1Schema } = await import('@happier-dev/protocol/projects/projectDeploymentDefaultsV1');
        let metadata = ProjectDeploymentDefaultsOutputV1Schema.parse({ ok: true, projectSourceId: 'shared-source', sourceRevision: 1, revision: 0, content: null });
        const account = await createSecretSettingsTestHarness({ settings: settingsParse({ actionsSettingsV1: { v: 1,
            approvalWaivedSurfaces: { 'artifact.create': ['ui'], 'artifact.access.grants.set': ['ui'], 'projects.deploymentDefaults.set': ['ui'] } } }),
            handleRequest: async (path, init) => {
                // Source's HTTP owner admits administrators of an audience Team as managers.
                if (path.startsWith('/v1/projects/sources/shared-source')) return Response.json({ ok: true, canManage: true,
                    source: { id: 'shared-source', revision: 1, name: 'Shared app', owner: { kind: 'account', accountId: 'source-owner' },
                        audience: [{ principal: { kind: 'team', teamId: 'team-a' }, level: 'view' }], createdByAccountId: 'source-owner' } });
                if (path.startsWith('/v1/projects/shared-source/deployment-defaults')) {
                    if (init?.method === 'PUT') {
                        const input = ProjectDeploymentDefaultsSetInputV1Schema.parse(JSON.parse(String(init.body)));
                        if (metadata.ok) metadata = { ...metadata, revision: metadata.revision + 1, content: input.content };
                    }
                    return Response.json(metadata);
                }
                return null;
            } });
        const { captureLazyActionAccountContext } = await import('@/sync/ops/actions/actionAccountContext');
        const { ProjectDeploymentDefaultsSettings } = await projectPages['./ProjectDeploymentDefaultsSettings.tsx']!();
        const context = await captureLazyActionAccountContext(account.scope.serverId);
        try {
            const screen = await renderScreen(<InjectedAuthProvider credentials={account.credentials}><ProjectDeploymentDefaultsSettings
                lifetime={context.accountLifetime} sourceId="shared-source" demand={{ mounted: true, visible: true, focused: true }} /></InjectedAuthProvider>);
            const retention = () => screen.findAllByType(FieldValueItem).find(row => row.props.testID === 'deployment-defaults.retention')!;
            await vi.waitFor(() => expect(retention()?.props.disabled).toBe(false));
            await act(async () => retention().props.onCommit('4'));
            await vi.waitFor(() => expect(metadata.ok && metadata.content).toBeTruthy());
            if (!metadata.ok || !metadata.content) throw new Error('Expected published defaults');
            expect(account.artifacts.readGrants(metadata.content.contentArtifactId)).toEqual(expect.arrayContaining([
                expect.objectContaining({ principal: { kind: 'account', accountId: 'source-owner' }, accessLevel: 'edit' }),
                expect.objectContaining({ principal: { kind: 'team', teamId: 'team-a' }, accessLevel: 'view' }),
            ]));
        } finally { standardCleanup(); context.dispose(); await account.dispose(); }
    });

    it('shows Team builtins without borrowing the viewer’s Account preferences and prevents viewer writes', async () => {
        const reads: string[] = [];
        const account = await createSecretSettingsTestHarness({ settings: settingsParse({ deploymentDefaultsV1: { retainPreviousDeployments: 99 } }),
            handleRequest: async path => {
                if (path.startsWith('/v1/projects/sources/source-team') || path.startsWith('/v1/projects/source-team/deployment-defaults')) reads.push(path);
                if (path.startsWith('/v1/projects/sources/source-team')) return Response.json({ ok: true, canManage: false,
                    source: { id: 'source-team', revision: 1, name: 'Team app', owner: { kind: 'team', teamId: 'team-a' }, audience: [], createdByAccountId: 'owner' } });
                if (path.startsWith('/v1/projects/source-team/deployment-defaults')) return Response.json({ ok: true,
                    projectSourceId: 'source-team', sourceRevision: 1, revision: 0, content: null });
                return null;
            } });
        const { captureLazyActionAccountContext } = await import('@/sync/ops/actions/actionAccountContext');
        const { ProjectDeploymentDefaultsSettings } = await projectPages['./ProjectDeploymentDefaultsSettings.tsx']!();
        const context = await captureLazyActionAccountContext(account.scope.serverId);
        let show = () => {};
        function Page() {
            const [focused, setFocused] = React.useState(false);
            show = () => setFocused(true);
            return <InjectedAuthProvider credentials={account.credentials}><ProjectDeploymentDefaultsSettings
                lifetime={context.accountLifetime} sourceId="source-team" demand={{ mounted: true, visible: focused, focused }} /></InjectedAuthProvider>;
        }
        try {
            const screen = await renderScreen(<Page />);
            expect(reads).toEqual([]);
            await act(async () => show());
            const retention = () => screen.findAllByType(FieldValueItem).find(row => row.props.testID === 'deployment-defaults.retention')!;
            await vi.waitFor(() => expect(retention()?.props.placeholder).toBe('1'));
            expect(retention().props.disabled).toBe(true);
            expect(screen.findByTestId('project-deployment-defaults.account')).toBeNull();
            await act(async () => retention().props.onCommit('8'));
            expect(account.artifacts.list()).toHaveLength(0);
        } finally { standardCleanup(); context.dispose(); await account.dispose(); }
    });

    it('leads to each Environment’s own Triggers instead of a Project trigger list', async () => {
        const { ProjectDeploymentDefaultsSettings } = await projectPages['./ProjectDeploymentDefaultsSettings.tsx']!();
        const opened: string[] = [];
        const screen = await renderScreen(<ProjectDeploymentDefaultsSettings lifetime={null} sourceId="source-app"
            demand={{ mounted: true, visible: true, focused: true }}
            environments={[{ id: 'env-staging', title: 'Staging' }, { id: 'env-production', title: 'Production' }]}
            onOpenEnvironment={id => opened.push(id)} />);
        await screen.pressByTestIdAsync('project-deployment-defaults.triggers.env-production');
        expect(opened).toEqual(['env-production']);
        expect(screen.getTextContent()).toContain('Staging');
    });
});
