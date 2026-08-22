/**
 * RN-HARDEN item 1 — Re.Pack `guardedRequire` strict-mode safety.
 *
 * Re.Pack's `RepackTargetPlugin` injects a `guardedRequire` runtime module
 * (`@callstack/repack/dist/plugins/RepackTargetPlugin/implementation/guardedRequire.js`)
 * that wraps `__webpack_require__` in an `ErrorUtils.reportFatalError`-on-throw
 * guard. To preserve the wrapped function's own metadata it copies every own
 * property of the original via `Object.getOwnPropertyNames(...).forEach(key
 * => { guardedWebpackRequire[key] = originalWebpackRequire[key]; })` —
 * INCLUDING `length`/`name`, which are non-writable (configurable but not
 * writable) own properties of every JS function. A plain assignment to a
 * non-writable property throws `TypeError: Cannot assign to read-only
 * property 'length'` in strict mode — exactly the strict-mode IIFE rspack
 * emits for a Module Federation "remote" container build. This is an
 * upstream `@callstack/repack` bug (verified directly against the emitted
 * runtime module's own source), not a config or plugin-author mistake.
 *
 * Root-cause fix belongs at the ARTIFACT-BUILD chokepoint, not a runtime
 * patch shipped to every host: this pure transform rewrites the offending
 * assignment in the FINAL built asset to a strict-safe try/catch (skipping
 * the handful of read-only own props like `length`/`name` — copying them is
 * cosmetic; `__webpack_require__`'s call surface is unaffected either way).
 * `buildUiArtifacts` is the single consumer and applies it to every emitted
 * JavaScript-carrying file of a `repack` surface, so the patch lands whichever
 * bundler invocation produced the bytes.
 */

const GUARDED_REQUIRE_UNSAFE_ASSIGNMENT =
    'guardedWebpackRequire[key] = originalWebpackRequire[key];';
const GUARDED_REQUIRE_STRICT_SAFE_ASSIGNMENT =
    'try { guardedWebpackRequire[key] = originalWebpackRequire[key]; } catch (assignError) { '
    + '/* strict-mode read-only own props (length/name) on the wrapped function: harmless to skip */ }';

export type StrictSafeGuardedRequireTransformResult = Readonly<{
    source: string;
    patched: boolean;
}>;

/**
 * Pure string transform — no bundler/filesystem dependency, so it is testable
 * in isolation and safe to run against any candidate JS asset. A no-op
 * (`patched: false`) when the known-unsafe literal is not present (either the
 * asset never contained Re.Pack's `guardedRequire` runtime module, or a
 * future `@callstack/repack` release has already fixed it upstream) — never
 * throws, never mangles unrelated source.
 */
export function applyStrictSafeGuardedRequireTransform(source: string): StrictSafeGuardedRequireTransformResult {
    // The strict-safe form's own text CONTAINS the unsafe literal as a
    // substring (it just wraps it in try/catch) — check for the already-safe
    // form FIRST, or this would double-wrap on a second pass / a source that
    // was already patched upstream.
    if (source.includes(GUARDED_REQUIRE_STRICT_SAFE_ASSIGNMENT)) {
        return Object.freeze({ source, patched: false });
    }
    if (!source.includes(GUARDED_REQUIRE_UNSAFE_ASSIGNMENT)) {
        return Object.freeze({ source, patched: false });
    }
    return Object.freeze({
        source: source.split(GUARDED_REQUIRE_UNSAFE_ASSIGNMENT).join(GUARDED_REQUIRE_STRICT_SAFE_ASSIGNMENT),
        patched: true,
    });
}

/** Diagnostic for build tooling: true when a JS source still carries the unsafe, unpatched assignment. */
export function containsUnsafeGuardedRequireAssignment(source: string): boolean {
    return source.includes(GUARDED_REQUIRE_UNSAFE_ASSIGNMENT)
        && !source.includes(GUARDED_REQUIRE_STRICT_SAFE_ASSIGNMENT);
}

/**
 * The single owner of "this emitted Re.Pack asset carries JavaScript".
 *
 * Re.Pack emits the container entry and its chunks under artifact-only
 * extensions (`<platform>.bundle`, `[name].chunk.bundle`) so the host app can
 * package them through Metro as opaque assets — Metro re-derives asset-ness
 * from the file name, so a `.js`-terminated artifact would be transformed and
 * executed instead of delivered. Source maps (`.map`) are data, never code.
 */
export function carriesReactNativeArtifactJavaScript(assetName: string): boolean {
    return assetName.endsWith('.js') || assetName.endsWith('.bundle');
}
