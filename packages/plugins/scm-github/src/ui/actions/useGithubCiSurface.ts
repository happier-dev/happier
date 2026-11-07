import type { ForgeCiReadsV1 } from '@happier-dev/forge-ci/runtime';
import { useForgeCiQueryV1, useForgeCiQueryStatusV1, useForgeCiQueryValueV1 } from '@happier-dev/forge-ci/ui';
import type { GithubCiSurfaceContextV1 } from './ciContext.js';

/** a6/a7 consume the same admitted query owner as Actions and its count Resource. */
export function useGithubCiSurfaceV1(reads: ForgeCiReadsV1 | null, context: GithubCiSurfaceContextV1) {
  const lease = useForgeCiQueryV1(reads, 'listRuns', context.kind === 'ready' ? context.input : null);
  const value = useForgeCiQueryValueV1(lease);
  const status = useForgeCiQueryStatusV1(lease);
  return { context, lease, value, ...status };
}
