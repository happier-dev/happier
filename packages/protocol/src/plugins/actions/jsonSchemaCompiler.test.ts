import { describe, expect, it, vi } from 'vitest';
import AjvCore from 'ajv/dist/core.js';
import { Session } from 'node:inspector';
import { setImmediate } from 'node:timers/promises';

import { compileProtocolJsonSchema } from './jsonSchemaCompiler.js';

describe('Protocol JSON Schema compiler lifetime', () => {
  it.each(['draft-07', 'draft-2020-12'] as const)(
    'retains only live %s schemas and validators across balanced mount cycles',
    async dialect => {
      const inspector = new Session();
      inspector.connect();
      // Observe the real AJV engines without keeping them alive in spy history.
      const compile = vi.spyOn(AjvCore.prototype, 'compile');
      const engines: WeakRef<AjvCore>[] = [];
      const seen = new WeakSet<AjvCore>();
      const schemas: WeakRef<object>[] = [];
      const validators: WeakRef<object>[] = [];
      const id = `https://happier.dev/tests/compiler-retirement/${dialect}`;
      const liveSchema = { $id: id, type: 'integer', minimum: 2 };
      const live = compileProtocolJsonSchema(liveSchema, dialect);
      const mountAndRetire = () => {
        // Match TABLEAK-PROD's 20/40/60 retired-schema reproduction, including
        // remounts with equal content but fresh declaration identities.
        for (let mount = 0; mount < 20; mount++) {
          const schema = { $id: id, type: 'string', format: 'email' };
          const validate = compileProtocolJsonSchema(schema, dialect);
          expect(validate('person@example.com')).toBe(true);
          expect(validate(2)).toBe(false);
          schemas.push(new WeakRef(schema));
          validators.push(new WeakRef(validate));
          expect(compileProtocolJsonSchema(liveSchema, dialect)).toBe(live);
        }
        for (const engine of compile.mock.contexts) {
          if (!(engine instanceof AjvCore)) throw new Error('Expected a real AJV compilation context');
          if (!seen.has(engine)) {
            seen.add(engine);
            engines.push(new WeakRef(engine));
          }
        }
        compile.mockClear();
      };
      const liveScopeEntries = () => engines.reduce((total, ref) => {
        const engine = ref.deref();
        const scope: Record<string, unknown> = engine?.scope.get() ?? {};
        const entries = Array.isArray(scope.schema) ? scope.schema : [];
        return total + entries.filter(schema => schema?.$id === id).length;
      }, 0);
      const collectGarbage = () => new Promise<void>((resolve, reject) => inspector.post('HeapProfiler.collectGarbage', error => {
        if (error) reject(error);
        else resolve();
      }));
      try {
        for (let cycle = 0; cycle < 3; cycle++) {
          mountAndRetire();
          // WeakRef targets survive their current job; cross that boundary
          // before forcing real V8 GC, without a time-based settling sleep.
          await setImmediate();
          await collectGarbage();
          // Allow weak/ephemeron cleanup from the first collection to settle.
          await setImmediate();
          await collectGarbage();
          expect.soft(schemas.filter(ref => ref.deref()).length, `cycle ${cycle}`).toBe(0);
          expect.soft(validators.filter(ref => ref.deref()).length, `cycle ${cycle}`).toBe(0);
          expect.soft(liveScopeEntries()).toBeLessThanOrEqual(1);
          expect(live(2)).toBe(true);
          expect(live(1)).toBe(false);
        }
      } finally {
        compile.mockRestore();
        inspector.disconnect();
      }
    },
  );

});
