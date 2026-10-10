export function areAccountSettingsJsonValuesEqual(left: unknown, right: unknown): boolean {
    if (Object.is(left, right)) return true;
    if (left == null || right == null) return left === right;
    if (Array.isArray(left) || Array.isArray(right)) {
        if (!Array.isArray(left) || !Array.isArray(right)) return false;
        if (left.length !== right.length) return false;
        for (let index = 0; index < left.length; index += 1) {
            if (!areAccountSettingsJsonValuesEqual(left[index], right[index])) return false;
        }
        return true;
    }
    if (typeof left !== 'object' || typeof right !== 'object') return false;

    const leftRecord = left as Record<string, unknown>;
    const rightRecord = right as Record<string, unknown>;
    const leftKeys = Object.keys(leftRecord);
    const rightKeys = Object.keys(rightRecord);
    if (leftKeys.length !== rightKeys.length) return false;
    for (const key of leftKeys) {
        if (!Object.prototype.hasOwnProperty.call(rightRecord, key)) return false;
        if (!areAccountSettingsJsonValuesEqual(leftRecord[key], rightRecord[key])) return false;
    }
    return true;
}
