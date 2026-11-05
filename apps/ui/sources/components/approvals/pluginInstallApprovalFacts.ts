import { PluginInstallActionInputSchema } from '@happier-dev/protocol/actions/specs/pluginDevelopment';
import { resolveWorkspacePathBasenameV1 } from '@happier-dev/protocol/workspaces/workspaceRefResolutionV1';
import { PluginInstallationReviewSchema } from '@happier-dev/protocol/marketplace/internal';
import {
  describePluginInstallationReviewFacts,
  listPluginInstallationReviewFactSections,
} from '@/components/settings/plugins/model/pluginInstallationReviewFacts';
import type { ApprovalActionFieldsPresentation } from './approvalFieldValues';

type ApprovalFieldRow = ApprovalActionFieldsPresentation['rows'][number];

/** Protocol's `describePluginInstallApprovalDisclosure` row: its `value` is the exact evaluated review. */
const PLUGIN_INSTALL_REVIEW_ROW_PATH =
  'preview.pluginInstall.pendingReview.review';

function readReview(row: ApprovalFieldRow) {
  if (row.kind !== 'value' || row.path !== PLUGIN_INSTALL_REVIEW_ROW_PATH)
    return null;
  try {
    const parsed = PluginInstallationReviewSchema.safeParse(
      JSON.parse(row.value),
    );
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/**
 * The install's own arguments that say where the plugin comes from. The review's Identity section
 * already states the source (and flags a development path), so these arguments are not a second,
 * differently worded statement of it: they wait in Technical details.
 */
const PLUGIN_INSTALL_SOURCE_ARGUMENT_PATHS: ReadonlySet<string> = new Set(['path', 'kind', 'dev']);

/**
 * A plugin-install approval reads as the same install-and-trust facts the Settings install review
 * shows (one presentation owner), one row per section. The evaluated structure itself stays one
 * disclosure away: every raw value moves to Technical details, keyed by where it sits.
 */
export function presentPluginInstallApprovalRows(
  rows: readonly ApprovalFieldRow[],
): readonly ApprovalFieldRow[] {
  if (
    !rows.some(
      (row) =>
        row.kind === 'value' && row.path === PLUGIN_INSTALL_REVIEW_ROW_PATH,
    )
  )
    return rows;
  return rows.flatMap((row): ApprovalFieldRow[] => {
    if (row.kind === 'value' && PLUGIN_INSTALL_SOURCE_ARGUMENT_PATHS.has(row.path)) {
      return [{ ...row, technical: true }];
    }
    const review = readReview(row);
    if (!review || row.kind !== 'value') return [row];
    const sections = listPluginInstallationReviewFactSections(
      describePluginInstallationReviewFacts(review),
    );
    return [
      ...sections.map((section): ApprovalFieldRow => ({
        kind: 'value',
        path: `${row.path}#${section.id}`,
        title: section.title,
        value: section.lines.join('\n'),
      })),
      {
        ...row,
        title: review.displayName,
        technical: true,
        entries: row.entries?.map((entry) =>
          entry.value === null ? entry : { ...entry, technical: true as const },
        ),
      },
    ];
  });
}

/**
 * What an install says it installs before its review names the plugin: the Store or installed plugin's
 * id, the npm package, or the folder or archive it reads.
 */
export function readPluginInstallSourceName(actionArgs: unknown): string | null {
  const parsed = PluginInstallActionInputSchema.safeParse(actionArgs);
  if (!parsed.success) return null;
  if ('source' in parsed.data) return parsed.data.source.pluginId;
  return parsed.data.kind === 'npm' ? parsed.data.path : resolveWorkspacePathBasenameV1(parsed.data.path);
}
