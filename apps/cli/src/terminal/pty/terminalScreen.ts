import type { IBufferCell, ITerminalAddon, Terminal as XtermTerminal } from '@xterm/headless';

/**
 * The PTY terminal host's one screen model: `@xterm/headless` (the parser the app's terminal
 * pane uses), read through the same `capture()` shape the classifiers consume. Plain `text` is
 * the visible screen; `styledText` is the same rows serialized with SGR attributes (the
 * `capture-pane -p -e` shape `buildTerminalControlCapture` and the style-evidence parsers read).
 *
 * Writes are parsed asynchronously, so `capture()` resolves after every byte written before it
 * was called has been parsed. Scrollback is 0: the only consumer reads the visible screen.
 */
export type TerminalScreenCapture = Readonly<{
  text: string;
  /** The visible rows with SGR attributes; null when no cell carries an attribute. */
  styledText: string | null;
  cursor: Readonly<{ x: number; y: number }>;
}>;

export type TerminalScreen = Readonly<{
  write(data: Uint8Array | string): void;
  capture(): Promise<TerminalScreenCapture>;
  resize(cols: number, rows: number): void;
  dispose(): void;
}>;

// The addon's typings name `@xterm/xterm`'s Terminal (the app's browser build); it loads into the
// headless Terminal, so it is typed against headless's own addon contract.
type XtermModule = { Terminal: typeof XtermTerminal; UnicodeGraphemesAddon: new () => ITerminalAddon };

let loading: Promise<XtermModule> | undefined;

/** CommonJS packages: the named export, or the same object behind `default`. */
function exported<T extends object>(module: unknown, name: keyof T): T {
  const value = module as T & { default?: T };
  return (value[name] ? value : value.default!) as T;
}

/** Loaded once per process, by the first PTY host Session (never by processes that use a multiplexer). */
export function loadTerminalScreenModel(): Promise<XtermModule> {
  loading ??= Promise.all([import('@xterm/headless'), import('@xterm/addon-unicode-graphemes')]).then(([terminal, graphemes]) => ({
    Terminal: exported<{ Terminal: typeof XtermTerminal }>(terminal, 'Terminal').Terminal,
    UnicodeGraphemesAddon: exported<{ UnicodeGraphemesAddon: new () => ITerminalAddon }>(graphemes, 'UnicodeGraphemesAddon').UnicodeGraphemesAddon,
  }));
  return loading;
}

function sgr(cell: IBufferCell): string {
  const codes = ['0'];
  if (cell.isBold()) codes.push('1');
  if (cell.isDim()) codes.push('2');
  if (cell.isItalic()) codes.push('3');
  if (cell.isUnderline()) codes.push('4');
  if (cell.isBlink()) codes.push('5');
  if (cell.isInverse()) codes.push('7');
  if (cell.isInvisible()) codes.push('8');
  if (cell.isStrikethrough()) codes.push('9');
  const rgb = (value: number) => `${(value >> 16) & 255};${(value >> 8) & 255};${value & 255}`;
  if (cell.isFgRGB()) codes.push(`38;2;${rgb(cell.getFgColor())}`);
  else if (cell.isFgPalette()) codes.push(`38;5;${cell.getFgColor()}`);
  if (cell.isBgRGB()) codes.push(`48;2;${rgb(cell.getBgColor())}`);
  else if (cell.isBgPalette()) codes.push(`48;5;${cell.getBgColor()}`);
  return codes.join(';');
}

/** Trailing whitespace per row and trailing blank rows dropped, like `capture-pane` output once normalized. */
function joinRows(rows: string[]): string {
  const trimmed = rows.map(row => row.replace(/\s+$/u, ''));
  while (trimmed.length > 0 && trimmed[trimmed.length - 1] === '') trimmed.pop();
  return trimmed.join('\n');
}

export function createTerminalScreen(model: XtermModule, params: Readonly<{ cols: number; rows: number }>): TerminalScreen {
  const terminal = new model.Terminal({
    cols: Math.max(2, Math.trunc(params.cols)),
    rows: Math.max(2, Math.trunc(params.rows)),
    scrollback: 0,
    // The buffer read API (`buffer.active`) is a proposed API in the headless build.
    allowProposedApi: true,
  });
  // Cell widths by grapheme cluster (emoji modifiers, variation selectors, ZWJ sequences), as
  // Claude's renderer (string-width) lays its rows out; the default Unicode 6 widths drift.
  terminal.loadAddon(new model.UnicodeGraphemesAddon());
  const cell = terminal.buffer.active.getNullCell();
  const read = (): TerminalScreenCapture => {
    const buffer = terminal.buffer.active;
    const textRows: string[] = [];
    const styledRows: string[] = [];
    let styled = false;
    for (let y = 0; y < terminal.rows; y += 1) {
      const line = buffer.getLine(buffer.viewportY + y);
      if (!line) { textRows.push(''); styledRows.push(''); continue; }
      textRows.push(line.translateToString(true));
      let row = '';
      let current = '0';
      let blanks = '';
      for (let x = 0; x < terminal.cols; x += 1) {
        line.getCell(x, cell);
        // The second cell of a wide character.
        if (cell.getWidth() === 0) continue;
        const chars = cell.getChars() || ' ';
        const attributes = sgr(cell);
        if (chars === ' ' && attributes === '0') { blanks += ' '; continue; }
        row += blanks;
        blanks = '';
        if (attributes !== current) { row += `\u001b[${attributes}m`; current = attributes; styled = true; }
        row += chars;
      }
      if (current !== '0') row += '\u001b[0m';
      styledRows.push(row);
    }
    return { text: joinRows(textRows), styledText: styled ? joinRows(styledRows) : null,
      cursor: { x: buffer.cursorX, y: buffer.cursorY } };
  };
  return {
    write: data => { terminal.write(data); },
    // The callback of an empty write runs once everything written before it is parsed.
    capture: () => new Promise(resolve => terminal.write('', () => resolve(read()))),
    resize: (cols, rows) => { terminal.resize(Math.max(2, Math.trunc(cols)), Math.max(2, Math.trunc(rows))); },
    dispose: () => { terminal.dispose(); },
  };
}
