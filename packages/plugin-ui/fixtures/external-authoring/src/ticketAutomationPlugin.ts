import { definePlugin, type PluginInvocationContext } from '@happier-dev/plugin-sdk';
import { PluginSubjectKindListInputV1Schema } from '@happier-dev/plugin-sdk/automations';
import { admitCheckpointedPluginEventObservationV1 } from '@happier-dev/plugin-sdk/events';
import {
  defineProtocolArray,
  defineProtocolLiteral,
  defineProtocolObject,
  defineProtocolString,
  type ProtocolSchemaOutput,
} from '@happier-dev/plugin-sdk/protocol';

/** The two fixture plugins deliberately reuse both their kind id and ticket id. */
export const EXTERNAL_TICKET_PLUGIN_ID = 'fixture.external-authoring';
export const OTHER_EXTERNAL_TICKET_PLUGIN_ID = 'fixture.other-external-tickets';
export const EXTERNAL_TICKET_ID = 'ticket-1';
export const EXTERNAL_TICKET_KIND_ID = 'ticket';

export const externalTicketIdentitySchema = defineProtocolObject({
  ticketId: defineProtocolString({ minLength: 1 }),
}, { policy: 'closed' });

const ticketStateSchema = defineProtocolObject({
  ticketId: defineProtocolString({ minLength: 1 }),
  state: defineProtocolLiteral('closed'),
}, { policy: 'closed' });
const closeTicketInputSchema = defineProtocolObject({
  ticket: externalTicketIdentitySchema,
}, { policy: 'closed' });
const listResultSchema = defineProtocolObject({
  items: defineProtocolArray(defineProtocolObject({
    identity: externalTicketIdentitySchema,
    label: defineProtocolString(),
  }, { policy: 'closed' })),
  nextCursor: defineProtocolLiteral(null),
}, { policy: 'closed' });

/**
 * A real external Action/event producer for the D13 composed journey. Its two-ticket inventory is
 * fixture data; Happier still owns trigger storage, subject matching, admission and Run history.
 */
export function createExternalTicketContributions(pluginId: string) {
  const observeTicket = (ticket: ProtocolSchemaOutput<typeof externalTicketIdentitySchema>, context: PluginInvocationContext) => {
    const observedAt = Date.now();
    return admitCheckpointedPluginEventObservationV1({
      eventRef: { pluginId, localId: 'ticket-changed' }, sourceInstanceId: 'tickets', sourceContractVersion: 1,
      occurrenceId: crypto.randomUUID(), occurredAt: observedAt, observationReceivedAt: observedAt,
      observedDelta: 1, payload: { ticket, state: 'closed' },
    }, context);
  };
  return {
    subjectKinds: { ticket: { label: 'Ticket', identitySchema: externalTicketIdentitySchema.jsonSchema, listAction: 'list-tickets' } },
    actions: {
      'watch-tickets': {
        title: 'Watch tickets', surfaces: ['plugin', 'ui', 'cli'], execution: { target: 'daemon' }, readOnly: true,
        inputSchema: externalTicketIdentitySchema,
        run: (input: ProtocolSchemaOutput<typeof externalTicketIdentitySchema>) => ({
          v: 1, sourceInstanceId: 'tickets', sourceContractVersion: 1, sourceConfig: input,
        }),
      },
      'observe-ticket': {
        title: 'Observe ticket', surfaces: ['plugin', 'ui', 'cli'], execution: { target: 'daemon' }, readOnly: false,
        inputSchema: externalTicketIdentitySchema,
        run: observeTicket,
      },
      'list-tickets': {
        title: 'List tickets',
        surfaces: ['plugin', 'ui'],
        execution: { target: 'daemon' },
        readOnly: true,
        inputSchema: PluginSubjectKindListInputV1Schema,
        resultSchema: listResultSchema,
        run: () => ({
          items: [
            { identity: { ticketId: EXTERNAL_TICKET_ID }, label: 'Fix the checkout' },
            { identity: { ticketId: 'ticket-2' }, label: 'Review the deployment' },
          ],
          nextCursor: null,
        }),
      },
      'close-ticket': {
        title: 'Close ticket',
        surfaces: ['plugin', 'ui', 'cli'],
        execution: { target: 'daemon' },
        readOnly: false,
        approvalScope: { kind: 'plugin', subjectKindId: EXTERNAL_TICKET_KIND_ID, identityField: 'ticket' },
        inputSchema: closeTicketInputSchema,
        resultSchema: ticketStateSchema,
        async run(input: ProtocolSchemaOutput<typeof closeTicketInputSchema>, context: PluginInvocationContext) {
          const closed = { ticketId: input.ticket.ticketId, state: 'closed' as const };
          await observeTicket(input.ticket, context);
          return closed;
        },
      },
    },
    events: {
      'ticket-changed': {
        declaration: {
          kind: 'event',
          title: 'Ticket changed',
          payloadSchema: defineProtocolObject({ ticket: externalTicketIdentitySchema,
            state: defineProtocolLiteral('closed') }, { policy: 'closed' }).jsonSchema,
          automation: { v: 1, eligible: true,
            subjects: [{ kind: 'plugin', subjectKindId: EXTERNAL_TICKET_KIND_ID, identityField: 'ticket' }],
            source: { sourceContractVersion: 1, supportedObservationTransports: ['checkpointedPull'],
              sourceConfigSchema: externalTicketIdentitySchema.jsonSchema,
              setupActionRef: { pluginId, localId: 'watch-tickets' } },
          },
        },
      },
    },
  } as const;
}

export const externalTicketContributions = createExternalTicketContributions(EXTERNAL_TICKET_PLUGIN_ID);

export function createExternalTicketPlugin(pluginId: string) {
  return definePlugin({ id: pluginId, version: '0.1.0', ...createExternalTicketContributions(pluginId) });
}
