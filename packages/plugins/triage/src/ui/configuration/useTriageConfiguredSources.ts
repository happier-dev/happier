import { CORPUS_SOURCE_INSTANCES_COLLECTION } from '../../corpus/collections/definitions.js';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { isPluginError } from '@happier-dev/plugin-sdk';
import { usePluginHostApi, usePluginTranslation, usePluginSurfaceActivity, usePluginUiDataClientOrNull, useSurfaceContext } from '@happier-dev/plugin-ui';

import { readActiveConfiguredSourceRows } from '../../corpus/configuration/readConfiguredSourceRows.js';
import { removeConfiguredSourceInstance } from '../../corpus/configuration/administerConfiguredSourceInstance.js';
import { useTriageDurableAccount, type TriageDurableAccountV1 } from '../durable/accountDurableState.js';
import { TRIAGE_SOURCES_ADMINISTER_ACTION_LOCAL_ID_V1, type TriageConfiguredSourceInstanceV1 } from '@happier-dev/triage-protocol/v1';
import { indexTriageAdmittedSourcesV1, readAccountDataSourceRecordsV1 } from '../../corpus/configuration/accountDataSources.js';
import { TRIAGE_SOURCES_CONTRIBUTION_POINT_ID_V1, TRIAGE_SOURCES_CONTRIBUTION_PROTOCOL_ID_V1, TRIAGE_SOURCES_CONTRIBUTION_PROTOCOL_VERSION_V1 } from '@happier-dev/triage-protocol/v1';
import { presentTriageMountedUiActionFailure } from '../mountedActions.js';

export type TriageMountedConfiguredSourceV1 = Readonly<{
  sourceInstanceId: string;
  /** Exact durable source fact used by source-owned targeted operations. */
  configured: TriageConfiguredSourceInstanceV1;
  displayLabel: string;
  displayPath?: string;
  /** Built-in Account-data targets have no connection to remove. */
  removable?: boolean;
}>;

export type TriageMountedConfiguredSourcesV1 = Readonly<{
  sources: readonly TriageMountedConfiguredSourceV1[];
  /** A complete read succeeded for this Account; an empty initial value is not absence. */
  loaded: boolean;
  busySourceInstanceId: string | null;
  notice: TriageConfiguredSourcesNoticeV1 | null;
  unavailableReason: string | null;
  /** Reads the configured sources again after an unavailable read. */
  retry(): void;
  remove(sourceInstanceId: string): Promise<boolean>;
}>;

export type TriageConfiguredSourcesNoticeV1 = Readonly<{
  kind: 'conflict' | 'missing' | 'refused';
  message: string;
}>;

const UNAVAILABLE_REASON =
  'Happier cannot reach your account right now, so configured sources cannot be changed.';
const EMPTY_SOURCES: readonly TriageMountedConfiguredSourceV1[] = Object.freeze([]);

type ConfiguredSourceRead = Readonly<{
  collections: TriageDurableAccountV1['collections'];
  sources: readonly TriageMountedConfiguredSourceV1[];
  loaded: boolean;
  unavailableReason: string | null;
}>;

/**
 * Triage's configured source rows over the mounted Account Collection.
 *
 * There is deliberately no daemon fallback: these Triage-owned rows are
 * readable and removable whenever the Account authority is reachable. Discovery
 * and source creation use each declared source operation's execution placement.
 * Failed reads retain the last accepted rows and failed writes publish no
 * speculative change or replay intent.
 */
export function useTriageConfiguredSources(): TriageMountedConfiguredSourcesV1 {
  const host = usePluginHostApi();
  const { active } = usePluginSurfaceActivity();
  const surface = useSurfaceContext();
  const accountDataSources = useMemo(() => readAccountDataSourceRecordsV1(indexTriageAdmittedSourcesV1(
    surface.targetedContributions?.points.find(point => point.pointId === TRIAGE_SOURCES_CONTRIBUTION_POINT_ID_V1)
      ?.protocols.find(protocol => protocol.protocol.id === TRIAGE_SOURCES_CONTRIBUTION_PROTOCOL_ID_V1
        && protocol.protocol.version === TRIAGE_SOURCES_CONTRIBUTION_PROTOCOL_VERSION_V1)?.contributions ?? [],
  )), [surface.targetedContributions]);
  const dataClient = usePluginUiDataClientOrNull();
  const durable = useTriageDurableAccount();
  const text = usePluginTranslation();
  const [acceptedRead, setAcceptedRead] = useState<ConfiguredSourceRead | null>(null);
  const [busySourceInstanceId, setBusySourceInstanceId] = useState<string | null>(null);
  const [notice, setNotice] = useState<TriageConfiguredSourcesNoticeV1 | null>(null);
  // Never carry one Account's configured rows through a replacement Data client,
  // including the render before its new read effect commits.
  const currentRead = acceptedRead?.collections === durable.collections ? acceptedRead : null;
  const sources = currentRead?.sources ?? EMPTY_SOURCES;
  const loaded = currentRead?.loaded ?? false;
  const unavailableReason = durable.collections === null
    ? text('plugins.triage.surface.sources.unavailable', UNAVAILABLE_REASON)
    : currentRead?.unavailableReason ?? null;
  const generation = useRef(0);
  const setUnavailableReason = useCallback((reason: string) => {
    setAcceptedRead(current => ({
      collections: durable.collections,
      sources: current?.collections === durable.collections ? current.sources : EMPTY_SOURCES,
      loaded: current?.collections === durable.collections && current.loaded,
      unavailableReason: reason,
    }));
  }, [durable.collections]);

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
        { signal, accountDataSources },
      );
      if (signal.aborted || generation.current !== current) return false;
      const sources = Object.freeze(result.rows.map((row) => Object.freeze({
        sourceInstanceId: row.configured.instance.sourceInstanceId,
        configured: row.configured,
        displayLabel: row.configured.locator?.displayLabel ?? row.configured.localInstanceKey,
        removable: !result.automaticSourceInstanceIds.includes(row.configured.instance.sourceInstanceId),
        ...(row.configured.locator?.displayPath === undefined
          ? {}
          : { displayPath: row.configured.locator.displayPath }),
      })));
      setAcceptedRead({ collections: durable.collections, sources, loaded: true, unavailableReason: null });
      return true;
    } catch (error) {
      if (signal.aborted || generation.current !== current) return false;
      setUnavailableReason(text('plugins.triage.surface.sources.unavailable', UNAVAILABLE_REASON));
      await presentTriageMountedUiActionFailure(host, error, text);
      return false;
    }
  }, [accountDataSources, durable.collections, host, setUnavailableReason, text]);

  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    let watch: Readonly<{ dispose(): void }> | undefined;
    if (dataClient) {
      void dataClient.watchAccountData({ kind: 'collection', collectionId: CORPUS_SOURCE_INSTANCES_COLLECTION.id },
        () => { void read(controller.signal); }, { signal: controller.signal }).then(opened => {
          if (controller.signal.aborted) { opened.dispose(); return; }
          watch = opened;
          void read(controller.signal);
        }).catch(async (error: unknown) => {
          if (controller.signal.aborted) return;
          setUnavailableReason(text('plugins.triage.surface.sources.unavailable', UNAVAILABLE_REASON));
          await presentTriageMountedUiActionFailure(host, error, text);
        });
    } else void read(controller.signal);
    return () => { controller.abort(); watch?.dispose(); };
  }, [active, dataClient, host, read, setUnavailableReason, text]);

  const remove = useCallback(async (sourceInstanceId: string): Promise<boolean> => {
    if (!loaded || durable.collections === null || busySourceInstanceId !== null || unavailableReason !== null) {
      return false;
    }
    const controller = new AbortController();
    setBusySourceInstanceId(sourceInstanceId);
    setNotice(null);
    try {
      if (!await host.admitAction(TRIAGE_SOURCES_ADMINISTER_ACTION_LOCAL_ID_V1,
        { v: 1, kind: 'remove', sourceInstanceId }, { signal: controller.signal })) return false;
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
    } catch (error) {
      await presentTriageMountedUiActionFailure(host, error, text);
      if (isPluginError(error) && error.code === 'denied') {
        setNotice({ kind: 'refused', message: text('happier.plugin-ui.action.error.denied', 'This isn’t allowed here.') });
        return false;
      }
      setUnavailableReason(text('plugins.triage.surface.sources.unavailable', UNAVAILABLE_REASON));
      return false;
    } finally {
      setBusySourceInstanceId(null);
    }
  }, [busySourceInstanceId, durable.collections, host, loaded, read, setUnavailableReason, text, unavailableReason]);

  const retry = useCallback(() => { void read(new AbortController().signal); }, [read]);

  return useMemo(() => Object.freeze({
    sources,
    loaded,
    busySourceInstanceId,
    notice,
    unavailableReason,
    retry,
    remove,
  }), [busySourceInstanceId, loaded, notice, remove, retry, sources, unavailableReason]);
}
