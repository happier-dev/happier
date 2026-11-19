/** @vitest-environment jsdom */
import * as React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import type { PermissionMode } from '@/sync/domains/permissions/permissionTypes';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', async () => {
    const { getVitestNodeBuiltin } = await import('@/dev/vitestNodeBuiltins');
    const { createRequire } = getVitestNodeBuiltin<Pick<typeof import('node:module'), 'createRequire'>>('node:module');
    // Resolve the real DOM boundary: the bare RNW package request has a Node shim.
    return await vi.importActual(createRequire(import.meta.url).resolve('react-native-web'));
});
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

// Keep the picker, radio primitive, theme projection and text graph real.
const { PermissionModePicker } = await import('./PermissionModePicker');
const styles = {
    overlaySection: {}, overlaySectionTitle: {}, overlayOptionRow: {}, overlayOptionRowPressed: {},
    overlayOptionLabel: {}, overlayOptionLabelSelected: {}, overlayOptionLabelUnselected: {}, overlayOptionDescription: {},
} satisfies React.ComponentProps<typeof PermissionModePicker>['styles'];

it.each<PermissionMode | null>(['default', null])('announces selected and unselected radio states from %s through a public choice', async (initial) => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    function Picker() {
        const [selected, setSelected] = React.useState<PermissionMode | null>(initial);
        return <>
            <output data-testid="selected-mode">{selected ?? 'Mixed'}</output>
            <PermissionModePicker title="Permission mode" selected={selected} onSelect={setSelected} styles={styles}
                options={[
                    { value: 'default', label: 'Default', description: 'Ask before acting' },
                    { value: 'yolo', label: 'YOLO', description: 'Act without asking' },
                ]}
                effectivePermissionLabel={selected ?? 'Mixed'}
                effectivePermissionPolicy={{ effectiveMode: selected ?? 'default', reasons: [], notes: [] }} />
        </>;
    }
    const option = (value: PermissionMode) => container.querySelector<HTMLElement>(`[data-testid="permission-mode-${value}"]`);
    try {
        await act(async () => root.render(<Picker />));
        expect(option('default')?.getAttribute('role')).toBe('radio');
        expect(option('default')?.getAttribute('aria-label')).toBe('Default');
        expect(option('yolo')?.getAttribute('role')).toBe('radio');
        const initialChecked = [option('default')?.getAttribute('aria-checked'), option('yolo')?.getAttribute('aria-checked')];

        // Establish the real press/state path before the accessibility assertion can fail.
        await act(async () => { option('yolo')!.click(); });
        expect(container.querySelector('[data-testid="selected-mode"]')?.textContent).toBe('yolo');
        expect(initialChecked).toEqual([initial === 'default' ? 'true' : 'false', 'false']);
        expect([option('default')?.getAttribute('aria-checked'), option('yolo')?.getAttribute('aria-checked')]).toEqual(['false', 'true']);
    } finally {
        await act(async () => root.unmount());
        container.remove();
    }
});
