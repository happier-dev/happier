import { z } from 'zod';

const IdentifierSchema = z.string().trim().min(1).max(256);
const PresentationTextSchema = z.string().max(16_384);

export const CurrentSessionPresentationBindV1Schema = z.object({
  clientId: IdentifierSchema,
  focused: z.boolean(),
  draftRevision: z.number().int().nonnegative(),
}).strict();

export type CurrentSessionPresentationBindV1 = z.infer<typeof CurrentSessionPresentationBindV1Schema>;

export const CurrentSessionPresentationBindResultV1Schema = z.object({
  status: z.literal('bound'),
  sessionId: IdentifierSchema,
  hostNonce: IdentifierSchema,
  revision: z.number().int().nonnegative(),
}).strict();

export type CurrentSessionPresentationBindResultV1 = z.infer<typeof CurrentSessionPresentationBindResultV1Schema>;

const CurrentSessionPresentationCommandV1Schema = z.discriminatedUnion('kind', [
  z.object({
    id: IdentifierSchema,
    clientId: IdentifierSchema,
    kind: z.literal('notify'),
    message: PresentationTextSchema,
    severity: z.enum(['info', 'warning', 'error']),
  }).strict(),
  z.object({
    id: IdentifierSchema,
    clientId: IdentifierSchema,
    kind: z.literal('composer.replace'),
    text: PresentationTextSchema,
    expectedDraftRevision: z.number().int().nonnegative(),
  }).strict(),
]);

export const CurrentSessionPresentationStateV1Schema = z.object({
  v: z.literal(1),
  hostNonce: IdentifierSchema,
  revision: z.number().int().nonnegative(),
  statuses: z.array(z.object({
    key: IdentifierSchema,
    text: PresentationTextSchema,
    revision: z.number().int().nonnegative(),
  }).strict()).max(32),
  widgets: z.array(z.object({
    key: IdentifierSchema,
    placement: z.enum(['beforeComposer', 'afterComposer']),
    lines: z.array(PresentationTextSchema).max(32),
    revision: z.number().int().nonnegative(),
  }).strict()).max(16),
  command: CurrentSessionPresentationCommandV1Schema.optional(),
}).strict();

export type CurrentSessionPresentationStateV1 = z.infer<typeof CurrentSessionPresentationStateV1Schema>;
export type CurrentSessionPresentationCommandV1 = NonNullable<CurrentSessionPresentationStateV1['command']>;

export const CurrentSessionPresentationAckV1Schema = z.object({
  hostNonce: IdentifierSchema,
  clientId: IdentifierSchema,
  commandId: IdentifierSchema,
  status: z.enum(['applied', 'conflict']),
  draftRevision: z.number().int().nonnegative().optional(),
}).strict();

export type CurrentSessionPresentationAckV1 = z.infer<typeof CurrentSessionPresentationAckV1Schema>;

export const CURRENT_SESSION_PRESENTATION_AGENT_STATE_KEY = 'currentSessionPresentationV1' as const;
export const CURRENT_SESSION_PRESENTATION_BIND_RPC_METHOD = 'session.presentation.bind' as const;
export const CURRENT_SESSION_PRESENTATION_ACK_RPC_METHOD = 'session.presentation.ack' as const;
