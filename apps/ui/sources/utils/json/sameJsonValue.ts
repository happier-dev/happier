/** Compares admitted JSON without recursion or depending on object insertion order. */
export function sameJsonValue(left: unknown, right: unknown): boolean {
    if (left === right) return true;
    // Reuse one frame per nesting level rather than queuing every value in wide objects.
    const frames: Array<{
        left: object; right: object; keys: string[] | undefined; index: number; length: number;
    }> = [];
    let depth = 0;
    let currentLeft = left;
    let currentRight = right;
    for (;;) {
        if (
            currentLeft === null
            || currentRight === null
            || typeof currentLeft !== 'object'
            || typeof currentRight !== 'object'
        ) {
            return false;
        }
        const leftIsArray = Array.isArray(currentLeft);
        if (leftIsArray !== Array.isArray(currentRight)) return false;
        let keys: string[] | undefined;
        let length: number;
        if (leftIsArray) {
            const leftItems = currentLeft as readonly unknown[];
            const rightItems = currentRight as readonly unknown[];
            if (leftItems.length !== rightItems.length) return false;
            length = leftItems.length;
        } else {
            keys = Object.keys(currentLeft);
            length = keys.length;
            if (length !== Object.keys(currentRight).length) return false;
        }
        const frame = frames[depth];
        if (frame) {
            frame.left = currentLeft; frame.right = currentRight; frame.keys = keys; frame.index = 0; frame.length = length;
        } else frames.push({ left: currentLeft, right: currentRight, keys, index: 0, length });
        depth++;
        let different = false;
        while (depth > 0) {
            const active = frames[depth - 1]!;
            if (active.index === active.length) { depth--; continue; }
            const index = active.index++;
            if (active.keys) {
                const key = active.keys[index]!;
                if (!Object.prototype.hasOwnProperty.call(active.right, key)) return false;
                currentLeft = (active.left as Readonly<Record<string, unknown>>)[key];
                currentRight = (active.right as Readonly<Record<string, unknown>>)[key];
            } else {
                currentLeft = (active.left as readonly unknown[])[index];
                currentRight = (active.right as readonly unknown[])[index];
            }
            if (currentLeft !== currentRight) { different = true; break; }
        }
        if (!different) return true;
    }
}
