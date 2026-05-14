/**
 * Row activation logic shared by every render path of the SelectionList
 * orchestrator (plain rows, virtualized rows, keyboard-driven Enter).
 *
 * R14 extracted this from the inline press handler in `SelectionList.tsx` so
 * the activation contract is single-source-of-truth and can be unit tested
 * without booting the React tree.
 *
 * Activation order:
 *   1. Disabled options short-circuit silently (UI may still render the row
 *      but presses must do nothing — the keyboard hook also filters disabled
 *      ids out of `flatVisibleOptionIds`).
 *   2. `openStep` wins over `onSelect`; the type-level discriminated union
 *      already enforces mutual exclusion, but the runtime check matches the
 *      type contract for safety.
 *   3. Otherwise: invoke the option-level `onSelect` first, then bubble to
 *      the orchestrator's top-level `onSelect`. The order is observable —
 *      consumers rely on the option-level callback to mutate state before the
 *      orchestrator's `onSelect` reads it.
 */

import type { SelectionListOption, SelectionListStep } from './_types';

export type ActivateSelectionListRowArgs = Readonly<{
    option: SelectionListOption;
    onSelect: (id: string, option: SelectionListOption) => void;
    onPushStep: (step: SelectionListStep) => void;
}>;

export function activateSelectionListRow(args: ActivateSelectionListRowArgs): void {
    const { option, onSelect, onPushStep } = args;
    if (option.disabled === true) return;
    if (option.openStep !== undefined) {
        onPushStep(option.openStep);
        return;
    }
    option.onSelect?.();
    onSelect(option.id, option);
}
