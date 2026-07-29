import { describe, expect, it, vi } from 'vitest';
import { ProviderConnectionIdSchema } from '@happier-dev/protocol';

import { applyProviderModelBulkAction } from './applyProviderModelBulkAction';

const changes = [{
    ref: {
        scope: 'allAgents' as const,
        providerConnectionId: ProviderConnectionIdSchema.parse('pc_a'),
        modelId: 'model-a',
    },
    hidden: true,
}];

describe('applyProviderModelBulkAction', () => {
    it('does not mutate when a destructive bulk action is cancelled', async () => {
        const apply = vi.fn(async () => {});
        await expect(applyProviderModelBulkAction({
            action: 'hideAll', changes, confirm: async () => false, apply,
        })).resolves.toBe('cancelled');
        expect(apply).not.toHaveBeenCalled();
    });

    it('applies the exact typed change set once after confirmation', async () => {
        const apply = vi.fn(async () => {});
        await expect(applyProviderModelBulkAction({
            action: 'showOnly', changes, confirm: async () => true, apply,
        })).resolves.toBe('applied');
        expect(apply).toHaveBeenCalledTimes(1);
        expect(apply).toHaveBeenCalledWith(changes);
    });

    it('shows all without an unnecessary confirmation', async () => {
        const confirm = vi.fn(async () => true);
        const apply = vi.fn(async () => {});
        await expect(applyProviderModelBulkAction({
            action: 'showAll', changes: [{ ...changes[0], hidden: false }], confirm, apply,
        })).resolves.toBe('applied');
        expect(confirm).not.toHaveBeenCalled();
    });
});
