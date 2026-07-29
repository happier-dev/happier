export type VirtualTerminalScreen = Readonly<{
  write(data: string): void;
  capture(): string;
  resize(cols: number, rows: number): void;
}>;

type ParserState =
  | { kind: 'normal' }
  | { kind: 'escape' }
  | { kind: 'csi'; buffer: string }
  | { kind: 'osc'; buffer: string; sawEscape: boolean };

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function blankLine(cols: number): string[] {
  return Array.from({ length: cols }, () => ' ');
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === '') return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseCsiParams(buffer: string): { privateMarker: string; params: string[]; final: string } | null {
  if (buffer.length === 0) return null;
  const final = buffer[buffer.length - 1] ?? '';
  const body = buffer.slice(0, -1);
  const privateMarker = body.match(/^[?<>=!]+/)?.[0] ?? '';
  const paramsBody = privateMarker ? body.slice(privateMarker.length) : body;
  return {
    privateMarker,
    params: paramsBody.length > 0 ? paramsBody.split(';') : [],
    final,
  };
}

export function createVirtualTerminalScreen(params?: Readonly<{ cols?: number; rows?: number }>): VirtualTerminalScreen {
  let cols = Math.max(2, Math.trunc(params?.cols ?? 120));
  let rows = Math.max(2, Math.trunc(params?.rows ?? 40));
  let lines = Array.from({ length: rows }, () => blankLine(cols));
  let cursorRow = 0;
  let cursorCol = 0;
  let state: ParserState = { kind: 'normal' };

  const scrollIfNeeded = (): void => {
    while (cursorRow >= rows) {
      lines.shift();
      lines.push(blankLine(cols));
      cursorRow -= 1;
    }
  };

  const clearAll = (): void => {
    lines = Array.from({ length: rows }, () => blankLine(cols));
    cursorRow = 0;
    cursorCol = 0;
  };

  const clearLineRange = (row: number, startCol: number, endCol: number): void => {
    const line = lines[row];
    if (!line) return;
    for (let col = clamp(startCol, 0, cols - 1); col <= clamp(endCol, 0, cols - 1); col += 1) {
      line[col] = ' ';
    }
  };

  const clearDisplayFromCursor = (): void => {
    clearLineRange(cursorRow, cursorCol, cols - 1);
    for (let row = cursorRow + 1; row < rows; row += 1) {
      clearLineRange(row, 0, cols - 1);
    }
  };

  const clearDisplayToCursor = (): void => {
    for (let row = 0; row < cursorRow; row += 1) {
      clearLineRange(row, 0, cols - 1);
    }
    clearLineRange(cursorRow, 0, cursorCol);
  };

  const newline = (): void => {
    cursorRow += 1;
    scrollIfNeeded();
  };

  const writePrintable = (char: string): void => {
    if (cursorCol >= cols) {
      cursorCol = 0;
      newline();
    }
    lines[cursorRow]![cursorCol] = char;
    cursorCol += 1;
  };

  const handleCsi = (buffer: string): void => {
    const parsed = parseCsiParams(buffer);
    if (!parsed) return;
    const first = parsePositiveInt(parsed.params[0], 1);
    switch (parsed.final) {
      case 'A':
        cursorRow = clamp(cursorRow - first, 0, rows - 1);
        break;
      case 'B':
        cursorRow = clamp(cursorRow + first, 0, rows - 1);
        break;
      case 'C':
        cursorCol = clamp(cursorCol + first, 0, cols - 1);
        break;
      case 'D':
        cursorCol = clamp(cursorCol - first, 0, cols - 1);
        break;
      case 'G':
        cursorCol = clamp(first - 1, 0, cols - 1);
        break;
      case 'H':
      case 'f': {
        const row = parsePositiveInt(parsed.params[0], 1);
        const col = parsePositiveInt(parsed.params[1], 1);
        cursorRow = clamp(row - 1, 0, rows - 1);
        cursorCol = clamp(col - 1, 0, cols - 1);
        break;
      }
      case 'J': {
        const mode = Number.parseInt(parsed.params[0] ?? '0', 10);
        if (mode === 2 || mode === 3) {
          clearAll();
        } else if (mode === 1) {
          clearDisplayToCursor();
        } else {
          clearDisplayFromCursor();
        }
        break;
      }
      case 'K': {
        const mode = Number.parseInt(parsed.params[0] ?? '0', 10);
        if (mode === 2) clearLineRange(cursorRow, 0, cols - 1);
        else if (mode === 1) clearLineRange(cursorRow, 0, cursorCol);
        else clearLineRange(cursorRow, cursorCol, cols - 1);
        break;
      }
      case 'h':
      case 'l':
        if (parsed.privateMarker.includes('?') && parsed.params.some((param) => param === '1049' || param === '1047')) {
          clearAll();
        }
        break;
    }
  };

  const handleNormalChar = (char: string): void => {
    if (char === '\u001b') {
      state = { kind: 'escape' };
      return;
    }
    if (char === '\r') {
      cursorCol = 0;
      return;
    }
    if (char === '\n') {
      newline();
      return;
    }
    if (char === '\b') {
      cursorCol = clamp(cursorCol - 1, 0, cols - 1);
      return;
    }
    if (char === '\t') {
      cursorCol = clamp(cursorCol + (8 - (cursorCol % 8)), 0, cols - 1);
      return;
    }
    const code = char.charCodeAt(0);
    if (code >= 0x20 && code !== 0x7f) {
      writePrintable(char);
    }
  };

  return {
    write(data: string): void {
      for (const char of String(data ?? '')) {
        if (state.kind === 'normal') {
          handleNormalChar(char);
          continue;
        }
        if (state.kind === 'escape') {
          if (char === '[') {
            state = { kind: 'csi', buffer: '' };
          } else if (char === ']') {
            state = { kind: 'osc', buffer: '', sawEscape: false };
          } else if (char === 'c') {
            clearAll();
            state = { kind: 'normal' };
          } else {
            state = { kind: 'normal' };
          }
          continue;
        }
        if (state.kind === 'osc') {
          if (char === '\u0007' || (state.sawEscape && char === '\\')) {
            state = { kind: 'normal' };
            continue;
          }
          state = { kind: 'osc', buffer: '', sawEscape: char === '\u001b' };
          continue;
        }
        const nextBuffer = `${state.buffer}${char}`;
        if (/[@-~]/.test(char)) {
          handleCsi(nextBuffer);
          state = { kind: 'normal' };
        } else {
          state = { kind: 'csi', buffer: nextBuffer };
        }
      }
    },
    capture(): string {
      const rendered = lines.map((line) => line.join('').replace(/\s+$/u, ''));
      while (rendered.length > 0 && rendered[rendered.length - 1] === '') {
        rendered.pop();
      }
      return rendered.join('\n');
    },
    resize(nextCols: number, nextRows: number): void {
      const safeCols = Math.max(2, Math.trunc(nextCols));
      const safeRows = Math.max(2, Math.trunc(nextRows));
      const nextLines = Array.from({ length: safeRows }, (_, row) => {
        const existing = lines[row] ?? [];
        return Array.from({ length: safeCols }, (_, col) => existing[col] ?? ' ');
      });
      cols = safeCols;
      rows = safeRows;
      lines = nextLines;
      cursorRow = clamp(cursorRow, 0, rows - 1);
      cursorCol = clamp(cursorCol, 0, cols - 1);
    },
  };
}
