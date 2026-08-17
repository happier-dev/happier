import type { PluginSettingsContribution } from '@happier-dev/plugin-sdk/settings';

import {
    MAX_TRIAGE_SAVED_VIEWS_V1,
    MAX_TRIAGE_SAVED_VIEW_FACET_VALUES_V1,
    MAX_TRIAGE_SAVED_VIEW_LABEL_UTF8_BYTES_V1,
    TRIAGE_SAVED_VIEWS_SETTING_ID_V1,
} from './savedViews.js';

/**
 * The one declared Account Settings field this document owns.
 *
 * It is declared so the value has a real home in the Account record, and it is
 * hidden because it is not a Settings-page control: a user creates, renames,
 * selects and removes views from the list's own lens affordance, never by
 * editing JSON. Materialization deliberately has no Settings value at all, so a
 * view edit can never contend with or become a refresh command.
 *
 * The declared schema is a shape guard at the host boundary. It is not the
 * authority — `savedViews.ts` owns the exact bounds, the closed vocabularies and
 * the CAS decision, because a JSON-schema declaration cannot express "at most
 * 64 KiB for the whole value" or "duplicates rejected by canonical identity".
 */

const contributionIdentitySchema = {
    type: 'object',
    properties: {
        pluginId: { type: 'string', minLength: 1 },
        localId: { type: 'string', minLength: 1 },
    },
    required: ['pluginId', 'localId'],
    additionalProperties: false,
} as const;

const facet = (items: Readonly<Record<string, unknown>>) => ({
    type: 'array' as const,
    maxItems: MAX_TRIAGE_SAVED_VIEW_FACET_VALUES_V1,
    items,
});

export const TRIAGE_SAVED_VIEWS_SETTINGS_CONTRIBUTION_V1 = {
    id: 'saved-views',
    title: 'Saved views',
    description: 'The saved filter and order views for PRs & Issues, and which one is selected.',
    target: { kind: 'plugin' },
    scope: 'account',
    fields: [{
        id: TRIAGE_SAVED_VIEWS_SETTING_ID_V1,
        title: 'Saved views',
        schema: {
            type: 'object',
            properties: {
                v: { type: 'integer', const: 1 },
                views: {
                    type: 'array',
                    maxItems: MAX_TRIAGE_SAVED_VIEWS_V1,
                    items: {
                        type: 'object',
                        properties: {
                            viewId: { type: 'string', minLength: 1 },
                            label: {
                                type: 'string',
                                minLength: 1,
                                maxLength: MAX_TRIAGE_SAVED_VIEW_LABEL_UTF8_BYTES_V1,
                            },
                            filters: {
                                type: 'object',
                                properties: {
                                    sources: facet({
                                        type: 'object',
                                        properties: { source: contributionIdentitySchema },
                                        required: ['source'],
                                        additionalProperties: false,
                                    }),
                                    types: facet({
                                        type: 'object',
                                        properties: {
                                            source: contributionIdentitySchema,
                                            kindId: { type: 'string', minLength: 1 },
                                        },
                                        required: ['source', 'kindId'],
                                        additionalProperties: false,
                                    }),
                                    scopes: facet({
                                        type: 'object',
                                        properties: {
                                            source: contributionIdentitySchema,
                                            collisionScope: { type: 'string', minLength: 1 },
                                        },
                                        required: ['source', 'collisionScope'],
                                        additionalProperties: false,
                                    }),
                                    states: facet({
                                        type: 'string',
                                        enum: ['open', 'done', 'absent', 'unresolved'],
                                    }),
                                    attention: facet({
                                        type: 'string',
                                        enum: ['required', 'suggested', 'none'],
                                    }),
                                },
                                required: ['sources', 'types', 'scopes', 'states', 'attention'],
                                additionalProperties: false,
                            },
                            order: { type: 'string', enum: ['newest', 'oldest', 'smart'] },
                            smartPolicy: {
                                type: 'object',
                                properties: {
                                    v: { type: 'integer', const: 1 },
                                    precedence: {
                                        type: 'array',
                                        minItems: 2,
                                        maxItems: 2,
                                        items: { type: 'string', enum: ['attention', 'activity'] },
                                    },
                                },
                                required: ['v', 'precedence'],
                                additionalProperties: false,
                            },
                        },
                        required: ['viewId', 'label', 'filters', 'order', 'smartPolicy'],
                        additionalProperties: false,
                    },
                },
                selectedViewId: { anyOf: [{ type: 'string', minLength: 1 }, { type: 'null' }] },
            },
            required: ['v', 'views', 'selectedViewId'],
            additionalProperties: false,
        },
        default: { v: 1, views: [], selectedViewId: null },
        presentation: { hidden: true },
    }],
} satisfies PluginSettingsContribution;
