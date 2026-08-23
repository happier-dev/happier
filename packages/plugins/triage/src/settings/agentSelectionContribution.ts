import type { PluginSettingsContribution } from '@happier-dev/plugin-sdk/settings';

import {
    MAX_TRIAGE_AGENT_TARGET_KEY_LENGTH_V1,
    MAX_TRIAGE_MODEL_ID_LENGTH_V1,
    MAX_TRIAGE_PROVIDER_CONNECTION_ID_LENGTH_V1,
    TRIAGE_AGENT_SELECTION_SETTING_ID_V1,
} from './agentSelection.js';

/**
 * The one declared Account Settings field the agent selection owns.
 *
 * It is declared so the value has a real home in the Account record, and it is
 * hidden for the same reason `saved-views` is: it is not a generic Settings-page
 * control. The agents a person may choose come from the host's live
 * `agents.backends.list` inventory, and a declared field can only carry a
 * **static** `presentation.options` list
 * (`packages/protocol/src/plugins/contributions/settings.ts`) — there is no
 * dynamic option source for plugin Settings fields. A visible field here would
 * therefore be either a raw JSON box or a hard-coded agent list that goes stale
 * the moment an agent is installed, disabled or removed. The reader picks their
 * agent and model on Triage's own settings surface, which reads the live
 * inventory through `agentSelectionChoices.ts`.
 *
 * The declared schema is a shape guard at the host boundary. It is not the
 * authority — `agentSelection.ts` owns the exact bounds, the canonical-string
 * rules and the CAS decision, because a JSON-schema declaration cannot express
 * "already trimmed, no control characters, not a reserved record key" or "a
 * model id containing no whitespace".
 */

const selectionSchema = {
    anyOf: [{
        type: 'object',
        properties: {
            agentTargetKey: {
                type: 'string',
                minLength: 1,
                maxLength: MAX_TRIAGE_AGENT_TARGET_KEY_LENGTH_V1,
            },
            model: {
                anyOf: [{
                    type: 'object',
                    properties: {
                        modelId: {
                            type: 'string',
                            minLength: 1,
                            maxLength: MAX_TRIAGE_MODEL_ID_LENGTH_V1,
                        },
                        providerConnectionId: {
                            anyOf: [{
                                type: 'string',
                                minLength: 1,
                                maxLength: MAX_TRIAGE_PROVIDER_CONNECTION_ID_LENGTH_V1,
                            }, { type: 'null' }],
                        },
                        updatedAt: { type: 'number', minimum: 0 },
                    },
                    required: ['modelId', 'providerConnectionId', 'updatedAt'],
                    additionalProperties: false,
                }, { type: 'null' }],
            },
        },
        required: ['agentTargetKey', 'model'],
        additionalProperties: false,
    }, { type: 'null' }],
} as const;

export const TRIAGE_AGENT_SELECTION_SETTINGS_CONTRIBUTION_V1 = {
    id: 'agent-selection',
    title: 'Agent for Ask and Fix',
    description: 'The agent, and optionally the model, a session started from an entry uses. Unset lets the normal new-session flow choose.',
    target: { kind: 'plugin' },
    scope: 'account',
    fields: [{
        id: TRIAGE_AGENT_SELECTION_SETTING_ID_V1,
        title: 'Agent for Ask and Fix',
        schema: {
            type: 'object',
            properties: {
                v: { type: 'integer', const: 1 },
                ask: selectionSchema,
                fix: selectionSchema,
            },
            required: ['v', 'ask', 'fix'],
            additionalProperties: false,
        },
        // Both intents start with no opinion. This default is the whole
        // contract of the feature: an unset intent must reach the Session start
        // as unset, never as some agent this declaration picked.
        default: { v: 1, ask: null, fix: null },
        presentation: { hidden: true },
    }],
} satisfies PluginSettingsContribution;
