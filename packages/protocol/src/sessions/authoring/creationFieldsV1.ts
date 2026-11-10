import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from '../../zodRuntimePolicy.js';

import { WindowsRemoteSessionLaunchModeSchema } from '../metadata/windowsRemoteSessionLaunchMode.js';
import { WindowsTerminalWindowNameSchema } from '../metadata/windowsTerminalWindowName.js';

/**
 * Creation-time Session authoring fields live in this dependency-light leaf.
 *
 * Session creation and Automation execution recipes both consume these
 * schemas. Keeping their runtime owner outside the full authoring field
 * catalog prevents that catalog's Automation definitions from forming a
 * reciprocal initialization cycle with Session spawn.
 */
export const SessionAuthoringCheckoutCreationDraftV1Schema = lazyZodSchema(() => z.strictObject({
  kind: z.literal('git_worktree'),
  displayName: z.string().check(z.trim(), z.minLength(1)),
  baseRef: z.nullable(z.string().check(z.trim(), z.minLength(1))),
  branchMode: z.optional(z.enum(['new', 'existing'])),
}));

export type SessionAuthoringCheckoutCreationDraftV1 = z.infer<
  typeof SessionAuthoringCheckoutCreationDraftV1Schema
>;

const SessionAuthoringWindowsTerminalV1Schema = lazyZodSchema(() => z.strictObject({
  launchMode: z.optional(WindowsRemoteSessionLaunchModeSchema),
  console: z.optional(z.enum(['hidden', 'visible'])),
  windowName: z.optional(WindowsTerminalWindowNameSchema),
}));

export const SessionAuthoringTerminalModeV1Schema = lazyZodSchema(() => z.enum([
  'integrated', 'plain', 'tmux', 'zellij', 'herdr', 'windows_terminal', 'windows_console',
]));
export const SessionAuthoringTmuxTerminalV1Schema = lazyZodSchema(() => z.strictObject({
  sessionName: z.optional(z.string()),
  isolated: z.optional(z.boolean()),
  tmpDir: z.optional(z.union([z.string(), z.null()])),
}));
export const SessionAuthoringHerdrTerminalV1Schema = lazyZodSchema(() => z.strictObject({
  sessionName: z.optional(z.string()),
}));

export const SessionAuthoringTerminalV1Schema = lazyZodSchema(() => z.strictObject({
  mode: z.optional(SessionAuthoringTerminalModeV1Schema),
  tmux: z.optional(SessionAuthoringTmuxTerminalV1Schema),
  herdr: z.optional(SessionAuthoringHerdrTerminalV1Schema),
  windows: z.optional(SessionAuthoringWindowsTerminalV1Schema),
}));

export type SessionAuthoringTerminalV1 = z.infer<typeof SessionAuthoringTerminalV1Schema>;
