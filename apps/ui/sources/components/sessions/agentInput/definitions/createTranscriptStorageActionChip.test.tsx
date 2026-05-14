import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@expo/vector-icons', () => ({
    Ionicons: (props: Record<string, unknown>) => React.createElement('Ionicons', props, null),
}));

vi.mock('@/text', () => ({
    t: (key: string) => key,
}));

vi.mock('@/components/ui/rendering/normalizeNodeForView', () => ({
    normalizeNodeForView: (node: React.ReactNode) => node,
}));

vi.mock('@/components/sessions/agentInput/components/AgentInputSelectionListPopover', () => ({
    AgentInputSelectionListPopover: () => null,
}));

vi.mock('@/components/ui/text/Text', () => ({
    Text: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
        React.createElement('Text', props, props.children),
}));

describe('createTranscriptStorageActionChip', () => {
    it("publishes a 'list' presentation collapsedOptionsPopover with persisted + direct rows", async () => {
        const { createTranscriptStorageActionChip } = await import('./createTranscriptStorageActionChip');

        const chip = createTranscriptStorageActionChip({
            transcriptStorage: 'persisted',
            onStorageChange: vi.fn(),
        });

        expect(chip.collapsedOptionsPopover?.presentation).toBe('list');
        const section = chip.collapsedOptionsPopover?.rootStep?.sections?.[0];
        if (!section || section.kind !== 'static') throw new Error('expected static section');
        expect(section.options.map((option) => option.id)).toEqual(['persisted', 'direct']);
    });

    it('exposes per-option onSelect callbacks that dispatch onStorageChange so the overlay route fires the mutation', async () => {
        const { createTranscriptStorageActionChip } = await import('./createTranscriptStorageActionChip');

        const onStorageChange = vi.fn();
        const chip = createTranscriptStorageActionChip({
            transcriptStorage: 'persisted',
            onStorageChange,
        });

        const section = chip.collapsedOptionsPopover?.rootStep?.sections?.[0];
        if (!section || section.kind !== 'static') throw new Error('expected static section');

        const directOption = section.options.find((option) => option.id === 'direct');
        expect(typeof directOption?.onSelect).toBe('function');

        directOption!.onSelect!();
        expect(onStorageChange).toHaveBeenCalledWith('direct');
    });

    it('descriptor-level onSelect is a documented close-only no-op (does NOT mutate storage state)', async () => {
        const { createTranscriptStorageActionChip } = await import('./createTranscriptStorageActionChip');

        const onStorageChange = vi.fn();
        const chip = createTranscriptStorageActionChip({
            transcriptStorage: 'persisted',
            onStorageChange,
        });

        chip.collapsedOptionsPopover!.onSelect('direct');
        chip.collapsedOptionsPopover!.onSelect('persisted');
        expect(onStorageChange).not.toHaveBeenCalled();
    });
});
