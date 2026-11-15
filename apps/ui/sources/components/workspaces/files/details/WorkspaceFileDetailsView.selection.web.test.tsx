// @vitest-environment jsdom
import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';
import { standardCleanup } from '@/dev/testkit';
import { createSessionFilesViewFixture, installSessionFilesViewBoundaries, prepareSessionFilesViewTestkit } from '@/components/sessions/files/views/sessionFilesViewTestkit';

installSessionFilesViewBoundaries({ platformOS: 'web' });
await prepareSessionFilesViewTestkit();
const { WorkspaceFileDetailsView } = await import('./WorkspaceFileDetailsView');
const { FileReadAskControls } = await import('../file/FileReadAskControls');
const { KeyboardShortcutProvider } = await import('@/keyboard/KeyboardShortcutProvider');
const { router } = await import('expo-router');
const { readNewSessionDraftProjectionFromRepository } = await import('@/components/sessions/composer/newSessionDraftRepositoryAdapter');
const { getActiveServerAccountScope } = await import('@/sync/domains/scope/activeServerAccountScope');
afterEach(standardCleanup);

it.each([
    { filePath: 'conflict.txt', mode: 'file' },
    { filePath: 'README.md', mode: 'file' },
    { filePath: 'README.md', mode: 'markdown' },
])('opens a quoted draft from $filePath ($mode) through the loaded file reader', async ({ filePath, mode }) => {
    const text = 'alpha own sync139\n';
    const fixture = await createSessionFilesViewFixture({ settings: { filesAskWithoutSessionTarget: 'session' }, rpc: ({ method }) => method.includes('stat')
        ? { success: true, exists: true, kind: 'file', sizeBytes: text.length }
        : { success: true, content: Buffer.from(text).toString('base64') } });
    const host = document.createElement('div');
    host.innerHTML = '<div><div id="reader-f:1"><span>alpha own sync139</span></div></div><p>next panel</p>';
    const root = host.firstElementChild!;
    Object.defineProperty(root, 'scrollTo', { configurable: true, value: () => {} });
    document.body.append(host);
    const rect = { x: 20, y: 200, left: 20, top: 200, right: 180, bottom: 220, width: 160, height: 20, toJSON: () => ({}) };
    // jsdom has no layout engine; provide only the browser geometry boundary.
    const geometry = ['getBoundingClientRect', 'getClientRects'] as const;
    const descriptors = geometry.map(key => Object.getOwnPropertyDescriptor(Range.prototype, key));
    Object.defineProperty(Range.prototype, 'getBoundingClientRect', { configurable: true, value: () => rect });
    Object.defineProperty(Range.prototype, 'getClientRects', { configurable: true, value: () => [rect] });
    vi.mocked(router.push).mockClear();
    const screen = await fixture.render(<KeyboardShortcutProvider handlers={{}}>
        <WorkspaceFileDetailsView scopeId="selection" scope={fixture.scope} filePath={filePath} sessionIdForAugmentation={null} />
    </KeyboardShortcutProvider>, { createNodeMock: () => root });
    try {
        await vi.waitFor(() => expect(screen.findAllByType(FileReadAskControls)).toHaveLength(1));
        if (filePath.endsWith('.md')) await screen.pressByTestIdAsync(`file-details-view-mode:${mode}`);
        // Chromium triple-click includes the block break: the next element at offset zero is exclusive.
        const range = document.createRange(); range.setStart(root.querySelector('span')!.firstChild!, 0);
        range.setEnd(host.lastElementChild!, 0);
        await act(async () => {
            window.getSelection()!.removeAllRanges(); window.getSelection()!.addRange(range);
            document.dispatchEvent(new Event('selectionchange'));
        });
        expect(screen.findAllHostsByTestId('selection-toolbar-ask').length).toBeGreaterThan(0);
        await screen.pressByTestIdAsync('selection-toolbar-ask');
        await vi.waitFor(() => expect(vi.mocked(router.push).mock.calls.at(-1)?.[0]).toMatchObject({ pathname: '/new' }));
        const destination = vi.mocked(router.push).mock.calls.at(-1)?.[0];
        if (typeof destination !== 'object' || !destination || !('params' in destination)) throw new Error('Expected draft destination');
        const draftId = destination.params?.draftId;
        if (typeof draftId !== 'string') throw new Error('Expected draft identity');
        expect(readNewSessionDraftProjectionFromRepository({ scope: getActiveServerAccountScope()!, draftId })?.draft).toMatchObject({
            input: expect.stringContaining(text.trim()), selectedMachineId: fixture.scope.machineId, selectedPath: fixture.scope.rootPath,
        });
    } finally {
        window.getSelection()!.removeAllRanges(); host.remove(); await screen.unmount();
        geometry.forEach((key, index) => {
            const descriptor = descriptors[index];
            if (descriptor) Object.defineProperty(Range.prototype, key, descriptor);
            else delete (Range.prototype as Partial<Range>)[key];
        });
    }
});
