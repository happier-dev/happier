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

/** A session this device cannot name: it says where the session lives instead of showing its id. */
export function describeUnnamedApprovalSession(
  homeName: string | null | undefined,
): string {
  const home = homeName?.trim();
  return home
    ? t('detailPages.approval.sessionOnHome', { home })
    : t('detailPages.approval.sessionElsewhere');
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
