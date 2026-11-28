import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { createDeferred } from '@/dev/testkit/hooks/createDeferred';
import { apiSocket } from '@/sync/api/session/apiSocket';
import { storage } from '@/sync/domains/state/storage';

const saveFile = vi.hoisted(() => vi.fn());
vi.mock('@/sync/runtime/files/saveFileBytes', () => ({ saveFileBytes: saveFile }));

afterEach(() => {
    vi.restoreAllMocks();
    saveFile.mockReset();
});

it('reads a hosted session through its terminal empty page and completes the Markdown download', async () => {
    const id = 'export-session';
    storage.getState().applySessions([createSessionFixture({ id, encryptionMode: 'plain' })]);
    const requests: string[] = [];
    vi.spyOn(apiSocket, 'request').mockImplementation(async (path) => {
        requests.push(path);
        const beforeSeq = new URL(path, 'https://local.test').searchParams.get('beforeSeq');
        return Response.json(beforeSeq ? { messages: [], hasMore: false, nextBeforeSeq: null } : {
            messages: [{
                id: 'm1', seq: 9, localId: null, createdAt: 1,
                content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'Save this transcript' } } },
            }],
            hasMore: true,
            nextBeforeSeq: 9,
        });
    });
    const saving = createDeferred<Uint8Array>();
    const finish = createDeferred<void>();
    saveFile.mockImplementation(async ({ bytes }: { bytes: Uint8Array }) => {
        saving.resolve(bytes);
        await finish.promise;
    });

    const { ExportSheet } = await import('./ExportSheet');
    const screen = await renderScreen(<ExportSheet onClose={() => {}} initialScope="session" sessionId={id} />);
    const start = screen.root.find((node) => node.props.testID === 'export-sheet-start' && typeof node.props.onPress === 'function');
    await act(async () => {
        start.props.onPress();
        const bytes = await saving.promise;
        expect(new TextDecoder().decode(bytes)).toBe('## User\n\nSave this transcript\n');
    });

    expect(requests).toEqual([
        '/v1/sessions/export-session/messages?scope=all',
        '/v1/sessions/export-session/messages?scope=all&beforeSeq=9',
    ]);
    const save = screen.root.find((node) => node.props.testID === 'export-step-save' && node.props.accessibilityState !== undefined);
    const read = screen.root.find((node) => node.props.testID === 'export-step-read' && node.props.accessibilityState !== undefined);
    expect(read.props.accessibilityState).toMatchObject({ checked: true });
    expect(save.props.accessibilityState).toMatchObject({ checked: false, selected: true });
    await act(async () => finish.resolve());
    expect(screen.root.findAllByProps({ testID: 'export-sheet-done' }).length).toBeGreaterThan(0);
});
