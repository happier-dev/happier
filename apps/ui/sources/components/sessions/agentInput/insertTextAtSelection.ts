import type { TextInputState } from '@/components/ui/forms/MultiTextInput';

export function insertTextAtSelection(params: {
    text: string;
    selection: TextInputState['selection'];
    insertedText: string;
}): TextInputState {
    const textLength = params.text.length;
    const start = Math.max(0, Math.min(params.selection.start, textLength));
    const end = Math.max(start, Math.min(params.selection.end, textLength));
    const nextText = `${params.text.slice(0, start)}${params.insertedText}${params.text.slice(end)}`;
    const cursor = start + params.insertedText.length;

    return {
        text: nextText,
        selection: {
            start: cursor,
            end: cursor,
        },
    };
}
