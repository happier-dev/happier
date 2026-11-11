import { resolveAccountDisplayLabelV1 } from '../../account/accountDisplayProfileV1.js';
import { HomeAccountSearchResultV1Schema } from '../../home/governance/accounts.js';
import { readRecord } from '../../inputs/inputRecords.js';
import { TeamMemberAddInputV1Schema } from '../../teams/membership.js';
import { TeamSummaryV1Schema } from '../../teams/projections.js';
import type { ActionExecutorContext, ActionExecutorDeps } from '../executor/types.js';

/** Recipient-safe names captured by the exact Home's authorized Team/picker readers. */
export type TeamMemberApprovalPresentation = Readonly<{
  teamId: string; accountId: string; teamName: string; accountName: string;
}>;

/** Retained previews may supply labels only for the operands this request actually carries. */
export function readTeamMemberApprovalPresentation(preview: unknown, input: unknown): TeamMemberApprovalPresentation | null {
  const facts = readRecord(readRecord(preview).teamMemberPresentation);
  const operands = readRecord(input);
  return facts.teamId === operands.teamId && facts.accountId === operands.accountId
    && typeof facts.teamId === 'string' && typeof facts.accountId === 'string'
    && typeof facts.teamName === 'string' && Boolean(facts.teamName.trim())
    && typeof facts.accountName === 'string' && Boolean(facts.accountName.trim())
    ? { teamId: facts.teamId, accountId: facts.accountId, teamName: facts.teamName, accountName: facts.accountName }
    : null;
}

export async function prepareTeamMemberApprovalPresentation(params: Readonly<{
  deps: Pick<ActionExecutorDeps, 'homeDomainAction'>; input: unknown; context: ActionExecutorContext;
}>): Promise<TeamMemberApprovalPresentation | null> {
  const input = TeamMemberAddInputV1Schema.safeParse(params.input);
  const read = params.deps.homeDomainAction;
  if (!input.success || !read) return null;
  try {
    const [teamValue, accountsValue] = await Promise.all([
      read({ actionId: 'teams.get', input: { teamId: input.data.teamId }, context: params.context, signal: params.context.signal }),
      read({ actionId: 'home.accounts.search', input: { query: input.data.accountId,
        scope: { kind: 'team', teamId: input.data.teamId } }, context: params.context, signal: params.context.signal }),
    ]);
    const team = TeamSummaryV1Schema.safeParse(teamValue);
    const accounts = HomeAccountSearchResultV1Schema.safeParse(accountsValue);
    const account = accounts.success ? accounts.data.accounts.find(account => account.accountId === input.data.accountId) : null;
    const accountName = account ? resolveAccountDisplayLabelV1(account.profile) : null;
    return team.success && team.data.id === input.data.teamId && accountName
      ? { teamId: input.data.teamId, accountId: input.data.accountId, teamName: team.data.name, accountName }
      : null;
  } catch {
    // Display data does not add an effect-admission requirement; the Home still owns the mutation.
    params.context.signal?.throwIfAborted();
    return null;
  }
}
