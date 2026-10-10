/** @vitest-environment jsdom */
import * as React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';

// The testkit stub cannot supply DOM semantics; this one-off platform boundary uses real RNW.
// All shared option logic stays real.
vi.mock('react-native', () => vi.importActual('react-native-web'));
const { HappierOptionRow } = await import('@happier-dev/plugin-ui/presentation');
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('public controlled option anatomy', () => {
    it('keeps choice activation disabled independently of a trailing control and forwards checked semantics', async () => {
        const selected: string[] = [];
        const container = document.createElement('div'); document.body.appendChild(container);
        const root = createRoot(container);
        const render = (disabled: boolean) => <HappierOptionRow title="Instructions" subtitle="From this Home"
            disabled={disabled} onSelect={() => selected.push('document')}
            controlProps={{ testID: 'option', role: 'radio', 'aria-checked': true, accessibilityLabel: 'Instructions' }}
            right={<button onClick={() => selected.push('trailing')}>Inspect</button>} rightElementOutsidePressable
            styles={{}} rowStyle={() => undefined} splitPressOpacity={1} />;
        try {
            await act(async () => { root.render(render(true)); });
            const option = container.querySelector<HTMLElement>('[data-testid="option"]')!;
            expect(option.getAttribute('role')).toBe('radio');
            expect(option.getAttribute('aria-checked')).toBe('true');
            await act(async () => { option.click(); container.querySelector<HTMLButtonElement>('button')!.click(); });
            expect(selected).toEqual(['trailing']);
            await act(async () => { root.render(render(false)); });
            await act(async () => { container.querySelector<HTMLElement>('[data-testid="option"]')!.click(); });
            expect(selected).toEqual(['trailing', 'document']);
        } finally { await act(async () => { root.unmount(); }); container.remove(); }
    });
});
