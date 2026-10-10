import type {
  MemoryFactV1,
  MemoryTopicV1,
} from '@happier-dev/protocol/prompts/library/memoryDocV1';
import type { PromptDocArtifactRefV1 } from '@happier-dev/protocol/prompts/library/promptArtifactRefsV1';
import type { ArtifactCallerAccessV1 } from '@happier-dev/protocol/artifacts/artifactAccessV1';
import { MemoryDocReadResultV1Schema } from '@happier-dev/protocol/prompts/library/memoryActionsV1';
import * as React from 'react';

import type {
  MemoryDocumentRevision,
  MemoryDocumentTarget,
} from '@/sync/ops/promptLibrary/memoryDocuments';
import { withUiPromptLibraryArtifactReader } from '@/sync/ops/promptLibrary/promptLibraryArtifactStore';
import type { LazyActionAccountContext } from '@/sync/ops/actions/actionAccountContext';
import { useArtifact, useActiveServerAccountScope } from '@/sync/domains/state/storage';
import { captureActiveServerAccountScopeCurrentness, captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { subscribeHomeCredentialChange } from '@/sync/runtime/orchestration/homeAccountChange';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';

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
  /** The admitted readable address survives refresh without retaining write authority. */
  ref: PromptDocArtifactRefV1;
  access: ArtifactCallerAccessV1 | null;
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
  /** Returns only the freshly admitted write target, never a retained display snapshot. */
  refresh: () => Promise<MemoryDocumentTarget | null>;
}>;

type Loaded = Readonly<{
  key: string;
  identity: string;
  accountId: string | null;
  isCurrent: () => boolean;
  status: MemoryDocumentStatus;
  view: MemoryDocumentView | null;
  stale: boolean;
}>;

const NO_REFRESH = async () => null;

function reviewedWriteTarget(view: MemoryDocumentView, serverId: string, topic?: string): MemoryDocumentTarget | null {
  if (view.access === null || view.access === 'view') return null;
  return { ref: view.ref, serverId, expectedRevision: view.revision,
    ...(topic === undefined ? {} : { topic }) };
}
const LOCKED_CODES = new Set([
  'content_unavailable',
  'artifact_content_unavailable',
  'artifact_encryption_material_unavailable',
  'artifact_account_mode_mismatch',
  'account_encryption_mode_unavailable',
]);

/**
 * Display read of one `memory_doc.v1` document through the canonical `memory.read` Action:
 * the index first, or one topic when `topic` is given (D48: topics load
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
  const accountScope = useActiveServerAccountScope();
  const activeLifetime = captureActiveServerAccountScopeLifetime();
  const identity = JSON.stringify([homeId, accountScope?.serverId, accountScope?.accountId, artifactId, topic ?? null]);
  // The active Home's Artifact row is the change signal; another Home's document re-reads on demand.
  const activeRow = useArtifact(artifactId);
  const row = accountScope && areServerProfileIdentifiersEquivalent(accountScope.serverId, homeId) ? activeRow : null;
  const key = JSON.stringify([
    homeId,
    artifactId,
    topic ?? null,
    row?.headerVersion ?? null,
    row?.bodyVersion ?? null,
  ]);
  const [loaded, setLoaded] = React.useState<Loaded | null>(null);
  // Keep the canonical captured Home Account alive while its content is displayed.
  const displayedAccount = React.useRef<LazyActionAccountContext | null>(null);
  const pending = React.useRef<Readonly<{
    key: string;
    controller: AbortController;
    promise: Promise<MemoryDocumentTarget | null>;
  }> | null>(null);

  const refresh = React.useCallback((): Promise<MemoryDocumentTarget | null> => {
    if (!enabled || !artifactId) return Promise.resolve(null);
    pending.current?.controller.abort();
    const controller = new AbortController();
    const currentness = captureActiveServerAccountScopeCurrentness();
    setLoaded((previous) => {
      const view = previous?.identity === identity && previous.isCurrent() ? previous.view : null;
      return {
        key,
        identity,
        accountId: view ? previous?.accountId ?? null : null,
        isCurrent: view && previous ? previous.isCurrent : currentness.isCurrent,
        status: view ? 'refreshing' : 'loading',
        view,
        stale: false,
      };
    });
    const promise = (async () => {
      let account: LazyActionAccountContext | null = null;
      try {
        const { captureLazyActionAccountContext } = await import('@/sync/ops/actions/actionAccountContext');
        account = await captureLazyActionAccountContext(homeId, controller.signal);
        const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
        const result = await createDefaultActionExecutor().execute('memory.read', {
          ref: { kind: 'doc', artifactId, serverId: homeId },
          ...(topic === undefined ? {} : { topic }),
        }, { surface: 'ui', authority: 'present_user', serverId: homeId,
          expectedAccountId: account.accountId, signal: controller.signal });
        if (!result.ok) throw Object.assign(new Error(result.error), { code: result.errorCode });
        const read = MemoryDocReadResultV1Schema.parse(result.result);
        const access = await withUiPromptLibraryArtifactReader(
          async (reader) => {
            const artifact = await reader.readArtifactHeader({ kind: 'doc', artifactId, serverId: homeId });
            return artifact?.access ?? null;
          },
          { serverId: homeId, signal: controller.signal, accountContext: account },
        );
        if (controller.signal.aborted || !currentness.isCurrent()) return null;
        const view: MemoryDocumentView =
          'topic' in read
            ? {
                artifactId,
                ref: { kind: 'doc', artifactId, serverId: homeId },
                access,
                title: read.header.title,
                revision: read.revision,
                facts: read.topic.facts,
                topics: [],
                topic: { title: read.topic.title, summary: read.topic.summary },
              }
            : {
                artifactId,
                ref: { kind: 'doc', artifactId, serverId: homeId },
                access,
                title: read.header.title,
                revision: read.revision,
                facts: read.body.index,
                topics: read.body.topics,
                topic: null,
              };
        const capturedLifetime = account.accountOnlyLifetime;
        displayedAccount.current?.dispose();
        displayedAccount.current = account;
        setLoaded({ key, identity, accountId: account.accountId,
          isCurrent: () => currentness.isCurrent() && capturedLifetime.isCurrent(),
          status: 'ready', view, stale: false });
        return capturedLifetime.isCurrent() ? reviewedWriteTarget(view, homeId, topic) : null;
      } catch (error) {
        if (controller.signal.aborted || !currentness.isCurrent()) return null;
        const failure = (status: MemoryDocumentStatus): Loaded => ({ key, identity, accountId: null,
          isCurrent: currentness.isCurrent, status, view: null, stale: false });
        const code: unknown =
          error && typeof error === 'object'
              ? Reflect.get(error, 'code')
              : undefined;
        if (
          code === 'memory_doc_not_found' ||
          code === 'memory_topic_not_found'
        ) {
          setLoaded(failure('not_found'));
        } else if (code === 'memory_doc_invalid') {
          setLoaded(failure('invalid'));
        } else if (typeof code === 'string' && LOCKED_CODES.has(code)) {
          setLoaded(failure('locked'));
        } else {
          // Offline keeps the last version, marked as such.
          setLoaded((previous) => {
            const view = previous?.identity === identity && previous.isCurrent() ? previous.view : null;
            return { ...failure('unavailable'), view, stale: Boolean(view),
              accountId: view ? previous?.accountId ?? null : null,
              isCurrent: view && previous ? previous.isCurrent : currentness.isCurrent };
          });
        }
        return null;
      } finally {
        if (account && displayedAccount.current !== account) account.dispose();
        if (pending.current?.controller === controller) pending.current = null;
      }
    })();
    pending.current = { key, controller, promise };
    return promise;
  }, [activeLifetime, artifactId, enabled, homeId, identity, key, topic]);

  React.useEffect(() => {
    const retirement = activeLifetime?.onRetire(() => {
      pending.current?.controller.abort();
      setLoaded(null);
    });
    return () => retirement?.dispose();
  }, [activeLifetime]);

  React.useEffect(() => subscribeHomeCredentialChange((event) => {
    if (!areServerProfileIdentifiersEquivalent(event.serverId, homeId)) return;
    pending.current?.controller.abort();
    displayedAccount.current?.dispose();
    displayedAccount.current = null;
    setLoaded(null);
    if (enabled) void refresh();
  }), [enabled, homeId, refresh]);

  React.useEffect(() => () => {
    displayedAccount.current?.dispose();
    displayedAccount.current = null;
  }, []);

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
    const current = loaded?.identity === identity && loaded.isCurrent() ? loaded : {
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
        view && current.status === 'ready' && current.key === key
          ? reviewedWriteTarget(view, homeId, topic)
          : null,
      refresh,
    };
  }, [activeLifetime, enabled, homeId, identity, key, loaded, ref, refresh, serverId, topic]);
}
