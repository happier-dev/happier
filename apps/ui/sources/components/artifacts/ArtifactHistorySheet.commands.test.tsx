import * as React from 'react';
import { Pressable } from 'react-native';
import { act } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, encodePlainArtifactStoredContent } from '@happier-dev/protocol/storage/artifactStoredContent';
import { CurrentUiContextSnapshotV1Schema } from '@happier-dev/protocol/plugins/ui/currentUiContext';
import { standardCleanup } from '@/dev/testkit';
import { serveActionHomes } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { renderMountedCurrentUiContext } from '@/dev/testkit/harness/mountedCurrentUiContext';
import { CurrentUiContextCommandsProvider, useCurrentUiContextCommandBridge, useCurrentUiContextComposedCommands } from '@/components/appShell/currentUiContext/CurrentUiContextCommands';
import { usePublishCurrentUiContext } from '@/components/appShell/currentUiContext/CurrentUiContextProvider';
import { captureActiveServerAccountScopeLifetime, retireActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { createDefaultActionExecutor } from '@/sync/ops/actions/defaultActionExecutor';
import { getStorage } from '@/sync/domains/state/storage';
import { Modal } from '@/modal';
import type { DecryptedArtifact } from '@/sync/domains/artifacts/artifactTypes';
import { useArtifactOperations } from './useArtifactOperations';
import { showArtifactHistorySheet } from './ArtifactHistorySheet';
import { ProseDiffViewer } from '@/components/ui/code/diff/prose/ProseDiffViewer';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeNativeMock({ platformOS: 'ios' }));
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock({ pathname: '/artifacts/document' }).module);
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock());
// Browser focus/portals have no native renderer counterpart; modal and command owners stay real.
vi.mock('@/components/ui/popover', async importOriginal =>
    (await import('@/dev/testkit/mocks/popover')).createInlinePopoverModuleMock(importOriginal));

const artifact: DecryptedArtifact = { id: 'document', title: 'Notes', isDecrypted: true,
    header: { title: 'Notes' }, rawHeader: { title: 'Notes' }, headerVersion: 3, bodyVersion: 3, seq: 3,
    body: 'Current notes', createdAt: 1, updatedAt: 3, ownerAccountId: 'owner', access: 'owner', storageMode: 'plain' };
let home: Awaited<ReturnType<typeof serveActionHomes>> | undefined;
const initialState = getStorage().getState();
afterEach(async () => {
    Modal.hideAll();
    standardCleanup();
    retireActiveServerAccountScopeLifetime();
    await home?.dispose(); home = undefined;
    getStorage().setState(initialState, true);
});

function Publication() {
    const commands = useCurrentUiContextComposedCommands();
    const enrichment = React.useMemo(() => ({ commands }), [commands]);
    usePublishCurrentUiContext(enrichment);
    return null;
}

function Page() {
    const authority = captureActiveServerAccountScopeLifetime();
    return <CurrentUiContextCommandsProvider authority={authority}><Publication /><HistoryEntry /></CurrentUiContextCommandsProvider>;
}
function HistoryEntry() {
    const operations = useArtifactOperations(artifact);
    const commandBridge = useCurrentUiContextCommandBridge();
    return <><Pressable testID="open-history" onPress={() => operations.history()} />
        <Pressable testID="compare-history" onPress={() => showArtifactHistorySheet({ artifactId: artifact.id,
            compareFromBodyVersion: 1, commandBridge })} /></>;
}

it('lets the answering agent select retained revisions through the real History modal without extra reads', async () => {
    home = await serveActionHomes({ homes: [{ key: 'owner', serverUrl: 'https://history-commands.test', accountId: 'owner', currentAccount: true }],
        route: request => request.path.endsWith('/revisions') ? Response.json({ retentionCount: 10,
            revisions: [3, 2, 1].map(bodyVersion => ({ bodyVersion, createdAt: bodyVersion, sizeBytes: 20,
                body: encodePlainArtifactStoredContent({ body: `Notes ${bodyVersion}` }) })) })
            : request.path === '/v1/artifacts/document' ? Response.json({ ...artifact,
                header: encodePlainArtifactStoredContent({ title: 'Notes' }),
                body: encodePlainArtifactStoredContent({ body: 'Notes 3' }),
                dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER, encryptionMode: 'plain' }) : undefined });
    await home.restoreActiveConnection();
    getStorage().getState().addArtifact(artifact);
    const screen = await renderMountedCurrentUiContext(<Page />, { withModalProvider: true });
    await screen.pressByTestIdAsync('open-history');
    await vi.waitFor(() => expect(screen.findByTestId('artifact-history:loading')).toBeNull());
    const executor = createDefaultActionExecutor();
    const read = await executor.execute('ui.current_context.read', {}, { surface: 'agent' });
    expect(read.ok).toBe(true);
    if (!read.ok) throw new Error('Current UI context unavailable');
    const parsed = CurrentUiContextSnapshotV1Schema.parse(read.result);
    const revision = parsed.commands.find(command => command.title === 'artifacts.browser.history.version(n=2)');
    expect(revision).toBeDefined();
    await act(async () => {
        const result = await executor.execute('ui.current_context.command.invoke', { commandId: revision!.id }, { surface: 'agent' });
        expect(result.ok).toBe(true);
    });
    expect(screen.getTextContent()).toContain('Notes 2');
    expect(home.requests.filter(request => request.path.endsWith('/revisions'))).toHaveLength(1);
    await act(async () => { Modal.hideAll(); });
    const retired = await executor.execute('ui.current_context.command.invoke', { commandId: revision!.id }, { surface: 'agent' });
    expect(retired.ok).toBe(false);
    await screen.pressByTestIdAsync('compare-history');
    await vi.waitFor(() => expect(screen.findByTestId('artifact-history:changes')).not.toBeNull());
    const compareRead = await executor.execute('ui.current_context.read', {}, { surface: 'agent' });
    expect(compareRead.ok).toBe(true);
    if (!compareRead.ok) throw new Error('Expected compare History');
    const compareRevision = CurrentUiContextSnapshotV1Schema.parse(compareRead.result).commands.find(command => command.title === 'artifacts.browser.history.version(n=2)');
    expect(compareRevision).toBeDefined();
    await act(async () => {
        expect((await executor.execute('ui.current_context.command.invoke', { commandId: compareRevision!.id }, { surface: 'agent' })).ok).toBe(true);
    });
    expect(screen.findByType(ProseDiffViewer).props).toMatchObject({ oldText: 'Notes 2', newText: 'Notes 3' });
    expect(screen.getTextContent()).toContain('Notes');
    expect(home.requests.filter(request => request.path.endsWith('/revisions'))).toHaveLength(2);
    await screen.unmount();
    expect((await executor.execute('ui.current_context.command.invoke', { commandId: compareRevision!.id }, { surface: 'agent' })).ok).toBe(false);
});
