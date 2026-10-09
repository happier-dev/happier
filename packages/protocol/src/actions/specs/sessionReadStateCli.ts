import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from 'zod';

import { actionCliDerivedDefault, type ActionCliBindContext, type ActionCliProjection } from '../actionCliProjection.js';
import type { ActionInputHints } from '../metadata.js';

/**
 * Friendly `session read <session> [--unread]` spelling for
 * `session.read_state.set` (Lane 09 E1).
 *
 * The canonical Action owns `{ sessionId, state }`; argv parsing never becomes
 * another read-state input model. `--unread` selects the deliberate CAS
 * lowering; omission marks read.
 */
export const SessionReadStateSetCliInputSchema = lazyZodSchema(() => z.object({
  sessionId: z.string().trim().min(1),
  unread: z.boolean().optional(),
}).strict());
export type SessionReadStateSetCliInput = z.infer<typeof SessionReadStateSetCliInputSchema>;

export function bindSessionReadStateSetCliInput(
  value: SessionReadStateSetCliInput,
  _context: ActionCliBindContext,
): Readonly<Record<string, unknown>> {
  return {
    sessionId: value.sessionId,
    state: value.unread === undefined ? actionCliDerivedDefault('read') : value.unread ? 'unread' : 'read',
  };
}

const READ_STATE_SET_HINTS: ActionInputHints = {
  title: 'Mark a session read',
  fields: [
    { path: 'sessionId', title: 'Session id or prefix', widget: 'text', required: true },
    { path: 'unread', title: 'Mark unread instead of read', widget: 'boolean' },
  ],
};

export const SESSION_READ_STATE_SET_CLI_PROJECTION: ActionCliProjection = {
  acceptsServerId: true,
  commands: [{
    path: ['session', 'read'],
    positionals: ['sessionId'],
    visibility: 'canonical',
  }],
  inputSchema: SessionReadStateSetCliInputSchema,
  inputHints: READ_STATE_SET_HINTS,
  bindInput: (value, context) => bindSessionReadStateSetCliInput(
    value as SessionReadStateSetCliInput,
    context,
  ),
};
