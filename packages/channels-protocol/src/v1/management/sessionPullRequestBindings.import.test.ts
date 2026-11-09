import { expect, it } from 'vitest';

// Keep the real cold import order at collection, where source transformation
// belongs, rather than charging that work to the assertion timeout.
// This order previously reached a copied accessor before its receiver had an
// admitted Protocol lifetime. No schema projection is warmed here.
await import('@happier-dev/plugin-sdk/protocol');
await import('@happier-dev/plugin-sdk/sessions');
await import('@happier-dev/plugin-sdk/automations');
const { ConversationPullRequestV1Schema, SessionPullRequestBindingInputV1Schema } =
    await import('./sessionPullRequestBindings.js');

it('loads pull-request bindings after the SDK leaf consumers without prewarming schema projections', () => {
    const input = { repository: 'owner/repo', number: 1 };
    expect(ConversationPullRequestV1Schema.parse(input)).toEqual(input);
    expect(ConversationPullRequestV1Schema.safeParse({ ...input, retired: true }).success).toBe(false);
    expect(SessionPullRequestBindingInputV1Schema.safeParse({}).success).toBe(false);
    const document = ConversationPullRequestV1Schema.jsonSchema;
    expect(ConversationPullRequestV1Schema.jsonSchema).toBe(document);
    expect(structuredClone(document)).toEqual(document);
});
