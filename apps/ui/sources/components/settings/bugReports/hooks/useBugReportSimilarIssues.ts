import React from 'react';

import type { BugReportSimilarIssue } from '../bugReportServiceClient';
import { searchBugReportSimilarIssues } from '../bugReportServiceClient';
import { fireAndForget } from '@/utils/system/fireAndForget';

function buildQueryText(input: {
  title: string;
  summary: string;
  currentBehavior: string;
  expectedBehavior: string;
}): string {
  return [
    input.title.trim(),
    input.summary.trim(),
    input.currentBehavior.trim(),
    input.expectedBehavior.trim(),
  ]
    .filter(Boolean)
    .join('\n')
    .slice(0, 1200);
}

export function useBugReportSimilarIssues(input: {
  enabled: boolean;
  providerUrl: string | null;
  owner: string;
  repo: string;
  title: string;
  summary: string;
  currentBehavior: string;
  expectedBehavior: string;
  disabled: boolean;
}): {
  loading: boolean;
  issues: BugReportSimilarIssue[];
  error: string | null;
} {
  const [loading, setLoading] = React.useState(false);
  const [issues, setIssues] = React.useState<BugReportSimilarIssue[]>([]);
  const [error, setError] = React.useState<string | null>(null);

  const queryText = React.useMemo(
    () =>
      buildQueryText({
        title: input.title,
        summary: input.summary,
        currentBehavior: input.currentBehavior,
        expectedBehavior: input.expectedBehavior,
      }),
    [input.currentBehavior, input.expectedBehavior, input.summary, input.title],
  );

  React.useEffect(() => {
    if (!input.enabled || input.disabled || !input.providerUrl) {
      setIssues([]);
      setLoading(false);
      setError(null);
      return;
    }
    if (queryText.trim().length < 20) {
      setIssues([]);
      setLoading(false);
      setError(null);
      return;
    }

    let canceled = false;
    const handle = setTimeout(() => {
      fireAndForget((async () => {
        try {
          setLoading(true);
          setError(null);
          const result = await searchBugReportSimilarIssues({
            providerUrl: input.providerUrl!,
            owner: input.owner,
            repo: input.repo,
            query: queryText,
            limit: 8,
          });
          if (canceled) return;
          setIssues(Array.isArray(result.issues) ? result.issues : []);
        } catch (err) {
          if (canceled) return;
          setIssues([]);
          setError(err instanceof Error ? err.message : 'Could not search similar issues.');
        } finally {
          if (canceled) return;
          setLoading(false);
        }
      })(), { tag: 'useBugReportSimilarIssues.search' });
    }, 600);

    return () => {
      canceled = true;
      clearTimeout(handle);
    };
  }, [
    input.disabled,
    input.enabled,
    input.owner,
    input.providerUrl,
    input.repo,
    queryText,
  ]);

  return { loading, issues, error };
}
