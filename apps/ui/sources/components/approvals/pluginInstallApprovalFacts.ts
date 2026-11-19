import { PluginChangePendingReviewResultSchema } from '@happier-dev/protocol/marketplace/internal';
import { readPluginInstallApprovalPendingReview } from '@happier-dev/protocol/actions/actionApprovalPresentation';
import { PluginInstallActionInputSchema } from '@happier-dev/protocol/actions/specs/pluginDevelopment';
import { resolveWorkspacePathBasenameV1 } from '@happier-dev/protocol/workspaces/workspaceRefResolutionV1';
import {
  describePluginContentOmissions,
  describePluginInstallConsent,
  type PluginInstallConsentScope,
} from '@/components/settings/plugins/model/pluginInstallationReviewFacts';
import { t } from '@/text';
import type { ApprovalActionFieldsPresentation } from './approvalFieldValues';

type ApprovalFieldRow = ApprovalActionFieldsPresentation['rows'][number];

/** Protocol's `describePluginInstallApprovalDisclosure` row: its `value` is the exact evaluated pending review. */
const PLUGIN_INSTALL_REVIEW_ROW_PATH = 'preview.pluginInstall.pendingReview';

function readPendingReview(row: ApprovalFieldRow) {
  if (row.kind !== 'value' || row.path !== PLUGIN_INSTALL_REVIEW_ROW_PATH) return null;
  try {
    const parsed = PluginChangePendingReviewResultSchema.safeParse(JSON.parse(row.value));
    return parsed.success && parsed.data.reviewKind === 'installation' ? parsed.data : null;
  } catch {
    return null;
  }
}

/**
 * What a plugin-install approval changes, from its own evaluated review: an Update of the installed plugin
 * (its new release asks for more than the installed one) or an install. Titles and decisions name it so.
 */
export function readPluginInstallApprovalChange(preview: unknown): 'install' | 'update' | null {
  const pendingReview = readPluginInstallApprovalPendingReview(preview);
  if (!pendingReview) return null;
  return pendingReview.reason === 'authorityExpansion' ? 'update' : 'install';
}

/**
 * What an install says it installs before its review names the plugin: the Store or installed plugin's
 * id, the npm package, or the folder or archive it reads.
 */
export function readPluginInstallSourceName(actionArgs: unknown): string | null {
  const parsed = PluginInstallActionInputSchema.safeParse(actionArgs);
  if (!parsed.success) return null;
  if ('source' in parsed.data) {
    const source = parsed.data.source;
    return source.kind === 'git' ? source.locator : source.kind === 'gitCatalog' ? source.itemId : source.pluginId;
  }
  return parsed.data.kind === 'npm' ? parsed.data.path : resolveWorkspacePathBasenameV1(parsed.data.path);
}

/**
 * The install's own source arguments wait in Technical details; the consent names the plugin. A local
 * install passes `path`/`kind`/`dev`; a Store install and an installed plugin's Update pass one `source` selector.
 */
const PLUGIN_INSTALL_SOURCE_ARGUMENT_PATHS: ReadonlySet<string> = new Set(['path', 'kind', 'dev', 'source']);

const SCOPE_TITLE_KEY = {
  requiredHostAccess: 'settingsPlugins.installReviewSections.requiredAccess',
  connectedAccountPurpose: 'settingsPlugins.installReviewSections.requiredAccess',
  selectedOptionalHostAccess: 'settingsPlugins.installReviewSections.optionalAccess',
  requestInterceptor: 'settingsPlugins.installReviewSections.requestInterceptors',
  rawCredentialAccess: 'settingsPlugins.installReviewSections.rawCredentials',
} as const satisfies Record<PluginInstallConsentScope, string>;

/**
 * The consent a plugin install asks for, as titled facts: the plugin (its release, the version it replaces,
 * its publisher), then what it uses, or for an update only what is new. One reading for every surface that
 * asks for this consent: the approval's fields and the combined review across several Machines.
 */
export function listPluginInstallConsentFacts(
  pendingReview: Parameters<typeof describePluginInstallConsent>[0],
): readonly Readonly<{ key: string; title: string; value: string }>[] {
  const consent = describePluginInstallConsent(pendingReview);
  const { source, notImported } = pendingReview.review;
  const omissions = describePluginContentOmissions(notImported);
  const labelsByTitleKey = new Map<string, string[]>();
  for (const use of consent.uses) {
    const key = SCOPE_TITLE_KEY[use.scope];
    labelsByTitleKey.set(key, [...(labelsByTitleKey.get(key) ?? []), use.label]);
  }
  return [
    {
      key: 'identity',
      title: t('settingsPlugins.installReviewSections.identity'),
      value: [
        `${consent.pluginName} · ${consent.version}`,
        ...(consent.currentVersion ? [`${consent.currentVersion} → ${consent.version}`] : []),
        ...(consent.publisher
          ? [t('settingsPlugins.installReviewSections.publisherUnverified', consent.publisher)]
          : []),
      ].join('\n'),
    },
    ...(source.kind === 'git' ? [{ key: 'git', title: t('settingsPlugins.gitInstall.mode'),
      value: [source.locator, source.subdirectory, source.resolvedCommit].filter(Boolean).join('\n') }] : []),
    ...(omissions.length ? [{ key: 'notImported', title: t('settingsPlugins.gitInstall.notImported'), value: omissions.join('\n') }] : []),
    ...[...labelsByTitleKey].map(([key, labels]) => ({
      key,
      title: t(key as (typeof SCOPE_TITLE_KEY)[PluginInstallConsentScope]),
      value: labels.join(', '),
    })),
  ];
}

/**
 * A plugin-install approval reads as the same simple install consent the in-place Store prompt
 * shows (one facts owner): the plugin, its publisher and what it uses, or only what an update newly
 * asks for. The evaluated structure stays one disclosure away in Technical details.
 */
export function presentPluginInstallApprovalRows(
  rows: readonly ApprovalFieldRow[],
): readonly ApprovalFieldRow[] {
  if (!rows.some((row) => row.kind === 'value' && row.path === PLUGIN_INSTALL_REVIEW_ROW_PATH)) return rows;
  return rows.flatMap((row): ApprovalFieldRow[] => {
    if (row.kind === 'value' && PLUGIN_INSTALL_SOURCE_ARGUMENT_PATHS.has(row.path)) {
      return [{ ...row, technical: true }];
    }
    const pendingReview = readPendingReview(row);
    if (!pendingReview || row.kind !== 'value') return [row];
    const consent = describePluginInstallConsent(pendingReview);
    return [
      ...listPluginInstallConsentFacts(pendingReview).map((fact): ApprovalFieldRow => ({
        kind: 'value',
        path: `${row.path}#${fact.key}`,
        title: fact.title,
        value: fact.value,
      })),
      {
        ...row,
        title: consent.pluginName,
        technical: true,
        entries: row.entries?.map((entry) =>
          entry.value === null ? entry : { ...entry, technical: true as const },
        ),
      },
    ];
  });
}
