/**
 * STAGED REMOVAL — this module has no behavior left.
 *
 * Codex's spawn/resume transport projection moved onto the public declarative
 * path (`behavior.payload.backendTransport` in `./descriptor.ts`), which is the
 * same seam an externally installed Agent reaches.
 *
 * The constant stays only because the checked-in bundled projection
 * (`apps/ui/sources/agents/registry/generatedBundledPluginEntries.uiBehaviorOverrides.ts`)
 * still imports it, and that file has a single producer: the bundled-plugin
 * publisher. Its descriptor half is already current with `./descriptor.ts`, so
 * emptying this override is behavior-preserving.
 *
 * Removal condition: delete this file and the `./ui/behavior` export from
 * `package.json`, then run
 * `node --experimental-strip-types scripts/migrations/extensions/generateBundledPluginEntries.ts --mode write`.
 * The generator only emits the override import when `src/ui/uiBehavior.ts`
 * exists, so that run drops the import.
 */
export const CODEX_UI_BEHAVIOR_OVERRIDE = {} as const;
