import type { ActiveWord } from '@/components/autocomplete/findActiveWord';
import { containsLikelyNonWhitespace } from '@/components/ui/forms/largeTextInputPolicy';

export type LiveInputTextStatus = Readonly<{
    length: number;
    hasText: boolean;
}>;

export function resolveLiveInputTextStatus(text: string): LiveInputTextStatus {
    return {
        length: text.length,
        hasText: containsLikelyNonWhitespace(text),
    };
}

export function areLiveInputTextStatusesEqual(left: LiveInputTextStatus, right: LiveInputTextStatus): boolean {
    return left.length === right.length && left.hasText === right.hasText;
}

export function areActiveWordsEqual(left: ActiveWord | undefined, right: ActiveWord | undefined): boolean {
    if (left === right) return true;
    if (!left || !right) return false;
    return left.word === right.word
        && left.activeWord === right.activeWord
        && left.offset === right.offset
        && left.length === right.length
        && left.activeLength === right.activeLength
        && left.endOffset === right.endOffset;
}
