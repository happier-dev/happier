import { describe, expect, it } from 'vitest';

import {
    applyStrictSafeGuardedRequireTransform,
    carriesReactNativeArtifactJavaScript,
    containsUnsafeGuardedRequireAssignment,
} from './reactNativeRepackStrictSafety';

// The exact literal Re.Pack's `RepackTargetPlugin` GuardedRequireRuntimeModule
// template emits (verified against
// `node_modules/@callstack/repack/dist/plugins/RepackTargetPlugin/implementation/guardedRequire.js`).
const REAL_GUARDED_REQUIRE_RUNTIME_SNIPPET = `
var $globalObject$;
module.exports = function () {
  var inGuard = false;
  var originalWebpackRequire = __webpack_require__;
  function guardedWebpackRequire(moduleId) {
    if (!inGuard && $globalObject$.ErrorUtils) {
      inGuard = true;
      let exports;
      try {
        exports = originalWebpackRequire(moduleId);
      } catch (e) {
        $globalObject$.ErrorUtils.reportFatalError(e);
      }
      inGuard = false;
      return exports;
    } else {
      return originalWebpackRequire(moduleId);
    }
  }
  Object.getOwnPropertyNames(originalWebpackRequire).forEach(key => {
    guardedWebpackRequire[key] = originalWebpackRequire[key];
  });
  __webpack_require__ = guardedWebpackRequire;
};
`;

describe('applyStrictSafeGuardedRequireTransform', () => {
    it('wraps the unsafe own-property copy assignment in a try/catch', () => {
        const { source, patched } = applyStrictSafeGuardedRequireTransform(REAL_GUARDED_REQUIRE_RUNTIME_SNIPPET);

        expect(patched).toBe(true);
        expect(source).toContain('try { guardedWebpackRequire[key] = originalWebpackRequire[key]; } catch');
        expect(source).not.toContain('  guardedWebpackRequire[key] = originalWebpackRequire[key];\n  });');
    });

    it('proves the transformed source no longer throws under strict mode for a read-only own prop', () => {
        // Reproduce the exact failure mode: a real function's `length`/`name`
        // are non-writable own properties. A plain assignment throws in
        // strict mode; the transformed try/catch form must not.
        function original(_a: unknown, _b: unknown): void { /* length: 2 */ }
        function guarded(): void { /* length: 0 */ }

        const unsafeAssign = new Function(
            'guardedWebpackRequire', 'originalWebpackRequire',
            `'use strict'; ${GUARDED_REQUIRE_UNSAFE_ASSIGN_ALL_KEYS}`,
        );
        expect(() => unsafeAssign(guarded, original)).toThrow(/read.only property/u);

        const { source } = applyStrictSafeGuardedRequireTransform(
            `function run(guardedWebpackRequire, originalWebpackRequire) { 'use strict';\n`
            + `  Object.getOwnPropertyNames(originalWebpackRequire).forEach(key => {\n`
            + `    ${GUARDED_REQUIRE_UNSAFE_ASSIGNMENT_LITERAL}\n`
            + `  });\n}`,
        );
        const safeRun = new Function(`return (${source.replace(/^function run/u, 'function')})`)() as (
            a: unknown, b: unknown,
        ) => void;
        expect(() => safeRun(guarded, original)).not.toThrow();
    });

    it('is a no-op on unrelated source that never contained the unsafe literal', () => {
        const unrelated = 'export const value = 1;';
        expect(applyStrictSafeGuardedRequireTransform(unrelated)).toEqual({ source: unrelated, patched: false });
    });

    it('is idempotent — re-running the transform on already-patched output is a no-op, not a double-wrap', () => {
        const { source: patchedOnce, patched: firstPassPatched } =
            applyStrictSafeGuardedRequireTransform(REAL_GUARDED_REQUIRE_RUNTIME_SNIPPET);
        expect(firstPassPatched).toBe(true);

        const { source: patchedTwice, patched: secondPassPatched } =
            applyStrictSafeGuardedRequireTransform(patchedOnce);
        expect(secondPassPatched).toBe(false);
        expect(patchedTwice).toBe(patchedOnce);
        expect(patchedTwice).not.toContain('try { try {');
    });
});

describe('containsUnsafeGuardedRequireAssignment', () => {
    it('detects the unsafe literal and clears once patched', () => {
        expect(containsUnsafeGuardedRequireAssignment(REAL_GUARDED_REQUIRE_RUNTIME_SNIPPET)).toBe(true);
        const { source } = applyStrictSafeGuardedRequireTransform(REAL_GUARDED_REQUIRE_RUNTIME_SNIPPET);
        expect(containsUnsafeGuardedRequireAssignment(source)).toBe(false);
    });
});

describe('carriesReactNativeArtifactJavaScript', () => {
    it('claims the artifact-only extensions Re.Pack emits code under, and no source map', () => {
        for (const codeAsset of ['ios.bundle', 'PluginPanel.chunk.bundle', 'unrelated.js']) {
            expect(carriesReactNativeArtifactJavaScript(codeAsset)).toBe(true);
        }
        for (const dataAsset of ['ios.bundle.map', 'unrelated.js.map', 'assets/logo.png']) {
            expect(carriesReactNativeArtifactJavaScript(dataAsset)).toBe(false);
        }
    });
});

// Kept out-of-band (below the transform's own private constant) so the test
// file's own literal is provably independent of the module's internal
// constant — a mutation to the module's private string cannot silently make
// this fixture "self-fulfilling".
const GUARDED_REQUIRE_UNSAFE_ASSIGNMENT_LITERAL = 'guardedWebpackRequire[key] = originalWebpackRequire[key];';
const GUARDED_REQUIRE_UNSAFE_ASSIGN_ALL_KEYS =
    'Object.getOwnPropertyNames(originalWebpackRequire).forEach(key => { '
    + `${GUARDED_REQUIRE_UNSAFE_ASSIGNMENT_LITERAL} });`;
