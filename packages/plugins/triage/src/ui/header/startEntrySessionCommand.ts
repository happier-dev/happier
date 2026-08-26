import type { JsonValue } from '@happier-dev/plugin-sdk';
import type { PluginUiActionExecutionOptions } from '@happier-dev/plugin-sdk/ui';

import {
    TRIAGE_START_ENTRY_SESSION_ACTION_LOCAL_ID_V1,
    TriageStartEntrySessionResultV1Schema,
    type TriageStartEntrySessionInputV1,
    type TriageStartEntrySessionResultV1,
} from '../../actions/entrySessionProtocol.js';

/**
 * The header's one path to the Session-start orchestrator.
 *
 * `startEntrySession` owns the whole vertical — the workspace-mode gate, the
 * materialization, the generic create-or-rejoin, the idempotent link and the
 * canonical open — and a mounted surface can reach none of it directly: it
 * holds a Host API with no Account storage and no canonical creator. So a press
 * leaves through here and nowhere else.
 *
 * The module owns no state and makes no decision. It does not choose a
 * destination, mint a creation key, decide whether a mode is admissible, retry,
 * or interpret an outcome: every one of those belongs to the orchestrator, and
 * a second opinion here would be a second start owner for one entry.
 */

/**
 * What a start needs from a mount: the ability to invoke this plugin's own
 * Action. Deliberately the narrowest capability rather than a whole Host API —
 * nothing else about a mount takes part in starting a Session.
 */
export type TriageSessionStartHostV1 = Readonly<{
    executeAction(
        action: string,
        input: JsonValue,
        options?: PluginUiActionExecutionOptions,
    ): Promise<unknown>;
}>;

export async function submitTriageEntrySessionStart(
    host: TriageSessionStartHostV1,
    input: TriageStartEntrySessionInputV1,
    options?: PluginUiActionExecutionOptions,
): Promise<TriageStartEntrySessionResultV1> {
    const result = await host.executeAction(
        TRIAGE_START_ENTRY_SESSION_ACTION_LOCAL_ID_V1,
        // Passed through as the caller settled it. The entry reference in
        // particular is never rebuilt here: the link's address is derived from
        // it, and a reshaped one would address a second row for one
        // relationship.
        input as unknown as JsonValue,
        options,
    );
    // The Action crosses a JSON transport, so its own published result schema —
    // not a cast — is what admits the value the header's state is taken from.
    return TriageStartEntrySessionResultV1Schema.parse(result);
}
