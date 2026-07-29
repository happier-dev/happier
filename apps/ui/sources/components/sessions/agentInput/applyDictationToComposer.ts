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
    const nextState = insertTextAtSelection({
        text: params.state.text,
        selection: params.state.selection,
        insertedText: params.text,
    });
    params.input?.setTextAndSelection(nextState.text, nextState.selection);
    params.input?.focus();
    return nextState;
}
