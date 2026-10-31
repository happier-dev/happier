import test from 'node:test';
import assert from 'node:assert/strict';

import { stripAnsi } from './text.mjs';
import { formatBoxLine } from './box_line.mjs';

test('formatBoxLine strips ansi and pads when allowAnsi=false', () => {
  const s = '\x1b[31mRED\x1b[0m';
  const out = formatBoxLine({ text: s, width: 6, allowAnsi: false });
  assert.equal(out, 'RED   ');
});

test('formatBoxLine preserves ansi and pads/clips by visible width when allowAnsi=true', () => {
  const s = '\x1b[1;31mRED\x1b[0m!';
  for (const [width, expected] of [[2, 'RE'], [4, 'RED!'], [6, 'RED!  ']]) {
    const out = formatBoxLine({ text: s, width, allowAnsi: true });
    assert.ok(out.includes('\x1b['), 'expected ansi to be preserved');
    assert.equal(stripAnsi(out), expected);
  }
});

