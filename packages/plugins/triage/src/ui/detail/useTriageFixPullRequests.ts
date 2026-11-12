import { useCallback, useEffect, useEffectEvent, useMemo, useRef, useState } from 'react';
import { TRIAGE_DATA_ACTION_EXECUTION_V1 } from '../../accountExecution.js';
import type { JsonValue, PluginCancellationOptions } from '@happier-dev/plugin-sdk';
import type { PluginUiActionControlController } from '@happier-dev/plugin-sdk/ui';
import { isPluginActionConfirmationDeclined, projectPluginActionControlExecutionV1, usePluginTranslation, usePluginHostApi, usePluginHostReadiness, usePluginUiEphemeralSharedScope } from '@happier-dev/plugin-ui';
import type {
  TriageEntryRefV1,
  TriageFixPullRequestV1,
} from '@happier-dev/triage-protocol/v1';

import {
  TRIAGE_READ_FIX_PULL_REQUESTS_ACTION_LOCAL_ID_V1,
  TRIAGE_SET_FIX_PULL_REQUEST_ACTION_LOCAL_ID_V1,
  TriageReadFixPullRequestsResultV1Schema,
  TriageSetFixPullRequestResultV1Schema,
  type TriageReadFixPullRequestsResultV1,
  type TriageReadFixPullRequestsInputV1,
  type TriageSetFixPullRequestInputV1,
  type TriageSetFixPullRequestResultV1,
} from '@happier-dev/triage-protocol/v1';
import { sameTriageEntryRefV1 } from '../state/surface.js';
import { projectTriageFixPullRequestsRead } from '../../projection/fixPullRequests.js';

/**
 * The selected issue or error group's fix pull requests (`design/FIX-LINK.md`).
 *
 * It holds the authoritative answer and nothing else, like the pins hook: no
 * optimistic flip and no queue. A link or unlink shows once the write settled
 * and the read changed. There is no change feed — the corpus deliberately has
 * none — so the answer refreshes on selection, after this mount's own writes,
 * and on `retry`.
 *
 * The Account Action returns the owner-resolved answer and resolves current
 * source admission for both composed Session links and native associations.
 */

type Display = Readonly<{ title: string; scopeLabel: string }>;

export type TriageFixPullRequestsInputV1 = Readonly<{
  entryRef: TriageEntryRefV1;
  sourceContext?: TriageReadFixPullRequestsInputV1['sourceContext'];
  /** The issue's own display pair: a first fix-PR choice creates its mark row. */
  display: Display;
}>;

export type TriageFixPullRequestsStateV1 =
  | Readonly<{ kind: 'reading' }>
  | Readonly<{ kind: 'unreachable'; retry(): void }>
  | Readonly<{
    kind: 'ready';
    candidates: readonly TriageFixPullRequestV1[];
    primary: TriageFixPullRequestV1 | null;
    incomplete: boolean;
    busy: boolean;
    /** The last write conflicted or failed; `null` otherwise. */
    refusal: 'conflict' | 'failed' | null;
    link(pullRequest: Readonly<{ entryRef: TriageEntryRefV1; display: Display }>): void;
    unlink(entryRef: TriageEntryRefV1): void;
    unlinkControl(entryRef: TriageEntryRefV1): PluginUiActionControlController;
  }>;

type FixHostV1 = Readonly<{
  executeAction(action: string, input: JsonValue, options?: PluginCancellationOptions): Promise<unknown>;
}>;

export type TriageFixPullRequestsTransportV1 = Readonly<{
  read(entryRef: TriageEntryRefV1, options?: PluginCancellationOptions): Promise<TriageReadFixPullRequestsResultV1>;
  /** Null is a declined direct UI decision, not a domain write outcome. */
  write(input: TriageSetFixPullRequestInputV1, options?: PluginCancellationOptions): Promise<TriageSetFixPullRequestResultV1 | null>;
}>;

export function createActionTriageFixPullRequestsTransport(
  host: FixHostV1,
  sourceContext?: TriageReadFixPullRequestsInputV1['sourceContext'],
): TriageFixPullRequestsTransportV1 {
  return Object.freeze({
    async read(entryRef, options) {
      return TriageReadFixPullRequestsResultV1Schema.parse(await host.executeAction(
        TRIAGE_READ_FIX_PULL_REQUESTS_ACTION_LOCAL_ID_V1,
        { v: 1, entryRef, ...(sourceContext === undefined ? {} : { sourceContext }) } as unknown as JsonValue,
        options,
      ));
    },
    async write(input, options) {
      return TriageSetFixPullRequestResultV1Schema.parse(await host.executeAction(
        TRIAGE_SET_FIX_PULL_REQUEST_ACTION_LOCAL_ID_V1,
        input as unknown as JsonValue,
        options,
      ));
    },
  });
}

type Settled =
  | Readonly<{ kind: 'reading' }>
  | Readonly<{ kind: 'unreachable' }>
  | Readonly<{ kind: 'read'; entryRef: TriageEntryRefV1; owner: ReturnType<typeof usePluginUiEphemeralSharedScope>; resolved: TriageReadFixPullRequestsResultV1 }>;

export function useTriageFixPullRequests(
  input: TriageFixPullRequestsInputV1 | null,
  refreshGeneration = 0,
): TriageFixPullRequestsStateV1 | null {
  const hostApi = usePluginHostApi();
  const text = usePluginTranslation();
  const owner = usePluginUiEphemeralSharedScope();
  const readiness = usePluginHostReadiness(Object.is(TRIAGE_DATA_ACTION_EXECUTION_V1.target, 'daemon'));
  const sourceContext = input?.sourceContext;
  const transport = useMemo<TriageFixPullRequestsTransportV1>(
    () => createActionTriageFixPullRequestsTransport(hostApi, sourceContext),
    [hostApi, owner, sourceContext],
  );
  // Refreshed detail inputs carry new objects for the same admitted connection.
  // Spend its latest context on the next requested read, without starting a
  // second read when that detail refresh settles.
  const readCurrent = useEffectEvent((entryRef: TriageEntryRefV1, signal: AbortSignal) => transport.read(entryRef, { signal }));
  const [settled, setSettled] = useState<Settled>({ kind: 'reading' });
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<'conflict' | 'failed' | null>(null);
  const [readGeneration, setReadGeneration] = useState(0);
  const generation = useRef(0);

  // Reads key on the reference's value, so a caller that rebuilds an equal
  // reference each render does not re-read.
  const entryKey = input === null ? null : JSON.stringify([
    input.entryRef.source.pluginId,
    input.entryRef.source.localId,
    input.entryRef.kindId,
    input.entryRef.collisionScope,
    input.entryRef.entryId,
    sourceContext?.instance.instance.sourceInstanceId,
  ]);
  const entryRefRef = useRef<TriageEntryRefV1 | undefined>(undefined);
  entryRefRef.current = input?.entryRef;
  const entryRef = input?.entryRef;
  const display = input?.display;

  useEffect(() => {
    const entryRef = entryRefRef.current;
    if (entryKey === null || entryRef === undefined) return undefined;
    generation.current += 1;
    const current = generation.current;
    const controller = new AbortController();
    setSettled((previous) => (
      previous.kind === 'read' && previous.owner === owner && sameTriageEntryRefV1(previous.entryRef, entryRef)
        ? previous
        : !readiness.pending && readiness.ready === false ? { kind: 'unreachable' } : { kind: 'reading' }
    ));
    if (readiness.pending || readiness.ready === false) return () => controller.abort();
    void (async () => {
      let next: Settled;
      try {
        next = { kind: 'read', entryRef, owner, resolved: await readCurrent(entryRef, controller.signal) };
      } catch {
        next = { kind: 'unreachable' };
      }
      if (controller.signal.aborted || current !== generation.current) return;
      if (next.kind !== 'read') { setSettled(next); return; }
      const read = next;
      setSettled((previous) => {
        const baseline = previous.kind === 'read' && previous.owner === owner
          && sameTriageEntryRefV1(previous.entryRef, entryRef) ? previous : undefined;
        const resolved = projectTriageFixPullRequestsRead(read.resolved, baseline?.resolved);
        return baseline !== undefined && resolved === baseline.resolved ? baseline : { ...read, resolved };
      });
    })();
    return () => controller.abort();
  }, [entryKey, hostApi, owner, readGeneration, refreshGeneration, readiness.pending, readiness.ready, readiness.revision]);

  const beginWrite = useCallback(() => {
    setBusy(true);
    setRefusal(null);
  }, []);
  const settleWrite = useCallback((response: unknown, failed: boolean) => {
    try {
      if (failed) setRefusal('failed');
      else if (response !== null) {
        const result = TriageSetFixPullRequestResultV1Schema.parse(response);
        if (result.status === 'conflict') setRefusal(result.status);
      }
    } catch {
      setRefusal('failed');
    } finally {
      setBusy(false);
      setReadGeneration((value) => value + 1);
    }
  }, []);
  const write = useCallback((intent: TriageSetFixPullRequestInputV1): void => {
    beginWrite();
    void transport.write(intent).then(result => settleWrite(result, false), () => settleWrite(null, true));
  }, [transport, beginWrite, settleWrite]);

  const retry = useCallback(() => {
    if (readiness.pending || readiness.ready === false) return;
    setReadGeneration((value) => value + 1);
  }, [readiness.pending, readiness.ready]);

  return useMemo(() => {
    if (entryRef === undefined || display === undefined) return null;
    if (settled.kind === 'unreachable') return readiness.pending ? { kind: 'reading' } : { kind: 'unreachable', retry };
    if (settled.kind !== 'read' || settled.owner !== owner || !sameTriageEntryRefV1(settled.entryRef, entryRef)) return { kind: 'reading' };
    const resolved = settled.resolved;
    const unlinkInput = (fixPullRequest: TriageEntryRefV1): TriageSetFixPullRequestInputV1 =>
      ({ v: 1, linked: false, entryRef, displayAtMark: display, fixPullRequest });
    return {
      kind: 'ready',
      candidates: resolved.candidates,
      primary: resolved.primary,
      incomplete: resolved.incomplete,
      busy,
      refusal,
      link: (pullRequest) => write({
        v: 1,
        linked: true,
        entryRef,
        displayAtMark: display,
        fixPullRequest: pullRequest.entryRef,
        displayAtLink: pullRequest.display,
      }),
      unlink: (fixPullRequest) => write(unlinkInput(fixPullRequest)),
      unlinkControl: (fixPullRequest) => ({
        prepare: () => {
          if (busy) return null;
          beginWrite();
          return { input: unlinkInput(fixPullRequest) as unknown as JsonValue };
        },
        onSettled: settled => {
          const execution = projectPluginActionControlExecutionV1(settled, text);
          settleWrite(execution.status === 'success' ? execution.result : null,
            execution.status !== 'success' && !isPluginActionConfirmationDeclined(execution));
        },
      }),
    };
  }, [busy, display, entryRef, owner, refusal, retry, settled, write, readiness.pending, beginWrite, settleWrite, text]);
}
