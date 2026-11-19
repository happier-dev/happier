import { expect, it } from 'vitest';

// Preserve the SDK-first dependency evaluation order without warming any schema.
import { defineProtocolObject } from '@happier-dev/plugin-sdk/protocol';
import { SessionIdSchema } from '@happier-dev/plugin-sdk/sessions';
import { AutomationIdV1Schema } from '@happier-dev/plugin-sdk/automations';
import { ConversationPullRequestV1Schema, SessionPullRequestBindingInputV1Schema } from './sessionPullRequestBindings.js';

void defineProtocolObject;
void SessionIdSchema;
void AutomationIdV1Schema;

it('loads pull-request bindings after the SDK leaf consumers without prewarming schema projections', () => {
    const input = { repository: 'owner/repo', number: 1 };
    expect(ConversationPullRequestV1Schema.parse(input)).toEqual(input);
    expect(ConversationPullRequestV1Schema.safeParse({ ...input, retired: true }).success).toBe(false);
    expect(SessionPullRequestBindingInputV1Schema.safeParse({}).success).toBe(false);
    const document = ConversationPullRequestV1Schema.jsonSchema;
    expect(ConversationPullRequestV1Schema.jsonSchema).toBe(document);
    expect(structuredClone(document)).toEqual(document);
});
