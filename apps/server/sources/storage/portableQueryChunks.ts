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
    bindingsPerValue: number;
    fixedBindings?: number;
    compoundSelectsPerValue?: number;
}>): readonly (readonly T[])[] {
    const bindSize = Math.floor(
        (PORTABLE_SQL_MAX_BOUND_PARAMETERS - (params.fixedBindings ?? 0))
        / params.bindingsPerValue,
    );
    const size = params.compoundSelectsPerValue === undefined ? bindSize : Math.min(bindSize,
        Math.floor(PORTABLE_SQL_MAX_COMPOUND_SELECTS / params.compoundSelectsPerValue));
    if (size < 1) throw new Error("Query shape exceeds the portable SQL bind boundary");
    const result: T[][] = [];
    for (let index = 0; index < params.values.length; index += size) {
        result.push(params.values.slice(index, index + size));
    }
    return result;
}
