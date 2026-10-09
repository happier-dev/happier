import type {
  MemoryFactV1,
  MemoryTopicV1,
} from '@happier-dev/protocol/prompts/library/memoryDocV1';
import type { PromptDocArtifactRefV1 } from '@happier-dev/protocol/prompts/library/promptArtifactRefsV1';
import {
  MemoryDocFailureV1,
  readMemoryDocInLibrary,
} from '@happier-dev/protocol/prompts/library/promptLibraryActionOperations';
import * as React from 'react';

import type {
  MemoryDocumentRevision,
  MemoryDocumentTarget,
} from '@/sync/ops/promptLibrary/memoryDocuments';
import { withUiPromptLibraryArtifactReader } from '@/sync/ops/promptLibrary/promptLibraryArtifactStore';
import { useArtifact } from '@/sync/domains/state/storage';

export type MemoryDocumentStatus =
  | 'none'
  | 'loading'
  | 'refreshing'
  | 'ready'
  | 'not_found'
  | 'invalid'
  | 'locked'
  | 'unavailable';

/** What one read of a memory document shows: its always-loaded index, or one named topic. */
export type MemoryDocumentView = Readonly<{
  artifactId: string;
  title: string;
  revision: MemoryDocumentRevision;
  /** The facts of this page: the index's key facts, or the open topic's facts. */
  facts: readonly MemoryFactV1[];
  /** The index's topic list (title + one-line summary); empty on a topic page. */
  topics: readonly Readonly<{ title: string; summary: string }>[];
  topic: Pick<MemoryTopicV1, 'title' | 'summary'> | null;
}>;

export type MemoryDocumentSource = Readonly<{
  status: MemoryDocumentStatus;
  view: MemoryDocumentView | null;
  /** The shown view is the last one read; the current one could not be read. */
  stale: boolean;
  /** The reviewed write target for exactly the version on screen. */
  target: MemoryDocumentTarget | null;
  refresh: () => Promise<void>;
}>;

type Loaded = Readonly<{
  key: string;
  status: MemoryDocumentStatus;
  view: MemoryDocumentView | null;
  stale: boolean;
}>;

const NO_REFRESH = async () => {};
const LOCKED_CODES = new Set([
  'content_unavailable',
  'artifact_content_unavailable',
  'artifact_encryption_material_unavailable',
  'artifact_account_mode_mismatch',
  'account_encryption_mode_unavailable',
]);

/**
 * Display read of one `memory_doc.v1` document through the canonical qualified reader
 * (`readMemoryDocInLibrary`): the index first, or one topic when `topic` is given (D48: topics load
 * on demand). It keeps the last version while a newer one loads, re-reads when the Home's Artifact
 * row moves, and never writes; edits go through the `memory.*` Actions against `target`.
 */
export function useMemoryDocument(
  params: Readonly<{
    ref: PromptDocArtifactRefV1 | null;
    serverId: string | null;
    topic?: string;
    /** A closed or switched-off surface reads nothing. */
    enabled?: boolean;
  }>,
): MemoryDocumentSource {
  const { ref, serverId, topic } = params;
  const enabled = params.enabled !== false && ref !== null && serverId !== null;
  const artifactId = ref?.artifactId ?? '';
  const homeId = ref?.serverId ?? serverId ?? '';
  // The active Home's Artifact row is the change signal; another Home's document re-reads on demand.
  const row = useArtifact(artifactId);
  const key = JSON.stringify([
    homeId,
    artifactId,
    topic ?? null,
    row?.headerVersion ?? null,
    row?.bodyVersion ?? null,
  ]);
  const [loaded, setLoaded] = React.useState<Loaded | null>(null);
  const pending = React.useRef<Readonly<{
    key: string;
    controller: AbortController;
    promise: Promise<void>;
  }> | null>(null);

  const refresh = React.useCallback((): Promise<void> => {
    if (!enabled || !artifactId) return Promise.resolve();
    pending.current?.controller.abort();
    const controller = new AbortController();
    setLoaded((previous) => ({
      key,
      status:
        previous?.view?.artifactId === artifactId ? 'refreshing' : 'loading',
      view:
        previous?.view?.artifactId === artifactId &&
        (previous.view.topic?.title ?? null) === (topic ?? null)
          ? previous.view
          : null,
      stale: false,
    }));
    const promise = (async () => {
      try {
        const read = await withUiPromptLibraryArtifactReader(
          (reader) =>
            readMemoryDocInLibrary({
              artifactId,
              store: {
                read: () =>
                  reader.readArtifact({
                    kind: 'doc',
                    artifactId,
                    serverId: homeId,
                  }),
              },
              ...(topic === undefined ? {} : { topic }),
              signal: controller.signal,
            }),
          { serverId: homeId, signal: controller.signal },
        );
        if (controller.signal.aborted) return;
        const view: MemoryDocumentView =
          'topic' in read
            ? {
                artifactId,
                title: read.header.title,
                revision: read.revision,
                facts: read.topic.facts,
                topics: [],
                topic: { title: read.topic.title, summary: read.topic.summary },
              }
            : {
                artifactId,
                title: read.header.title,
                revision: read.revision,
                facts: read.body.index,
                topics: read.body.topics,
                topic: null,
              };
        setLoaded({ key, status: 'ready', view, stale: false });
      } catch (error) {
        if (controller.signal.aborted) return;
        const code: unknown =
          error instanceof MemoryDocFailureV1
            ? error.code
            : error && typeof error === 'object'
              ? Reflect.get(error, 'code')
              : undefined;
        if (
          code === 'memory_doc_not_found' ||
          code === 'memory_topic_not_found'
        ) {
          setLoaded({ key, status: 'not_found', view: null, stale: false });
        } else if (code === 'memory_doc_invalid') {
          setLoaded({ key, status: 'invalid', view: null, stale: false });
        } else if (typeof code === 'string' && LOCKED_CODES.has(code)) {
          setLoaded({ key, status: 'locked', view: null, stale: false });
        } else {
          // Offline keeps the last version, marked as such.
          setLoaded((previous) => ({
            key,
            status: 'unavailable',
            view: previous?.view ?? null,
            stale: Boolean(previous?.view),
          }));
        }
      } finally {
        if (pending.current?.controller === controller) pending.current = null;
      }
    })();
    pending.current = { key, controller, promise };
    return promise;
  }, [artifactId, enabled, homeId, key, topic]);

  React.useEffect(() => {
    if (enabled) void refresh();
    return () => {
      pending.current?.controller.abort();
      pending.current = null;
    };
  }, [enabled, refresh]);

  return React.useMemo((): MemoryDocumentSource => {
    if (!enabled || !ref || !serverId)
      return {
        status: 'none',
        view: null,
        stale: false,
        target: null,
        refresh: NO_REFRESH,
      };
    const current = loaded ?? {
      key,
      status: 'loading' as const,
      view: null,
      stale: false,
    };
    const view = current.view;
    return {
      status: current.status,
      view,
      stale: current.stale,
      target:
        view && current.status === 'ready'
          ? {
              ref,
              serverId: homeId,
              expectedRevision: view.revision,
              ...(topic === undefined ? {} : { topic }),
            }
          : null,
      refresh,
    };
  }, [enabled, homeId, key, loaded, ref, refresh, serverId, topic]);
}
