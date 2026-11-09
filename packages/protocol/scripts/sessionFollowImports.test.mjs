import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'vitest';

// Like actionCatalogImports.test.mjs, use a fresh native ESM graph rather than
// Vitest's already-initialized/transformed module cache for each entry order.
for (const first of ['sessionFollowPolicyV1', 'sessionFollowSourceOccurrenceV1']) {
  // As in the catalog harness, native transpiler/bootstrap work happens during
  // collection; the assertions do not impose Vitest's generic test deadline on it.
  const result = spawnSync(process.execPath, [
      '--experimental-transform-types', '--conditions=happier-source', '--input-type=module', '--eval', `
      import assert from 'node:assert/strict';
      import { existsSync } from 'node:fs';
      import { registerHooks } from 'node:module';

      // Reuse the native source-resolution pattern from profile-schema-memory.mjs.
      // The optional negative control restores the former source topology only
      // in this child process; it never edits the checkout or substitutes a parser.
      registerHooks({
        resolve(specifier, context, nextResolve) {
          if (specifier.startsWith('.') && specifier.endsWith('.js') && context.parentURL) {
            const candidate = new URL(specifier.slice(0, -3) + '.ts', context.parentURL);
            if (!existsSync(new URL(specifier, context.parentURL)) && existsSync(candidate)) {
              return nextResolve(candidate.href, context);
            }
          }
          return nextResolve(specifier, context);
        },
        load(url, context, nextLoad) {
          const loaded = nextLoad(url, context);
          if (process.env.HAPPIER_TEST_FOLLOW_EAGER_SELECTED_DELIVERY === '1'
            && url.endsWith('/sessions/follow/sessionFollowSourceOccurrenceV1.ts')) {
            const source = typeof loaded.source === 'string' ? loaded.source : new TextDecoder().decode(loaded.source);
            const current = "import { SessionFollowSelectedDeliveryV1Schema } from './sessionFollowSelectedDeliveryV1.js';";
            assert.ok(source.includes(current), 'Negative control requires the current leaf import');
            assert.ok(source.includes('selectedDelivery: SessionFollowSelectedDeliveryV1Schema'), 'Negative control requires the current selected delivery field');
            return { ...loaded, source: source.replace(current,
              "import { SessionFollowSelectedDeliveryV1Schema } from './sessionFollowPolicyV1.js';") };
          }
          if (process.env.HAPPIER_TEST_FOLLOW_EAGER_SELECTED_DELIVERY === '1'
            && url.endsWith('/sessions/follow/sessionFollowPolicyV1.ts')) {
            const source = typeof loaded.source === 'string' ? loaded.source : new TextDecoder().decode(loaded.source);
            const current = "export { SessionFollowSelectedDeliveryV1Schema, type SessionFollowSelectedDeliveryV1 } from './sessionFollowSelectedDeliveryV1.js';";
            assert.ok(source.includes(current), 'Negative control requires the current policy re-export');
            // Restore the actual former owner declaration as well as its eager
            // consumer: an indirect export of the new leaf is not the old cycle.
            return { ...loaded, source: source
              .replace("import type { SessionFollowSelectedDeliveryV1 } from './sessionFollowSelectedDeliveryV1.js';", '')
              .replace(current, "export const SessionFollowSelectedDeliveryV1Schema = lazyZodSchema(() => z.enum(['wake', 'next_turn']));") };
          }
          return loaded;
        },
      });

      await import('./src/sessions/follow/${first}.ts');
      const { SessionFollowSourceOccurrenceWitnessFieldsV1 } = await import('./src/sessions/follow/sessionFollowSourceOccurrenceV1.ts');
      const { SessionFollowSelectedDeliveryV1Schema } = await import('./src/sessions/follow/sessionFollowPolicyV1.ts');
      const { SessionFollowInputV1Schema } = await import('./src/sessions/follow/sessionFollowInputV1.ts');
      await import('./src/sessions/follow/sessionFollowTransportV1.ts');
      const selected = SessionFollowSourceOccurrenceWitnessFieldsV1.selectedDelivery;
      const input = { v: 1, original: { source: { kind: 'execution_run', machineId: 'machine', runId: 'run' },
        terminalEventId: 'terminal' }, event: { kind: 'finished' } };
      for (const value of ['wake', 'next_turn']) {
        assert.equal(selected.parse(value), value);
        assert.equal(SessionFollowSelectedDeliveryV1Schema.parse(value), value);
        assert.equal(SessionFollowInputV1Schema.parse({ ...input, delivery: value }).delivery, value);
      }
      for (const value of ['off', undefined, { delivery: 'wake' }]) {
        assert.equal(selected.safeParse(value).success, false);
        assert.equal(SessionFollowInputV1Schema.safeParse({ ...input, delivery: value }).success, false);
      }
      console.log('follow-schema-validation-completed');
  `], { cwd: fileURLToPath(new URL('../', import.meta.url)), encoding: 'utf8' });
  test(`loads Follow schemas with ${first} first and preserves selected delivery validation`, () => {
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), 'follow-schema-validation-completed');
  });
}
