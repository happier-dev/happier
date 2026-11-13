import assert from 'node:assert/strict';
import test from 'node:test';

import { parseKeyboardCommands } from './generateKeyboardReference.mjs';

test('parseKeyboardCommands keeps command boundaries with Windows line endings', () => {
  const source = [
    'export const commands = [',
    '    {',
    "        id: 'first',",
    "        defaultBinding: { binding: 'Mod+1' },",
    '    },',
    '    {',
    "        id: 'second',",
    "        defaultBinding: { binding: 'Mod+2' },",
    '    },',
    '];',
  ].join('\r\n');

  assert.deepEqual([...parseKeyboardCommands(source)], [
    ['first', [{ key: 'Mod+1', scope: null }]],
    ['second', [{ key: 'Mod+2', scope: null }]],
  ]);
});
