import { evaluateInputPredicate } from '../../inputs/inputPredicates.js';
import type { PluginActionContributionV2 } from './v2.js';

/** Discovery treats input-dependent reads as potential effects. */
export function projectPluginActionReadOnlySideEffectClass(
    readOnly: PluginActionContributionV2['readOnly'],
): 'read' | 'external' | undefined {
    if (readOnly === undefined) return undefined;
    return readOnly === true ? 'read' : 'external';
}

/** Read authority is explicit and input-sensitive; `safe` also covers non-read effects. */
export function pluginActionDeclarationIsReadOnlyForInput(
    declaration: Pick<PluginActionContributionV2, 'readOnly'>,
    input: unknown,
): boolean {
    return declaration.readOnly === true || typeof declaration.readOnly === 'object'
        && declaration.readOnly !== null && evaluateInputPredicate(declaration.readOnly, input);
}
