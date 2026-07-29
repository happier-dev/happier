import { z } from 'zod';

/**
 * Canonical system-task prompt kinds.
 *
 * These identifiers are part of the wire-level contract surfaced via:
 * - `systemTasks` runner `pendingPrompt.kind`
 * - `SystemTaskEvent` payloads with `type: 'prompt'`
 *
 * Ownership boundary:
 * - Protocol owns the stable ids and their grouping/versioning.
 * - UX copy, orchestration, and execution policy live outside protocol.
 */
export const SYSTEM_TASK_PROMPT_KINDS_V1 = [
  'ssh.trustHost',
  'ssh.replaceHostKey',
  'ssh.password',
  'ssh.privateKeyPassphrase',
  'ssh.keyboardInteractive',
  'auth.approveRemoteProvisioning',
  'releaseChannel.switchDefaultForSetup',
  'daemon.takeOverManualRelayRuntimeForSetup',
  'daemon.replaceLocalBackgroundServices',
  'daemon.replaceRemoteBackgroundServices',
] as const;

export const SystemTaskPromptKindSchema = z.enum(SYSTEM_TASK_PROMPT_KINDS_V1);
export type SystemTaskPromptKind = z.infer<typeof SystemTaskPromptKindSchema>;
