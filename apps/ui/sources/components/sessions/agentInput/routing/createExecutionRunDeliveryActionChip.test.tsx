import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@expo/vector-icons', () => ({
    Ionicons: (props: Record<string, unknown>) => React.createElement('Ionicons', props, null),
}));

vi.mock('@/text', () => ({
    t: (key: string, params?: Record<string, unknown>) => {
        if (params && Object.keys(params).length > 0) {
            return `${key}:${JSON.stringify(params)}`;
        }
        return key;
    },
}));

describe('createExecutionRunDeliveryActionChip', () => {
    it("publishes a 'list' presentation collapsedOptionsPopover with a rootStep section (no flat options)", async () => {
        const { createExecutionRunDeliveryActionChip } = await import('./createExecutionRunDeliveryActionChip');

        const chip = createExecutionRunDeliveryActionChip({
            recipient: {
                kind: 'execution_run',
                runId: 'A1',
            },
            delivery: 'interrupt',
            onDeliveryChange: () => {},
        });

        const popover = chip.collapsedOptionsPopover;
        expect(popover).toBeTruthy();
        expect(popover!.presentation).toBe('list');
        expect(popover!.rootStep).toBeTruthy();
        // The flat `options` field MUST be absent on a 'list' descriptor.
        expect((popover as Record<string, unknown>).options).toBeUndefined();

        const section = popover!.rootStep!.sections[0];
        expect(section.kind).toBe('static');
        if (section.kind !== 'static') return;
        expect(section.options.map((option) => option.id)).toEqual([
            'prompt',
            'steer_if_supported',
            'interrupt',
        ]);
        expect(popover!.selectedOptionId).toBe('interrupt');
    });

    it('exposes per-option onSelect callbacks that dispatch onDeliveryChange so the overlay route fires the mutation', async () => {
        const { createExecutionRunDeliveryActionChip } = await import('./createExecutionRunDeliveryActionChip');

        const onDeliveryChange = vi.fn();
        const chip = createExecutionRunDeliveryActionChip({
            recipient: {
                kind: 'execution_run',
                runId: 'A1',
            },
            delivery: 'prompt',
            onDeliveryChange,
        });

        const section = chip.collapsedOptionsPopover!.rootStep!.sections[0];
        if (section.kind !== 'static') throw new Error('expected static section');

        const steerOption = section.options.find((option) => option.id === 'steer_if_supported');
        expect(typeof steerOption?.onSelect).toBe('function');

        steerOption!.onSelect!();
        expect(onDeliveryChange).toHaveBeenCalledWith('steer_if_supported');
    });

    it('descriptor-level onSelect is a documented close-only no-op (does NOT mutate delivery state)', async () => {
        const { createExecutionRunDeliveryActionChip } = await import('./createExecutionRunDeliveryActionChip');

        const onDeliveryChange = vi.fn();
        const chip = createExecutionRunDeliveryActionChip({
            recipient: {
                kind: 'execution_run',
                runId: 'A1',
            },
            delivery: 'prompt',
            onDeliveryChange,
        });

        chip.collapsedOptionsPopover!.onSelect('steer_if_supported');
        chip.collapsedOptionsPopover!.onSelect('interrupt');
        expect(onDeliveryChange).not.toHaveBeenCalled();
    });
});
