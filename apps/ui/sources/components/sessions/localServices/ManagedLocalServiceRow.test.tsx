import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { buildManagedLocalServiceRow, flushHookEffects, renderScreen } from '@/dev/testkit';
import type { IModal } from '@/modal/types';

const modalSpies = vi.hoisted(() => ({
    confirm: vi.fn<IModal['confirm']>(async () => true),
}));

vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock({ spies: { confirm: modalSpies.confirm } }).module;
});

import { ManagedLocalServiceRow } from './ManagedLocalServiceRow';

describe('ManagedLocalServiceRow in-flight spinner', () => {
    beforeEach(() => {
        modalSpies.confirm.mockReset();
        modalSpies.confirm.mockResolvedValue(true);
    });

    it('shows a per-row spinner and disables the stop button while the stop promise is pending', async () => {
        let resolveStop: (() => void) | undefined;
        const onStop = () => new Promise<void>((resolve) => {
            resolveStop = resolve;
        });
        const screen = await renderScreen(
            <ManagedLocalServiceRow
                row={buildManagedLocalServiceRow({
                    id: 'running-service',
                    phase: 'running',
                    supportedActions: ['stop_managed'],
                })}
                onStop={onStop}
                testID="managed-row"
            />,
        );

        // No spinner before the action fires.
        expect(screen.findAllByTestId('managed-row-stop-spinner')).toHaveLength(0);

        await screen.pressByTestIdAsync('managed-row-stop');

        // Spinner visible + button busy while the promise is pending.
        const button = screen.findByTestId('managed-row-stop');
        expect(button?.props.accessibilityState?.busy).toBe(true);
        expect(button?.props.disabled).toBe(true);
        expect(screen.findAllByTestId('managed-row-stop-spinner').length).toBeGreaterThan(0);

        resolveStop?.();
        await flushHookEffects();

        // Spinner clears and the button returns to its prior affordance once settled.
        expect(screen.findAllByTestId('managed-row-stop-spinner')).toHaveLength(0);
        expect(screen.findByTestId('managed-row-stop')?.props.disabled).toBe(false);
    });

    it('does not run stop when the destructive confirmation is declined', async () => {
        modalSpies.confirm.mockResolvedValueOnce(false);
        const onStop = vi.fn();
        const screen = await renderScreen(
            <ManagedLocalServiceRow
                row={buildManagedLocalServiceRow({
                    id: 'running-service',
                    phase: 'running',
                    supportedActions: ['stop_managed'],
                })}
                onStop={onStop}
                testID="managed-row"
            />,
        );

        await screen.pressByTestIdAsync('managed-row-stop');

        expect(modalSpies.confirm).toHaveBeenCalledTimes(1);
        expect(onStop).not.toHaveBeenCalled();
    });

    it('does not show a spinner for a synchronous (void) stop handler', async () => {
        const screen = await renderScreen(
            <ManagedLocalServiceRow
                row={buildManagedLocalServiceRow({
                    id: 'running-service',
                    phase: 'running',
                    supportedActions: ['stop_managed'],
                })}
                onStop={() => undefined}
                testID="managed-row"
            />,
        );

        await screen.pressByTestIdAsync('managed-row-stop');

        expect(screen.findAllByTestId('managed-row-stop-spinner')).toHaveLength(0);
        expect(screen.findByTestId('managed-row-stop')?.props.disabled).toBe(false);
    });
});
