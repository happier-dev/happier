import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

test('the daemon host and its workspace schema owners share one installed Zod runtime', () => {
  const manifests = [
    '../../apps/cli/package.json', '../../packages/protocol/package.json',
    '../../packages/session-core/package.json', '../../packages/agents/package.json',
  ];
  const schemas = manifests.map(manifest => createRequire(new URL(manifest, import.meta.url))('zod'));
  for (const schemaOwner of schemas.slice(1)) {
    assert.equal(schemaOwner.ZodType, schemas[0].ZodType);
    const schema = schemaOwner.object({ id: schemaOwner.string().min(1) }).strict();
    assert.equal(schema instanceof schemas[0].ZodType, true);
    assert.deepEqual(schemas[0].parse(schema, { id: 'a' }), { id: 'a' });
    assert.equal(schemas[0].safeParse(schema, { id: 'a', unknown: true }).success, false);
  }
});
