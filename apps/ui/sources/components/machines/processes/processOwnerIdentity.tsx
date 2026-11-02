import * as React from 'react';
import { readSessionPresentationAgentId } from '@/sync/domains/session/presentation/readSessionPresentationAgentId';
import type {
  OwnerRowV1,
  ProcessRowV1,
} from '@happier-dev/protocol/machines/processes/machineProcessesV1';
import { useUnistyles } from 'react-native-unistyles';

import { MachineAgentMark } from '@/components/machines/agents/MachineAgentMark';
import { Icon, type IconName } from '@/components/ui/icons/Icon';
import { useSession } from '@/sync/store/hooks';
import { t } from '@/text';
import { usePreferredLanguage } from '@/text/usePreferredLanguage';
import { useSessionDisplayTitles } from '@/utils/sessions/sessionDisplayTitle';
import { useSessionStatus } from '@/utils/sessions/sessionUtils';

/**
 * Who a process row belongs to, in the app's own words (plan 30 §10.1 "Owner identity"): sessions are named
 * by the session title owner and marked by their agent from the Agent catalog; their status word is the
 * canonical session status presenter's. Nothing here re-derives a status rule.
 */

/**
 * A process in plain words first: its browser engine, else the name the daemon knows it by ("Vite", the Agent's
 * or MCP server's catalog name), else what it does ("Type checker"), else its native name. The command follows
 * in mono where it is shown.
 */
export function describeProcessTitle(
  row: Pick<ProcessRowV1, 'role' | 'name' | 'browserEngine' | 'displayName'>,
): string {
  if (row.browserEngine) return { chromium: 'Chromium', firefox: 'Firefox', webkit: 'WebKit' }[row.browserEngine];
  if (row.displayName) return row.displayName;
  return row.role ? t(`machineProcesses.roles.${row.role}`) : row.name;
}

/**
 * What a row named by `displayName` also is, so two "Node" or "Agent" rows stay tellable apart: its role in
 * words and its native process name ("Dev server · node"). Rows titled by their role or name already say it.
 */
export function describeProcessIdentity(
  row: Pick<ProcessRowV1, 'role' | 'name' | 'browserEngine' | 'displayName'>,
): string | null {
  if (row.browserEngine || !row.displayName) return null;
  const parts = [row.role ? t(`machineProcesses.roles.${row.role}`) : null, row.name]
    .filter((part): part is string => part !== null && part !== row.displayName);
  return parts.length > 0 ? parts.join(' · ') : null;
}

function rootOf(owner: OwnerRowV1): ProcessRowV1 | null {
  return (
    owner.members.find((row) => row.parentRowId === owner.rowId) ??
    owner.members[0] ??
    null
  );
}

/** The name an owner gets when the app has nothing better: its kind and the process at its root. */
export function describeOwnerFallbackTitle(owner: OwnerRowV1): string {
  const root = rootOf(owner);
  const name = root ? describeProcessTitle(root) : '';
  switch (owner.owner.kind) {
    case 'session':
      // A guest's session names whose it is; one of the viewer's own not loaded here yet is just a session.
      if (!owner.requester) return t('machineProcesses.owners.session');
      return owner.requester.displayName
        ? t('machineProcesses.owners.someonesSession', { name: owner.requester.displayName })
        : t('machineProcesses.owners.anotherAccount');
    case 'terminal':
      // A census without the shell's name says just "Terminal", never "Terminal · ".
      return root?.name
        ? t('machineProcesses.owners.terminal', { name: root.name })
        : t('machineDetailPage.subPages.terminal');
    case 'service':
      return name
        ? t('machineProcesses.owners.service', { name })
        : owner.owner.serviceId;
    case 'container':
      return t('machineProcesses.owners.service', { name: owner.owner.composeService });
    case 'run':
      return t('machineProcesses.owners.run', { name });
    case 'browser_sidecar':
      return t('machineProcesses.owners.browserSidecar');
    case 'workspace_sync':
      return t('machineProcesses.owners.workspaceSync');
    case 'happier':
      return owner.owner.component
        ? t(`machineProcesses.owners.components.${owner.owner.component}`)
        : t('machineProcesses.owners.happier');
  }
}

/** Every owner's title through one session-title subscription (the store owner batches the reads). */
export function useProcessOwnerTitles(
  owners: readonly OwnerRowV1[] | undefined,
  serverId: string,
): ReadonlyMap<string, string> {
  const language = usePreferredLanguage();
  const sessions = React.useMemo(
    () =>
      (owners ?? []).flatMap((owner) =>
        owner.owner.kind === 'session'
          ? [{ rowId: owner.rowId, sessionId: owner.owner.sessionId, serverId }]
          : [],
      ),
    [owners, serverId],
  );
  const titles = useSessionDisplayTitles(sessions);
  return React.useMemo(() => {
    const byRow = new Map<string, string>();
    sessions.forEach((session, index) => {
      const title = titles[index];
      if (title) byRow.set(session.rowId, title);
    });
    for (const owner of owners ?? [])
      if (!byRow.has(owner.rowId))
        byRow.set(owner.rowId, describeOwnerFallbackTitle(owner));
    return byRow;
  }, [language, owners, sessions, titles]);
}

const OWNER_ICONS: Readonly<
  Record<Exclude<OwnerRowV1['owner']['kind'], 'session'>, IconName>
> = {
  terminal: 'terminal',
  service: 'cube',
  container: 'cube',
  run: 'play',
  browser_sidecar: 'globe',
  workspace_sync: 'arrows-clockwise',
  happier: 'crosshair',
};

/** The owner's mark: a session's agent brand (no tile behind it), else the kind's glyph in secondary ink. */
export const ProcessOwnerMark = React.memo(function ProcessOwnerMark(
  props: Readonly<{
    owner: OwnerRowV1['owner'];
    serverId: string;
    machineId: string;
    size?: number;
  }>,
) {
  const { theme } = useUnistyles();
  const size = props.size ?? 16;
  if (props.owner.kind === 'session') {
    return (
      <SessionOwnerMark
        sessionId={props.owner.sessionId}
        serverId={props.serverId}
        machineId={props.machineId}
        size={size}
      />
    );
  }
  return (
    <Icon
      name={OWNER_ICONS[props.owner.kind]}
      size={size}
      color={theme.colors.text.secondary}
    />
  );
});

function SessionOwnerMark(
  props: Readonly<{
    sessionId: string;
    serverId: string;
    machineId: string;
    size: number;
  }>,
) {
  const { theme } = useUnistyles();
  const session = useSession(props.sessionId, props.serverId);
  const agentId = session
    ? readSessionPresentationAgentId(session)
    : null;
  if (!agentId)
    return (
      <Icon
        name="chat-circle"
        size={props.size}
        color={theme.colors.text.secondary}
      />
    );
  return (
    <MachineAgentMark
      agentId={agentId}
      machineId={props.machineId}
      serverId={props.serverId}
      size={props.size}
    />
  );
}

const ROLE_ICONS: Partial<Record<NonNullable<ProcessRowV1['role']>, IconName>> =
  {
    tool_shell: 'terminal',
    dev_server: 'cube',
    browser: 'globe',
    database: 'hard-drives',
  };

/** A process's glyph: the few roles a person recognises by shape; everything else is a quiet dot. */
export function processGlyphName(role: ProcessRowV1['role']): IconName | null {
  return role ? (ROLE_ICONS[role] ?? null) : null;
}

export type ProcessOwnerStatus = Readonly<{
  text: string;
  color: string | null;
}>;

/**
 * A session owner's status word from the canonical presenter ("Working", "Needs you" in its tone); quiet
 * states say nothing. Other owners have no live status here and return `null`.
 */
export function useProcessOwnerStatus(
  owner: OwnerRowV1['owner'],
  serverId: string,
): ProcessOwnerStatus | null {
  const { theme } = useUnistyles();
  const sessionId = owner.kind === 'session' ? owner.sessionId : '';
  const session = useSession(sessionId, serverId);
  const status = useSessionStatus(session, {
    workingTextMode: 'static',
    subscribeToTranscript: false,
  });
  if (!status || !status.shouldShowStatus) return null;
  const quietColors = [
    theme.colors.status.connected,
    theme.colors.status.default,
  ];
  return {
    text: status.statusText,
    color: quietColors.includes(status.statusColor) ? null : status.statusColor,
  };
}
