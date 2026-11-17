import { getActionSpec } from './actionSpecs.js';
import { ACTION_IDS, type ActionId } from './actionIds.js';
import {
    createHappierActionToolNameIndex,
    isRecord,
    readHappierActionExecuteActionId,
    readHappierActionId,
    readHappierActionToolPayload,
} from './happierActionToolResult.js';

/*
 * Catalog-backed readers for the Happier Action a first-party tool call runs. They live apart from
 * `happierActionToolResult` because they load the whole Action catalog; hosts that already hold it
 * (the app, the CLI) share them, catalog-free consumers keep the binding-index readers.
 */

const KNOWN_ACTION_IDS: ReadonlySet<string> = new Set(ACTION_IDS);
const isKnownActionId = (id: string): id is ActionId => KNOWN_ACTION_IDS.has(id);
let actionToolNames: ReadonlyMap<string, ActionId> | null = null;

/** The Happier Action a first-party tool call runs: the `action_execute` operand, else the Action's own binding. */
export function readHappierActionCallId(toolName: string, input: unknown): ActionId | null {
    const executed = readHappierActionExecuteActionId(toolName, input, isKnownActionId);
    if (executed) return executed;
    actionToolNames ??= createHappierActionToolNameIndex((ACTION_IDS as readonly ActionId[])
        .map(actionId => ({ actionId, name: getActionSpec(actionId).bindings?.mcpToolName })));
    return readHappierActionId(toolName, actionToolNames);
}

/** The operands the call hands its Action: `action_execute`'s `input`, else the Action's own tool payload. */
export function readHappierActionCallInput(toolName: string, input: unknown): unknown {
    const payload = readHappierActionToolPayload(input);
    return readHappierActionExecuteActionId(toolName, input, isKnownActionId)
        ? (isRecord(payload) ? readHappierActionToolPayload(payload.input) : undefined)
        : payload;
}
