import type {
  MemoryFactReadV1,
  MemoryTopicV1,
} from '@happier-dev/protocol/prompts/library/memoryDocV1';
import type { PromptDocArtifactRefV1 } from '@happier-dev/protocol/prompts/library/promptArtifactRefsV1';
import type { ArtifactCallerAccessV1 } from '@happier-dev/protocol/artifacts/artifactAccessV1';
import { readArtifactAudience, type ArtifactAudience } from '@/sync/domains/artifacts/artifactAudience';
import { MemoryDocReadResultV1Schema } from '@happier-dev/protocol/prompts/library/memoryActionsV1';
import * as React from 'react';

import type {
  MemoryDocumentRevision,
  MemoryDocumentTarget,
} from '@/sync/ops/promptLibrary/memoryDocuments';
import type { LazyActionAccountContext } from '@/sync/ops/actions/actionAccountContext';
import { createArtifactAccessApi } from '@/sync/api/artifacts/apiArtifacts';
import { useActiveServerAccountScope } from '@/sync/domains/state/storage';
import { captureActiveServerAccountScopeCurrentness, captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { useServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { areServerAccountScopesEqual } from '@/sync/domains/scope/serverAccountScope';
import { subscribeHomeAccountChange } from '@/sync/runtime/orchestration/homeAccountChange';
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
  /** Current admitted granted/public audience; null cannot establish privacy. */
  shared: boolean | null;
  audience: ArtifactAudience | null;
  title: string;
  revision: MemoryDocumentRevision;
  /** The facts of this page: the index's key facts, or the open topic's facts. */
  facts: readonly MemoryFactReadV1[];
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
  /** Unpublished drafts belong to this admitted Account and document, across revision refreshes. */
  draftCustody: Readonly<{
    key: string;
    /** The qualified read's admitted Account, including read-only foreign documents. */
    scope: Readonly<{ serverId: string; accountId: string }>;
    isCurrent: () => boolean;
  }> | null;
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

function reviewedWriteTarget(
  view: MemoryDocumentView,
  serverId: string,
  authority: Pick<Loaded, 'accountId' | 'isCurrent'>,
  topic?: string,
): MemoryDocumentTarget | null {
  if (view.access === null || view.access === 'view' || view.shared === null || authority.accountId === null) return null;
  return { ref: view.ref, serverId, accountId: authority.accountId, isCurrent: authority.isCurrent,
    expectedRevision: view.revision,
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
 * on demand). It keeps the last version while a newer one loads, re-reads on the Home's exact Artifact
 * changes, and never writes; edits go through the `memory.*` Actions against `target`.
 */
export function useMemoryDocument(
  params: Readonly<{
    ref: PromptDocArtifactRefV1 | null;
    serverId: string | null;
    topic?: string;
    /** A closed or switched-off surface reads nothing. */
    enabled?: boolean;
    /** An unresolved context attachment is unknown, not a successful empty read. */
    attachmentStatus?: 'loading' | 'ready' | 'unavailable';
  }>,
): MemoryDocumentSource {
  const { ref, serverId, topic } = params;
  const enabled = params.enabled !== false && ref !== null && serverId !== null;
  const artifactId = ref?.artifactId ?? '';
  const homeId = ref?.serverId ?? serverId ?? '';
  const { binding: credentialLifetime, resolution: credentialResolution } = useServerCredentialAccountScopeBinding(enabled ? homeId : null);
  const accountScope = useActiveServerAccountScope();
  const activeLifetime = captureActiveServerAccountScopeLifetime();
  const identity = JSON.stringify([homeId, accountScope?.serverId, accountScope?.accountId, artifactId, topic ?? null]);
  // The exact Home Artifact wake owns content and grant refreshes. Inventory
  // hydration is not another document change and must not reopen its body.
  const key = JSON.stringify([homeId, artifactId, topic ?? null]);
  const [loaded, setLoaded] = React.useState<Loaded | null>(null);
  const loadedRef = React.useRef(loaded);
  loadedRef.current = loaded;
  // Keep the canonical captured Home Account alive while its content is displayed.
  const displayedAccount = React.useRef<LazyActionAccountContext | null>(null);
  const pending = React.useRef<Readonly<{
    key: string;
    identity: string;
    controller: AbortController;
    promise: Promise<MemoryDocumentTarget | null>;
  }> | null>(null);

  const refresh = React.useCallback((): Promise<MemoryDocumentTarget | null> => {
    if (!enabled || !artifactId || !credentialLifetime?.isCurrent()) return Promise.resolve(null);
    pending.current?.controller.abort();
    const controller = new AbortController();
    const currentness = captureActiveServerAccountScopeCurrentness();
    let account: LazyActionAccountContext | null = null;
    const isReadCurrent = () => currentness.isCurrent() && (account?.accountOnlyLifetime.isCurrent() ?? true);
    const successorRead = async (): Promise<MemoryDocumentTarget | null> => {
      const successor = pending.current;
      // An Artifact wake may supersede the post-write read while its caller is
      // awaiting the refreshed target. Follow that same-document read, never a
      // replacement Account or a different document's target.
      if (!isReadCurrent() || !successor
        || successor.controller === controller || successor.identity !== identity) return null;
      try {
        const target = await successor.promise;
        return isReadCurrent() ? target : null;
      } catch { return null; }
    };
    setLoaded((previous) => {
      const view = previous?.identity === identity && previous.isCurrent() ? previous.view : null;
      return {
        key,
        identity,
        accountId: view ? previous?.accountId ?? null : null,
        isCurrent: view && previous ? previous.isCurrent : isReadCurrent,
        status: view ? 'refreshing' : 'loading',
        view,
        stale: false,
      };
    });
    const promise = (async () => {
      try {
        const { captureLazyActionAccountContext } = await import('@/sync/ops/actions/actionAccountContext');
        account = await captureLazyActionAccountContext(homeId, controller.signal);
        const { executeDefaultActionInCapturedAccount } = await import('@/sync/ops/actions/defaultActionExecutor');
        const readAccount = { ...account };
        const readArtifactContent = account.readArtifactContent;
        // Observe the admitted Action's existing read, rather than fetching the body again for audience metadata.
        const observed: { artifact: Awaited<ReturnType<LazyActionAccountContext['readArtifactContent']>> } = { artifact: null };
        readAccount.readArtifactContent = async (requestedArtifactId, options) => {
          const artifact = await readArtifactContent(requestedArtifactId, options);
          if (requestedArtifactId === artifactId) observed.artifact = artifact;
          return artifact;
        };
        const result = await executeDefaultActionInCapturedAccount(readAccount, 'memory.read', {
          ref: { kind: 'doc', artifactId, serverId: homeId },
          ...(topic === undefined ? {} : { topic }),
        }, { surface: 'ui', authority: 'present_user', serverId: homeId,
          expectedAccountId: account.accountId, signal: controller.signal });
        if (!result.ok) throw Object.assign(new Error(result.error), { code: result.errorCode });
        const read = MemoryDocReadResultV1Schema.parse(result.result);
        const artifact = observed.artifact;
        if (!artifact) throw Object.assign(new Error('memory_doc_not_found'), { code: 'memory_doc_not_found' });
        const access = artifact.access ?? null;
        // Finite observations must not prepare/publish the Artifact and invalidate their own read.
        const accessGrants = createArtifactAccessApi(account.credentials, { request: account.request });
        const audience = await readArtifactAudience({ current: artifact, signal: controller.signal,
          readGrants: () => accessGrants.list({ artifactId }, controller.signal),
        }).catch(() => null);
        const shared = audience?.shared ?? null;
        if (!isReadCurrent()) return null;
        if (controller.signal.aborted) return await successorRead();
        const view: MemoryDocumentView =
          'topic' in read
            ? {
                artifactId,
                ref: { kind: 'doc', artifactId, serverId: homeId },
                access,
                shared,
                audience,
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
                shared,
                audience,
                title: read.header.title,
                revision: read.revision,
                facts: read.body.index,
                topics: read.body.topics,
                topic: null,
              };
        // Keep the displayed Account/material lifetime alive across ordinary refreshes,
        // so retained drafts keep observing its canonical retirement after bearer renewal.
        if (!displayedAccount.current?.accountOnlyLifetime.isCurrent()
          || !areServerAccountScopesEqual(displayedAccount.current.accountOnlyLifetime.scope, account.accountOnlyLifetime.scope)) {
          displayedAccount.current?.dispose();
          displayedAccount.current = account;
        }
        const capturedDisplay = displayedAccount.current;
        const capturedLifetime = capturedDisplay.accountOnlyLifetime;
        const isCurrent = () => displayedAccount.current === capturedDisplay
          && isReadCurrent() && capturedLifetime.isCurrent();
        setLoaded({ key, identity, accountId: account.accountId,
          isCurrent,
          status: 'ready', view, stale: false });
        return isCurrent() ? reviewedWriteTarget(view, homeId, { accountId: account.accountId, isCurrent }, topic) : null;
      } catch (error) {
        if (!isReadCurrent()) return null;
        if (controller.signal.aborted) return await successorRead();
        const failure = (status: MemoryDocumentStatus): Loaded => ({ key, identity, accountId: null,
          isCurrent: isReadCurrent, status, view: null, stale: false });
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
              isCurrent: view && previous ? previous.isCurrent : isReadCurrent };
          });
        }
        return null;
      } finally {
        if (account && displayedAccount.current !== account) account.dispose();
        if (pending.current?.controller === controller) pending.current = null;
      }
    })();
    pending.current = { key, identity, controller, promise };
    return promise;
  }, [activeLifetime, artifactId, credentialLifetime, enabled, homeId, identity, key, topic]);

  React.useEffect(() => {
    const retirement = activeLifetime?.onRetire(() => {
      pending.current?.controller.abort();
      setLoaded(null);
    });
    return () => retirement?.dispose();
  }, [activeLifetime]);

  React.useEffect(() => {
    if (!enabled) return;
    return subscribeHomeAccountChange(event => {
      if (!areServerProfileIdentifiersEquivalent(event.serverId, homeId)) return;
      if (event.changeKinds && !event.changeKinds.includes('artifact')) return;
      if (event.entityIds && !event.entityIds.includes(artifactId)) return;
      // Grant changes have no document revision; the existing Account wake owns their invalidation.
      void refresh();
    }, { serverIds: [homeId], reconnect: { readNotCurrent: () => {
      const current = loadedRef.current;
      return current?.identity !== identity || !current.isCurrent() || current.status !== 'ready' || current.view?.audience === null;
    } } });
  }, [artifactId, enabled, homeId, identity, refresh]);

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
        status: !ref && params.attachmentStatus && params.attachmentStatus !== 'ready' ? params.attachmentStatus : 'none',
        view: null,
        stale: false,
        target: null,
        draftCustody: activeLifetime ? {
          key: JSON.stringify([identity, activeLifetime.scope.accountId]),
          scope: activeLifetime.scope,
          isCurrent: activeLifetime.isCurrent,
        } : null,
        refresh: NO_REFRESH,
      };
    const current = loaded?.identity === identity && loaded.isCurrent() ? loaded : {
      key,
      status: credentialResolution.kind === 'resolving' || credentialResolution.kind === 'bound'
        ? 'loading' as const : 'unavailable' as const,
      view: null,
      stale: false,
    };
    const view = current.view;
    return {
      status: current.status,
      view,
      stale: current.stale,
      draftCustody: view && loaded?.accountId ? {
        key: JSON.stringify([identity, loaded.accountId]),
        scope: { serverId: homeId, accountId: loaded.accountId },
        isCurrent: loaded.isCurrent,
      } : null,
      target:
        view && loaded && current.status === 'ready' && current.key === key
          ? reviewedWriteTarget(view, homeId, loaded, topic)
          : null,
      refresh,
    };
  }, [activeLifetime, credentialResolution.kind, enabled, homeId, identity, key, loaded, params.attachmentStatus, ref, refresh, serverId, topic]);
}
