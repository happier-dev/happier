/**
 * @vitest-environment jsdom
 */
import * as React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe('Deferred', () => {
    it('renders immediately when enabled=true', async () => {
        const { Deferred } = await import('./Deferred');
        const host = document.createElement('div');
        const root = createRoot(host);

        act(() => {
            root.render(<Deferred enabled><div data-testid="child" /></Deferred>);
        });

        expect(host.querySelector('[data-testid="child"]')).not.toBeNull();

        act(() => root.unmount());
    });

    it('defers rendering children when enabled=false', async () => {
        vi.useFakeTimers();
        const { Deferred } = await import('./Deferred');
        const host = document.createElement('div');
        const root = createRoot(host);

        act(() => {
            root.render(<Deferred enabled={false}><div data-testid="child" /></Deferred>);
        });
        expect(host.querySelector('[data-testid="child"]')).toBeNull();

        act(() => {
            vi.advanceTimersByTime(10);
        });
        expect(host.querySelector('[data-testid="child"]')).not.toBeNull();

        act(() => root.unmount());
        vi.useRealTimers();
    });

    it('shows a fallback during the defer window and swaps to children afterwards', async () => {
        vi.useFakeTimers();
        const { Deferred } = await import('./Deferred');
        const host = document.createElement('div');
        const root = createRoot(host);

        act(() => {
            root.render(
                <Deferred enabled={false} fallback={<div data-testid="fallback" />}>
                    <div data-testid="child" />
                </Deferred>,
            );
        });
        expect(host.querySelector('[data-testid="fallback"]')).not.toBeNull();
        expect(host.querySelector('[data-testid="child"]')).toBeNull();

        act(() => {
            vi.advanceTimersByTime(10);
        });
        expect(host.querySelector('[data-testid="fallback"]')).toBeNull();
        expect(host.querySelector('[data-testid="child"]')).not.toBeNull();

        act(() => root.unmount());
        vi.useRealTimers();
    });

    it('renders immediately when enabled flips to true', async () => {
        vi.useFakeTimers();
        const { Deferred } = await import('./Deferred');
        const host = document.createElement('div');
        const root = createRoot(host);

        act(() => {
            root.render(<Deferred enabled={false}><div data-testid="child" /></Deferred>);
        });
        expect(host.querySelector('[data-testid="child"]')).toBeNull();

        act(() => {
            root.render(<Deferred enabled><div data-testid="child" /></Deferred>);
        });
        expect(host.querySelector('[data-testid="child"]')).not.toBeNull();

        act(() => root.unmount());
        vi.useRealTimers();
    });
});
