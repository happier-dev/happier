export { captureSummaryFailed } from '@happier-dev/plugin-sdk/database';

/** What a request's step was: a database query, a call out of the app (span kind client), or work in the app. */
export function captureStepKind(row: Readonly<{ kind: 'request' | 'span' | 'query'; spanKind: number | null }>): 'query' | 'external' | 'app' {
  if (row.kind === 'query') return 'query';
  return row.spanKind === 3 ? 'external' : 'app';
}
