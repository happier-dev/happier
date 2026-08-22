import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { readDiscriminatedMembers, renderRuntimeEventReferenceMarkdown } from './generateRuntimeEventReference.mjs';

const literal = (value) => ({ _def: { value } });
const member = (disc, value) => ({ shape: { [disc]: literal(value) } });
const union = (disc, values) => ({ _def: { discriminator: disc, options: values.map((v) => member(disc, v)) } });

test('reads the literal of each union member', () => {
  assert.deepEqual(readDiscriminatedMembers(union('kind', ['turn-start', 'turn-complete'])), ['turn-start', 'turn-complete']);
});

test('refuses a member whose discriminator it cannot read', () => {
  const broken = { _def: { discriminator: 'kind', options: [{ shape: {} }] } };
  assert.throws(() => readDiscriminatedMembers(broken), /could not read the "kind" literal/);
});

test('refuses to publish when the schema gains a kind no family claims', async () => {
  // The failure this prevents is silent: an unplaced kind simply would not
  // appear, and the page would read as complete while missing a whole event.
  const schemaPath = new URL('./__fixture-runtime-schema.mjs', import.meta.url).pathname;
  await assert.rejects(
    () => renderRuntimeEventReferenceMarkdown({ schemaPath }),
    /not assigned to a family: brand-new-kind/,
  );
});
