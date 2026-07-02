export type VerifyResumeReachableInput = Readonly<{
  targetMaterializedRoot: string;
  targetMaterializedEnv: Readonly<Record<string, string>>;
  vendorResumeId: string | null;
  cwd: string;
  candidatePersistedSessionFile?: string | null;
  /**
   * When true, the probe must prove reachability ONLY from the EXACT final path the vendor reads
   * post-materialization (e.g. for Pi: `PI_CODING_AGENT_DIR/sessions/--<cwd>--`, which follows the
   * shared-state symlink into native). It MUST exclude pre-materialization "source proof" roots
   * (native `~/.pi`, legacy session dirs, `pi-sessions`/`.local-*` staging) so a file that exists
   * only in a staging/source location cannot produce a false-positive spawn gate (plan §2 / CS-FINDING-6).
   *
   * The spawn-time §2 gate (`verifySpawnResumeReachability`) sets this. The EARLY continuity check
   * (pre-materialization) leaves it unset, keeping its broad source-proof search.
   *
   * Providers whose probe already searches only the final target (e.g. Codex's `codex-home/sessions`)
   * are unaffected by this flag.
   */
  targetStrict?: boolean;
}>;

export type VerifyResumeReachableResult =
  | Readonly<{
      ok: true;
      resolvedPath: string | null;
    }>
  | Readonly<{
      ok: false;
      reason: string;
    }>;
