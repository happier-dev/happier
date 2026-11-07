import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { lazyActionSpecArray, lazyActionSpecRecord } from './lazyActionSpecValue.js';

describe('lazy Action aggregation', () => {
  it('imports cyclic spec modules before aggregating both initialized rows', () => {
    const entry = new URL('./testFixtures/lazyRegistry/second.mjs', import.meta.url).href;
    const code = `const { readSpecs } = await import(${JSON.stringify(entry)}); console.log(JSON.stringify(readSpecs()));`;
    const output = execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', code], {
      cwd: fileURLToPath(new URL('../../../../', import.meta.url)),
      encoding: 'utf8',
    });
    expect(JSON.parse(output)).toEqual([{ id: 'first' }, { id: 'second' }]);
  });

  it('constructs once on consumption and retains frozen native array behavior', () => {
    let constructions = 0;
    const row = { id: 'first' };
    const specs = lazyActionSpecArray(() => {
      constructions += 1;
      return Object.freeze([row]);
    });
    expect(Array.isArray(specs)).toBe(true);
    expect(constructions).toBe(0);
    expect([...specs]).toEqual([row]);
    expect(specs[0]).toBe(row);
    expect(specs.map(spec => spec.id)).toEqual(['first']);
    expect(Object.keys(specs)).toEqual(['0']);
    expect(Object.getOwnPropertyDescriptor(specs, 'length')?.value).toBe(1);
    expect(Object.isFrozen(specs)).toBe(true);
    expect(Reflect.set(specs, '0', { id: 'changed' })).toBe(false);
    expect(constructions).toBe(1);
  });

  it('retains frozen schema-record reflection when reflection is the first consumer', () => {
    let constructions = 0;
    const schema = { parse: (value: string) => value };
    const schemas = lazyActionSpecRecord(() => {
      constructions += 1;
      return Object.freeze({ first: schema });
    });
    expect(constructions).toBe(0);
    expect(Object.isFrozen(schemas)).toBe(true);
    expect(Object.keys(schemas)).toEqual(['first']);
    expect('first' in schemas).toBe(true);
    expect(schemas.first).toBe(schema);
    expect(constructions).toBe(1);
  });
});
