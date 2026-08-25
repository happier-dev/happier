import type {
  PublicActionId,
  PublicActionInputById,
  PublicActionResultById,
} from './actions/generated.js';

export type ActionTarget =
  | Readonly<{ kind: 'machine'; machineId: string }>
  | Readonly<{ kind: 'session'; sessionId: string }>;

export type ActionExecutionOptions = Readonly<{
  target?: ActionTarget;
  signal?: AbortSignal;
  requestId?: string;
}>;

export type ActionExecute = <K extends PublicActionId>(
  actionId: K,
  input: PublicActionInputById[K],
  options?: ActionExecutionOptions,
) => Promise<PublicActionResultById[K]>;

export type HappierConnectOptions = Readonly<{
  endpoint: string | URL;
  token: string;
}>;

/** A structured contributed-Action identity or its canonical qualified discovery id. */
export type ContributedActionId =
  | PublicActionInputById['action.invoke']['action']
  | string;
