/**
 * The two texts a text comparison hands Pierre. When neither side ends with a newline (an edit's
 * old → new snippet, a fragment rather than a file), both read as ending with one, so Pierre draws no
 * "No newline at end of file" marker that would say nothing about the change. When only one side lost
 * its final newline that is a real difference, and the marker stays.
 */
export function pierreTextDiffContents(oldText: string, newText: string): Readonly<{ oldContents: string; newContents: string }> {
    if (oldText.endsWith('\n') || newText.endsWith('\n')) return { oldContents: oldText, newContents: newText };
    return {
        oldContents: oldText.length > 0 ? `${oldText}\n` : oldText,
        newContents: newText.length > 0 ? `${newText}\n` : newText,
    };
}
