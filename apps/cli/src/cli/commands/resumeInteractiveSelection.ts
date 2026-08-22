import type { AccountSettings } from '@happier-dev/protocol';

import {
  buildCliSessionRowModel,
  UNKNOWN_CLI_SESSION_AGENT_LABEL,
  type CliSessionRowModel,
} from '@/cli/output/session/buildCliSessionRowModel';
import type { StoredCredentials } from '@/persistence';
import type { ResolvedContributionRegistry } from '@/plugins/projection/registry/types';
import type { RawSessionListRow } from '@/session/transport/http/sessionsHttp';
import { compactHomePath } from '@/ui/format/styles';
import type { SessionActionSelectorRow } from '@/ui/ink/SessionActionSelector';

type FetchSessionsPageFn = (params: {
  token: string;
  cursor?: string;
  limit?: number;
  activeOnly?: boolean;
  archivedOnly?: boolean;
}) => Promise<{
  sessions: RawSessionListRow[];
  nextCursor: string | null;
  hasNext: boolean;
}>;

type ResumeContributionRegistry = Pick<ResolvedContributionRegistry, 'agentDefinitionsById'>;

export type ResumeSelectionFooterHint = Readonly<{
  ineligibleCount: number;
  resumableCount: number;
  activeRunningCount: number;
}>;

export type ResumeSelectionModel = Readonly<{
  rows: SessionActionSelectorRow[];
  hint: ResumeSelectionFooterHint;
}>;

type ResumeIneligibilityCategory =
  | 'vendor_resume_not_supported'
  | 'vendor_resume_id_missing'
  | 'experimental_disabled'
  | 'path_unknown'
  | 'unknown';

function classifyResumeIneligibility(rowModel: CliSessionRowModel): ResumeIneligibilityCategory {
  if (!rowModel.path) return 'path_unknown';
  if (rowModel.vendorResume.eligible) return 'unknown';
  switch (rowModel.vendorResume.reasonCode) {
    case 'agent_unsupported':
      return 'vendor_resume_not_supported';
    case 'vendor_resume_id_missing':
      return 'vendor_resume_id_missing';
    case 'experimental_disabled':
    case 'backend_disabled_by_account_settings':
      return 'experimental_disabled';
    default:
      return 'unknown';
  }
}

function shortReasonForResume(category: ResumeIneligibilityCategory): string {
  switch (category) {
    case 'vendor_resume_not_supported':
      return 'agent does not support resume';
    case 'vendor_resume_id_missing':
      return 'vendor resume id missing';
    case 'experimental_disabled':
      return 'resume disabled in settings';
    case 'path_unknown':
      return 'working directory missing';
    default:
      return 'cannot be resumed';
  }
}

function fullReasonForResume(category: ResumeIneligibilityCategory): string {
  switch (category) {
    case 'vendor_resume_not_supported':
      return 'This session agent does not support resume from the CLI.';
    case 'vendor_resume_id_missing':
      return 'The vendor resume id is missing from this session metadata.';
    case 'experimental_disabled':
      return 'Resume is disabled by your account settings.';
    case 'path_unknown':
      return 'This session has no working directory recorded; CLI resume needs one.';
    default:
      return 'This session cannot be resumed from this CLI.';
  }
}

function buildBaseRow(rowModel: CliSessionRowModel): SessionActionSelectorRow {
  const path = compactHomePath(rowModel.path) || rowModel.path || '';
  return {
    sessionId: rowModel.id,
    agentId: rowModel.agentId ?? UNKNOWN_CLI_SESSION_AGENT_LABEL,
    updatedAt: rowModel.updatedAt,
    title: [rowModel.tag, rowModel.title].filter((value) => typeof value === 'string' && value.trim().length > 0).join(' · '),
    path,
    annotation: null,
    probeable: false,
    disabled: false,
    disabledReason: null,
  };
}

export async function buildResumeSelectionModel(params: Readonly<{
  credentials: StoredCredentials;
  accountSettings: AccountSettings;
  fetchSessionsPageFn: FetchSessionsPageFn;
  contributionRegistry: ResumeContributionRegistry | null;
  accountEncryptionMode: 'plain' | 'e2ee';
}>): Promise<ResumeSelectionModel> {
  const page = await params.fetchSessionsPageFn({ token: params.credentials.token, limit: 200 });
  const rows: SessionActionSelectorRow[] = [];
  let activeRunningCount = 0;
  let ineligibleCount = 0;
  let resumableCount = 0;

  for (const rawSession of page.sessions) {
    const rowModel = buildCliSessionRowModel({
      credentials: params.credentials,
      accountEncryptionMode: params.accountEncryptionMode,
      rawSession,
      accountSettings: params.accountSettings,
      contributionRegistry: params.contributionRegistry,
    });
    if (rowModel.isSystem) continue;
    if (rowModel.archivedAt !== null) continue;
    if (rowModel.active === true) {
      activeRunningCount += 1;
      continue;
    }

    const baseRow = buildBaseRow(rowModel);
    if (rowModel.vendorResume.eligible && rowModel.path) {
      rows.push(baseRow);
      resumableCount += 1;
      continue;
    }

    const category = classifyResumeIneligibility(rowModel);
    ineligibleCount += 1;
    rows.push({
      ...baseRow,
      annotation: shortReasonForResume(category),
      disabled: true,
      disabledReason: fullReasonForResume(category),
    });
  }

  rows.sort((left, right) => {
    if (left.disabled !== right.disabled) return left.disabled ? 1 : -1;
    return right.updatedAt - left.updatedAt;
  });

  return {
    rows,
    hint: { ineligibleCount, resumableCount, activeRunningCount },
  };
}

export function formatResumeSelectionFooter(hint: ResumeSelectionFooterHint): string | null {
  const sessionWord = (count: number) => count === 1 ? 'session' : 'sessions';
  const fragments: string[] = [];
  if (hint.activeRunningCount > 0) {
    fragments.push(`${hint.activeRunningCount} ${sessionWord(hint.activeRunningCount)} running; use \`happier attach\` to attach a terminal.`);
  }
  if (hint.ineligibleCount > 0) {
    fragments.push(`${hint.ineligibleCount} ${sessionWord(hint.ineligibleCount)} cannot be resumed; see reasons above.`);
  }
  return fragments.length > 0 ? fragments.join(' ') : null;
}
