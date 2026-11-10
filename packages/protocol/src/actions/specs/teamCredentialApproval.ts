import { TEAM_CREDENTIAL_ACTION_INPUT_SCHEMAS_V1, type TeamCredentialHomeActionIdV1 } from '../../teams/credentials/actionsV1.js';
import { TeamCredentialResourceEntitledPageV1Schema, type TeamCredentialResourceAudienceInputV1 } from '../../teams/credentials/resourceV1.js';
import { TeamSummaryV1Schema, TeamsPageV1Schema } from '../../teams/projections.js';
import type { ActionExecutorContext, ActionExecutorDeps } from '../executor/types.js';
import { readRecord } from '../../inputs/inputRecords.js';
import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from 'zod/mini';
import { normalizeConnectedServiceSelectionInput, resolveFanoutConnectedServicesSelections } from '../../connect/normalizeConnectedServiceSelectionInput.js';

export type TeamCredentialSourceRef = Readonly<{ resourceId: string; teamId?: string }>;
export type TeamCredentialSourceSelection = Readonly<{ serverId?: string; resources: readonly TeamCredentialSourceRef[] }>;

/** Public names captured by the recipient catalog owner, never credential or routing authority. */
export const TeamCredentialApprovalSourceSchema = lazyZodSchema(() => z.strictObject({
  teamId: z.string(), resourceId: z.string(), teamName: z.string(), accountName: z.string(),
}));
export type TeamCredentialApprovalSource = z.infer<typeof TeamCredentialApprovalSourceSchema>;

export function readTeamCredentialApprovalSources(preview: unknown): readonly TeamCredentialApprovalSource[] {
  const parsed = z.array(TeamCredentialApprovalSourceSchema).safeParse(readRecord(preview).teamCredentialSources);
  return parsed.success ? parsed.data : [];
}

/** The owning start spec calls this on its admitted Session/engine selections. */
export function selectTeamCredentialSourcesForApproval(input: unknown): TeamCredentialSourceSelection {
  const selection = readRecord(input);
  const refs = new Map<string, TeamCredentialSourceRef>();
  const add = (value: unknown) => {
    const ref = readRecord(value);
    if (typeof ref.resourceId === 'string') refs.set(ref.resourceId, { resourceId: ref.resourceId,
      ...(typeof ref.teamId === 'string' ? { teamId: ref.teamId } : {}) });
  };
  add(selection.teamCredentialModel);
  if (Array.isArray(selection.teamCredentialBindings)) selection.teamCredentialBindings.forEach(add);
  const connected = (bindings: unknown) => {
    for (const binding of Object.values(readRecord(readRecord(bindings).bindingsByServiceId))) {
      if (readRecord(binding).source === 'team_resource' && !refs.has(String(readRecord(binding).resourceId))) add(binding);
    }
  };
  if (Array.isArray(selection.backendTargetKeys)) {
    const selected = resolveFanoutConnectedServicesSelections(selection, selection.backendTargetKeys);
    if (selected.ok) for (const target of selected.selections.values()) connected(target.bindings);
  } else {
    const selected = normalizeConnectedServiceSelectionInput(selection.connectedServices);
    if (selected.ok) connected(selected.bindings);
  }
  const serverId = readRecord(selection.executionTarget).serverId;
  return { ...(typeof serverId === 'string' ? { serverId } : {}), resources: [...refs.values()] };
}

export function appendTeamCredentialSourceSummary(summary: string, sources: readonly TeamCredentialApprovalSource[]): string {
  return sources.length ? `${summary}\n\n${sources.map(source => `Uses ${source.teamName}’s shared ${source.accountName}.`).join(' ')}` : summary;
}

/** Read public source labels before admission. This never selects delivery or acquires material. */
export async function prepareTeamCredentialSources(params: Readonly<{ deps: Pick<ActionExecutorDeps, 'homeDomainAction'>;
  selection: TeamCredentialSourceSelection | undefined; context: ActionExecutorContext }>): Promise<readonly TeamCredentialApprovalSource[]> {
  const selection = params.selection;
  const refs = selection?.resources ?? [];
  if (!refs.length) return [];
  const serverId = selection?.serverId ?? params.context.serverId;
  const presentation = params.context.teamCredentialPresentation;
  const known = presentation && presentation.serverId === serverId ? presentation.sources : [];
  const sources: TeamCredentialApprovalSource[] = [];
  const teamNames = new Map<string, string>();
  let memberTeamsRead = false;
  const read = async (actionId: 'teams.get' | 'teams.list' | 'teams.credentials.entitled.list', input: unknown) => {
    params.context.signal?.throwIfAborted();
    return params.deps.homeDomainAction?.({ actionId, input,
      context: { ...params.context, ...(serverId ? { serverId } : {}) }, signal: params.context.signal });
  };
  for (const ref of refs) {
    const captured = known.find(source => source.resourceId === ref.resourceId && (!ref.teamId || source.teamId === ref.teamId));
    if (captured) { sources.push(captured); continue; }
    if (!params.deps.homeDomainAction) continue;
    try {
      if (ref.teamId && !teamNames.has(ref.teamId)) {
        const team = TeamSummaryV1Schema.safeParse(await read('teams.get', { teamId: ref.teamId }));
        if (team.success && team.data.id === ref.teamId) teamNames.set(team.data.id, team.data.name);
      } else if (!ref.teamId && !memberTeamsRead) {
        let cursor: string | null = null;
        do {
          const page = TeamsPageV1Schema.safeParse(await read('teams.list', { v: 1, scope: 'member', archived: 'active', ...(cursor ? { cursor } : {}) }));
          if (!page.success) break;
          for (const team of page.data.items) teamNames.set(team.id, team.name);
          cursor = page.data.nextCursor;
        } while (cursor);
        memberTeamsRead = true;
      }
      for (const teamId of ref.teamId ? [ref.teamId] : teamNames.keys()) {
        const teamName = teamNames.get(teamId);
        if (!teamName) continue;
        let cursor: string | null = null;
        do {
          const page = TeamCredentialResourceEntitledPageV1Schema.safeParse(await read('teams.credentials.entitled.list', {
            teamId, resourceId: ref.resourceId, ...(cursor ? { cursor } : {}),
          }));
          if (!page.success) break;
          const resource = page.data.resources.find(resource => resource.id === ref.resourceId && resource.teamId === teamId);
          if (resource) { sources.push({ teamId, resourceId: resource.id, teamName, accountName: resource.displayName }); break; }
          cursor = page.data.nextCursor;
        } while (cursor);
        if (sources.some(source => source.resourceId === ref.resourceId)) break;
      }
    } catch {
      // Optional display context cannot add a credential authority or another admission failure.
      params.context.signal?.throwIfAborted();
    }
  }
  return sources;
}

function hasNativeAudience(input: Partial<TeamCredentialResourceAudienceInputV1>): boolean {
  return input.allMembersAllowedRoutes?.includes('vendor-native') === true
    || input.groupGrants?.some(grant => grant.allowedRoutes.includes('vendor-native')) === true
    || input.memberGrants?.some(grant => grant.allowedRoutes.includes('vendor-native')) === true;
}

/** Native export consent reaches the same Action admission on every surface.
 * Reversible metadata and existing broker/direct editor review keep their policy. */
function readTeamCredentialMutationDisclosure(actionId: TeamCredentialHomeActionIdV1, input: unknown): 'native' | 'none' | 'invalid' {
  switch (actionId) {
    case 'teams.credentials.create': {
      const parsed = TEAM_CREDENTIAL_ACTION_INPUT_SCHEMAS_V1[actionId].safeParse(input);
      if (!parsed.success) return 'invalid';
      return parsed.data.deliveryPolicy.preferredAllowedModes.includes('vendor-native')
        || hasNativeAudience(parsed.data) ? 'native' : 'none';
    }
    case 'teams.credentials.update': {
      const parsed = TEAM_CREDENTIAL_ACTION_INPUT_SCHEMAS_V1[actionId].safeParse(input);
      if (!parsed.success) return 'invalid';
      return parsed.data.deliveryPolicy?.preferredAllowedModes.includes('vendor-native') === true
        || parsed.data.replacement?.custodian?.deliveryPolicy.preferredAllowedModes.includes('vendor-native') === true
        || (parsed.data.replacement !== undefined && hasNativeAudience(parsed.data.replacement)) ? 'native' : 'none';
    }
    case 'teams.credentials.audience.set': {
      const parsed = TEAM_CREDENTIAL_ACTION_INPUT_SCHEMAS_V1[actionId].safeParse(input);
      if (!parsed.success) return 'invalid';
      return hasNativeAudience(parsed.data) ? 'native' : 'none';
    }
    default: return 'invalid';
  }
}

export function teamCredentialMutationRequiresUiConfirmation(actionId: TeamCredentialHomeActionIdV1, input: unknown): boolean {
  return readTeamCredentialMutationDisclosure(actionId, input) !== 'none';
}

export function teamCredentialNativeDisclosureApprovalSummary(actionId: TeamCredentialHomeActionIdV1, input: unknown): string | null {
  if (readTeamCredentialMutationDisclosure(actionId, input) !== 'native') return null;
  return 'Native delivery may disclose the selected credential key to the vendor’s control plane, separate from the provisioning token. The source custodian and vendor remain trusted. Installed requests bypass Happier’s per-request authorization, body/model policy and request, token or cost limits. Vendor matchers narrow key substitution; they do not inspect model JSON or deny unmatched requests. Configure budgets and key restrictions at the Gateway/vendor; coverage is not verified here. Installed rules may continue while the controller is offline, when changes and removal cannot be guaranteed. Upstream key rotation or revocation is the independent hard stop; previously disclosed bytes cannot be recalled. Attribution is observational, not authenticated member identity or chargeback. Members sharing an OS user can read and reuse each other’s placeholders; these are not private between members.';
}
