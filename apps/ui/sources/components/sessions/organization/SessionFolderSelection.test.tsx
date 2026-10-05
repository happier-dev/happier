import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { Modal, ModalProvider } from '@/modal';
import type { SessionFolderMoveTarget } from '@/sync/domains/session/folders';
import { openSessionFolderSelection } from './SessionFolderSelection';

vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock({ renderCustomModals: true }).module;
});

const targets: readonly SessionFolderMoveTarget[] = [
    { id: 'root-option', folderId: null, title: 'Workspace root', depth: 0, disabled: false },
    { id: 'folder-option', folderId: 'id:with:separators', title: 'Planning', depth: 1, disabled: false },
    { id: 'disabled-option', folderId: 'current', title: 'Current folder', depth: 0, disabled: true },
];

describe('explicit Session folder selection', () => {
    it.each([targets[0]!, targets[1]!])('returns the canonical $title target through the mounted shared list', async (target) => {
        const screen = await renderScreen(<ModalProvider children={null} />);
        let selection!: Promise<SessionFolderMoveTarget | null>;
        await act(async () => {
            selection = openSessionFolderSelection({ sourceLabel: 'Two sessions', targets });
        });
        await screen.pressByTestIdAsync(`session-folder-selection:root:option:${target.id}`);
        await expect(selection).resolves.toBe(target);
        expect(screen.findByTestId('session-folder-selection')).toBeNull();
        await screen.unmount();
    });

    it('does not select a disabled folder and resolves cancellation without a root assignment', async () => {
        const screen = await renderScreen(<ModalProvider children={null} />);
        let selection!: Promise<SessionFolderMoveTarget | null>;
        let resolved = false;
        await act(async () => {
            selection = openSessionFolderSelection({ sourceLabel: 'One session', targets });
            void selection.then(() => { resolved = true; });
        });
        expect(screen.findByTestId('session-folder-selection:root:option:disabled-option')?.props.disabled).toBe(true);
        await screen.pressByTestIdAsync('session-folder-selection:root:option:disabled-option');
        expect(resolved).toBe(false);
        const config = vi.mocked(Modal.show).mock.calls.at(-1)?.[0];
        await act(async () => { config?.onRequestClose?.(); });
        await expect(selection).resolves.toBeNull();
        expect(screen.findByTestId('session-folder-selection')).toBeNull();
        await screen.unmount();
    });
});
