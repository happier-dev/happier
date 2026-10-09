import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from 'zod';

import { parseAgentPermissionIntentV1Alias } from '../../runtime/permissionIntentV1.js';
import { actionCliDerivedDefault, type ActionCliBindContext, type ActionCliProjection } from '../actionCliProjection.js';
import type { ActionInputHints } from '../metadata.js';

/**
 * The explicit Agent-native model source. The Action contract represents it as a
 * null connection id; `native` is only the caller's spelling for it.
 */
export const SESSION_SEND_NATIVE_PROVIDER_CONNECTION_TOKEN = 'native';

/** The caller spelling `--model default` uses to clear a session model override. */
export const SESSION_SEND_DEFAULT_MODEL_TOKEN = 'default';

/** The friendly send timeout the CLI has always applied when none is supplied. */
export const SESSION_SEND_DEFAULT_TIMEOUT_SECONDS = 300;
const SESSION_SEND_MAX_TIMEOUT_SECONDS = 3600;

/**
 * The caller shape `happier send` accepts.
 *
 * It differs from canonical `session.message.send` input in exactly the places
 * where the command line has an established shorthand: `--run` instead of a
 * structured recipient, `--permission-mode` aliases, `--model default`,
 * `--provider-connection native`. Everything else is the canonical field under
 * its canonical name, and the canonical schema still validates what the binder
 * below emits.
 */
export const SessionSendCliInputSchema = lazyZodSchema(() => z.object({
  sessionId: z.string().trim().min(1),
  /**
   * Authored content. It is deliberately not trimmed: the caller's exact argv
   * bytes — leading whitespace, newlines, quotes, Unicode — reach the Action.
   * Only blankness is rejected, the same way the incumbent command rejects it.
   */
  message: z.string().refine((value) => value.trim().length > 0, {
    message: 'message must not be blank',
  }),
  /** The Session-owned interactive Execution Run this input targets. */
  run: z.string().trim().min(1).optional(),
  permissionMode: z.string().trim().min(1)
    .refine((value) => parseAgentPermissionIntentV1Alias(value) !== null, {
      message: 'Invalid permission mode',
    })
    .optional(),
  model: z.string().trim().min(1).optional(),
  providerConnection: z.string().trim().min(1).optional(),
  localId: z.string().trim().min(1).optional(),
  wait: z.boolean().optional(),
  timeoutSeconds: z.number().int().min(1).optional(),
}).strict().superRefine((value, ctx) => {
  // The canonical schema owns the same rule, but it can only name the canonical
  // field. Naming the caller's flags keeps the established diagnostic.
  if (value.providerConnection === undefined) return;
  if (
    value.model === undefined
    || (value.providerConnection !== SESSION_SEND_NATIVE_PROVIDER_CONNECTION_TOKEN
      && value.model === SESSION_SEND_DEFAULT_MODEL_TOKEN)
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: '--provider-connection requires --model <model-id>',
    });
  }
}));

export type SessionSendCliInput = z.infer<typeof SessionSendCliInputSchema>;

export const SessionSendCliInputHints: ActionInputHints = {
  title: 'Send a message',
  fields: [
    { path: 'sessionId', title: 'Session id or prefix', widget: 'text', required: true },
    { path: 'message', title: 'Message', widget: 'textarea', required: true },
    { path: 'run', title: 'Target execution run id (optional)', widget: 'text' },
    { path: 'permissionMode', title: 'Permission mode override (optional)', widget: 'text' },
    { path: 'model', title: 'Model override, or "default" (optional)', widget: 'text' },
    { path: 'providerConnection', title: 'Provider connection id, or "native" (optional)', widget: 'text' },
    { path: 'localId', title: 'Durable input identity for a safe retry (optional)', widget: 'text' },
    // Shared by the main send and a targeted `--run` send: `wait` settles the
    // admitted message's own turn, never parent-Session idle (Lane 05 plan 04 §10.2).
    { path: 'wait', title: 'Wait for message completion (optional)', widget: 'boolean' },
    { path: 'timeoutSeconds', title: 'Wait timeout in seconds (optional)', widget: 'text' },
  ],
};

/**
 * Pure caller-shape projection. It authorizes nothing, resolves nothing and
 * reaches nothing: an omitted `run` constructs no recipient and keeps the
 * main-Session fast path, and an explicit one becomes the strict recipient the
 * canonical Session-input owner then admits or refuses.
 */
export function bindSessionSendCliInput(
  value: Readonly<Partial<SessionSendCliInput>>,
  context: ActionCliBindContext,
): Readonly<Record<string, unknown>> {
  const permissionModeOverride = value.permissionMode === undefined
    ? undefined
    : parseAgentPermissionIntentV1Alias(value.permissionMode) ?? undefined;
  const modelOverride = value.model === undefined
    ? undefined
    : value.model === SESSION_SEND_DEFAULT_MODEL_TOKEN ? null : value.model;
  const providerConnectionId = value.providerConnection === undefined
    ? undefined
    : value.providerConnection === SESSION_SEND_NATIVE_PROVIDER_CONNECTION_TOKEN
      ? null
      : value.providerConnection;
  // Over canonical whole-input JSON this binder sees only the caller fields the
  // caller actually typed, so each projection is conditional on its source.
  return {
    ...(value.sessionId === undefined ? {} : { sessionId: value.sessionId }),
    ...(value.message === undefined ? {} : { message: value.message }),
    ...(value.run === undefined ? {} : { recipient: { kind: 'execution_run' as const, runId: value.run } }),
    ...(permissionModeOverride ? { permissionModeOverride } : {}),
    ...(modelOverride !== undefined ? { modelOverride } : {}),
    ...(providerConnectionId !== undefined ? { providerConnectionId } : {}),
    // The durable identity this send is keyed by. Retrying with it rejoins the
    // exact pending input instead of queueing a second message, so one is always
    // retained — an identity minted out of the caller's reach cannot be named in
    // the failure guidance.
    localId: value.localId ?? actionCliDerivedDefault(context.invocationId),
    ...(value.wait ? { wait: true } : {}),
    timeoutSeconds: value.timeoutSeconds === undefined
      ? actionCliDerivedDefault(SESSION_SEND_DEFAULT_TIMEOUT_SECONDS)
      : Math.min(SESSION_SEND_MAX_TIMEOUT_SECONDS, value.timeoutSeconds),
  };
}

/**
 * The three friendly spellings of one canonical send.
 *
 * `session run send SESSION RUN MESSAGE` is a compatibility argv alias: it binds
 * the same caller field `run` positionally and reaches the same canonical Action
 * input, with no parser, delivery policy or executor of its own.
 */
export const SESSION_SEND_CLI_PROJECTION: ActionCliProjection = {
  commands: [
    { path: ['session', 'send'], positionals: ['sessionId', 'message'], visibility: 'canonical' },
    { path: ['send'], positionals: ['sessionId', 'message'], visibility: 'alias' },
    {
      path: ['session', 'run', 'send'],
      positionals: ['sessionId', 'run', 'message'],
      visibility: 'alias',
      deprecated: {
        replacement: 'happier send <session> <message> --run <run>',
        removalCondition: 'the approved 0.3 CLI compatibility window has ended',
      },
    },
  ],
  inputSchema: SessionSendCliInputSchema,
  inputHints: SessionSendCliInputHints,
  flagAliases: [
    { path: 'message', aliases: ['--prompt'] },
    { path: 'timeoutSeconds', aliases: ['--timeout'] },
  ],
  bindInput: (value, context) => bindSessionSendCliInput(value as Partial<SessionSendCliInput>, context),
};
