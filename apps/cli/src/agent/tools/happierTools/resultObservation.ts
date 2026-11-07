import { ActionIdSchema } from '@happier-dev/protocol/actions/actionIds';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { isShellToolNameAlias } from '@happier-dev/protocol/tools/v2/aliases';
import { readHappierActionToolPayload } from '@happier-dev/protocol/actions/happierActionToolResult';

import { HAPPIER_BUILT_IN_TOOLS } from './catalog';
import { parseMcpToolName } from '../normalization/families/mcp';
import {
    extractCanonicalInputFromHappierToolsShellBridge,
    resolveCanonicalToolNameFromHappierToolsShellBridge,
} from '../normalization/happierToolsShellBridgeCanonicalization';

function asRecord(value: unknown): Readonly<Record<string, unknown>> | null {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value as Readonly<Record<string, unknown>> : null;
}

function readNativeToolResult(value: unknown): unknown {
    if (typeof value === 'string') return JSON.parse(value);
    const record = asRecord(value);
    if (!record) return value;
    // Native Codex represents absent MCP structured content as null.
    if (record.structuredContent != null) return record.structuredContent;
    if (Array.isArray(record.content)) {
        return readNativeToolResult(record.content.map(block => asRecord(block)?.text ?? '').join('\n'));
    }
    if (typeof record.content === 'string') return readNativeToolResult(record.content);
    if (record.tool_use_result !== undefined) return readNativeToolResult(record.tool_use_result);
    // The first-party shell bridge carries the Action result in its typed receipt.
    if (typeof record.stdout === 'string') {
        const receipt = asRecord(readNativeToolResult(record.stdout));
        const data = asRecord(receipt?.data);
        return receipt?.v === 1 && receipt.kind === 'tools_call' && data?.source === 'happier'
            ? data.output : receipt;
    }
    return value;
}

function resolveObservationCall(toolName: string, input: unknown) {
    const shellBridge = isShellToolNameAlias(toolName)
        ? resolveCanonicalToolNameFromHappierToolsShellBridge(input) : null;
    const name = shellBridge ?? toolName;
    const mcp = parseMcpToolName(name);
    if (mcp && mcp.serverId !== 'happier') return null;
    const localName = mcp?.toolId ?? name;
    const args = shellBridge ? extractCanonicalInputFromHappierToolsShellBridge(input) : input;
    const id = ActionIdSchema.safeParse(localName === 'action_execute'
        ? asRecord(args)?.actionId
        : HAPPIER_BUILT_IN_TOOLS.find(tool => tool.name === localName)?.actionId);
    if (!id.success) return null;
    return { spec: getActionSpec(id.data), args, wrapped: localName === 'action_execute' };
}

/** Rebuild from semantic operands: native display/raw/bridge copies may contain private input. */
export function projectHappierToolInputForObservation(toolName: string, input: unknown): unknown {
    const call = resolveObservationCall(toolName, input);
    const project = call?.spec.projectObservationInput;
    if (!call || !project) return input;
    const args = readHappierActionToolPayload(call.args);
    const observed = project(readHappierActionToolPayload(call.wrapped ? asRecord(args)?.input : args));
    return call.wrapped ? { actionId: call.spec.id, input: observed } : observed;
}

/** Retain the admitted call's Action projection, never its show-once result. */
export function resolveHappierToolResultObservationProjector(
    toolName: string,
    input: unknown,
): ((output: unknown) => unknown) | undefined {
    const project = resolveObservationCall(toolName, input)?.spec.projectObservationOutput;
    if (!project) return undefined;
    return output => {
        try {
            // Discard the native wrappers too: Claude duplicates content in
            // tool_use_result, and normalization otherwise copies it to _raw.
            return project(readNativeToolResult(output));
        } catch {
            return { redacted: true };
        }
    };
}
