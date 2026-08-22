import { describe, expect, it } from 'vitest';

import {
  findPluginDiagnosticSourceLocation,
  formatPluginDiagnosticSourceLocation,
  prefixPluginDiagnosticSourceLocation,
} from './sourceLocation';

const SOURCE_ROOT = '/Users/alice/workspaces/acme-plugin';

describe('findPluginDiagnosticSourceLocation', () => {
  it('reads a TypeScript compiler location reported relative to the project root', () => {
    expect(findPluginDiagnosticSourceLocation({
      texts: ["src/daemon.ts(7,19): error TS2307: Cannot find module 'left-pad'.\n"],
      sourceRoot: SOURCE_ROOT,
    })).toEqual({ file: 'src/daemon.ts', line: 7, column: 19 });
  });

  it('reads an absolute stack frame inside the project root', () => {
    expect(findPluginDiagnosticSourceLocation({
      texts: [`SyntaxError\n    at activate (${SOURCE_ROOT}/src/ui/panel.tsx:3:5)`],
      sourceRoot: SOURCE_ROOT,
    })).toEqual({ file: 'src/ui/panel.tsx', line: 3, column: 5 });
  });

  it('prefers a located frame over a bare file named earlier in the same text', () => {
    expect(findPluginDiagnosticSourceLocation({
      texts: [
        `Cannot find module imported from ${SOURCE_ROOT}/src/entry.ts`,
        `    at ${SOURCE_ROOT}/src/daemon.ts:11:2`,
      ],
      sourceRoot: SOURCE_ROOT,
    })).toEqual({ file: 'src/daemon.ts', line: 11, column: 2 });
  });

  it('names a bare importer file when no position is reported anywhere', () => {
    expect(findPluginDiagnosticSourceLocation({
      texts: [`Cannot find module 'left-pad' imported from ${SOURCE_ROOT}/src/entry.ts`],
      sourceRoot: SOURCE_ROOT,
    })).toEqual({ file: 'src/entry.ts' });
  });

  it('refuses a stack frame belonging to another project on the same host', () => {
    expect(findPluginDiagnosticSourceLocation({
      texts: ['SyntaxError\n    at /Users/alice/private/other-project/daemon.ts:7:19'],
      sourceRoot: SOURCE_ROOT,
    })).toBeNull();
  });

  it('refuses a relative candidate that escapes the project root', () => {
    expect(findPluginDiagnosticSourceLocation({
      texts: ['../../private/other-project/daemon.ts(7,19): error TS2307: nope.'],
      sourceRoot: SOURCE_ROOT,
    })).toBeNull();
  });

  it('refuses a path fragment embedded in an unrelated absolute path', () => {
    expect(findPluginDiagnosticSourceLocation({
      texts: ['    at Module._load (/opt/happier/runtime/src/daemon.ts:7:19)'],
      sourceRoot: SOURCE_ROOT,
    })).toBeNull();
  });

  it('refuses a token with no file extension', () => {
    expect(findPluginDiagnosticSourceLocation({
      texts: [`${SOURCE_ROOT}/src:7:19`],
      sourceRoot: SOURCE_ROOT,
    })).toBeNull();
  });

  it('reads a Windows stack frame against a Windows project root', () => {
    expect(findPluginDiagnosticSourceLocation({
      texts: ['    at activate (C:\\\\authors\\\\acme-plugin\\\\src\\\\daemon.ts:7:19)'],
      sourceRoot: 'C:\\\\authors\\\\acme-plugin',
    })).toEqual(
      process.platform === 'win32'
        ? { file: 'src/daemon.ts', line: 7, column: 19 }
        : null,
    );
  });
});

describe('plugin diagnostic source location rendering', () => {
  it('renders the most precise form the location carries', () => {
    expect(formatPluginDiagnosticSourceLocation({ file: 'src/daemon.ts' }))
      .toBe('src/daemon.ts');
    expect(formatPluginDiagnosticSourceLocation({ file: 'src/daemon.ts', line: 7 }))
      .toBe('src/daemon.ts:7');
    expect(formatPluginDiagnosticSourceLocation({ file: 'src/daemon.ts', line: 7, column: 19 }))
      .toBe('src/daemon.ts:7:19');
  });

  it('leads text-only seams with the location and leaves unlocated text alone', () => {
    expect(prefixPluginDiagnosticSourceLocation(
      { file: 'src/daemon.ts', line: 7, column: 19 },
      'Cannot find module.',
    )).toBe('src/daemon.ts:7:19: Cannot find module.');
    expect(prefixPluginDiagnosticSourceLocation(null, 'Cannot find module.'))
      .toBe('Cannot find module.');
  });
});
