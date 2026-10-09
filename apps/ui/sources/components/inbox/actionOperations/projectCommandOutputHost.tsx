import * as React from 'react';

import { parseProjectPaneScopeId } from '@/components/projects/detail/projectPaneScope';
import { parseSessionPaneScopeId } from '@/components/sessions/panes/sessionPaneScopeId';
import { EMPTY_TERMINAL_WORKSPACE } from '@/components/sessions/terminal/sessionTerminalWorkspace';
import { readSessionTerminalWorkspaceForScope } from '@/components/sessions/terminal/sessionTerminalWorkspaceRuntime';
import { useSessionTerminalActionExecute } from '@/components/sessions/terminal/useSessionTerminalWorkspace';
import type { ActionOperationProjection } from '@/sync/domains/actionOperations/actionOperationSelectors';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { useDeviceType } from '@/utils/platform/responsive';

import { openActionOperationDetail } from './openActionOperationDetail';
import { readActionOperationOutputAttachment } from './actionOperationDetailPresentation';

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
}>;

function scopeServerId(scopeId: string): string | null {
  return (
    parseProjectPaneScopeId(scopeId)?.serverId ??
    parseSessionPaneScopeId(scopeId)?.address?.serverId ??
    null
  );
}

/**
 * Opens a project command's output where its host shows terminals: the same PTY as a borrowed,
 * read-only bottom terminal tab, focused when it is already open there. Opening or closing the tab
 * never ensures, restarts or stops the process. Otherwise it opens the operation detail.
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
      const attachment = readActionOperationOutputAttachment(operation.snapshot);
      const server = scopeId ? scopeServerId(scopeId) : null;
      if (
        scopeId &&
        !phone &&
        attachment?.terminalId &&
        server &&
        areServerProfileIdentifiersEquivalent(server, attachment.serverId)
      ) {
        const workspace = readSessionTerminalWorkspaceForScope(
          scopeId,
          parseProjectPaneScopeId(scopeId)
            ? EMPTY_TERMINAL_WORKSPACE
            : undefined,
        );
        const open = workspace?.tabs
          .flatMap((tab) => tab.terminals)
          .find(
            (member) =>
              member.target.kind === 'terminal_view' &&
              member.target.terminalId === attachment.terminalId &&
              member.target.machineId === attachment.machineId,
          );
        const result = open
          ? await execute('session.terminals.focus', { terminalId: open.id })
          : await execute('session.terminals.open', {
              target: {
                kind: 'terminal_view',
                machineId: attachment.machineId,
                terminalId: attachment.terminalId,
                terminalKey: `project-command:${attachment.terminalId}`,
                ...(attachment.kind === 'projectCommand' ? { cwd: attachment.cwd } : {}),
              },
              title: options.title,
            });
        if (result.ok) return true;
      }
      if (options.fallbackToDetail !== false)
        openActionOperationDetail({
          serverId: operation.serverId,
          operationId: operation.snapshot.operationId,
        });
      return false;
    },
    [execute, phone, scopeId],
  );
  // Desktop hosts with a bottom terminal open output there; elsewhere it opens the operation detail.
  return { open, opensInTerminal: scopeId !== null && !phone } as const;
}
