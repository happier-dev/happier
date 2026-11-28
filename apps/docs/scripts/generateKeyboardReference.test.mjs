import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';

import { readKeyboardCommands, renderKeyboardReferenceMarkdown } from './generateKeyboardReference.mjs';

test('projects mapped space ordinals and their OS/host scopes from the real registry', async () => {
  const commands = await readKeyboardCommands();
  assert.equal(commands.has('sessionList.space.select1'), true);
  assert.deepEqual(commands.get('sessionList.space.select9'), [
    { key: 'Ctrl+9', scope: 'macOS' },
    { key: 'Alt+9', scope: 'Windows, Linux desktop' },
  ]);
});

test('projects imported bindings with browser and desktop-host availability', async () => {
  const root = await mkdtemp(join(tmpdir(), 'happier-keyboard-reference-'));
  try {
    const commandsPath = join(root, 'commands.ts');
    await writeFile(join(root, 'bindings.ts'), `export const browserBinding = {
  binding: 'Alt+Shift+J', platforms: ['web'], webHost: 'browser',
};\n`);
    await writeFile(commandsPath, `import { browserBinding } from './bindings';
export const defaultKeyboardCommands = [
    {
      id: 'session.pending.next',
      defaultBindings: [
        browserBinding,
        { binding: 'Mod+Shift+J', webHost: 'desktop' },
      ],
    },
];`);
    const commands = await readKeyboardCommands(commandsPath);
    assert.deepEqual(commands.get('session.pending.next'), [
      { key: 'Alt+Shift+J', scope: 'browser' },
      { key: 'Mod+Shift+J', scope: 'desktop and native' },
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('documents Search independent gating and account-synced shortcut preferences', async () => {
  const root = await mkdtemp(join(tmpdir(), 'happier-keyboard-reference-'));
  try {
    const commandsPath = join(root, 'commands.ts');
    const settingsPath = join(root, 'accountSettings.ts');
    await writeFile(commandsPath, `export const defaultKeyboardCommands = [
    {
      id: 'commandPalette.open',
      defaultBinding: { binding: 'Alt+K' },
    },
    {
      id: 'session.new',
      defaultBinding: { binding: 'Alt+N' },
    },
];\n`);
    await writeFile(settingsPath, `const settings = {
  commandPaletteEnabled: accountPreference(z.boolean(), true, 'keyboard shortcuts'),
  keyboardShortcutsV2Enabled: accountPreference(z.boolean(), false, 'keyboard shortcuts'),
};\n`);

    const markdown = await renderKeyboardReferenceMarkdown({ commandsPath, settingsPath });

    assert.match(markdown, /Open Search shortcut has its own switch/u);
    assert.match(markdown, /other commands remain off/u);
    assert.match(markdown, /sync with your account/u);
    assert.doesNotMatch(markdown, /before any binding below does anything/u);
    assert.doesNotMatch(markdown, /stored per device rather than synced/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
