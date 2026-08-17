/**
 * The canonical outcome shape shared by Action execution projections.
 *
 * It is deliberately separate from the daemon-heavy executor type graph so
 * browser-facing SDK declarations do not pull the aggregate Actions barrel.
 */
export type ActionExecuteResult =
  | Readonly<{ ok: true; result: unknown }>
  | Readonly<{ ok: false; errorCode: string; error: string; details?: unknown }>;
