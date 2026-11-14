import * as React from 'react';
import type { PluginUiTargetedContributionOperationV1 } from '@happier-dev/plugin-sdk/ui';
import { usePluginHostApi } from '@happier-dev/plugin-ui';
import {
  TriageTaskCreationPlacesResultV1Schema,
  type TriageConfiguredSourceInstanceV1,
  type TriageScanContinuationV1,
  type TriageSourceFailureV1,
  type TriageTaskCreationPlaceV1,
} from '@happier-dev/triage-protocol/v1';

/** One read of a source's creation places: its root directory, or one place's children. */
export type TriageTaskCreationPlacesPageV1 = Readonly<{
  status: 'loading' | 'ready' | 'failed';
  /** Places already read, kept while the next page loads. */
  places: readonly TriageTaskCreationPlaceV1[];
  /** The source's own continuation; present only while its directory has more. */
  nextCursor?: TriageScanContinuationV1;
  /** The source's own failure, when it said one. */
  failure?: TriageSourceFailureV1;
}>;

export type TriageTaskCreationPlacesReadV1 = Readonly<{
  /** Pages by `triageTaskCreationPlacesKeyV1`. A missing key has not been asked for. */
  pages: ReadonlyMap<string, TriageTaskCreationPlacesPageV1>;
  /**
   * Read a page through the source's own `listCreationPlaces` operation. A page already read or loading is not read
   * again; `more` continues it from its cursor, and a failed page reads again.
   */
  read(
    input: Readonly<{
      instance: TriageConfiguredSourceInstanceV1;
      operation: PluginUiTargetedContributionOperationV1;
      scopeId?: string;
      query?: string;
      more?: boolean;
    }>,
  ): void;
}>;

export function triageTaskCreationPlacesKeyV1(
  sourceInstanceId: string,
  scopeId?: string,
  query?: string,
): string {
  return JSON.stringify([sourceInstanceId, scopeId ?? null, query?.trim() || null]);
}

/**
 * The places a new task can go, read only while the person is choosing one. The source decides every place, its
 * operands and why one can't be used; this holds what was read for the life of the draft and nothing else.
 */
export function useTriageTaskCreationPlaces(): TriageTaskCreationPlacesReadV1 {
  const host = usePluginHostApi();
  const [pages, setPages] = React.useState<
    ReadonlyMap<string, TriageTaskCreationPlacesPageV1>
  >(() => new Map());
  const pagesRef = React.useRef(pages);
  pagesRef.current = pages;
  const controllers = React.useRef(new Set<AbortController>());
  React.useEffect(
    () => () => {
      for (const controller of controllers.current) controller.abort();
    },
    [],
  );
  const read = React.useCallback<TriageTaskCreationPlacesReadV1['read']>(
    (input) => {
      const key = triageTaskCreationPlacesKeyV1(
        input.instance.instance.sourceInstanceId,
        input.scopeId,
        input.query,
      );
      const current = pagesRef.current.get(key);
      if (current?.status === 'loading') return;
      if (
        current?.status === 'ready' &&
        (input.more !== true || current.nextCursor === undefined)
      )
        return;
      const cursor = input.more === true ? current?.nextCursor : undefined;
      const kept = cursor === undefined ? [] : (current?.places ?? []);
      const update = (page: TriageTaskCreationPlacesPageV1) => {
        pagesRef.current = new Map(pagesRef.current).set(key, page);
        setPages(pagesRef.current);
      };
      update({ status: 'loading', places: kept });
      const controller = new AbortController();
      controllers.current.add(controller);
      void host
        .executeAction(
          input.operation.action,
          {
            v: 1,
            instance: input.instance,
            ...(input.scopeId === undefined ? {} : { scopeId: input.scopeId }),
            ...(input.query?.trim() ? { query: input.query.trim() } : {}),
            ...(cursor === undefined ? {} : { cursor }),
          },
          { signal: controller.signal },
        )
        .then(
          (raw) => {
            const parsed =
              TriageTaskCreationPlacesResultV1Schema.safeParse(raw);
            if (!parsed.success)
              return update({ status: 'failed', places: kept });
            if (parsed.data.kind === 'failed')
              return update({
                status: 'failed',
                places: kept,
                failure: parsed.data.failure,
              });
            update({
              status: 'ready',
              places: [...kept, ...parsed.data.places],
              ...(parsed.data.nextCursor === undefined
                ? {}
                : { nextCursor: parsed.data.nextCursor }),
              ...(parsed.data.failure === undefined
                ? {}
                : { failure: parsed.data.failure }),
            });
          },
          () => {
            if (!controller.signal.aborted)
              update({ status: 'failed', places: kept });
          },
        )
        .finally(() => {
          controllers.current.delete(controller);
        });
    },
    [host],
  );
  return React.useMemo(() => ({ pages, read }), [pages, read]);
}
