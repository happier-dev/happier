import { AsyncLocalStorage } from 'node:async_hooks';
import type { WorkspaceSource } from '@/workspaces/source/workspaceSource';

/**
 * The Session a piece of runner work belongs to. One process can host several
 * Sessions; today's runner is a host with one Session and passes the live
 * `process.env`, so its behaviour is unchanged.
 *
 * - `environment` is the Session's process environment: daemon-to-runner
 *   handoff keys, the process owner tag and policy overlays that children of
 *   this Session inherit. Session code reads and writes it instead of
 *   `process.env`.
 * - `termination` is filled by the termination owner so a fatal error raised
 *   inside this Session's work ends only this Session.
 * - `sessionId` and `workingDirectory` are bound by the runtime once known: log
 *   lines carry the Session, and cwd fallbacks use the Session's directory
 *   instead of the process cwd (never `process.chdir`).
 */
export type HostedSessionScope = {
  readonly environment: NodeJS.ProcessEnv;
  termination: unknown;
  sessionId?: string;
  workingDirectory?: string;
  /** Where this Session's workspace lives; bound by the placement owner (absent = this Machine's disk). */
  workspaceSource?: WorkspaceSource;
};

const hostedSessionScope = new AsyncLocalStorage<HostedSessionScope>();

/**
 * Run one Session's work inside its scope. A nested call joins the scope that
 * is already active, so the CLI entry and the runtime share one scope.
 */
export function runInHostedSessionScope<T>(
  input: Readonly<{ environment?: NodeJS.ProcessEnv }>,
  run: () => T,
): T {
  if (hostedSessionScope.getStore()) return run();
  return hostedSessionScope.run({ environment: input.environment ?? process.env, termination: null }, run);
}

export function readHostedSessionScope(): HostedSessionScope | undefined {
  return hostedSessionScope.getStore();
}

/** The current Session's process environment; `process.env` outside a Session. */
export function sessionProcessEnvironment(): NodeJS.ProcessEnv {
  return hostedSessionScope.getStore()?.environment ?? process.env;
}

/** Bind the Session identity of the current scope (Session swaps rebind it). */
export function bindHostedSessionId(sessionId: string): void {
  const scope = hostedSessionScope.getStore();
  if (scope) scope.sessionId = sessionId;
}

/** Bind the Session's working directory once the runtime has resolved it. */
export function bindHostedSessionWorkingDirectory(directory: string): void {
  const scope = hostedSessionScope.getStore();
  if (scope) scope.workingDirectory = directory;
}

/** Bind the Session's workspace source once its placement is known (a target Session's holder source). */
export function bindHostedSessionWorkspaceSource(source: WorkspaceSource): void {
  const scope = hostedSessionScope.getStore();
  if (scope) scope.workspaceSource = source;
}

/** The current Session's working directory; the process cwd outside a Session. */
export function sessionWorkingDirectory(): string {
  return hostedSessionScope.getStore()?.workingDirectory ?? process.cwd();
}
