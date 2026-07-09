import type {
  DaemonVoiceInferenceModelStatus,
  ModelPackCatalogEntry,
  ModelPackKind,
} from '@happier-dev/protocol';
import {
  getDefaultModelPackId,
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
  /** Resident memory reported by the daemon readiness snapshot, or null. */
  residentMemoryBytes: number | null;
  /** Daemon-reported install error message, or null. */
  lastError: string | null;
  /** Whether this pack is the selected default for its kind. */
  isDefault: boolean;
  /** Whether an install/retry action is offered for this row. */
  canInstall: boolean;
  /** Whether a remove action is offered for this row. */
  canRemove: boolean;
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
function deriveDisplayName(entry: ModelPackCatalogEntry): string {
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
  return getDefaultModelPackId(kind);
}

function buildRowsForKind(
  kind: ModelPackKind,
  statusByPackId: ReadonlyMap<string, DaemonVoiceInferenceModelStatus>,
  selectedPackId: string | null,
  statusUnavailable: boolean,
): readonly ModelCatalogRow[] {
  const defaultPackId = resolveDefaultPackId(kind, selectedPackId);
  return listModelPackCatalogEntries(kind).map((entry) => {
    const status = statusByPackId.get(entry.packId);
    const { state, progress } = statusUnavailable
      ? { state: 'unknown' as ModelCatalogRowState, progress: null }
      : resolveRowState(status);
    const installed = state === 'installed' || state === 'ready' || state === 'warming' || state === 'evicted';
    return {
      packId: entry.packId,
      kind: entry.kind,
      displayName: deriveDisplayName(entry),
      model: entry.model,
      state,
      progress,
      residentMemoryBytes:
        typeof status?.residentMemoryBytes === 'number' ? status.residentMemoryBytes : null,
      lastError: status?.lastError ?? null,
      isDefault: defaultPackId === entry.packId,
      canInstall: state === 'not_installed' || state === 'error',
      canRemove: installed,
    };
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
    stt: buildRowsForKind('stt_sherpa', statusByPackId, params.selectedSttPackId, statusUnavailable),
    tts: buildRowsForKind('tts_sherpa', statusByPackId, params.selectedTtsPackId, statusUnavailable),
  };
}
