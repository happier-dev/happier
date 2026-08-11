import type { ToolCall } from '@/sync/domains/messages/messageTypes';
import { t } from '@/text';
import {
    TaskOutputInputV2Schema,
    TaskOutputResultV2Schema,
    TaskStopInputV2Schema,
    TaskStopResultV2Schema,
} from '@happier-dev/protocol';

import { ICON_TASK_OUTPUT, ICON_TASK_STOP } from '../icons';
import type { KnownToolDefinition } from '../_types';

/**
 * Tools that act on a **background task** — a detached process, not an agent.
 *
 * Both are real Claude Agent SDK tools (`TaskOutputInput` / `TaskStopInput` in the SDK's
 * `ToolInputSchemas` union). Without these entries they fall through to the unknown-tool card and
 * its `wrench` fallback icon, which is why they get named catalog entries here rather than being
 * folded into the subagent family: a background command has no transcript, no sidechain and no
 * recipient (PLAN §4.9).
 *
 * `BashOutput` and `KillShell`/`KillBash` deliberately have **no** entry: `BashOutput` is the
 * `Bash` tool's *result* shape (a member of the SDK's `ToolOutputSchemas`, not a tool), and
 * `KillShell`/`KillBash` do not exist in this SDK at all.
 */
function readTaskId(tool: ToolCall): string | null {
    const input = tool.input;
    if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
    const record = input as Record<string, unknown>;
    for (const key of ['task_id', 'shell_id'] as const) {
        const value = record[key];
        if (typeof value === 'string' && value.trim().length > 0) return value.trim();
    }
    return null;
}

function readStoppedCommand(tool: ToolCall): string | null {
    const result = tool.result;
    if (!result || typeof result !== 'object' || Array.isArray(result)) return null;
    const command = (result as Record<string, unknown>).command;
    return typeof command === 'string' && command.trim().length > 0 ? command.trim() : null;
}

export const coreBackgroundTaskTools = {
    'TaskOutput': {
        title: () => t('tools.names.taskOutput'),
        icon: ICON_TASK_OUTPUT,
        input: TaskOutputInputV2Schema,
        result: TaskOutputResultV2Schema,
        extractSubtitle: (opts: { tool: ToolCall }) => readTaskId(opts.tool),
    },
    'TaskStop': {
        title: () => t('tools.names.taskStop'),
        icon: ICON_TASK_STOP,
        input: TaskStopInputV2Schema,
        result: TaskStopResultV2Schema,
        // The result names the command it stopped; the input only carries an opaque id, so prefer
        // the command and fall back to the id while the call is still running.
        extractSubtitle: (opts: { tool: ToolCall }) => readStoppedCommand(opts.tool) ?? readTaskId(opts.tool),
    },
} satisfies Record<string, KnownToolDefinition>;
