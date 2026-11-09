import type {
    MultiTextInputHandle,
    TextInputState,
} from '@/components/ui/forms/MultiTextInput';

import { insertTextAtSelection } from './insertTextAtSelection';

export function applyDictationToComposer(params: Readonly<{
    input: Pick<MultiTextInputHandle, 'focus' | 'setTextAndSelection'> | null;
    state: TextInputState;
    text: string;
}>): TextInputState {
    const prefix = params.state.text.slice(0, Math.max(0, params.state.selection.start));
    const separator = params.text.length > 0 && /\S$/u.test(prefix) && !/^\s/u.test(params.text) ? ' ' : '';
    const nextState = insertTextAtSelection({
        text: params.state.text,
        selection: params.state.selection,
        insertedText: `${separator}${params.text}`,
    });
    params.input?.setTextAndSelection(nextState.text, nextState.selection);
    params.input?.focus();
    return nextState;
}
