import test from 'node:test';
import assert from 'node:assert/strict';

import { promptSelect } from './wizard.mjs';

function mkRl(answer) {
  return { question: async () => String(answer ?? '') };
}

test('promptSelect marks the default option in the rendered list', async (t) => {
  const lines = [];
  t.mock.method(console, 'log', (...args) => {
    lines.push(args.map(String).join(' '));
  });
  const picked = await promptSelect(mkRl(''), {
    title: 'Pick a value:',
    options: [
      { label: 'One', value: 'one' },
      { label: 'Two', value: 'two' },
      { label: 'Three', value: 'three' },
    ],
    defaultIndex: 1,
  });
  assert.equal(picked, 'two');

  const rendered = lines.join('\n');
  assert.match(rendered, /\b2\)\s+Two\b.*\(\s*default\s*\)/i);
  assert.doesNotMatch(rendered, /\b1\)\s+One\b.*\(\s*default\s*\)/i);
  assert.doesNotMatch(rendered, /\b3\)\s+Three\b.*\(\s*default\s*\)/i);
});

test('promptSelect accepts duplicated single-digit input (e.g. \"22\")', async (t) => {
  t.mock.method(console, 'log', () => {});
  const picked = await promptSelect(mkRl('22'), {
    title: 'Pick:',
    options: [
      { label: 'One', value: 'one' },
      { label: 'Two', value: 'two' },
      { label: 'Three', value: 'three' },
    ],
    defaultIndex: 0,
  });
  assert.equal(picked, 'two');
});
