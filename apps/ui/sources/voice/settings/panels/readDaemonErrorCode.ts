/**
 * Read an error's `code` and collapse it to a known union member.
 *
 * Daemon RPC failures surface a string `code`. Panels render an explicit state
 * per known code, so an unrecognized code (or a missing one) must never leak
 * through as a non-union string — that would read as a healthy/"ready" status.
 * This shared whitelist-and-collapse keeps both daemon voice panels consistent
 * (modelCatalog + single-pack inference) instead of each casting `code`
 * unchecked.
 *
 * @param error    the thrown value (may be anything)
 * @param known    the set of codes this panel renders explicitly
 * @param fallback the code to collapse unknown/missing codes onto
 */
export function readDaemonErrorCode<TCode extends string>(
    error: unknown,
    known: ReadonlySet<TCode>,
    fallback: TCode,
): TCode {
    const code = error && typeof error === 'object' && 'code' in error
        ? String((error as { code?: unknown }).code ?? '')
        : '';
    return code && (known as ReadonlySet<string>).has(code) ? (code as TCode) : fallback;
}
