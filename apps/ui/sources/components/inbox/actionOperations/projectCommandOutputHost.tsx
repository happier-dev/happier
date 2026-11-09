import * as React from 'react';

import { parseProjectPaneScopeId } from '@/components/projects/detail/projectPaneScope';
import { parseSessionPaneScopeId } from '@/components/sessions/panes/sessionPaneScopeId';
import { EMPTY_TERMINAL_WORKSPACE } from '@/components/sessions/terminal/sessionTerminalWorkspace';
import { readSessionTerminalWorkspaceForScope, readVisibleSessionTerminalTabsForScope, subscribeSessionTerminalWorkspace } from '@/components/sessions/terminal/sessionTerminalWorkspaceRuntime';
import { useSessionTerminalActionExecute } from '@/components/sessions/terminal/useSessionTerminalWorkspace';
import type { ActionOperationProjection } from '@/sync/domains/actionOperations/actionOperationSelectors';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { useDeviceType } from '@/utils/platform/responsive';
import { createFrontDoorActionExecute } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';
import { storage } from '@/sync/domains/state/storage';
import { readProjectWorkspaceRefs } from '@/sync/store/domains/projectAccountRows';

import { openActionOperationDetail } from './openActionOperationDetail';
import { openProjectCommandOutputPage } from './ProjectCommandOutputPage';
import { readActionOperationOutputAttachment, readProjectCommandOutputWorkspace } from './actionOperationDetailPresentation';

/**
 * The pane scope whose bottom terminal shows a project command's output (plan 21 §2/§8). A host that
 * mounts a bottom terminal (the Project page, its rail, a Session's panel) provides its scope; hosts
 * without one (phone, Overview widgets) leave it absent and output opens in the operation detail.
 */
const ProjectCommandOutputHostContext = React.createContext<string | null>(
  null,
);

export function ProjectCommandOutputHost(
  props: Readonly<{
    scopeId: string | null | undefined;
    children: React.ReactNode;
  }>,
) {
  return (
    <ProjectCommandOutputHostContext.Provider value={props.scopeId ?? null}>
      {props.children}
    </ProjectCommandOutputHostContext.Provider>
  );
}

export type ProjectCommandOutputOpenOptions = Readonly<{
  /** The bottom tab's label: the script and its actual Machine ("test · hz-build-1"). */
  title: string;
  /** Opening on the user's own Run waits for the tab only; it never pops the detail by itself. */
  fallbackToDetail?: boolean;
  /** The command's own name ("test", "Setup"), titling its phone output page; defaults to `title`. */
  name?: string;
  /** What runs, as declared, for the phone output page. */
  command?: string | null;
}>;

function scopeServerId(scopeId: string): string | null {
  return (
    parseProjectPaneScopeId(scopeId)?.serverId ??
    parseSessionPaneScopeId(scopeId)?.address?.serverId ??
    null
  );
}

type OutputTerminalRef = Readonly<{ terminalId?: string | null; machineId: string; workspaceRefId?: string }>;

/** Retained PTY membership for explicit focus/open reuse, independent of pane visibility. */
function findOutputTerminalInHost(scopeId: string, attachment: OutputTerminalRef) {
  const workspace = readSessionTerminalWorkspaceForScope(
    scopeId,
    parseProjectPaneScopeId(scopeId) ? EMPTY_TERMINAL_WORKSPACE : undefined,
  );
  return workspace?.tabs
    .flatMap((tab) => tab.terminals)
    .find(
      (member) =>
        member.target.kind === 'terminal_view' &&
        member.target.terminalId === attachment.terminalId &&
        member.target.machineId === attachment.machineId &&
        (!attachment.workspaceRefId || member.target.workspace?.workspaceId === attachment.workspaceRefId),
    );
}

/**
 * Whether the host's terminal workspace already shows this command's PTY. One PTY has one surface on a
 * page: while the host tab shows it, inline output points there instead of mounting a second view.
 */
export function useProjectCommandOutputDocked(attachment: OutputTerminalRef | null): boolean {
  const scopeId = React.useContext(ProjectCommandOutputHostContext);
  const terminalId = attachment?.terminalId ?? null;
  const machineId = attachment?.machineId ?? null;
  const subscribe = subscribeSessionTerminalWorkspace;
  const read = React.useCallback(
    () => Boolean(scopeId && terminalId && machineId && readVisibleSessionTerminalTabsForScope(scopeId)
      .some(tab => tab.terminals.some(member => member.target.kind === 'terminal_view'
        && member.target.terminalId === terminalId && member.target.machineId === machineId))),
    [machineId, scopeId, terminalId],
  );
  return React.useSyncExternalStore(subscribe, read, read);
}

/**
 * Opens a project command's output where its host shows terminals: the same PTY as a borrowed,
 * read-only terminal tab, focused when it is already open there. Opening or closing the tab
 * never ensures, restarts or stops the process. On a phone a project command opens its output page;
 * otherwise it opens the operation detail.
 */
export function useProjectCommandOutputOpener() {
  const scopeId = React.useContext(ProjectCommandOutputHostContext);
  const phone = useDeviceType() === 'phone';
  const execute = useSessionTerminalActionExecute(scopeId ?? '');
  const open = React.useCallback(
    async (
      operation: ActionOperationProjection,
      options: ProjectCommandOutputOpenOptions,
    ): Promise<boolean> => {
      let openedInTerminal = false;
      const present = async (address: Readonly<{ operation: ActionOperationProjection['snapshot'] }>) => {
        const attachment = readActionOperationOutputAttachment(address.operation);
        const server = scopeId ? scopeServerId(scopeId) : null;
        const workspace = attachment?.kind === 'projectCommand'
          ? readProjectCommandOutputWorkspace(attachment, readProjectWorkspaceRefs(storage.getState())) : null;
        if (scopeId && !phone && attachment?.terminalId && server
          && areServerProfileIdentifiersEquivalent(server, attachment.serverId)
          && (attachment.kind !== 'projectCommand' || workspace)) {
          const open = findOutputTerminalInHost(scopeId, attachment);
          const result = open
            ? await execute('session.terminals.focus', { terminalId: open.id })
            : await execute('session.terminals.open', {
                target: {
                  kind: 'terminal_view',
                  machineId: attachment.machineId,
                  terminalId: attachment.terminalId,
                  terminalKey: `project-command:${attachment.terminalId}`,
                  ...(attachment.kind === 'projectCommand' ? { cwd: attachment.cwd,
                    ...(workspace ? { workspace } : {}) } : {}),
                },
                title: options.title,
              });
          if (result.ok) {
            openedInTerminal = true;
            return;
          }
        }
        if (options.fallbackToDetail === false) return;
        // A phone has no bottom terminal: a project command's output is its own page (lab OUTPUTp).
        if (phone && attachment?.kind === 'projectCommand') {
          openProjectCommandOutputPage({ serverId: operation.serverId, operationId: operation.snapshot.operationId,
            name: options.name ?? options.title, command: options.command ?? null });
          return;
        }
        openActionOperationDetail({
          serverId: operation.serverId, operationId: operation.snapshot.operationId,
        });
      };
      const executeOpen = createFrontDoorActionExecute(undefined, { actionOperationOpenOutput: present });
      const result = await executeOpen('projects.execution.output.open', {
        serverId: operation.serverId,
        machineId: operation.snapshot.scope.machineId,
        operationId: operation.snapshot.operationId,
      }, { surface: 'ui', authority: 'present_user', serverId: operation.serverId,
        expectedAccountId: operation.snapshot.scope.accountId });
      if (!result.ok && options.fallbackToDetail !== false) openActionOperationDetail({
        serverId: operation.serverId, operationId: operation.snapshot.operationId,
      });
      return openedInTerminal;
    },
    [execute, phone, scopeId],
  );
  // Desktop hosts with a bottom terminal open output there; a phone opens a project command's output
  // page; elsewhere it opens the operation detail.
  return { open, opensInTerminal: scopeId !== null && !phone } as const;
}
