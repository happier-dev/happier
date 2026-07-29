import * as React from 'react';

export type PromptEditorDraftField<T> = Readonly<{
    value: T;
    setValue: (next: T) => void;
    setPristineValue: (next: T) => void;
    applyExternalValue: (next: T, options?: Readonly<{ preserveDirty?: boolean }>) => void;
    resetDirty: () => void;
    isDirty: () => boolean;
}>;

/**
 * Owns one locally-editable prompt-settings field whose seed can refresh from
 * synced/persisted data while the screen is open.
 *
 * Prompt editor screens receive periodic settings/artifact refreshes. Those
 * refreshes must update pristine fields, but must never overwrite fields the
 * user has edited locally; overwriting the markdown/code editor value forces the
 * editor surface to replace its document and can move the caret back to the top.
 */
export function usePromptEditorDraftField<T>(initialValue: T): PromptEditorDraftField<T> {
    const [value, setValueState] = React.useState<T>(initialValue);
    const dirtyRef = React.useRef(false);

    const setValue = React.useCallback((next: T) => {
        dirtyRef.current = true;
        setValueState(next);
    }, []);

    const setPristineValue = React.useCallback((next: T) => {
        dirtyRef.current = false;
        setValueState(next);
    }, []);

    const applyExternalValue = React.useCallback((next: T, options?: Readonly<{ preserveDirty?: boolean }>) => {
        if (options?.preserveDirty === true && dirtyRef.current) {
            return;
        }
        dirtyRef.current = false;
        setValueState(next);
    }, []);

    const resetDirty = React.useCallback(() => {
        dirtyRef.current = false;
    }, []);

    const isDirty = React.useCallback(() => dirtyRef.current, []);

    return React.useMemo(
        () => ({
            value,
            setValue,
            setPristineValue,
            applyExternalValue,
            resetDirty,
            isDirty,
        }),
        [applyExternalValue, isDirty, resetDirty, setPristineValue, setValue, value],
    );
}
