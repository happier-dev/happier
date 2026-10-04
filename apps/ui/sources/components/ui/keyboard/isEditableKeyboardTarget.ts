/**
 * Whether a key event's target is somewhere the person is typing or composing (a field, an editable region,
 * or a surface that owns its own keys). Single-letter shortcuts never fire there.
 */
export function isEditableKeyboardTarget(target: unknown): boolean {
    if (!target || typeof target !== 'object') return false;
    const element = target as {
        tagName?: unknown;
        isContentEditable?: boolean;
        closest?: (selector: string) => unknown;
    };
    const tagName = String(element.tagName ?? '').toLowerCase();
    return tagName === 'input'
        || tagName === 'textarea'
        || tagName === 'select'
        || element.isContentEditable === true
        || element.closest?.('[contenteditable="true"], [data-keyboard-shortcuts-owned="true"]') != null;
}
