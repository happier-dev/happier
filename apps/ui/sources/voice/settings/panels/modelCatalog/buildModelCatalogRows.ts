import type {
  DaemonVoiceInferenceModelStatus,
  ModelPackCatalogEntry,
  ModelPackKind,
} from '@happier-dev/protocol';
import {
  getDefaultModelPackId,
  getModelPackCatalogEntry,
  isPublishedModelPackCatalogEntry,
  listModelPackCatalogEntries,
  resolveCanonicalModelPackId,
} from '@happier-dev/protocol';

/**
 * Derived presentation state for a single model-pack row. Combines the daemon
 * install lifecycle (`installState`) with optional resident readiness telemetry
 * (`runtimeState`). Readiness takes precedence when the pack is installed so a
 * loaded/evicted/warming pack reads its live runtime status instead of a flat
 * "installed".
 */
export type ModelCatalogRowState =
  | 'not_installed'
  | 'downloading'
  | 'installed'
  | 'warming'
  | 'ready'
  | 'evicted'
  | 'error'
  | 'unsupported'
  /**
   * Daemon status could not be fetched, so the pack's true install/readiness is
   * unknown. Distinct from `not_installed` (a daemon that answered and reported
   * the pack absent): an `unknown` row offers no install/remove action so a
   * mutation can never fire against an unreachable/unhealthy daemon.
   */
  | 'unknown';

export type ModelCatalogRow = Readonly<{
  packId: string;
  kind: ModelPackKind;
  displayName: string;
  model: string;
  state: ModelCatalogRowState;
  /** Download progress in [0,1] while `state === 'downloading'`, else null. */
  progress: number | null;
  /** Declared size of the artifact whose daemon runtime is loaded, or null; not RSS. */
  loadedArtifactBytes: number | null;
  /** Daemon-reported install error message, or null. */
  lastError: string | null;
  /** Whether this pack is the selected default for its kind. */
  isDefault: boolean;
  /** Whether an install/retry action is offered for this row. */
  canInstall: boolean;
  /** Whether a remove action is offered for this row. */
  canRemove: boolean;
  /** Exact daemon-projected consent review for an external plugin pack. */
  licenseReview: DaemonVoiceInferenceModelStatus['licenseReview'] | null;
  sourcePluginId: string | null;
}>;

export type ModelCatalogRowGroups = Readonly<{
  stt: readonly ModelCatalogRow[];
  tts: readonly ModelCatalogRow[];
}>;

export type BuildModelCatalogRowsParams = Readonly<{
  statuses: readonly DaemonVoiceInferenceModelStatus[];
  /**
   * True when the daemon status request failed (or has not yet succeeded), so
   * the per-pack install/readiness is unknown. Forces every row to the
   * uninstallable `unknown` state regardless of `statuses`.
   */
  statusUnavailable?: boolean;
  /** Last failed mutation, retained independently from status reconciliation. */
  actionError?: Readonly<{
    packId: string;
    operation: 'install' | 'remove';
  }> | null;
  /** Currently-selected STT default pack id (may be a legacy id), or null. */
  selectedSttPackId: string | null;
  /** Currently-selected TTS default pack id (may be a legacy id), or null. */
  selectedTtsPackId: string | null;
}>;

/**
 * Build a human-facing display name from a catalog model identifier. The
 * canonical catalog does not yet carry localized display names, so we derive a
 * readable label from the model id (titleized segments) rather than inventing a
 * parallel name registry. Strings here are identifiers, not user copy.
 */
function deriveDisplayName(entry: Pick<ModelPackCatalogEntry, 'packId' | 'model'>): string {
  const source = entry.model.trim().length > 0 ? entry.model : entry.packId;
  const cleaned = source
    .replace(/^sherpa-onnx-/i, '')
    .replace(/[._]/g, '-')
    .split('-')
    .filter((segment) => segment.length > 0)
    .map((segment) => (/^[a-z]/.test(segment) ? segment.charAt(0).toUpperCase() + segment.slice(1) : segment))
    .join(' ');
  return cleaned.length > 0 ? cleaned : source;
}

function resolveRowState(status: DaemonVoiceInferenceModelStatus | undefined): {
  state: ModelCatalogRowState;
  progress: number | null;
} {
  if (!status) {
    return { state: 'not_installed', progress: null };
  }
  if (status.installState === 'installing') {
    return { state: 'downloading', progress: status.progress?.progress ?? null };
  }
  if (status.installState === 'error') {
    return { state: 'error', progress: null };
  }
  if (status.installState === 'not_installed') {
    return { state: 'not_installed', progress: null };
  }
  // Physical presence remains authoritative after a failed reinstall. The
  // daemon reports `installed` plus the separate attempt error so the row can
  // offer both retry and remove without inferring disk state from error text.
  if (status.lastError) {
    return { state: 'error', progress: null };
  }
  // installState === 'installed': prefer live readiness when available.
  switch (status.runtimeState) {
    case 'warming':
      return { state: 'warming', progress: null };
    case 'ready':
      return { state: 'ready', progress: null };
    case 'evicted':
      return { state: 'evicted', progress: null };
    default:
      return { state: 'installed', progress: null };
  }
}

function resolveDefaultPackId(kind: ModelPackKind, selected: string | null): string | null {
  const trimmed = typeof selected === 'string' ? selected.trim() : '';
  if (trimmed.length > 0) {
    return resolveCanonicalModelPackId(trimmed);
  }
  const defaultPackId = getDefaultModelPackId(kind);
  return isPublishedModelPackCatalogEntry(
    defaultPackId ? getModelPackCatalogEntry(defaultPackId) : null,
  )
    ? defaultPackId
    : null;
}

function buildRowsForKind(
  kind: ModelPackKind,
  statusByPackId: ReadonlyMap<string, DaemonVoiceInferenceModelStatus>,
  selectedPackId: string | null,
  statusUnavailable: boolean,
  actionError: BuildModelCatalogRowsParams['actionError'],
): readonly ModelCatalogRow[] {
  const defaultPackId = resolveDefaultPackId(kind, selectedPackId);
  const explicitSelectedPackId = typeof selectedPackId === 'string' && selectedPackId.trim().length > 0
    ? resolveCanonicalModelPackId(selectedPackId)
    : null;
  const builtIns = listModelPackCatalogEntries(kind).map((entry) => ({
    ...entry,
    external: false as const,
    publicationAvailable: isPublishedModelPackCatalogEntry(entry),
  }));
  const external = [...statusByPackId.values()]
    .filter((status) => status.kind === kind && status.pluginIdentity !== null)
    .map((status) => ({
      packId: status.packId,
      kind: status.kind,
      model: status.model,
      runtimeFamily: status.runtimeFamily ?? null,
      external: true as const,
      publicationAvailable: true,
    }));
  return [...builtIns, ...external].flatMap((entry): readonly ModelCatalogRow[] => {
    const status = statusByPackId.get(entry.packId);
    const runtimeSupported = entry.publicationAvailable
      && status?.runtimeSupported === true
      && (entry.runtimeFamily === null || status.runtimeFamily === entry.runtimeFamily);
    const installedByDaemon = status?.installState === 'installed';
    const explicitlySelected = explicitSelectedPackId === entry.packId;
    if (
      !statusUnavailable
      && (!entry.publicationAvailable || status !== undefined)
      && !runtimeSupported
      && !installedByDaemon
      && !explicitlySelected
    ) {
      return [];
    }
    const resolved = statusUnavailable
      ? { state: 'unknown' as ModelCatalogRowState, progress: null }
      : !entry.publicationAvailable
        ? { state: 'unsupported' as ModelCatalogRowState, progress: null }
      : !status
        ? { state: 'unknown' as ModelCatalogRowState, progress: null }
        : !runtimeSupported
          ? { state: 'unsupported' as ModelCatalogRowState, progress: null }
          : resolveRowState(status);
    const actionFailed = !statusUnavailable && actionError?.packId === entry.packId;
    const state = actionFailed && entry.publicationAvailable ? 'error' : resolved.state;
    const progress = actionFailed && entry.publicationAvailable ? null : resolved.progress;
    const installed = resolved.state === 'installed'
      || resolved.state === 'ready'
      || resolved.state === 'warming'
      || resolved.state === 'evicted';
    const row: ModelCatalogRow = {
      packId: entry.packId,
      kind: entry.kind,
      displayName: deriveDisplayName(entry),
      model: entry.model,
      state,
      progress,
      loadedArtifactBytes:
        typeof status?.loadedArtifactBytes === 'number' ? status.loadedArtifactBytes : null,
      lastError: status?.lastError ?? null,
      isDefault: defaultPackId === entry.packId,
      canInstall: entry.publicationAvailable
        && (actionFailed
          ? actionError?.operation === 'install'
          : state === 'not_installed' || state === 'error'),
      canRemove: actionFailed
        ? actionError?.operation === 'remove' && installedByDaemon
        : installed || installedByDaemon,
      licenseReview: status?.licenseReview ?? null,
      sourcePluginId: status?.pluginIdentity?.pluginId ?? null,
    };
    return [row];
  });
}

/**
 * Map the canonical model-pack catalog against the daemon's per-pack install +
 * readiness snapshot into grouped STT/TTS row view-models. Pure: the same inputs
 * always yield the same rows, which is the unit under test. No provider-name
 * branching — grouping is driven entirely by the catalog `kind`.
 */
export function buildModelCatalogRows(params: BuildModelCatalogRowsParams): ModelCatalogRowGroups {
  const statusByPackId = new Map<string, DaemonVoiceInferenceModelStatus>();
  for (const status of params.statuses) {
    statusByPackId.set(status.packId, status);
  }
  const statusUnavailable = params.statusUnavailable === true;
  return {
    stt: buildRowsForKind(
      'stt_sherpa',
      statusByPackId,
      params.selectedSttPackId,
      statusUnavailable,
      params.actionError,
    ),
    tts: buildRowsForKind(
      'tts_sherpa',
      statusByPackId,
      params.selectedTtsPackId,
      statusUnavailable,
      params.actionError,
    ),
  };
}
