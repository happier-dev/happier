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
 * The command registry is a pure TypeScript module with type-only imports. Read
 * its actual exported declarations, including mapped ordinals, rather than
 * reconstructing a second registry from source formatting.
 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

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
      'sessionList.filter.open': 'Open list filters',
      ...Object.fromEntries(Array.from({ length: 9 }, (_, index) => [
        `sessionList.space.select${index + 1}`, `Select space ${index + 1}`,
      ])),
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
    title: 'Files',
    commands: {
      'search.files': 'Open a workspace file',
      'search.symbols': 'Find a symbol in the open file',
      'search.textInFiles': 'Search text in workspace files',
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

export async function parseKeyboardCommands(source) {
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    reportDiagnostics: true,
  });
  const errors = (compiled.diagnostics ?? []).filter(diagnostic => diagnostic.category === ts.DiagnosticCategory.Error);
  if (errors.length) throw new Error(ts.formatDiagnosticsWithColorAndContext(errors, {
    getCanonicalFileName: path => path, getCurrentDirectory: () => REPO, getNewLine: () => '\n',
  }));
  // Only the repository's pure declaration module is evaluated; type imports disappear.
  const module = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputText).toString('base64')}`);
  const registry = module.defaultKeyboardCommands;
  if (!Array.isArray(registry) || registry.length === 0) throw new Error('keyboard commands.ts exported no commands');
  const commands = new Map();
  const platformLabels = { macos: 'macOS', windows: 'Windows', linux: 'Linux', ios: 'iOS', android: 'Android' };
  for (const command of registry) {
    if (typeof command.id !== 'string') throw new Error('keyboard command has no identity');
    const bindings = [];
    for (const binding of command.defaultBindings ?? (command.defaultBinding ? [command.defaultBinding] : [])) {
      const platforms = binding.platforms ?? [];
      const blocked = binding.blockedSurfaces ?? [];
      const operatingSystems = platforms.filter(platform => platform !== 'web').map(platform => platformLabels[platform]).join(', ');
      let scope = null;
      if (platforms.includes('web') || blocked.includes('native')) scope = 'web';
      else if (blocked.includes('web')) scope = 'everywhere else';
      if (binding.webHost && scope !== 'everywhere else') {
        scope = scope === 'web' ? binding.webHost : `${binding.webHost} and native`;
      }
      if (operatingSystems) scope = scope ? `${operatingSystems} ${scope}` : operatingSystems;
      bindings.push({ key: binding.binding, scope });
    }
    commands.set(command.id, bindings);
  }
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
  const commands = await parseKeyboardCommands(readFileSync(commandsPath, 'utf8'));
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

${commands.has('search.files') ? `In unreleased 0.3 development source, file quick open uses this same Search
surface, scoped to the workspace. Its registered shortcut is
${formatBindings(commands.get('search.files'))}; the general shortcut registry must be enabled.
The browser or operating system may claim a binding before Happier receives it.
See [Files and the editor](/code/files-and-editor) for the file workflow.

` : ''}## Shortcuts

In unreleased 0.3 development source, Open list filters and Select space follow
the focused Sessions, Workflows or Discussions list. Space numbers follow that
list's displayed space order. Turning spaces off suspends space selection
shortcuts while leaving the filter command available. The default space-number
bindings do not apply in Windows or Linux browsers; the title menu remains
available there. Space selection leaves the workspace tab shortcuts unchanged.

${grouped.join('\n\n')}
${extras}
${commands.has('workspace.tab.new') ? `The development-only 0.3 workspace adds tab shortcuts for the focused pane.
They work while editing: \`Mod+T\` opens an empty tab, \`Mod+W\` closes the active
tab, \`Mod+Shift+W\` closes the pane's unpinned tabs, \`Mod+1\` through \`Mod+8\`
select a position, and \`Mod+9\` selects the last
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

## Inline chip editing (0.3 development)

The unreleased 0.3 composer treats each reference chip as one item. Left and
Right Arrow step across the whole chip. Backspace immediately after a chip
selects it; a second Backspace removes it. Delete immediately before a chip
removes it whole. Undo restores a deleted chip. Removing an attachment from
the tray also removes its chips; undo does not bring the removed attachment
back.

Copy and cut write readable reference markers. Pasting text keeps it plain,
so it cannot recreate a chip. Deleting an image chip keeps the image in the
tray. See [Attachments and image previews](/apps/attachments).

## Changing them

**Settings → Keyboard shortcuts** lists every command with its current binding
and lets you set your own. Conflicts are detected as you assign them, and your
choices sync with your account, so a binding changed on one connected device
can follow you to the others.

## Related

- [Session settings](/sessions/session-settings)
- [Prompts and templates](/extending/prompts) — what else Search can reach.
`;
}

const isEntrypoint = process.argv[1] ? resolve(process.argv[1]) === fileURLToPath(import.meta.url) : false;
if (isEntrypoint) {
  const { writeFileSync } = await import('node:fs');
  writeFileSync(OUTPUT_PATH, await renderKeyboardReferenceMarkdown(), 'utf8');
  console.log(`wrote ${OUTPUT_PATH}`);
}
