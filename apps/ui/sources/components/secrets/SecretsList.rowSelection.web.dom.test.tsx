/**
 * @vitest-environment jsdom
 *
 * Saved Secret rows are the only way to pick a stored secret on every surface that
 * embeds {@link SecretsList} (the Voice credential picker, MCP value refs, both
 * provider-connection screens, the profile/session pick flow). These tests drive the
 * REAL react-native-web render and the REAL DOM events rather than invoking the row's
 * handler directly, because the defect class this file pins is one where the handler is
 * perfectly correct and the rendered row never delivers a press to it.
 */
import * as React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { SavedSecret } from '@/sync/domains/settings/savedSecretTypes';

import { SecretsList } from './SecretsList';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', async () => {
    const actual: Record<string, unknown> = await vi.importActual('react-native-web');
    return {
        ...actual,
        Platform: {
            ...(actual.Platform as object ?? {}),
            OS: 'web',
            select: (values: Record<string, unknown>) =>
                values?.web ?? values?.default ?? values?.native ?? values?.ios ?? values?.android,
        },
    };
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key: string) => key });
});

vi.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));

const modalMock = vi.hoisted(() => ({ prompt: vi.fn(async () => null) }));

vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock({ spies: { prompt: modalMock.prompt } }).module;
});

const SECRET: SavedSecret = {
    id: 'secret-a',
    name: 'Primary key',
    kind: 'apiKey',
    encryptedValue: { _isSecretValue: true, value: 'sk-a' },
    createdAt: 1,
    updatedAt: 1,
};

let mounted: Readonly<{ root: Root; container: HTMLElement }> | null = null;

afterEach(async () => {
    const current = mounted;
    mounted = null;
    if (current) {
        await act(async () => { current.root.unmount(); });
        current.container.remove();
    }
    modalMock.prompt.mockClear();
});

async function renderSecretsList(): Promise<Readonly<{
    container: HTMLElement;
    onSelectId: ReturnType<typeof vi.fn>;
}>> {
    const onSelectId = vi.fn();
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    mounted = { root, container };

    await act(async () => {
        root.render(
            <SecretsList
                secrets={[SECRET]}
                onChangeSecrets={() => {}}
                selectedId=""
                onSelectId={onSelectId}
                allowAdd={false}
            />,
        );
    });

    return { container, onSelectId };
}

function requireNode(container: HTMLElement, testID: string): HTMLElement {
    const node = container.querySelector<HTMLElement>(`[data-testid="${testID}"]`);
    if (!node) throw new Error(`missing node for testID "${testID}"`);
    return node;
}

/** A pointer press as the browser delivers it: down, up, then the activating click. */
function pressWithPointer(node: HTMLElement): void {
    const base = { bubbles: true, cancelable: true, button: 0, clientX: 4, clientY: 4 };
    node.dispatchEvent(new MouseEvent('mousedown', { ...base, buttons: 1 }));
    node.dispatchEvent(new MouseEvent('mouseup', { ...base, buttons: 0 }));
    node.dispatchEvent(new MouseEvent('click', { ...base, buttons: 0 }));
}

describe('SecretsList saved-secret rows (react-native-web)', () => {
    it('reaches onSelectId from a pointer press on the row itself', async () => {
        const { container, onSelectId } = await renderSecretsList();

        await act(async () => { pressWithPointer(requireNode(container, 'saved-secret:secret-a')); });

        expect(onSelectId.mock.calls).toEqual([['secret-a']]);
    });

    it('renders each selectable row as a labelled button that does not contain the row actions', async () => {
        const { container } = await renderSecretsList();
        const row = requireNode(container, 'saved-secret:secret-a');

        // The activation owner is the row element itself: a real button with an
        // accessible name. Without it the row is an unlabelled, role-less div that
        // assistive technology cannot announce or operate.
        expect(row.tagName).toBe('BUTTON');
        expect(row.getAttribute('role')).toBe('button');
        expect(row.getAttribute('aria-label')).toContain('Primary key');

        // One activation owner per control: the row's own actions are siblings of the
        // row button, never nested interactive elements inside it. (Which actions are
        // inline and which fall into the overflow menu depends on layout width, so the
        // contract is asserted through containment rather than a fixed action set.)
        expect(row.querySelector('button')).toBeNull();
        const rename = requireNode(container, 'saved-secret:secret-a:rename');
        expect(row.contains(rename)).toBe(false);
    });

    it('activates the row from the keyboard', async () => {
        const { container, onSelectId } = await renderSecretsList();
        const row = requireNode(container, 'saved-secret:secret-a');

        row.focus();
        await act(async () => {
            row.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
        });

        expect(onSelectId).toHaveBeenCalledWith('secret-a');
    });

    it('runs a row action without selecting the row', async () => {
        const { container, onSelectId } = await renderSecretsList();

        await act(async () => { pressWithPointer(requireNode(container, 'saved-secret:secret-a:rename')); });

        expect(modalMock.prompt).toHaveBeenCalledTimes(1);
        expect(onSelectId).not.toHaveBeenCalled();
    });
});
