import type { PluginChangePendingSurface } from '@/plugins/daemon/changeContract';
import {
  formatPluginDiagnosticSourceLocation,
  type PluginDiagnosticSourceLocation,
} from '@/plugins/validation/diagnostics/sourceLocation';

export type PluginAuthoringDiagnostic = Readonly<{
  code: string;
  message: string;
  /**
   * Where in the author's own project the failure is, relative to its root.
   * Present only when the producing stage resolved one for a locally trusted
   * development project; a diagnostic from any other realm carries text only.
   */
  source?: PluginDiagnosticSourceLocation;
  /** Root-rebased and redacted; carried for `--json` consumers, not human text. */
  stack?: string;
}>;

/**
 * The author-facing lifecycle stages the CLI can actually observe, in order.
 *
 * `loaded` and `rendered` are deliberately absent. No daemon-visible producer
 * for either exists in current bytes — the only acknowledgement is
 * renderer-local React state inside the mounted surface — so a CLI that named
 * them would be advertising a stage it cannot observe. Authoring diagnostics
 * therefore stop at `projected`; an actual loaded surface is live-QA evidence,
 * never a CLI claim.
 */
const PLUGIN_AUTHORING_STAGES = Object.freeze([
  'source_validated',
  'built',
  'package_validated',
  'admitted',
  'projected',
] as const);

export type PluginAuthoringStage = typeof PLUGIN_AUTHORING_STAGES[number];

export type PluginAuthoringStageReport = Readonly<{
  ok: boolean;
  /** The furthest stage actually reached, or the stage that failed. */
  stage: PluginAuthoringStage;
  diagnostics: readonly PluginAuthoringDiagnostic[];
  /**
   * Present only when a previously admitted generation is KNOWN to remain
   * current — i.e. this session already admitted one and the current attempt
   * never replaced it. Absent is "unknown", never "there was none".
   */
  retainedGeneration?: string;
  generation?: Readonly<{
    desired: string | null;
    applied: string | null;
    pendingSurfaces: readonly PluginChangePendingSurface[];
  }>;
}>;

function report(value: PluginAuthoringStageReport): PluginAuthoringStageReport {
  return Object.freeze({ ...value, diagnostics: Object.freeze([...value.diagnostics]) });
}

/** A stage the CLI attempted and failed. Nothing later than `stage` is claimed. */
export function pluginAuthoringStageFailure(params: Readonly<{
  stage: PluginAuthoringStage;
  diagnostics: readonly PluginAuthoringDiagnostic[];
  retainedGeneration?: string;
}>): PluginAuthoringStageReport {
  return report({
    ok: false,
    stage: params.stage,
    diagnostics: params.diagnostics,
    ...(params.retainedGeneration ? { retainedGeneration: params.retainedGeneration } : {}),
  });
}

/**
 * A stage the CLI completed and made no claim beyond. Used where the operation
 * succeeded but exposes no further observable fact — a packed lifecycle that
 * validated the package, or an accepted development candidate whose caller
 * supplied no generation identity to project from.
 */
export function pluginAuthoringStageReached(
  stage: PluginAuthoringStage,
): PluginAuthoringStageReport {
  return report({ ok: true, stage, diagnostics: [] });
}

/**
 * Project the daemon's committed change facts onto the stage vocabulary.
 *
 * `admitted` means the daemon accepted the new immutable generation.
 * `projected` additionally requires that it became the applied generation and
 * that no surface reconciliation is still outstanding — that pair IS the
 * "current projection contains the expected generation" fact. Retirement and
 * cleanup surfaces concern the superseded generation and do not hold the new
 * projection back.
 *
 * `ok` means the CLI reached its ceiling (`projected`). An admitted-but-not-yet
 * projected generation is a real partial outcome and reports `ok: false` with
 * the stage it actually reached — never a success that conflates the two.
 */
export function projectPluginAuthoringAdmission(params: Readonly<{
  desiredGeneration: string | null;
  appliedGeneration: string | null;
  pendingSurfaces: readonly PluginChangePendingSurface[];
}>): PluginAuthoringStageReport {
  const generation = Object.freeze({
    desired: params.desiredGeneration,
    applied: params.appliedGeneration,
    pendingSurfaces: Object.freeze([...params.pendingSurfaces]),
  });
  const applied = params.appliedGeneration !== null
    && params.appliedGeneration === params.desiredGeneration;
  const reconciling = params.pendingSurfaces.includes('reconciliation');
  if (applied && !reconciling) {
    return report({ ok: true, stage: 'projected', diagnostics: [], generation });
  }
  return report({
    ok: false,
    stage: 'admitted',
    diagnostics: [{
      code: 'plugin_dev_adoption_pending',
      message: applied
        ? 'The daemon admitted the generation; surface reconciliation is still pending.'
        : 'The daemon admitted the generation but has not made it current yet.',
    }],
    generation,
  });
}

/**
 * The one human rendering of a stage report. Human text and `--json` output are
 * projections of this same value, so they cannot drift.
 */
export function describePluginAuthoringStageReport(
  value: PluginAuthoringStageReport,
): readonly string[] {
  const lines: string[] = [
    value.ok
      ? `Stage: ${value.stage}`
      : `Stage: ${value.stage} (failed)`,
  ];
  if (value.generation) {
    lines.push(`  Generation: ${value.generation.applied ?? 'none'}`);
    if (value.generation.pendingSurfaces.length > 0) {
      lines.push(`  Pending: ${value.generation.pendingSurfaces.join(', ')}`);
    }
  }
  if (value.retainedGeneration) {
    lines.push(`  Retained previous generation: ${value.retainedGeneration}`);
  }
  for (const diagnostic of value.diagnostics) {
    lines.push(`  ${diagnostic.code}: ${diagnostic.message}`);
    if (diagnostic.source) {
      lines.push(`    at ${formatPluginDiagnosticSourceLocation(diagnostic.source)}`);
    }
  }
  return Object.freeze(lines);
}
