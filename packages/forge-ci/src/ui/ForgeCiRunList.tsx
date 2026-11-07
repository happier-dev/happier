import type { ReactNode } from 'react';
import type { ForgeCiRunsListInputV1 } from '@happier-dev/triage-protocol/ci/v1';
import type { ForgeCiReadValueV1, ForgeCiReadsV1 } from '../runtime/reads.js';
import { useForgeCiQueryValueV1 } from './useForgeCiReads.js';
import { useForgeCiPagedQueryV1 } from './useForgeCiPagedQuery.js';

export type ForgeCiRunListProps = Readonly<{
  reads: ForgeCiReadsV1 | null; input: ForgeCiRunsListInputV1;
  children(model: Readonly<{ query: ReturnType<typeof useForgeCiPagedQueryV1<'listRuns'>>; page: ForgeCiReadValueV1<'listRuns'> | null }>): ReactNode;
}>;

export function ForgeCiRunList({ reads, input, children }: ForgeCiRunListProps): ReactNode {
  const query = useForgeCiPagedQueryV1(reads, 'listRuns', input);
  const page = useForgeCiQueryValueV1(query);
  return children({ query, page });
}
