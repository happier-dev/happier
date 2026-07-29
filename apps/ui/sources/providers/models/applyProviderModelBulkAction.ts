import type { ProviderModelVisibilityChange } from './ProviderModelManager';

export async function applyProviderModelBulkAction(input: Readonly<{
    action: 'showAll' | 'hideAll' | 'showOnly';
    changes: readonly ProviderModelVisibilityChange[];
    confirm: () => Promise<boolean>;
    apply: (changes: readonly ProviderModelVisibilityChange[]) => Promise<unknown>;
}>): Promise<'applied' | 'cancelled' | 'empty'> {
    if (input.changes.length === 0) return 'empty';
    if (input.action !== 'showAll' && !(await input.confirm())) return 'cancelled';
    await input.apply(input.changes);
    return 'applied';
}
