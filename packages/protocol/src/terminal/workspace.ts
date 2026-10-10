import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from 'zod';
import { DaemonTerminalLaunchIntentSchema } from '../daemon/terminal.js';
import { WorkspaceAddressV1Schema } from '../workspaces/workspaceRefV1.js';

const id = z.string().trim().min(1);
const shellLaunch = {
  initialCommand: z.string().max(100_000).optional(),
  launch: DaemonTerminalLaunchIntentSchema.optional(),
};
export const SessionTerminalTargetV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('workspace_shell'), workspace: WorkspaceAddressV1Schema.optional(), ...shellLaunch }).strict(),
  z.object({ kind: z.literal('session_attach') }).strict(),
  z.object({ kind: z.literal('machine_shell'), machineId: id, cwd: id, ...shellLaunch }).strict(),
  z.object({ kind: z.literal('terminal_view'), machineId: id, terminalId: id, terminalKey: id, cwd: id, sessionId: id.optional() }).strict(),
]).refine((target) => !('initialCommand' in target && target.initialCommand !== undefined && target.launch !== undefined)
  && !('launch' in target && target.launch?.kind === 'session_attach'), {
  message: 'Shell command and launch are exclusive; agent attachments use the dedicated target',
}));
export type SessionTerminalTargetV1 = z.infer<typeof SessionTerminalTargetV1Schema>;
/** Reference only: the existing approval Artifact owns the original strict Action input and receipt. */
export const SessionTerminalPendingActionApprovalV1Schema = lazyZodSchema(() => z.object({
  scope: z.object({ serverId: id, accountId: id }).strict(),
  artifactId: id,
  actionId: z.enum(['machines.terminal.open', 'machines.terminal.restart']),
}).strict());
export type SessionTerminalPendingActionApprovalV1 = z.infer<typeof SessionTerminalPendingActionApprovalV1Schema>;
export const SessionTerminalMemberV1Schema = lazyZodSchema(() => z.object({ id, target: SessionTerminalTargetV1Schema,
  title: id.optional(), pendingActionApproval: SessionTerminalPendingActionApprovalV1Schema.optional() }).strict());
export type SessionTerminalMemberV1 = z.infer<typeof SessionTerminalMemberV1Schema>;
export type SessionTerminalLayoutV1 =
  | { kind: 'leaf'; terminalId: string }
  | { kind: 'split'; id: string; ratio: number; first: SessionTerminalLayoutV1; second: SessionTerminalLayoutV1 };
export const SessionTerminalLayoutV1Schema: z.ZodType<SessionTerminalLayoutV1> = z.lazy(() => z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('leaf'), terminalId: id }).strict(),
  z.object({ kind: z.literal('split'), id, ratio: z.number().finite().min(0).max(1), first: SessionTerminalLayoutV1Schema, second: SessionTerminalLayoutV1Schema }).strict(),
]));
export const SessionTerminalTabV1Schema = lazyZodSchema(() => z.object({
  id, terminals: z.array(SessionTerminalMemberV1Schema).min(1), focusedTerminalId: id, root: SessionTerminalLayoutV1Schema,
}).strict().superRefine((tab, ctx) => {
  const leaves: string[] = [];
  const nodeIds: string[] = [];
  const visit = (node: SessionTerminalLayoutV1): void => {
    if (node.kind === 'leaf') { leaves.push(node.terminalId); nodeIds.push(node.terminalId); }
    else { nodeIds.push(node.id); visit(node.first); visit(node.second); }
  };
  visit(tab.root);
  if (!leaves.includes(tab.focusedTerminalId) || leaves.length !== tab.terminals.length
    || new Set(nodeIds).size !== nodeIds.length || tab.terminals.some((terminal) => !leaves.includes(terminal.id))) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Terminal layout must contain each member exactly once and focus a member' });
  }
}));
export type SessionTerminalTabV1 = z.infer<typeof SessionTerminalTabV1Schema>;
export const SessionTerminalWorkspaceV1Schema = lazyZodSchema(() => z.object({
  v: z.literal(1), tabs: z.array(SessionTerminalTabV1Schema), activeTabId: id.nullable(), showList: z.boolean(),
  // Presentation ownership, not process authority: Project panes qualify retained
  // private labels and terminal views against their actual Home Account.
  ownerScope: z.object({ serverId: id, accountId: id }).strict().optional(),
}).strict().superRefine((workspace, ctx) => {
  const tabIds = workspace.tabs.map((tab) => tab.id);
  const terminalIds = workspace.tabs.flatMap((tab) => tab.terminals.map((terminal) => terminal.id));
  if (new Set(tabIds).size !== tabIds.length || new Set(terminalIds).size !== terminalIds.length
    || (workspace.tabs.length === 0 ? workspace.activeTabId !== null : !tabIds.includes(workspace.activeTabId ?? ''))) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Invalid terminal workspace identity or selection' });
  }
}));
export type SessionTerminalWorkspaceV1 = z.infer<typeof SessionTerminalWorkspaceV1Schema>;
