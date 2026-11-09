# Happier Server Instructions

Package-specific instructions for `apps/server`. These supplement the root constitution and override broader guidance where more specific.

## Commands

Use pnpm and the package scripts.

- `pnpm run build` — build/type-enforcing lane.
- `pnpm run start` — start the server.
- `pnpm run test` — run server tests.
- `pnpm run migrate` — run existing Prisma migrations when intentionally requested; an authorized schema/migration edit itself triggers the required repo-local deploy and reconciliation below.
- `pnpm run generate` — generate Prisma client/types when needed.
- `pnpm run db` — start local PostgreSQL in Docker.

## Core stack

- TypeScript strict mode.
- Fastify for HTTP routes.
- Prisma/PostgreSQL for storage.
- Zod for request/response validation.
- Socket.IO/Redis for realtime/event infrastructure.
- pnpm for package management.

## Source layout

- `sources/app/**` — application entrypoints and route/action ownership.
- `sources/modules/**` — reusable modules that abstract related complexity.
- `sources/storage/**` — database/storage helpers, transaction wrappers, Prisma client access.
- `sources/utils/**` — low-level utilities.
- `sources/recipes/**` — scripts run outside the server runtime.

Prefer existing domain folders and module owners before creating new top-level folders.

## TypeScript and style

- Use 4 spaces for indentation in server code.
- Use strict TypeScript and accurate exported types.
- Prefer functional/declarative patterns; avoid classes unless they clearly improve ownership.
- Prefer interfaces over broad object aliases when modeling stable contracts.
- Avoid enums for new code; prefer typed maps/unions where consistent with the package.
- Use absolute imports with the package alias when available.
- Utility files should have explicit, purpose-revealing names, preferably matching their primary export.

## Database and transactions

- Do not change Prisma schema unless schema/data-model changes are explicitly in scope.
- When schema changes are in scope, own the complete migration work:
  - update the relevant Prisma schema(s),
  - create/update the required migration(s) with the server workflow,
  - keep provider-specific Postgres/SQLite/MySQL schemas and migrations in sync when affected,
  - inspect generated SQL for data-loss or downtime risks,
  - validate with the relevant server test/build lane.
- Classify migration history before editing it:
  - Follow the 2026-10-31 **Migrations: no edits during development, one consolidation before 0.3 release** row in `.project/OWNER-RULINGS.md` for migration authoring, the named release check and accidental-edit reconciliation; the reconciliation procedure is in `apps/stack/AGENTS.md` **Repo-local development database reconciliation**.
  - stable/preview migration names and bytes are immutable and corrections are append-only;
  - do not keep draft add/rename/contract/drop chains or checksum/name compatibility solely because a retained development database applied an unpublished revision.
- Reconcile retained development databases separately from product migration history. Follow the 2026-10-31 **Migrations: no edits during development, one consolidation before 0.3 release** row in `.project/OWNER-RULINGS.md` for migration authoring, the named release check and accidental-edit reconciliation; the reconciliation procedure is in `apps/stack/AGENTS.md` **Repo-local development database reconciliation**.
- The current checkout's repo-local development database is retained data, not a disposable test database. Never delete, reset, recreate, replace, truncate, clean, or discard it to resolve migration drift. Reset-style commands are forbidden for this target even when they would be faster than reconciliation.
- For accidental applied-migration edits, reconciliation ownership and current-byte/schema verification follow `apps/stack/AGENTS.md` **Repo-local development database reconciliation**.
- If the repo-local stack has active stack-owned writers, quiesce only that stack through `hstack`, reconcile, and restore its prior running state. Do not kill by port or affect another stack. If stack/database ownership is ambiguous, stop without mutating a candidate.
- Backups and explicit approval remain required for `main`, shared, staging, production, external, another checkout's/named QA stack, or otherwise user-owned databases. The repo-local automatic rule never broadens to those targets.
- Custom migration SQL, backfills, `db push`, or reset-style commands are allowed only when appropriate for the task and target database.
  - Safe for genuinely disposable local/test databases when clearly scoped; the current checkout's repo-local development database is explicitly not disposable.
  - Requires explicit approval for shared, staging, production, or user-data databases.
- Do not use migrations as a workaround for unrelated schema drift. Identify and fix the owning schema/migration path.
- Use `inTx` for database operations that must be transactional.
- Use `afterTx` for events/side effects that must run only after a successful commit.
- Read sets, not rows: a loop over a result that issues one query per item (access witness, host reference, membership) is an N+1; resolve the set in one query inside the same transaction. Scope predicates must be index-servable on every shipped engine: an `OR` of correlated relation arms forces a scan, so read each arm through its own index (`id IN (…)`) and check the plan shape on SQLite and PostgreSQL.
- Do not run non-transactional side effects (file uploads, external calls, notifications, etc.) inside DB transactions.
- For complex DB fields, use JSON deliberately and validate at the application boundary.

## API and actions

- Routes live under the server application route owners; use Fastify and Zod for type-safe route definitions.
- Always validate external input with Zod or the canonical schema for that boundary.
- Design retryable operations to be idempotent. Clients may retry automatically, and repeated calls should produce the same durable result as one call.
- When writing DB-backed action functions, put each action in a dedicated file in the relevant app/domain subfolder. Prefer `entityAction` naming, for example `friendAdd`.
- Do not return data from action functions “just in case”; return only the essential contract.
- After writing an action, add/keep a documentation comment that explains the action logic and update it when logic changes.

## Privacy and encoding

- Never log secrets, tokens, encrypted secret plaintext, private keys, or raw credential payloads.
- Do not add logging unless it is necessary for the task or follows an existing diagnostics pattern.
- Use `privacyKit.decodeBase64` and `privacyKit.encodeBase64` from privacy-kit instead of Buffer-based one-off base64 logic.
- Prefer GitHub usernames for GitHub identity/user-facing GitHub references.

## Feature gates

- Do not gate route behavior with ad-hoc env checks when the feature is represented by the canonical feature system.
- `/v1/features` assembly is centralized; route handlers should use server feature gate helpers.
- Missing or malformed feature bits fail closed.

## Testing

- Use Vitest and existing server route/DB harnesses.
- Prefer real database/storage behavior with test isolation over internal mocks.
- Test files should use the package's established suffix and location conventions.
- For utility functions and behavior changes, write/update tests before implementation.
- If a storage/API contract changes, update affected route/DB tests in the same change.

## Debugging

Use `.agents/skills/happier-diagnose` for Happier issue diagnosis and evidence collection. Server logs are under `.logs/` when enabled, and consolidated client/server debugging can use `DANGEROUSLY_LOG_TO_SERVER_FOR_AI_AUTO_DEBUGGING=true` only when intentionally diagnosing.
