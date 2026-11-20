/** SQLite's portable legacy ceiling is the narrowest supported provider boundary. */
const PORTABLE_SQL_MAX_BOUND_PARAMETERS = 999;
const PORTABLE_SQL_MAX_COMPOUND_SELECTS = 500;

/**
 * Split an unbounded product collection only at the provider transport seam.
 * `bindingsPerValue` and `fixedBindings` describe the concrete Prisma query;
 * this never caps how many domain rows the caller may process.
 */
export function portableQueryChunks<T>(params: Readonly<{
    values: readonly T[];
    bindingsPerValue: number | ((value: T) => number);
    fixedBindings?: number;
    compoundSelectsPerValue?: number;
}>): readonly (readonly T[])[] {
    const { values, bindingsPerValue, fixedBindings = 0, compoundSelectsPerValue } = params;
    const availableBindings = PORTABLE_SQL_MAX_BOUND_PARAMETERS - fixedBindings;
    const compoundSize = compoundSelectsPerValue === undefined ? Infinity
        : Math.floor(PORTABLE_SQL_MAX_COMPOUND_SELECTS / compoundSelectsPerValue);
    const result: T[][] = [];
    if (typeof bindingsPerValue === 'number') {
        const size = Math.min(Math.floor(availableBindings / bindingsPerValue), compoundSize);
        if (size < 1) throw new Error("Query shape exceeds the portable SQL bind boundary");
        for (let index = 0; index < values.length; index += size) {
            result.push(values.slice(index, index + size));
        }
        return result;
    }

    let chunk: T[] = [];
    let usedBindings = 0;
    for (const value of values) {
        const bindings = bindingsPerValue(value);
        if (bindings > availableBindings || compoundSize < 1) throw new Error("Query shape exceeds the portable SQL bind boundary");
        if (usedBindings + bindings > availableBindings || chunk.length === compoundSize) {
            result.push(chunk);
            chunk = [];
            usedBindings = 0;
        }
        chunk.push(value);
        usedBindings += bindings;
    }
    if (chunk.length > 0) result.push(chunk);
    return result;
}
