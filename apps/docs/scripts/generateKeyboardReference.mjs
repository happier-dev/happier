/**
 * Renders the keyboard shortcut reference from the client's command registry.
 *
 * Two reasons this is generated rather than written. Bindings drift with every
 * platform tweak, and a shortcut list that is wrong is worse than none — you
 * press the key, nothing happens, and you stop trusting the page. And the
 * August 2026 release notes state the old command palette opens with `/`, which is
 * not what the registry says on any platform; a generated page cannot repeat
 * that mistake.
 *
 * Commands are parsed from source because `apps/ui` is an Expo app with path
 * aliases and is not importable from a plain Node script. `parseKeyboardCommands`
 * throws if it finds nothing, so a shape change fails here rather than
 * publishing an empty table.
 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..', '..');
const COMMANDS = join(REPO, 'apps', 'ui', 'sources', 'keyboard', 'commands.ts');
const SETTINGS = join(REPO, 'packages', 'protocol', 'src', 'account', 'settings', 'accountSettings.ts');
export const OUTPUT_PATH = join(HERE, '..', 'content', 'docs', 'apps', 'keyboard-shortcuts.mdx');

/**
 * Human names for command ids, grouped the way someone looking for a shortcut
 * thinks about them rather than the way the registry is ordered.
 */
const GROUPS = [
  {
    title: 'Moving between sessions',
    commands: {
      'session.new': 'Start a new session',
      'session.mru.next': 'Next recently used session',
      'session.mru.previous': 'Previous recently used session',
      'session.visible.next': 'Next session in the list',
      'session.visible.previous': 'Previous session in the list',
    },
  },
  {
    title: 'The session list',
    commands: {
      'sessions.row.moveUp': 'Move the focused session up',
      'sessions.row.moveDown': 'Move the focused session down',
      'sessions.row.moveToFolder': 'Move to a folder',
      'sessions.row.moveToWorkspaceRoot': 'Move out to the workspace root',
      'sessions.selection.toggleFocused': 'Select or deselect the focused row',
      'sessions.selection.extendUp': 'Extend the selection up',
      'sessions.selection.extendDown': 'Extend the selection down',
      'sessions.selection.selectAll': 'Select every session',
      'sessions.selection.clear': 'Clear the selection',
    },
  },
  {
    title: 'Writing and sending',
    commands: {
      'composer.focus': 'Jump to the composer',
      'composer.sendImmediate': 'Send now',
      'composer.sendPending': 'Queue without opening the composer',
      'composer.abortConfirm': 'Stop the current turn',
      'voice.toggle': 'Start or end Voice',
      'mode.cycle': 'Cycle session mode',
      'permission.cycle': 'Cycle permission mode',
    },
  },
  {
    title: 'Reading the transcript',
    commands: {
      'transcript.message.next': 'Next message',
      'transcript.message.previous': 'Previous message',
      'transcript.scroll.top': 'Jump to the top',
      'transcript.scroll.bottom': 'Jump to the live tail',
      'transcript.scroll.pageUp': 'Page up',
      'transcript.scroll.pageDown': 'Page down',
      'transcript.selection.selectAll': 'Select every message',
      'transcript.selection.copy': 'Copy the selected messages',
      'transcript.selection.sendToSession': 'Send the selection to another session',
      'transcript.selection.cancel': 'Cancel the selection',
    },
  },
  {
    title: 'Everything else',
    commands: {
      'commandPalette.open': 'Open Search',
      'shortcutsHelp.open': 'Show this list in the app',
      'settings.open': 'Open settings',
    },
  },
];

export function parseKeyboardCommands(source) {
  const commands = new Map();
  for (const block of source.split(/\n {4}\{\n/)) {
    const id = /id: '([^']+)'/.exec(block);
    if (!id) continue;
    const bindings = [];
    // `defaultBinding: { binding: 'X' }` or a `defaultBindings: [...]` array
    // whose members may be scoped by platform.
    for (const entry of block.split(/\{\s*binding:/).slice(1)) {
      const key = /^\s*'([^']+)'/.exec(entry);
      if (!key) continue;
      const platforms = /platforms:\s*\[([^\]]*)\]/.exec(entry);
      const blocked = /blockedSurfaces:\s*\[([^\]]*)\]/.exec(entry);
      const webHost = /webHost:\s*'(browser|desktop)'/.exec(entry);
      let scope = null;
      if (platforms && platforms[1].includes('web')) scope = 'web';
      else if (blocked && blocked[1].includes('web')) scope = 'everywhere else';
      if (webHost && scope !== 'everywhere else') {
        scope = scope === 'web' ? webHost[1] : `${webHost[1]} and native`;
      }
      bindings.push({ key: key[1], scope });
    }
    commands.set(id[1], bindings);
  }
  if (commands.size === 0) throw new Error('keyboard commands.ts parsed to zero commands');
  return commands;
}

/**
 * Read a boolean account preference's default.
 *
 * These settings used to be local settings carrying an inline `default:` field.
 * They are account preferences now, declared in the protocol as
 * `accountPreference(z.boolean(), false, 'keyboard shortcuts')`, and the
 * per-app registry file that replaced the old one holds analytics metadata
 * rather than values — reading a default from it silently describes the wrong
 * thing, so this reads the protocol declaration instead.
 */
function readDefault(source, name) {
  const match = new RegExp(`${name}:\\s*accountPreference\\(\\s*z\\.boolean\\(\\)\\s*,\\s*(true|false)`).exec(source);
  if (!match) throw new Error(`Could not read the default for ${name}`);
  return match[1] === 'true';
}

function formatBindings(bindings) {
  if (!bindings || bindings.length === 0) return '_Unbound by default_';
  return bindings
    .map((b) => (b.scope ? `\`${b.key}\` (${b.scope})` : `\`${b.key}\``))
    .join(' · ');
}

export async function renderKeyboardReferenceMarkdown({
  commandsPath = COMMANDS,
  settingsPath = SETTINGS,
} = {}) {
  const commands = parseKeyboardCommands(readFileSync(commandsPath, 'utf8'));
  const settings = readFileSync(settingsPath, 'utf8');
  const paletteOn = readDefault(settings, 'commandPaletteEnabled');
  const shortcutsOn = readDefault(settings, 'keyboardShortcutsV2Enabled');

  const grouped = GROUPS.map((group) => {
    const rows = Object.entries(group.commands)
      .filter(([id]) => commands.has(id))
      .map(([id, label]) => `| ${label} | ${formatBindings(commands.get(id))} |`);
    return rows.length ? `### ${group.title}\n\n| Action | Default |\n| --- | --- |\n${rows.join('\n')}` : null;
  }).filter(Boolean);

  const gateNotice = !shortcutsOn
    ? paletteOn
      ? 'The general shortcut registry is **off by default**, so other commands remain off. The Open Search shortcut has its own switch, and its enabled binding still works.'
      : 'Two independent controls are **off by default**: the Open Search shortcut has its own switch, while the general shortcut registry controls other commands. Search remains available from its other entry points.'
    : paletteOn
      ? 'Shortcuts are on by default.'
      : 'The Open Search shortcut is **off by default** through its own switch. Search remains available from its other entry points, and other enabled commands still follow the general shortcut registry.';

  const covered = new Set(GROUPS.flatMap((g) => Object.keys(g.commands)));
  const uncovered = [...commands.keys()].filter((id) => !covered.has(id));

  const extras = uncovered.length
    ? `\n### Not yet grouped\n\n| Command | Default |\n| --- | --- |\n${uncovered
        .map((id) => `| \`${id}\` | ${formatBindings(commands.get(id))} |`)
        .join('\n')}\n`
    : '';

  return `---
title: Keyboard shortcuts
description: Every rebindable shortcut and Search, with the defaults for web and native.
---

Happier has ${commands.size} keyboard commands. Every one can be rebound, and the defaults
differ between the web client and the native apps where the platform already
claims a key.

<Callout type="warn">
  ${gateNotice}
</Callout>

\`Mod\` means Command on macOS and iOS, and Control everywhere else. Where a
binding is written literally as \`Ctrl\`, it is Control on every platform
including macOS — that is deliberate, because the key is standing in for a
platform convention rather than for "the modifier key".

## Search

The fastest way to reach anything without remembering a binding. Search finds
built-in commands, sessions, projects, settings pages, messages, workspace
files and commits in one grouped list.

${formatBindings(commands.get('commandPalette.open'))}

## Shortcuts

${grouped.join('\n\n')}
${extras}
${commands.has('workspace.tab.new') ? `The development-only 0.3 workspace adds tab shortcuts for the focused pane.
They work while editing: \`Mod+T\` opens an empty tab, \`Mod+W\` closes the active
tab, \`Mod+1\` through \`Mod+8\` select a position, and \`Mod+9\` selects the last
tab. They require the general shortcut registry to be enabled. A browser may
claim these keys before Happier receives them; you can rebind them if needed.

In multi-selectable lists, \`x\` toggles the focused row, Shift+Up/Down extends
the range, and Escape clears. Shift-click selects a range; Select in a row's
menu starts selection with that row. Ordinary clicks then toggle rows; Done
exits. Long-press opens the row menu and hover alone never shows a checkbox.
Command-click on macOS or Ctrl-click on Windows/Linux opens an openable row in
a kept workspace tab, like Alt-click or middle-click, even during selection.

` : ''}Shortcuts respect focus. Most do nothing while you are typing in the composer,
which is why sending has its own explicitly editable-safe binding rather than
relying on you leaving the field first.

## Changing them

**Settings → Keyboard shortcuts** lists every command with its current binding
and lets you set your own. Conflicts are detected as you assign them, and your
choices sync with your account, so a binding changed on one connected device
can follow you to the others.

## Related

- [Session settings](/sessions/session-settings)
- [Prompts, skills, templates, and registries](/extending/prompts-and-skills) — what else Search can reach.
`;
}

const isEntrypoint = process.argv[1] ? resolve(process.argv[1]) === fileURLToPath(import.meta.url) : false;
if (isEntrypoint) {
  const { writeFileSync } = await import('node:fs');
  writeFileSync(OUTPUT_PATH, await renderKeyboardReferenceMarkdown(), 'utf8');
  console.log(`wrote ${OUTPUT_PATH}`);
}
