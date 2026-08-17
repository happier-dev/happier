/**
 * Declaration-level fixture for the authored-input projection of a composed
 * schema.
 *
 * `SchemaInput` is how every authoring seam names the value an author passes:
 * a contribution operation's `input`, a surface's `inputSchema`, and the
 * admitted-operation execution handle all project it, and the handle
 * additionally constrains it to `JsonValue`. Protocol publishes composable
 * schemas of its own through the SDK, so an authored input that composes one
 * must keep that member's exact type and requiredness. This fixture pins that
 * contract in both directions: a required Protocol-published member stays
 * required and exactly typed, and an `.optional()` member stays omissible.
 */
import { QualifiedConnectedAccountRefSchema } from './connectedAccounts.js';
import { defineProtocolObject, defineProtocolString } from './protocol/protocolFacade.js';

import type { AdmittedTargetedOperationExecutionHandle } from './actions/admittedTargetedOperation.js';
import type { ActionsService } from './actions/service.js';
import type { QualifiedConnectedAccountRef } from './connectedAccounts.js';
import type { JsonValue } from './identity.js';
import type { SchemaInput, SchemaOutput } from './targetedContributionAuthoring.js';

const accountBindingSchema = defineProtocolObject({
    purpose: defineProtocolString({ minLength: 1 }),
    account: QualifiedConnectedAccountRefSchema,
}, { policy: 'closed' });

type AccountBindingAuthoredInput = SchemaInput<typeof accountBindingSchema>;
type AccountBindingParsedOutput = SchemaOutput<typeof accountBindingSchema>;

// A required Protocol-published member keeps its exact authored type.
export function authoredBindingKeepsAccountRef(
    input: AccountBindingAuthoredInput,
): QualifiedConnectedAccountRef {
    return input.account;
}

// The parsed projection was never in doubt and must stay exact as well.
export function parsedBindingKeepsAccountRef(
    output: AccountBindingParsedOutput,
): QualifiedConnectedAccountRef {
    return output.account;
}

// The composed authored input remains admissible where an invocation seam
// requires `JsonValue` — the constraint an admitted operation handle imposes.
export function authoredBindingIsInvocableJson(input: AccountBindingAuthoredInput): JsonValue {
    return input;
}

// The whole point of the projection: an operation whose input composes a
// Protocol-published schema can actually be invoked through the one admitted
// execution seam.
export async function invokeAccountBindingOperation(
    actions: ActionsService,
    operation: AdmittedTargetedOperationExecutionHandle<AccountBindingAuthoredInput, JsonValue>,
    input: AccountBindingAuthoredInput,
): Promise<JsonValue> {
    return actions.executeAdmittedTargetedOperation(operation, input);
}

const optionalAccountSchema = defineProtocolObject({
    purpose: defineProtocolString({ minLength: 1 }),
    account: QualifiedConnectedAccountRefSchema.optional(),
}, { policy: 'closed' });

type OptionalAccountAuthoredInput = SchemaInput<typeof optionalAccountSchema>;

// An `.optional()` Protocol-published member stays omissible, so recovering
// the authored type must not make every member required.
export const optionalAccountMayBeOmitted: OptionalAccountAuthoredInput = { purpose: 'issues' };
