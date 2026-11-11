import * as React from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import 'fake-indexeddb/auto';
import { act, createDeferred, renderScreen, standardCleanup } from '@/dev/testkit';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { createSecretSettingsTestHarness } from '@/components/settings/secrets/secretSettingsTestHarness';
import { settingsParse } from '@/sync/domains/settings/settings';
import { storage } from '@/sync/domains/state/storage';
import { InjectedAuthProvider } from '@/auth/context/AuthContext';
import { ProjectDeploymentDefaultsOutputV1Schema, ProjectDeploymentDefaultsSetInputV1Schema } from '@happier-dev/protocol/projects/projectDeploymentDefaultsV1';

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
const { SegmentedChoiceItem } = await import('@/components/ui/lists/SegmentedChoiceItem');
const { FieldValueItem } = await import('@/components/ui/forms/FieldValueItem');
const original = storage.getState();
afterEach(() => { standardCleanup(); storage.setState(original, true); router.resetParams(); vi.unstubAllGlobals(); });

it.each(['account', 'project'] as const)('retains rapid %s defaults edits and neighboring fields while the first HTTP write waits', async owner => {
    const first = createDeferred<void>();
    const failure = createDeferred<void>();
    let refuse = false;
    let writes = 0;
    let metadata = ProjectDeploymentDefaultsOutputV1Schema.parse({ ok: true, projectSourceId: 'source-app', sourceRevision: 1, revision: 0, content: null });
    const baseline = settingsParse({ deploymentDefaultsV1: { retainPreviousDeployments: 7 }, actionsSettingsV1: { v: 1,
        approvalWaivedSurfaces: { 'settings.set': ['ui'], 'artifact.create': ['ui'], 'projects.deploymentDefaults.set': ['ui'] } } });
    const account = await createSecretSettingsTestHarness({ settings: baseline, handleRequest: async (path, init) => {
        if (owner === 'account' && path === '/v2/account/settings' && init?.method === 'POST') {
            if (++writes === 1) await first.promise;
            if (refuse) { await failure.promise; return Response.json({ error: 'forbidden' }, { status: 403 }); }
            return null;
        }
        if (path.startsWith('/v1/projects/sources/source-app')) return Response.json({ ok: true, canManage: true,
            source: { id: 'source-app', revision: 1, name: 'App', owner: { kind: 'account', accountId: 'account-a' }, audience: [], createdByAccountId: 'account-a', defaultRef: 'main' } });
        if (path.startsWith('/v1/projects/source-app/deployment-defaults')) {
            if (init?.method === 'PUT') {
                const input = ProjectDeploymentDefaultsSetInputV1Schema.parse(JSON.parse(String(init.body)));
                if (++writes === 1) await first.promise;
                if (refuse) { await failure.promise; return Response.json({ error: 'forbidden' }, { status: 403 }); }
                if (!metadata.ok || input.expectedRevision !== metadata.revision) return Response.json({ ok: false, error: 'project_defaults_conflict' }, { status: 409 });
                metadata = { ...metadata, revision: metadata.revision + 1, content: input.content };
            }
            return Response.json(metadata);
        }
        return null;
    } });
    const { captureLazyActionAccountContext } = await import('@/sync/ops/actions/actionAccountContext');
    const context = await captureLazyActionAccountContext(account.scope.serverId);
    try {
        const page = owner === 'account'
            ? React.createElement((await import('@/components/settings/deployments/DeploymentsSettingsView')).DeploymentsSettingsView)
            : React.createElement((await import('./ProjectDeploymentDefaultsSettings')).ProjectDeploymentDefaultsSettings, {
                lifetime: context.accountLifetime, sourceId: 'source-app', demand: { mounted: true, visible: true, focused: true },
            });
        const screen = await renderScreen(<InjectedAuthProvider credentials={account.credentials}>{page}</InjectedAuthProvider>);
        const row = (prefix: string) => screen.findAllByType(SegmentedChoiceItem).find(item => item.props.testIDPrefix === prefix)!;
        const database = () => row('deployment-defaults.previewDatabase');
        await vi.waitFor(() => expect(database()?.props.disabled).toBe(false));
        const changeAlertsFromOpenedEditor = row('deployment-defaults.alertChannels').props.onChange;
        await act(async () => database().props.onChange('none'));
        await vi.waitFor(() => expect(writes).toBe(1));
        expect(database().props.disabled).toBe(false);
        await act(async () => database().props.onChange('own'));
        const retention = () => screen.findAllByType(FieldValueItem).find(item => item.props.testID === 'deployment-defaults.retention')!;
        await act(async () => expect(retention().props.onCommit('12')).toBe('12'));
        for (const choice of ['branch', 'none', 'own', 'branch', 'branch']) await act(async () => database().props.onChange(choice));
        await act(async () => changeAlertsFromOpenedEditor('off'));
        expect(database().props.value).toBe('branch');
        await act(async () => first.resolve());
        const persisted = async () => owner === 'account' ? account.persistedSettings.deploymentDefaultsV1
            : metadata.ok && metadata.content ? JSON.parse(String((await context.readArtifactContent(metadata.content.contentArtifactId))?.body)).deploymentDefaults : {};
        await vi.waitFor(async () => expect(await persisted()).toMatchObject({ previewDatabase: 'branch', alertChannels: [], retainPreviousDeployments: 12 }));
        expect(writes).toBe(2);
        expect(database().props.value).toBe('branch');
        expect(retention().props.value).toBe('12');
        if (owner === 'project') expect(account.persistedSettings.deploymentDefaultsV1).toEqual(baseline.deploymentDefaultsV1);
        refuse = true;
        await act(async () => database().props.onChange('none'));
        await vi.waitFor(() => expect(writes).toBe(3));
        await act(async () => database().props.onChange('own'));
        await act(async () => failure.resolve());
        await vi.waitFor(() => expect(database().props.value).toBe('branch'));
        expect(await persisted()).toMatchObject({ previewDatabase: 'branch', alertChannels: [] });
        expect(writes).toBe(3);
    } finally { first.resolve(); failure.resolve(); standardCleanup(); context.dispose(); await account.dispose(); }
});

it('keeps a replacement Account binding independent of its predecessor’s held write', async () => {
    const first = createDeferred<void>();
    const writes: string[] = [];
    const settings = settingsParse({ actionsSettingsV1: { v: 1, approvalWaivedSurfaces: { 'settings.set': ['ui'] } } });
    const accountA = await createSecretSettingsTestHarness({ settings, handleRequest: async (path, init) => {
        if (path === '/v2/account/settings' && init?.method === 'POST') { writes.push('account-a'); await first.promise; }
        return null;
    } });
    let accountB: Awaited<ReturnType<typeof createSecretSettingsTestHarness>> | undefined;
    const { DeploymentsSettingsView } = await import('@/components/settings/deployments/DeploymentsSettingsView');
    let selectAccount = (_credentials: typeof accountA.credentials) => {};
    function Page() {
        const [credentials, setCredentials] = React.useState(accountA.credentials);
        selectAccount = setCredentials;
        return <InjectedAuthProvider credentials={credentials}><DeploymentsSettingsView /></InjectedAuthProvider>;
    }
    try {
        const screen = await renderScreen(<Page />);
        const database = () => screen.findAllByType(SegmentedChoiceItem).find(item => item.props.testIDPrefix === 'deployment-defaults.previewDatabase')!;
        await vi.waitFor(() => expect(database()?.props.disabled).toBe(false));
        await act(async () => database().props.onChange('none'));
        await vi.waitFor(() => expect(writes).toEqual(['account-a']));
        await act(async () => {
            accountB = await createSecretSettingsTestHarness({ accountId: 'account-b', settings, handleRequest: async (path, init) => {
                if (path === '/v2/account/settings' && init?.method === 'POST') writes.push('account-b');
                return null;
            } });
            selectAccount(accountB.credentials);
        });
        await vi.waitFor(() => expect(database()?.props.disabled).toBe(false));
        expect(database().props.value).toBe('inherit');
        await act(async () => database().props.onChange('branch'));
        await vi.waitFor(() => expect(accountB?.persistedSettings.deploymentDefaultsV1.previewDatabase).toBe('branch'));
        await act(async () => first.resolve());
        await vi.waitFor(() => expect(accountA.persistedSettings.deploymentDefaultsV1.previewDatabase).toBe('none'));
        expect(accountB.persistedSettings.deploymentDefaultsV1.previewDatabase).toBe('branch');
        expect(database().props.value).toBe('branch');
        expect(writes).toEqual(['account-a', 'account-b']);
    } finally { first.resolve(); standardCleanup(); await accountB?.dispose(); await accountA.dispose(); }
});
