/** @vitest-environment jsdom */
import * as React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';

// Accessibility relationships must reach actual DOM nodes through RNW, not a host-prop stub.
vi.mock('react-native', async () => vi.importActual('react-native-web'));
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock());

import { WidgetAddPanel } from './WidgetAddSurface';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

it('delivers search-owned active options to the DOM while arrows preserve focus and filtering never leaves a missing descendant', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const sections = [{ id: 'builtins', title: 'Built in', entries: [
        { id: 'alpha', title: 'Alpha', icon: 'chart-bar' as const, onPick: () => {} },
        { id: 'beta', title: 'Beta', icon: 'chat-circle' as const, onPick: () => {} },
    ] }];
    try {
        await act(async () => root.render(<WidgetAddPanel title="Add widgets" searchPlaceholder="Search widgets" sections={sections}
            addLabel="Add" composition="split" onRequestClose={() => {}} testID="add" />));
        const search = container.querySelector<HTMLInputElement>('input[data-testid="add.search"]')!;
        const list = container.querySelector('[role="listbox"]');
        expect(list).not.toBeNull();
        expect(search.getAttribute('role')).toBe('combobox');
        expect(search.getAttribute('aria-controls')).toBe(list!.id);
        search.focus();
        const arrow = async (key: string) => act(async () => search.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true })));
        await arrow('ArrowDown');
        const alphaId = search.getAttribute('aria-activedescendant')!;
        const alpha = document.getElementById(alphaId)!;
        expect(alpha.getAttribute('role')).toBe('option');
        expect(alpha.getAttribute('aria-label')).toContain('Alpha');
        expect(alpha.getAttribute('aria-selected')).toBe('true');
        expect(document.activeElement).toBe(search);
        await arrow('ArrowDown');
        const betaId = search.getAttribute('aria-activedescendant')!;
        expect(betaId).not.toBe(alphaId);
        expect(document.getElementById(betaId)?.getAttribute('aria-label')).toContain('Beta');
        expect(alpha.getAttribute('aria-selected')).toBe('false');
        expect(document.activeElement).toBe(search);
        const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
        await act(async () => { valueSetter.call(search, 'Alpha'); search.dispatchEvent(new Event('input', { bubbles: true })); });
        expect(document.getElementById(betaId)).toBeNull();
        expect(search.hasAttribute('aria-activedescendant')).toBe(false);
        await arrow('ArrowDown');
        expect(search.getAttribute('aria-activedescendant')).toBe(alphaId);
        expect(document.activeElement).toBe(search);
    } finally {
        await act(async () => root.unmount());
        container.remove();
    }
});
