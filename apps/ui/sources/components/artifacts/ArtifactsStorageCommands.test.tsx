import * as React from 'react';
import { Pressable } from 'react-native';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { StorageInventoryV1 } from '@happier-dev/protocol/artifacts/artifactActionsV1';
import { CurrentUiContextSnapshotV1Schema } from '@happier-dev/protocol/plugins/ui/currentUiContext';

import { usePublishCurrentUiContext } from '@/components/appShell/currentUiContext/CurrentUiContextProvider';
import { useOpenSaveFileAsArtifactDialog } from '@/components/workspaces/files/file/SaveFileAsArtifactDialog';
import { standardCleanup } from '@/dev/testkit';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { serveActionHomes } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { renderMountedCurrentUiContext } from '@/dev/testkit/harness/mountedCurrentUiContext';
import { retireActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import type { DecryptedArtifact } from '@/sync/domains/artifacts/artifactTypes';
import { getStorage } from '@/sync/domains/state/storage';
import { createDefaultActionExecutor } from '@/sync/ops/actions/defaultActionExecutor';
import { router } from 'expo-router';

import { ArtifactQuotaNotice } from './ArtifactQuotaNotice';
import { ArtifactsBrowser } from './ArtifactsBrowserScreen';

vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock({ pathname: '/artifacts' }).module);
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock());
// The daemon owns file bytes. Keep the actual dialog, mounted command and Artifact publication path.
vi.mock('@/sync/domains/transfers/runtime/transferRuntime', async importOriginal => ({
    ...await importOriginal<typeof import('@/sync/domains/transfers/runtime/transferRuntime')>(),
    downloadDaemonWorkspaceFileToDestination: async (request: { destination: { writeBytes(bytes: Uint8Array): Promise<void> } }) => {
        await request.destination.writeBytes(Uint8Array.of(0, 255, 3));
        return { ok: true, name: 'copy.bin', sizeBytes: 3 };
    },
}));

let home: Awaited<ReturnType<typeof serveActionHomes>>;
let disconnect: (() => Promise<void>) | undefined;
beforeEach(async () => {
    vi.mocked(router.push).mockClear();
    home = await serveActionHomes({
        homes: [{ key: 'owner', serverUrl: 'https://artifacts-storage-commands.test', accountId: 'owner', currentAccount: true }],
        route: request => request.path === '/v1/artifacts/content/upload'
            ? Response.json({ error: 'quota_exceeded', budget: 'account', limitBytes: 100, usedBytes: 125 }, { status: 413 })
            : request.path === '/v1/features' || request.path === '/v1/features/authenticated'
                ? Response.json(createRootLayoutFeaturesResponse()) : undefined,
    });
    disconnect = await home.restoreActiveConnection();
});
afterEach(async () => {
    await standardCleanup();
    await disconnect?.();
    disconnect = undefined;
    retireActiveServerAccountScopeLifetime();
    await home?.dispose();
});

function Page(props: React.PropsWithChildren) {
    usePublishCurrentUiContext({});
    return props.children;
}

const caller = { surface: 'agent' as const, authority: 'account_automation' as const };
const openStorageTitle = 'artifacts.browser.storageView.openStorage';
const seeUsageTitle = 'artifacts.browser.storageView.seeUsage';
const filteredStorageRoute = '/settings/storage?kind=artifacts';

async function currentCommands() {
    const result = await createDefaultActionExecutor().execute('ui.current_context.read', {}, caller);
    if (!result.ok) throw new Error(`Current UI context unavailable: ${result.errorCode}`);
    return CurrentUiContextSnapshotV1Schema.parse(result.result).commands;
}

function expectFilteredStorageOpened() {
    expect(vi.mocked(router.push).mock.calls.map(([href]) => href)).toEqual([filteredStorageRoute]);
}

async function invoke(title: string) {
    const commands = (await currentCommands()).filter(command => command.title === title);
    expect(commands).toHaveLength(1);
    await act(async () => {
        expect(await createDefaultActionExecutor().execute('ui.current_context.command.invoke', { commandId: commands[0]!.id }, caller))
            .toMatchObject({ ok: true });
    });
    expectFilteredStorageOpened();
}

const artifact: DecryptedArtifact = {
    id: 'document', title: 'Notes', isDecrypted: true, header: { title: 'Notes' },
    headerVersion: 1, bodyVersion: 1, seq: 1, body: 'Notes', createdAt: 1, updatedAt: 1,
    access: 'owner', storageMode: 'plain',
};

function inventory(artifactLimitBytes: number | null): StorageInventoryV1 {
    return {
        totalBytes: 100,
        artifactLimitBytes,
        unmeasuredKinds: [],
        byKind: { artifacts: 100, pluginArtifacts: 0, discussionAttachments: 0, accountPets: 0, pluginCollections: 0 },
    };
}

it.each([
    { label: 'stored total', limit: null, artifacts: [artifact], button: 'artifacts:storageOpen' },
    { label: 'meter', limit: 110, artifacts: [artifact], button: 'artifacts:storageOpen' },
    { label: 'full notice with an empty library', limit: 100, artifacts: [], button: 'artifacts:quota.action' },
])('opens filtered Account Storage from the $label', async ({ limit, artifacts, button }) => {
    const screen = await renderMountedCurrentUiContext(<Page>
        <ArtifactsBrowser artifacts={artifacts} usage={inventory(limit)} loaded loadFailed={false} onRetry={() => {}} />
    </Page>);
    await screen.pressByTestIdAsync(button);
    expectFilteredStorageOpened();
    vi.mocked(router.push).mockClear();
    await invoke(openStorageTitle);
});

it('opens filtered Account Storage from the default quota notice and retires the command for document limits', async () => {
    const accountQuota = { budget: 'account', usedBytes: 100, limitBytes: 100 } as const;
    const screen = await renderMountedCurrentUiContext(<Page>
        <ArtifactQuotaNotice quota={accountQuota} testID="quota" />
    </Page>);
    await screen.pressByTestIdAsync('quota.action');
    expectFilteredStorageOpened();
    vi.mocked(router.push).mockClear();
    await invoke(seeUsageTitle);
    await screen.update(<Page><ArtifactQuotaNotice quota={{ ...accountQuota, budget: 'document' }} testID="quota" /></Page>);
    expect(screen.findByTestId('quota.action')).toBeNull();
    expect((await currentCommands()).some(command => command.title === seeUsageTitle)).toBe(false);
});

it('dismisses Save as Artifact and opens filtered Storage from its quota recovery command', async () => {
    const serverId = home.homes.owner!.id;
    getStorage().setState({ machineListByServerId: { [serverId]: [createMachineFixture({ id: 'source-machine' })] } });
    function Opener() {
        const open = useOpenSaveFileAsArtifactDialog();
        return <Pressable testID="save-file" onPress={() => open({
            source: { scope: { serverId, accountId: 'owner' }, sourceSessionId: null,
                sourceWorkspace: { machineId: 'source-machine', rootPath: '/repo' }, filePath: 'copy.bin' },
            sourceFacts: 'Project',
        })} />;
    }
    const screen = await renderMountedCurrentUiContext(<Page><Opener /></Page>, { withModalProvider: true });
    await screen.pressByTestIdAsync('save-file');
    await vi.waitFor(() => expect(screen.findByTestId('save-as-artifact-save')?.props.disabled).toBe(false));
    await screen.pressByTestIdAsync('save-as-artifact-save');
    await vi.waitFor(() => expect(screen.findByTestId('save-as-artifact-quota.action')).not.toBeNull());
    await invoke(seeUsageTitle);
    await vi.waitFor(() => expect(screen.findByTestId('save-as-artifact-dialog')).toBeNull());
    expect((await currentCommands()).some(command => command.title === seeUsageTitle)).toBe(false);
});
