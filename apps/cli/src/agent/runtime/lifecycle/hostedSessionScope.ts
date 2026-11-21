import { AsyncLocalStorage } from 'node:async_hooks';
import type { SessionRuntimeIssueV1 } from '@happier-dev/protocol/sessions/control/runtimeIssueV1';
import type { WorkspaceSource } from '@/workspaces/source/workspaceSource';
import type { AgentRuntimeRunnerBootstrapV1 } from '@/agent/runtime/session/process/agentRuntimeRunnerProtocol';
import { SessionRuntimeConfiguration } from '@/configuration/sessionRuntimeConfiguration';
import type { TranscriptRecoveryCoordinator } from '@/api/session/recovery/TranscriptRecoveryCoordinator';
import type { ScmCredentialFreeRepositorySelectorV1 } from '@happier-dev/protocol/scm/repositoryClone';
import type { SessionInputLiveWork } from '@/agent/runtime/session/input/_types';

/**
 * The Session a piece of runner work belongs to. One process can host several
 * Sessions; today's runner is a host with one Session and passes the live
 * `process.env`, so its behaviour is unchanged.
 *
 * - `environment` is the Session's process environment: daemon-to-runner
 *   handoff keys, the process owner tag and policy overlays that children of
 *   this Session inherit. Session code reads and writes it instead of
 *   `process.env`.
 * - `runtimeConfiguration` captures policy once from that environment, without
 *   changing the host's Home, credentials or installation identity.
 * - `termination` is filled by the termination owner so a fatal error raised
 *   inside this Session's work ends only this Session.
 * - `sessionId` and `workingDirectory` are bound by the runtime once known: log
 *   lines carry the Session, and cwd fallbacks use the Session's directory
 *   instead of the process cwd (never `process.chdir`).
 */
export type HostedSessionScope = {
  readonly environment: NodeJS.ProcessEnv;
  /** Parsed once at admission; independent of the host's Home/install identity. */
  runtimeConfiguration: SessionRuntimeConfiguration;
  /** Recovery schedulers share this Session's admitted policy and lifetime. */
  transcriptRecoveryCoordinators?: Map<string, TranscriptRecoveryCoordinator>;
  termination: unknown;
  /** Content-free runner failure retained until this Session reports its end. */
  failureCause?: SessionRuntimeIssueV1['failureCause'];
  sessionId?: string;
  workingDirectory?: string;
  /** Where this Session's workspace lives; bound by the placement owner (absent = this Machine's disk). */
  workspaceSource?: WorkspaceSource;
  /** Host-recorded Project files clone source; never sourced from guest Git config. */
  projectFilesSource?: ScmCredentialFreeRepositorySelectorV1;
  /**
   * Ends this Session's command in a process that hosts several Sessions (set by the session host
   * when it adds the Session). Absent in a one-Session runner: its command ends the process.
   */
  readonly end?: (exitCode: number) => void;
  /** Work a planned host hand-over saves before it releases this Session's held Agents. */
  handoverSaves?: Set<() => Promise<void>>;
  /** This Session's current live work: the same non-content facts its runner pushes to the daemon. */
  readLiveWork?: () => Promise<SessionInputLiveWork>;
  /** The daemon-admitted runner bootstrap of the file this Session's environment names (session host). */
  readonly runnerBootstrap?: Readonly<{ path: string; bootstrap: AgentRuntimeRunnerBootstrapV1 }>;
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
  const environment = input.environment ?? process.env;
  return hostedSessionScope.run({ environment, runtimeConfiguration: new SessionRuntimeConfiguration(environment), termination: null }, run);
}

/**
 * Run one Session added to a session host: always its own scope (never the caller's), with the
 * host's per-Session end.
 */
export function runAddedHostedSession<T>(
  input: Readonly<{ environment: NodeJS.ProcessEnv; workingDirectory: string; end: (exitCode: number) => void;
    runnerBootstrap?: HostedSessionScope['runnerBootstrap'] }>,
  run: () => T,
): T {
  return hostedSessionScope.run({ ...input, runtimeConfiguration: new SessionRuntimeConfiguration(input.environment), termination: null }, run);
}

export function readHostedSessionScope(): HostedSessionScope | undefined {
  return hostedSessionScope.getStore();
}

/** Retain the registering Session when a transport invokes its callback from another async context. */
export function bindToHostedSessionScope<TArgs extends unknown[], TResult>(
  callback: (...args: TArgs) => TResult,
): (...args: TArgs) => TResult {
  const scope = hostedSessionScope.getStore();
  if (!scope) return callback;
  return (...args) => hostedSessionScope.run(scope, callback, ...args);
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

/** Let the session host answer its daemon's one live-work read for this Session (after a daemon restart). */
export function bindHostedSessionLiveWork(read: () => Promise<SessionInputLiveWork>): void {
  const scope = hostedSessionScope.getStore();
  if (scope) scope.readLiveWork = read;
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

/** Bind the immutable Project files clone source admitted in the Session recipe. */
export function bindHostedSessionProjectFilesSource(source: ScmCredentialFreeRepositorySelectorV1): void {
  const scope = hostedSessionScope.getStore();
  if (scope) scope.projectFilesSource = source;
}

/** The current Session's working directory; the process cwd outside a Session. */
export function sessionWorkingDirectory(): string {
  return hostedSessionScope.getStore()?.workingDirectory ?? process.cwd();
}

/**
 * Registers what this Session must save before a planned host hand-over releases its held Agents
 * (its pending transcript checkpoint). Outside a hosted Session there is no hand-over: a no-op.
 */
export function onHostedSessionHandover(save: () => Promise<void>): () => void {
  const scope = hostedSessionScope.getStore();
  if (!scope) return () => {};
  const saves = scope.handoverSaves ??= new Set();
  saves.add(save);
  return () => { saves.delete(save); };
}

/** Runs every hand-over save the Session registered. */
export async function saveHostedSessionForHandover(scope: HostedSessionScope): Promise<void> {
  await Promise.all([...scope.handoverSaves ?? []].map(save => save()));
}
