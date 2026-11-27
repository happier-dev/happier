import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { AcpToolCallSidechainResolver } from '@/agent/acp/runtime/createAcpRuntime';
import { AGY_APP_DATA_DIR, resolveAgyMachineProfileDir } from './agyAcpLaunch';

/**
 * agy 1.5.18 streams a subagent's tool calls into its parent's ACP session with the subagent's
 * conversation id as the call id prefix (`<uuid>:call_<n>`); the main agent's own calls are bare
 * `call_<n>`. No `_meta` links them, and subagent text is never streamed.
 */
const SUBAGENT_CALL_ID_PATTERN = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}):\S/i;

/** agy titles its generic tool calls `Run <tool name>`; this is the subagent launch tool. */
const INVOKE_SUBAGENT_TITLE = 'Run invoke_subagent';

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

export function readAgySubagentIdFromCallId(callId: string): string | null {
  return SUBAGENT_CALL_ID_PATTERN.exec(callId)?.[1]?.toLowerCase() ?? null;
}

/** Whether a normalized ACP tool input is agy's `invoke_subagent` launch call. */
export function isAgyInvokeSubagentInput(input: unknown): boolean {
  return readString(asRecord(asRecord(input)?._acp)?.title) === INVOKE_SUBAGENT_TITLE;
}

function readInvokeSubagentRole(input: unknown): string | null {
  const record = asRecord(input);
  return readString(record?.Role) ?? readString(asRecord(asRecord(record?._acp)?.rawInput)?.Role);
}

/**
 * The launch call never names the subagent it starts. agy records each subagent under its parent
 * conversation (`brain/<parent>/.system_generated/subagents/<subagent>.json`) with the role the
 * launch call passed, which is the only link between the two.
 */
function readRecordedSubagentRole(processEnv: NodeJS.ProcessEnv, parentSessionId: string | null, subagentId: string): string | null {
  if (!parentSessionId || /[\\/]/.test(parentSessionId) || parentSessionId === '.' || parentSessionId === '..') return null;
  const recordPath = join(
    resolveAgyMachineProfileDir(processEnv), AGY_APP_DATA_DIR, 'brain', parentSessionId, '.system_generated', 'subagents', `${subagentId}.json`,
  );
  try {
    const record = asRecord(JSON.parse(readFileSync(recordPath, 'utf8')));
    return readString(asRecord(record?.subagentDescriptor)?.role);
  } catch {
    return null;
  }
}

/**
 * Attributes each subagent's activity to the `invoke_subagent` call that launched it: by the role
 * agy recorded for that subagent, else the only launch still waiting for its subagent. When neither
 * identifies the launch, the subagent gets its own thread keyed by its conversation id, which still
 * keeps its calls out of the main reply.
 */
export function createAgySubagentSidechainResolver(context: Readonly<{ processEnv: NodeJS.ProcessEnv }>): AcpToolCallSidechainResolver {
  const unclaimedLaunches: Array<Readonly<{ callId: string; role: string | null }>> = [];
  const sidechainIdBySubagentId = new Map<string, string>();
  return ({ callId, input, sessionId }) => {
    const subagentId = readAgySubagentIdFromCallId(callId);
    if (!subagentId) {
      if (isAgyInvokeSubagentInput(input) && !unclaimedLaunches.some((launch) => launch.callId === callId)) {
        unclaimedLaunches.push({ callId, role: readInvokeSubagentRole(input) });
      }
      return null;
    }
    const known = sidechainIdBySubagentId.get(subagentId);
    if (known) return known;
    const role = readRecordedSubagentRole(context.processEnv, sessionId, subagentId);
    let launchIndex = role ? unclaimedLaunches.findIndex((launch) => launch.role === role) : -1;
    if (launchIndex < 0 && unclaimedLaunches.length === 1) launchIndex = 0;
    const sidechainId = launchIndex >= 0 ? unclaimedLaunches.splice(launchIndex, 1)[0]!.callId : subagentId;
    sidechainIdBySubagentId.set(subagentId, sidechainId);
    return sidechainId;
  };
}
