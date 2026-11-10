import { z } from '../zodRuntimePolicy.js';
import { lazyZodSchema } from '../lazyZodSchema.js';
import type { PluginAgentVendorResumeSupportV2 } from '../plugins/contributions/v2.js';
import { SessionRunnerRuntimeStateV1Schema } from '../sessions/control/sessionRunnerRuntimeV1.js';
import { isSessionRunnerWindowsHostedLaunchV1, readSessionRunnerDaemonLaunchRefusalV1 } from '../sessions/control/sessionRunnerRestartV1.js';
import { SessionTerminalMetadataSchema } from '../sessions/metadata/terminalMetadata.js';

export const CapabilityApplyTimingV1Schema = lazyZodSchema(() => z.discriminatedUnion('t', [
  z.strictObject({ t: z.literal('applied_now') }),
  z.strictObject({ t: z.literal('next_turn') }),
  z.strictObject({ t: z.literal('new_sessions_only') }),
  z.strictObject({ t: z.literal('session_not_running') }),
  z.strictObject({ t: z.literal('restart_to_apply'), restartBy: z.enum(['user', 'terminal']) }),
]));
export type CapabilityApplyTimingV1 = z.infer<typeof CapabilityApplyTimingV1Schema>;
export type CapabilityLaunchRestartV1 = 'automatic' | Readonly<{
  refused: 'windows_hosted_runner' | 'not_daemon_started' | 'not_remote_started';
}>;
export type CapabilityApplyTimingInputV1 = Readonly<{
  kind: 'skill' | 'native_skill' | 'mcp_server';
  sessionRunning: boolean;
  agent: Readonly<{ vendorResume: PluginAgentVendorResumeSupportV2; skillsLiveReload: 'supported' | 'unsupported' }>;
  launchRestart: CapabilityLaunchRestartV1;
}>;
/** Host-published facts for the actual admitted Agent runtime; safe to read while its Machine is offline. */
export const SessionCapabilityAgentFactsV1Schema = lazyZodSchema(() => z.strictObject({
  vendorResume: z.enum(['supported', 'experimental', 'unsupported']),
  skillsLiveReload: z.enum(['supported', 'unsupported']),
}));
export function readSessionCapabilityAgentFactsV1(metadata: unknown): CapabilityApplyTimingInputV1['agent'] | null {
  const record = metadata !== null && typeof metadata === 'object' && !Array.isArray(metadata)
    ? metadata as Record<string, unknown> : null;
  const capabilities = record?.agentRuntimeCapabilitiesV1;
  const facts = capabilities !== null && typeof capabilities === 'object' && !Array.isArray(capabilities)
    ? (capabilities as Record<string, unknown>).capabilitySelection : undefined;
  const parsed = SessionCapabilityAgentFactsV1Schema.safeParse(facts);
  return parsed.success ? parsed.data : null;
}
/** Actual launch restrictions precede a retained or more general daemon eligibility refusal. */
export function readCapabilityLaunchRestartFromMetadataV1(metadata: unknown): CapabilityLaunchRestartV1 {
  const record = metadata !== null && typeof metadata === 'object' && !Array.isArray(metadata)
    ? metadata as Record<string, unknown> : null;
  if (record?.startedBy === 'terminal') {
    const refused = readSessionRunnerDaemonLaunchRefusalV1(record.startedBy);
    if (refused) return { refused };
  }
  const terminal = SessionTerminalMetadataSchema.safeParse(record?.terminal);
  const launchMode = terminal.success ? terminal.data.mode : undefined;
  if (isSessionRunnerWindowsHostedLaunchV1(launchMode === 'windows_console' ? 'console' : launchMode)) {
    return { refused: 'windows_hosted_runner' };
  }
  const runtime = SessionRunnerRuntimeStateV1Schema.safeParse(record?.sessionRunnerRuntimeV1);
  const refused = runtime.success ? runtime.data.plannedRestart.disabledReason : null;
  return refused === 'windows_hosted_runner' || refused === 'not_daemon_started' || refused === 'not_remote_started'
    ? { refused } : 'automatic';
}
export function resolveCapabilityApplyTimingV1(input: CapabilityApplyTimingInputV1): CapabilityApplyTimingV1 {
  if (!input.sessionRunning) return { t: 'session_not_running' };
  if (input.kind === 'skill' && input.agent.skillsLiveReload === 'supported') return { t: 'applied_now' };
  if (input.agent.vendorResume === 'unsupported') return { t: 'new_sessions_only' };
  if (input.launchRestart !== 'automatic') return { t: 'restart_to_apply',
    restartBy: input.launchRestart.refused === 'windows_hosted_runner' ? 'user' : 'terminal' };
  return { t: 'next_turn' };
}
