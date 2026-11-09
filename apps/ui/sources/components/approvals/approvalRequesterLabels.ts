import type { ApprovalRequest } from '@happier-dev/protocol/approvals/approvalRequestV1';
import { getAgentCore } from '@/agents/catalog/catalog';
import { formatAgentLikeIdForDisplay } from '@/agents/catalog/formatAgentLikeIdForDisplay';
import { resolveHomeDisplayName } from '@/components/settings/server/homeDisplayName';
import { getServerProfileById } from '@/sync/domains/server/serverProfiles';
import { t } from '@/text';

/**
 * How an approval names who asked, for every approval surface (the Inbox row, the page's "Requested
 * by" section and its Details rows). A request stores hosts, surface enums and ids; a person reads
 * the Home's name, the way the request arrived, and a session by its name or, when this device does
 * not have that session, by where it lives.
 */

/** The Home's own name as the app says it everywhere; never its address. */
export function resolveApprovalHomeName(
  serverId: string | null | undefined,
): string | null {
  const id = serverId?.trim();
  return id ? resolveHomeDisplayName(getServerProfileById(id)) : null;
}

/**
 * The Home as a sentence names it: its own name, else "this Home" for a Home this device is signed in
 * to but never named, else null for a Home this device has no profile for.
 */
export function resolveApprovalHomeSentenceName(
  serverId: string | null | undefined,
): string | null {
  const id = serverId?.trim();
  if (!id) return null;
  return (
    resolveApprovalHomeName(id) ??
    (getServerProfileById(id) ? t('settingsAccount.thisHome') : null)
  );
}

/**
 * A session this device cannot name: it says where the session lives instead of showing its id. Only
 * a Home this device has no profile for is "not on this device".
 */
export function describeUnnamedApprovalSession(
  homeName: string | null | undefined,
): string {
  const home = homeName?.trim();
  return home
    ? t('detailPages.approval.sessionOnHome', { home })
    : t('detailPages.approval.sessionElsewhere');
}

/**
 * The surface a request arrived through, read once for every approval surface: a current built-in
 * request records it on its immutable execution origin, an older one as its requested surface, and
 * any other family on its creator. The host stamps the agent surface on a Workflow Run's own Action,
 * so that caller reads as the Run, never as an agent that was not involved.
 */
export function readApprovalRequesterSurface(
  request: ApprovalRequest | Readonly<{ createdBy: Readonly<{ surface?: string }> }> | null,
  builtIn: boolean,
): string {
  if (!request) return '';
  if (!builtIn) return request.createdBy.surface ?? '';
  const approval = request as ApprovalRequest;
  if (approval.v !== 2) return approval.requestedSurface ?? '';
  return approval.executionOriginV1.caller.kind === 'workflowRun'
    ? 'workflow_run'
    : approval.executionOriginV1.surface;
}

/**
 * Happier Guard asked: its Left behind Ask is created by the daemon's host on the system surface (no plugin, no
 * agent). It may still name the Session whose work it concerns; that Session did not ask.
 */
export function isHappierGuardApproval(
  request: ApprovalRequest | Readonly<{ createdBy: Readonly<{ surface?: string }> }> | null,
  builtIn: boolean,
): boolean {
  if (!request || !builtIn) return false;
  const approval = request as ApprovalRequest;
  return approval.v === 2 && approval.createdBy.surface === 'system' && !approval.createdBy.pluginId
    && approval.actionId === 'machines.processes.leftBehind.cleanUp'
    && approval.executionOriginV1.caller.kind === 'host';
}

/**
 * The requester line for a session this device cannot name. A request the person made themselves
 * from the app is theirs, so it reads as "You" rather than as a session they did not ask through.
 */
export function describeUnnamedApprovalRequester(
  surface: string | null | undefined,
  homeName: string | null | undefined,
): string {
  return surface?.trim() === 'ui'
    ? t('detailPages.approval.requesterYou')
    : describeUnnamedApprovalSession(homeName);
}

const ORIGIN_LABEL_KEYS = {
  voice: 'detailPages.approval.origin.voice',
  agent: 'detailPages.approval.origin.agent',
  session_agent: 'detailPages.approval.origin.agent',
  mcp: 'detailPages.approval.origin.mcp',
  cli: 'detailPages.approval.origin.cli',
  ui: 'detailPages.approval.origin.ui',
  api: 'detailPages.approval.origin.api',
  plugin: 'detailPages.approval.origin.plugin',
  workflow_run: 'detailPages.approval.origin.workflowRun',
  system: 'detailPages.approval.origin.system',
} as const;

/** How the request arrived, in words; an origin this build does not know says nothing. */
export function describeApprovalOrigin(
  surface: string | null | undefined,
): string | null {
  const key =
    ORIGIN_LABEL_KEYS[
      (surface?.trim() ?? '') as keyof typeof ORIGIN_LABEL_KEYS
    ];
  return key ? t(key) : null;
}

/** The agent that asked, by its product name. */
export function describeApprovalAgent(
  agentId: string | null | undefined,
): string | null {
  const id = agentId?.trim();
  if (!id) return null;
  const core = getAgentCore(id as Parameters<typeof getAgentCore>[0]);
  return core ? t(core.displayNameKey) : formatAgentLikeIdForDisplay(id);
}
