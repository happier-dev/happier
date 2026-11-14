import * as React from 'react';
import type {
  DeploymentActivityItemV1,
  DeploymentActivityPageV1,
} from '@happier-dev/deployments';

import { readDeploymentActivityPage } from '@/components/projects/deployments/deploymentActivityRead';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';

/** One screen of history; the page asks for the next one only when the person does. */
const ACTIVITY_PAGE_SIZE = 30;
const NO_ITEMS: readonly DeploymentActivityItemV1[] = Object.freeze([]);

export type FleetActivityState = Readonly<{
  status: 'loading' | 'ready' | 'failed';
  items: readonly DeploymentActivityItemV1[];
  nextCursor: DeploymentActivityPageV1['nextCursor'];
  coverage: DeploymentActivityPageV1['coverage'];
  unavailableSources: DeploymentActivityPageV1['unavailableSources'];
  failureCode: string | null;
  loadingMore: boolean;
}>;

const INITIAL: FleetActivityState = {
  status: 'loading',
  items: NO_ITEMS,
  nextCursor: null,
  coverage: 'complete',
  unavailableSources: [],
  failureCode: null,
  loadingMore: false,
};

const codeOf = (error: unknown) =>
  error &&
  typeof error === 'object' &&
  'code' in error &&
  typeof error.code === 'string'
    ? error.code
    : 'activity_unavailable';

/**
 * Machines → Activity's read: deploy receipts and Machine Action operations through the one activity read owner
 * (`readDeploymentActivityPage`), read when the page is presented, kept while it is not, and paged on request.
 */
export function useFleetActivityPage(
  lifetime: ServerAccountScopeLifetime | null,
  machineIds: readonly string[],
  presented: boolean,
) {
  const [state, setState] = React.useState<FleetActivityState>(INITIAL);
  const [generation, setGeneration] = React.useState(0);
  const pageAbort = React.useRef<AbortController | null>(null);
  const machineKey = machineIds.join('\n');

  React.useEffect(() => {
    if (!presented || !lifetime) return;
    const controller = new AbortController();
    pageAbort.current?.abort();
    readDeploymentActivityPage(
      lifetime,
      { limit: ACTIVITY_PAGE_SIZE },
      machineKey ? machineKey.split('\n') : [],
      { signal: controller.signal },
    )
      .then((page) => {
        if (controller.signal.aborted) return;
        setState({
          status: 'ready',
          items: page.items,
          nextCursor: page.nextCursor,
          coverage: page.coverage,
          unavailableSources: page.unavailableSources,
          failureCode: null,
          loadingMore: false,
        });
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        // A failed read keeps what was shown; only a first read has nothing to keep.
        setState((previous) => ({
          ...previous,
          status: previous.items.length > 0 ? 'ready' : 'failed',
          failureCode: codeOf(error),
          loadingMore: false,
        }));
      });
    return () => controller.abort();
  }, [generation, lifetime, machineKey, presented]);

  const loadMore = React.useCallback(() => {
    if (!lifetime || !state.nextCursor || state.loadingMore) return;
    const controller = new AbortController();
    pageAbort.current = controller;
    const cursor = state.nextCursor;
    setState((previous) => ({ ...previous, loadingMore: true }));
    readDeploymentActivityPage(
      lifetime,
      { limit: ACTIVITY_PAGE_SIZE, cursor },
      machineKey ? machineKey.split('\n') : [],
      { signal: controller.signal },
    )
      .then((page) => {
        if (controller.signal.aborted) return;
        setState((previous) => ({
          ...previous,
          items: [...previous.items, ...page.items],
          nextCursor: page.nextCursor,
          coverage: previous.coverage === 'partial' ? 'partial' : page.coverage,
          unavailableSources: [
            ...previous.unavailableSources,
            ...page.unavailableSources,
          ],
          loadingMore: false,
        }));
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setState((previous) => ({
          ...previous,
          failureCode: codeOf(error),
          loadingMore: false,
        }));
      });
  }, [lifetime, machineKey, state.loadingMore, state.nextCursor]);

  React.useEffect(() => () => pageAbort.current?.abort(), []);
  const retry = React.useCallback(
    () => setGeneration((value) => value + 1),
    [],
  );
  return { state, loadMore, retry };
}
