/** @vitest-environment jsdom */
import * as React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';

// The OS view boundary uses RNW elements so real web focus and Escape are exercised.
vi.mock('react-native', () => vi.importActual<typeof import('react-native-web')>('react-native-web'));
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());

import { AppShellPeekLayer, AppShellPeekProvider, useAppShellPeek } from './AppShellPeek';
import { useLayoutPresentationActive, usePluginSurfaceCurrentUiContextEligibility, usePluginSurfaceFocusEligibility } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';

function RailTrigger() {
    const peek = useAppShellPeek();
    return <button onClick={() => peek?.openFocused('plugin:acme.triage:triage')}>PRs &amp; Issues</button>;
}

// A mounted plugin runtime is the shell's output boundary. Its focus consumer stays real.
function PluginColumnProbe() {
    const eligible = usePluginSurfaceFocusEligibility();
    const current = usePluginSurfaceCurrentUiContextEligibility();
    const presented = useLayoutPresentationActive();
    return <button data-testid="column-focus" data-eligible={String(eligible)} data-current={String(current)} data-presented={String(presented)}>Views</button>;
}

describe('app shell column focus on web', () => {
    it('admits focused peek targets, transfers focus and returns to the rail without becoming semantic current', async () => {
        const container = document.createElement('div');
        document.body.appendChild(container);
        const root = createRoot(container);
        try {
            await act(async () => root.render(
                <AppShellPeekProvider enabled currentId="sessions" columnShown>
                    <RailTrigger />
                    <AppShellPeekLayer widthPx={320}
                        resolveColumn={() => ({ kind: 'plugin', destinationId: 'plugin:acme.triage:triage' })}
                        renderColumn={() => <PluginColumnProbe />} />
                </AppShellPeekProvider>,
            ));
            const trigger = container.querySelector('button')!;
            trigger.focus();
            await act(async () => trigger.click());
            const column = container.querySelector<HTMLElement>('[data-testid="column-focus"]')!;
            expect(column.dataset.eligible).toBe('true');
            expect(column.dataset.current).toBe('false');
            expect(document.activeElement).toBe(column);
            await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
            expect(document.activeElement).toBe(trigger);
            const retained = container.querySelector<HTMLElement>('[data-testid="column-focus"]');
            if (retained) {
                expect(retained.dataset.eligible).toBe('false');
                expect(retained.dataset.presented).toBe('false');
            }
        } finally {
            await act(async () => root.unmount());
            container.remove();
        }
    });
});
