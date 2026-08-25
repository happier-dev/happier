import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { usePluginTranslation } from '@happier-dev/plugin-ui';

import { readActiveConfiguredSourceRows } from '../../corpus/configuration/readConfiguredSourceRows.js';
import { removeConfiguredSourceInstance } from '../../corpus/configuration/administerConfiguredSourceInstance.js';
import { useTriageDurableAccount } from '../durable/accountDurableState.js';

export type TriageMountedConfiguredSourceV1 = Readonly<{
  sourceInstanceId: string;
  displayLabel: string;
  displayPath?: string;
}>;

export type TriageMountedConfiguredSourcesV1 = Readonly<{
  sources: readonly TriageMountedConfiguredSourceV1[];
  completeness: 'complete' | 'truncated';
  busySourceInstanceId: string | null;
  notice: TriageConfiguredSourcesNoticeV1 | null;
  unavailableReason: string | null;
  remove(sourceInstanceId: string): Promise<boolean>;
}>;

export type TriageConfiguredSourcesNoticeV1 = Readonly<{
  kind: 'conflict' | 'missing';
  message: string;
}>;

const UNAVAILABLE_REASON =
  'Happier cannot reach your account right now, so configured sources cannot be changed.';

/**
 * Triage's configured source rows over the mounted Account Collection.
 *
 * There is deliberately no daemon fallback: provider discovery and source
 * creation remain daemon work, while these already-durable Triage-owned rows
 * are readable and removable whenever the Account authority is reachable.
 * Failed reads retain the last accepted rows and failed writes publish no
 * speculative change or replay intent.
 */
export function useTriageConfiguredSources(): TriageMountedConfiguredSourcesV1 {
  const durable = useTriageDurableAccount();
  const text = usePluginTranslation();
  const [sources, setSources] = useState<readonly TriageMountedConfiguredSourceV1[]>([]);
  const [completeness, setCompleteness] = useState<'complete' | 'truncated'>('complete');
  const [busySourceInstanceId, setBusySourceInstanceId] = useState<string | null>(null);
  const [notice, setNotice] = useState<TriageConfiguredSourcesNoticeV1 | null>(null);
  const [unavailableReason, setUnavailableReason] = useState<string | null>(null);
  const generation = useRef(0);

  const read = useCallback(async (signal: AbortSignal): Promise<boolean> => {
    generation.current += 1;
    const current = generation.current;
    if (durable.collections === null) {
      setUnavailableReason(text('plugins.triage.surface.sources.unavailable', UNAVAILABLE_REASON));
      return false;
    }
    try {
      const result = await readActiveConfiguredSourceRows(
        durable.collections.sourceInstances,
        { signal },
      );
      if (signal.aborted || generation.current !== current) return false;
      setSources(Object.freeze(result.administrativeRows.map((row) => Object.freeze({
        sourceInstanceId: row.configured.instance.sourceInstanceId,
        displayLabel: row.configured.locator?.displayLabel ?? row.configured.localInstanceKey,
        ...(row.configured.locator?.displayPath === undefined
          ? {}
          : { displayPath: row.configured.locator.displayPath }),
      }))));
      setCompleteness(result.status);
      setUnavailableReason(null);
      return true;
    } catch {
      if (signal.aborted || generation.current !== current) return false;
      setUnavailableReason(text('plugins.triage.surface.sources.unavailable', UNAVAILABLE_REASON));
      return false;
    }
  }, [durable.collections, text]);

  useEffect(() => {
    const controller = new AbortController();
    void read(controller.signal);
    return () => { controller.abort(); };
  }, [read]);

  const remove = useCallback(async (sourceInstanceId: string): Promise<boolean> => {
    if (durable.collections === null || busySourceInstanceId !== null || unavailableReason !== null) {
      return false;
    }
    const controller = new AbortController();
    setBusySourceInstanceId(sourceInstanceId);
    setNotice(null);
    try {
      const result = await removeConfiguredSourceInstance({
        collections: durable.collections,
        sourceInstanceId,
        signal: controller.signal,
      });
      if (result.kind === 'conflict') {
        setNotice({
          kind: 'conflict',
          message: text(
            'plugins.triage.surface.sources.conflict',
            'Your configured sources changed somewhere else, so this source was not removed. Showing the current list; try again.',
          ),
        });
        await read(controller.signal);
        return false;
      }
      if (result.kind !== 'removed') {
        setNotice({
          kind: 'missing',
          message: text(
            'plugins.triage.surface.sources.missing',
            'That configured source no longer exists. Showing the current list.',
          ),
        });
        await read(controller.signal);
        return false;
      }
      return await read(controller.signal);
    } catch {
      setUnavailableReason(text('plugins.triage.surface.sources.unavailable', UNAVAILABLE_REASON));
      return false;
    } finally {
      setBusySourceInstanceId(null);
    }
  }, [busySourceInstanceId, durable.collections, read, text, unavailableReason]);

  return useMemo(() => Object.freeze({
    sources,
    completeness,
    busySourceInstanceId,
    notice,
    unavailableReason,
    remove,
  }), [busySourceInstanceId, completeness, notice, remove, sources, unavailableReason]);
}
