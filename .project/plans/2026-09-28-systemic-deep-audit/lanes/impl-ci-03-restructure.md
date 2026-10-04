# CI-03-RESTRUCTURE execution

Authority: user-approved `briefs/ci-03-restructure.md` and `reviews/test-ci-release-review.md` §§2, 4, 5.3, 6. No PRs; ordinary identity/credentials; fast-forward pushes to `origin/v0.3`; no force; rebases use `--no-autostash`.

The single isolated worktree is `/home/leeroy.guest/.cache/ci03-restructure.1PMNyN`, detached from `origin/v0.3` at `b4a625c9f16b04b040574454f6cf162d7a6e1d59` (remote rechecked 2026-10-04). The dependency overlay links external dependencies for narrow tooling checks and resolves workspace dependencies into this isolated worktree. No shared primary or 0.2 source/index/branch edits. This report is written at the approved relative path in the isolated worktree; the orchestrator owns primary-checkout synchronization.

## P0 — Signal (in progress)

Implemented the automatic v0.3 push/PR gate in `tests.yml`: compiler-only typecheck, affected CLI/UI/server/protocol/plugin unit suites, one CLI/server/HStack/web artifact build job and the canonical staged CLI import probe. Existing extended jobs remain reachable through the existing explicit manual/release selectors. Postgres DB contracts and SQLite lineage remain required on server Prisma changes. Superseded PR runs cancel; push runs retain exact-SHA evidence. Worst-case automatic gate is ten active jobs, including a Prisma-triggered DB lane; no branch-protection mutations were made.

Canonical owners: `scripts/testing/runTypecheck.ts` owns compiler-only execution; `scripts/ci/selectAffectedGatePackages.mjs` uses the existing workspace-manifest and dependency owners for consumer selection; `apps/stack/scripts/utils/cli/cliDistIntegrity.mjs` owns runtime import verification. The existing probe truncated stderr to its last eight lines and could hide the failing specifier; the repair preserves its captured diagnostic. Existing release trust guards, signing, updater trust, OIDC and released compatibility lanes are retained.

Observed RED: affected workspace/peer consumers were absent; compiler-only requests still entered noncompiler phases; selector emitted no GitHub outputs; the daemon import probe omitted `missing-daemon-dependency` before a long diagnostic tail. Focused GREEN is recorded below after terminal validation. No tests were deleted or quarantined. No local full typecheck/build was run. The exact-SHA hosted CI run owns the P0 integration verdict; P1–P6 cannot start before that verdict is green.

Static validation uses actionlint 1.7.12 (Linux arm64). It does not yet understand GitHub.com's documented `job.workflow_ref`, `job.workflow_sha`, and `job.workflow_repository` fields, so only those precise property diagnostics are ignored. Evidence: https://docs.github.com/en/actions/reference/workflows-and-actions/contexts#job-context . Trust guards keep their original job-specific workflow identity semantics. Postgres service-port keys now use string indexing. Shellcheck/pyflakes are not installed and were disabled for this local YAML check.

Authenticated GitHub operations are unavailable: `yarn -s ghops auth status` reports the managed Mac-host credential broker unavailable. Ordinary Git fast-forward push dry-run succeeded; unauthenticated public Actions metadata is readable. No credential or Stack lifecycle changes were attempted.

Terminal focused GREEN: `./apps/stack/bin/hstack-exec --local -- node --experimental-strip-types --test scripts/ci/selectAffectedGatePackages.test.mjs scripts/testing/lib/runTypecheck.test.ts apps/stack/scripts/utils/cli/cliDistIntegrity.test.mjs` passed **16/16** tests, including real subprocess import failure and timeout behavior. Local routing was explicit because these checks must observe this isolated worktree and its overlay rather than the shared primary mirror. The resource-admission queue delayed the command; no admission bypass or full typecheck was used. Targeted actionlint (documented-property exclusion only) and `git diff --check` passed.

Author self-attack corrected the conditional DB lane so an unsuccessful manual trust guard cannot fall back to a GitHub runner. Git diff disables rename collapsing so changes across workspace boundaries select both consumers. No duplicate import probe or typecheck runner was added; the staged probe calls the existing owner, and the new compiler mode stays in the existing runner. Cross-OS artifact smoke and released compatibility remain in the retained explicit/nightly/release corridors, with their later restructuring owned by P3–P5. Documentation changes remain scheduled for approved P5/P6.

## P1–P6 — Pending

The approved governance deletion/audit, build sharing/cache/parallelism, E2E smoke restructuring, artifact-based release with one runtime-selected channel build, and ownership documentation remain pending behind P0. No amendment or scope reduction is proposed.
