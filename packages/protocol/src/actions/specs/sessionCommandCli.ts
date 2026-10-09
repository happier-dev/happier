import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from 'zod';

import { parseAgentPermissionIntentV1Alias } from '../../runtime/permissionIntentV1.js';
import { actionCliDerivedDefault, type ActionCliProjection } from '../actionCliProjection.js';

/**
 * The friendly spellings of the one-shot Session Actions.
 *
 * Each declaration replaces a hand-written argv parser: the command paths, the
 * positional order and the established flag aliases are the only facts the
 * command line adds, and the canonical Action schema still validates every
 * invocation. A caller binder appears only where the released spelling is not
 * the canonical value — an alias for a permission intent, `native` for the
 * Agent-native model source, a clamped wait timeout.
 */

/** The explicit Agent-native model source, spelled as a null connection id. */
export const SESSION_MODEL_NATIVE_PROVIDER_CONNECTION_TOKEN = 'native';

/** The idle wait the CLI has always applied when the caller supplies none. */
export const SESSION_WAIT_DEFAULT_TIMEOUT_SECONDS = 300;
const SESSION_WAIT_MAX_TIMEOUT_SECONDS = 3600;

export const SESSION_STATUS_GET_CLI_PROJECTION: ActionCliProjection = {
  commands: [{ path: ['session', 'status'], positionals: ['sessionId'], visibility: 'canonical' }],
};

export const SESSION_TITLE_SET_CLI_PROJECTION: ActionCliProjection = {
  commands: [{ path: ['session', 'set-title'], positionals: ['sessionId', 'title'], visibility: 'canonical' }],
};

export const SESSION_ARCHIVE_CLI_PROJECTION: ActionCliProjection = {
  commands: [{ path: ['session', 'archive'], positionals: ['sessionId'], visibility: 'canonical' }],
};

export const SESSION_UNARCHIVE_CLI_PROJECTION: ActionCliProjection = {
  commands: [{ path: ['session', 'unarchive'], positionals: ['sessionId'], visibility: 'canonical' }],
};

export const SESSION_STOP_CLI_PROJECTION: ActionCliProjection = {
  commands: [
    { path: ['session', 'stop'], positionals: ['sessionId'], visibility: 'canonical' },
    { path: ['stop'], positionals: ['sessionId'], visibility: 'alias' },
  ],
};

/**
 * `<mode>` accepts every established alias — `plan`, `accept-edits`, `ro`,
 * `yolo` — and the binder resolves it to the canonical intent the incumbent
 * command sent. Rejecting an unknown alias at the caller schema keeps the
 * diagnostic naming the value the user typed.
 */
export const SessionPermissionModeSetCliInputSchema = lazyZodSchema(() => z.object({
  sessionId: z.string().trim().min(1),
  permissionMode: z.string().trim().min(1).refine(
    (value) => parseAgentPermissionIntentV1Alias(value) !== null,
    { message: 'Invalid permission mode' },
  ),
}).strict());
export type SessionPermissionModeSetCliInput = z.infer<typeof SessionPermissionModeSetCliInputSchema>;

export function bindSessionPermissionModeSetCliInput(
  value: Readonly<Partial<SessionPermissionModeSetCliInput>>,
): Readonly<Record<string, unknown>> {
  // Over canonical whole-input JSON this binder sees only the caller fields the
  // caller actually typed, so each projection is conditional on its source.
  return {
    ...(value.sessionId === undefined ? {} : { sessionId: value.sessionId }),
    ...(value.permissionMode === undefined
      ? {}
      : { permissionMode: parseAgentPermissionIntentV1Alias(value.permissionMode)! }),
  };
}

export const SESSION_PERMISSION_MODE_SET_CLI_PROJECTION: ActionCliProjection = {
  commands: [{
    path: ['session', 'set-permission-mode'],
    positionals: ['sessionId', 'permissionMode'],
    visibility: 'canonical',
  }],
  inputSchema: SessionPermissionModeSetCliInputSchema,
  inputHints: {
    title: 'Set permission mode',
    fields: [
      { path: 'sessionId', title: 'Session id or prefix', widget: 'text', required: true },
      { path: 'permissionMode', title: 'Permission mode or alias', widget: 'text', required: true },
    ],
  },
  bindInput: (value) => bindSessionPermissionModeSetCliInput(value as Partial<SessionPermissionModeSetCliInput>),
};

/**
 * `--provider-connection native` selects the Agent-native source, which the
 * Action contract represents as a null connection id. Omitting the flag leaves
 * the current selection untouched.
 */
export const SessionModelSetCliInputSchema = lazyZodSchema(() => z.object({
  sessionId: z.string().trim().min(1),
  modelId: z.string().trim().min(1),
  providerConnection: z.string().trim().min(1).optional(),
}).strict());
export type SessionModelSetCliInput = z.infer<typeof SessionModelSetCliInputSchema>;

export function bindSessionModelSetCliInput(
  value: SessionModelSetCliInput,
): Readonly<Record<string, unknown>> {
  return {
    sessionId: value.sessionId,
    modelId: value.modelId,
    ...(value.providerConnection === undefined ? {} : {
      providerConnectionId: value.providerConnection === SESSION_MODEL_NATIVE_PROVIDER_CONNECTION_TOKEN
        ? null
        : value.providerConnection,
    }),
  };
}

export const SESSION_MODEL_SET_CLI_PROJECTION: ActionCliProjection = {
  commands: [{
    path: ['session', 'set-model'],
    positionals: ['sessionId', 'modelId'],
    visibility: 'canonical',
  }],
  inputSchema: SessionModelSetCliInputSchema,
  inputHints: {
    title: 'Set session model',
    fields: [
      { path: 'sessionId', title: 'Session id or prefix', widget: 'text', required: true },
      { path: 'modelId', title: 'Model id', widget: 'text', required: true },
      {
        path: 'providerConnection',
        title: `Provider connection id, or "${SESSION_MODEL_NATIVE_PROVIDER_CONNECTION_TOKEN}" (optional)`,
        widget: 'text',
      },
    ],
  },
  bindInput: (value) => bindSessionModelSetCliInput(value as SessionModelSetCliInput),
};

/**
 * The incumbent wait clamps an over-long timeout instead of refusing it, and
 * applies its own default when none is supplied. The canonical schema owns the
 * accepted range, so the clamp lives in this caller projection rather than
 * widening the Action.
 */
export const SessionWaitIdleCliInputSchema = lazyZodSchema(() => z.object({
  sessionId: z.string().trim().min(1),
  timeoutSeconds: z.number().int().min(1).optional(),
}).strict());
export type SessionWaitIdleCliInput = z.infer<typeof SessionWaitIdleCliInputSchema>;

/**
 * The idle timeout a CLI caller's `--timeout` produces. `happier session create
 * --wait` composes the same wait, so it resolves its timeout here rather than
 * repeating the default and the ceiling.
 */
export function resolveSessionWaitTimeoutSeconds(value: number | null | undefined): number {
  return Math.min(
    SESSION_WAIT_MAX_TIMEOUT_SECONDS,
    typeof value === 'number' && Number.isFinite(value) && value > 0
      ? value
      : SESSION_WAIT_DEFAULT_TIMEOUT_SECONDS,
  );
}

export function bindSessionWaitIdleCliInput(
  value: SessionWaitIdleCliInput,
): Readonly<Record<string, unknown>> {
  return {
    sessionId: value.sessionId,
    timeoutSeconds: value.timeoutSeconds === undefined
      ? actionCliDerivedDefault(resolveSessionWaitTimeoutSeconds(undefined))
      : resolveSessionWaitTimeoutSeconds(value.timeoutSeconds),
  };
}

export const SESSION_WAIT_IDLE_CLI_PROJECTION: ActionCliProjection = {
  commands: [
    { path: ['session', 'wait'], positionals: ['sessionId'], visibility: 'canonical' },
  ],
  inputSchema: SessionWaitIdleCliInputSchema,
  inputHints: {
    title: 'Wait for idle',
    fields: [
      { path: 'sessionId', title: 'Session id or prefix', widget: 'text', required: true },
      { path: 'timeoutSeconds', title: 'Wait timeout in seconds (optional)', widget: 'text' },
    ],
  },
  flagAliases: [{ path: 'timeoutSeconds', aliases: ['--timeout'] }],
  bindInput: (value) => bindSessionWaitIdleCliInput(value as SessionWaitIdleCliInput),
};
