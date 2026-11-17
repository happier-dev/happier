import { describe, expect, it } from 'vitest';
import { createExternalTicketContributions, EXTERNAL_TICKET_PLUGIN_ID, EXTERNAL_TICKET_ID }
  from '../../fixtures/external-authoring/src/ticketAutomationPlugin.js';

describe('external ticket subject list Action', () => {
  const action = createExternalTicketContributions(EXTERNAL_TICKET_PLUGIN_ID).actions['list-tickets'];

  it('accepts an ordinary default page request without inventing a caller limit', () => {
    const input = action.inputSchema.parse({});
    expect(input).toEqual({});
    const page = action.resultSchema.parse(action.run(input));
    expect(page.items.map(item => item.identity.ticketId)).toEqual([EXTERNAL_TICKET_ID, 'ticket-2']);
    expect(page.nextCursor).toBeNull();
  });

  it('preserves explicit query and limit and resumes the source cursor without a default limit', () => {
    const requested = { query: 'the', limit: 1 };
    const input = action.inputSchema.parse(requested);
    expect(input).toEqual(requested);
    const first = action.resultSchema.parse(action.run(input));
    expect(first.items.map(item => item.identity.ticketId)).toEqual([EXTERNAL_TICKET_ID]);
    expect(first.nextCursor).not.toBeNull();

    const continuation = { query: requested.query, cursor: first.nextCursor };
    const continuedInput = action.inputSchema.parse(continuation);
    expect(continuedInput).toEqual(continuation);
    const second = action.resultSchema.parse(action.run(continuedInput));
    expect(second.items.map(item => item.identity.ticketId)).toEqual(['ticket-2']);
    expect(second.nextCursor).toBeNull();

    const filtered = action.resultSchema.parse(action.run(action.inputSchema.parse({ query: 'deployment', limit: 1 })));
    expect(filtered.items.map(item => item.identity.ticketId)).toEqual(['ticket-2']);
    expect(filtered.nextCursor).toBeNull();
  });
});
