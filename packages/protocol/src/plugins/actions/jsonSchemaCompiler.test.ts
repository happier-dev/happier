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

  it.each(['draft-07', 'draft-2020-12'] as const)(
    'reuses a %s schema identity while isolating distinct schemas with equal IDs',
    dialect => {
      const id = `https://happier.dev/tests/compiler-lifetime/${dialect}`;
      const schema = { $id: id, type: 'string', format: 'email' };
      const first = compileProtocolJsonSchema(schema, dialect);
      expect(compileProtocolJsonSchema(schema, dialect)).toBe(first);
      const second = compileProtocolJsonSchema({ $id: id, type: 'integer', minimum: 2 }, dialect);
      expect(first('person@example.com')).toBe(true);
      expect(first('invalid')).toBe(false);
      expect(first(2)).toBe(false);
      expect(second(2)).toBe(true);
      expect(second(1)).toBe(false);
      expect(second('person@example.com')).toBe(false);
    },
  );

  it.each(['draft-07', 'draft-2020-12'] as const)(
    'compiles equal %s content once while a validator for it is alive, whatever the schema identity',
    dialect => {
      // Normalization and parsing hand the compiler a fresh object for the same
      // declaration; each must not build and compile another AJV engine.
      const compile = vi.spyOn(AjvCore.prototype, 'compile');
      // One AJV engine per compiled schema content; count engines, not AJV's internal compiles.
      const engines = () => new Set(compile.mock.contexts).size;
      try {
        const declare = () => ({ type: 'object', properties: { name: { type: 'string', minLength: 2 } }, required: ['name'] });
        const first = compileProtocolJsonSchema(declare(), dialect);
        const second = compileProtocolJsonSchema(declare(), dialect);
        const prepared = compileProtocolJsonSchema(declare(), dialect, schema => schema);
        expect(engines()).toBe(1);
        expect(second).toBe(first);
        expect(prepared).toBe(first);
        expect(first({ name: 'Al' })).toBe(true);
        expect(first({ name: 'A' })).toBe(false);
        // Different content (or a preparation that changes it) still compiles its own validator.
        const other = compileProtocolJsonSchema({ type: 'string' }, dialect);
        const narrowed = compileProtocolJsonSchema(declare(), dialect, schema => ({ ...schema, additionalProperties: false }));
        expect(engines()).toBe(3);
        expect(other).not.toBe(first);
        expect(narrowed({ name: 'Al', extra: 1 })).toBe(false);
        expect(first({ name: 'Al', extra: 1 })).toBe(true);
      } finally {
        compile.mockRestore();
      }
    },
  );

  it.each(['draft-07', 'draft-2020-12'] as const)(
    'isolates %s local references and recovers after a failed compilation',
    dialect => {
      const id = `https://happier.dev/tests/compiler-references/${dialect}/`;
      const first = compileProtocolJsonSchema({
        $id: id, $defs: { value: { $id: 'value', type: 'string' } }, $ref: 'value',
      }, dialect);
      expect(() => compileProtocolJsonSchema({ $id: id, type: 'invalid' }, dialect)).toThrow();
      const second = compileProtocolJsonSchema({
        $id: id, $defs: { value: { $id: 'value', type: 'integer' } }, $ref: 'value',
      }, dialect);
      expect(first('first')).toBe(true);
      expect(first(2)).toBe(false);
      expect(second(2)).toBe(true);
      expect(second('first')).toBe(false);
    },
  );
});
