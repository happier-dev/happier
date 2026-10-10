import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from 'zod';

// Compatibility class (docs/compatibility.md#sdk-protocol-evolution): a read projection that a
// machine publishes about itself — additive-open/drop. Unknown properties are stripped; known
// fields stay strict. The same wire shape the 0.2 line publishes (plan R13 K5).

const NonEmptyString = z.string().trim().min(1);

/**
 * How the last first-party CLI update on a machine ended (plan R13 f / wave contract K5).
 *
 * - `succeeded`: the new version is active and, when the background service was running, its
 *   daemon proved it runs that version.
 * - `rolledBack`: activation or the service restart failed locally, so every piece of activation
 *   state was restored and the previous version runs again.
 * - `failed`: nothing was activated (acquisition, verification or smoke failed), or the restore
 *   itself could not complete — the message says which.
 * - `pendingReconnect`: the new version is active and the service is being restarted onto it; the
 *   updater has not reported the end yet. A machine that reconnects on `targetVersion` updated.
 */
export const CliUpdateOutcomeSchema = lazyZodSchema(() => z.enum(['succeeded', 'rolledBack', 'failed', 'pendingReconnect']));
export type CliUpdateOutcome = z.infer<typeof CliUpdateOutcomeSchema>;

/**
 * The persisted end of one update attempt (`<installRoot>/last-update.json`). `targetVersion` is
 * the version the attempt was bound to; only a `failed` attempt can lack one — the release could
 * not even be resolved (e.g. GitHub unreachable), so no version was chosen.
 */
const CliUpdateLastResultFields = {
  /** Epoch milliseconds when this outcome was recorded. */
  at: z.number().int().nonnegative(),
  message: z.string().nullable(),
};
export const CliUpdateLastResultSchema = lazyZodSchema(() => z.union([
  z.object({
    targetVersion: NonEmptyString,
    outcome: z.enum(['succeeded', 'rolledBack', 'pendingReconnect']),
    ...CliUpdateLastResultFields,
  }),
  z.object({
    targetVersion: NonEmptyString.nullable(),
    outcome: z.literal('failed'),
    ...CliUpdateLastResultFields,
  }),
]));
export type CliUpdateLastResult = z.infer<typeof CliUpdateLastResultSchema>;

/**
 * Where the running CLI came from, which decides who updates it: `managed` is Happier's own
 * versioned install (updated by `cli.update.v1` / `happier self update`); `npm` and `brew` belong to
 * that package manager (`updateCommand` names it); `other` is anything else (a repo checkout, a
 * copied binary) and has no update command.
 */
export const CliInstallSourceSchema = lazyZodSchema(() => z.enum(['managed', 'npm', 'brew', 'other']));
export type CliInstallSource = z.infer<typeof CliInstallSourceSchema>;

/**
 * K5 — a machine's first-party CLI update facts, produced by that machine's own CLI from files it
 * already keeps (no network read): the running version, the ring-filtered result of its cached
 * daily `self check`, its install source, and the last update outcome.
 *
 * Published in the machine's encrypted metadata as `cliUpdate` (every daemon, on start) and in
 * `daemon status --json` as the extension of `cliUpdate`. Absent from CLIs that predate it; a reader
 * then shows the version it already has and the update command.
 */
export const CliUpdateFactsSchema = lazyZodSchema(() => z.object({
  currentVersion: NonEmptyString,
  /** `null` when no check cached a result for this ring yet — never guessed. */
  latestVersion: NonEmptyString.nullable(),
  channel: z.enum(['stable', 'preview', 'dev']),
  installSource: CliInstallSourceSchema,
  /** The exact command a person runs to update this CLI; `null` when none is known. */
  updateCommand: NonEmptyString.nullable(),
  /**
   * Whether this machine's daemon runs the update itself when asked (`cli.update.v1` through
   * `tool.systemTasks`). Only a managed install on a platform whose service manager lets the
   * updater outlive the daemon restart.
   */
  canUpdateRemotely: z.boolean(),
  lastUpdate: CliUpdateLastResultSchema.nullable(),
}));
export type CliUpdateFacts = z.infer<typeof CliUpdateFactsSchema>;
