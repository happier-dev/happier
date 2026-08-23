/**
 * STAGED REMOVAL — this module has no behavior left.
 *
 * Auggie's indexing option moved onto the public declarative path
 * (`behavior.newSession.agentOptions` plus the `booleanOption` chip slot in
 * `./descriptor.ts`), which is the same seam an externally installed Agent
 * reaches. The spawn envelope is now built by the host through the canonical
 * `mergeSpawnConfigOptionAliases` owner instead of a plugin-local copy.
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
export const AUGGIE_UI_BEHAVIOR_OVERRIDE = {} as const;
