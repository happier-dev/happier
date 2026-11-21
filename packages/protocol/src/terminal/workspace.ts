import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from '../zodRuntimePolicy.js';
import { DaemonTerminalLaunchIntentSchema } from '../daemon/terminal.js';
import { isManagedWorkspaceRefV2, WorkspaceAddressV1Schema, WorkspaceAddressV2Schema } from '../workspaces/workspaceRefV1.js';

const id = z.string().check(z.trim(), z.minLength(1));
const shellLaunch = {
  launch: z.optional(DaemonTerminalLaunchIntentSchema),
};
export const SessionTerminalViewTargetV1Schema = lazyZodSchema(() => z.strictObject({
  kind: z.literal('terminal_view'), machineId: id, terminalId: id, terminalKey: id, cwd: id,
  workspace: z.optional(WorkspaceAddressV1Schema), sessionId: z.optional(id),
  /** Only the service supervisor grants input to its existing process. */
  interactive: z.optional(z.literal(true)),
}).check(z.refine(target => !target.workspace || target.workspace.machineId === target.machineId, {
  message: 'Borrowed output and its checkout must address the same Machine',
})));
export type SessionTerminalViewTargetV1 = z.infer<typeof SessionTerminalViewTargetV1Schema>;
export const SessionTerminalTargetV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('workspace_shell'), workspace: z.optional(WorkspaceAddressV2Schema), ...shellLaunch }),
  z.strictObject({ kind: z.literal('session_attach') }),
  z.strictObject({ kind: z.literal('machine_shell'), machineId: id, cwd: id, ...shellLaunch }),
  SessionTerminalViewTargetV1Schema,
]).check(z.refine((target) => !('launch' in target && target.launch?.kind === 'session_attach'), {
  message: 'Agent attachments use the dedicated target',
}), z.refine(target => !('launch' in target && target.launch?.kind === 'service_shell'), {
  message: 'Service shells use the Machine terminal owner',
}), z.refine(target => target.kind !== 'workspace_shell' || !target.workspace
  || !isManagedWorkspaceRefV2(target.workspace) || target.launch === undefined, {
  message: 'Managed Project terminals launch an interactive guest shell',
})));
export type SessionTerminalTargetV1 = z.infer<typeof SessionTerminalTargetV1Schema>;
/** Reference only: the existing approval Artifact owns the original strict Action input and receipt. */
export const SessionTerminalPendingActionApprovalV1Schema = lazyZodSchema(() => z.strictObject({
  scope: z.strictObject({ serverId: id, accountId: id }),
  artifactId: id,
  actionId: z.enum(['machines.terminal.open', 'machines.terminal.restart']),
}));
export type SessionTerminalPendingActionApprovalV1 = z.infer<typeof SessionTerminalPendingActionApprovalV1Schema>;
export const SessionTerminalMemberV1Schema = lazyZodSchema(() => z.strictObject({ id, target: SessionTerminalTargetV1Schema,
  title: z.optional(id), pendingActionApproval: z.optional(SessionTerminalPendingActionApprovalV1Schema),
  // A declined open belongs to this pane member, across responsive leaf replacement.
  openCancelled: z.optional(z.literal(true)) }));
export type SessionTerminalMemberV1 = z.infer<typeof SessionTerminalMemberV1Schema>;
export type SessionTerminalLayoutV1 =
  | { kind: 'leaf'; terminalId: string }
  | { kind: 'split'; id: string; ratio: number; first: SessionTerminalLayoutV1; second: SessionTerminalLayoutV1 };
export const SessionTerminalLayoutV1Schema: z.ZodMiniType<SessionTerminalLayoutV1> = z.lazy(() => z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('leaf'), terminalId: id }),
  z.strictObject({ kind: z.literal('split'), id, ratio: z.number().check(z.minimum(0), z.maximum(1)), first: SessionTerminalLayoutV1Schema, second: SessionTerminalLayoutV1Schema }),
]));
export const SessionTerminalTabV1Schema = lazyZodSchema(() => z.strictObject({
  id, terminals: z.array(SessionTerminalMemberV1Schema).check(z.minLength(1)), focusedTerminalId: id, root: SessionTerminalLayoutV1Schema,
}).check(z.superRefine((tab, ctx) => {
  const leaves: string[] = [];
  const nodeIds: string[] = [];
  const visit = (node: SessionTerminalLayoutV1): void => {
    if (node.kind === 'leaf') { leaves.push(node.terminalId); nodeIds.push(node.terminalId); }
    else { nodeIds.push(node.id); visit(node.first); visit(node.second); }
  };
  visit(tab.root);
  if (!leaves.includes(tab.focusedTerminalId) || leaves.length !== tab.terminals.length
    || new Set(nodeIds).size !== nodeIds.length || tab.terminals.some((terminal) => !leaves.includes(terminal.id))) {
    ctx.addIssue({ code: "custom", message: 'Terminal layout must contain each member exactly once and focus a member' });
  }
})));
export type SessionTerminalTabV1 = z.infer<typeof SessionTerminalTabV1Schema>;
export const SessionTerminalWorkspaceV1Schema = lazyZodSchema(() => z.strictObject({
  v: z.literal(1), tabs: z.array(SessionTerminalTabV1Schema), activeTabId: z.nullable(id), showList: z.boolean(),
  // Presentation ownership, not process authority: Project panes qualify retained
  // private labels and terminal views against their actual Home Account.
  ownerScope: z.optional(z.strictObject({ serverId: id, accountId: id })),
}).check(z.superRefine((workspace, ctx) => {
  const tabIds = workspace.tabs.map((tab) => tab.id);
  const terminalIds = workspace.tabs.flatMap((tab) => tab.terminals.map((terminal) => terminal.id));
  if (new Set(tabIds).size !== tabIds.length || new Set(terminalIds).size !== terminalIds.length
    || (workspace.tabs.length === 0 ? workspace.activeTabId !== null : !tabIds.includes(workspace.activeTabId ?? ''))) {
    ctx.addIssue({ code: "custom", message: 'Invalid terminal workspace identity or selection' });
  }
})));
export type SessionTerminalWorkspaceV1 = z.infer<typeof SessionTerminalWorkspaceV1Schema>;
