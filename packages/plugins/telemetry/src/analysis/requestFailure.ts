/** The capture list and finding detail use the same request failure definition. */
export function captureSummaryFailed(
    summary: Readonly<{ httpStatusCode?: number | null; outcome?: string | null }>,
): boolean {
    return (summary.httpStatusCode ?? 0) >= 500 || summary.outcome === 'error';
}
