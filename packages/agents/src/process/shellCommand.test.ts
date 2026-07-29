import { spawnSync } from 'node:child_process';

import { describe, expect, it } from 'vitest';

import {
  buildPosixShellCommand,
  buildPosixShellEnvironmentAssignments,
  buildShellCommand,
  buildWindowsCmdCommand,
} from './shellCommand.js';

describe('POSIX shell command serialization', () => {
  it('round-trips spaces, quotes, substitutions, backslashes, and cmd metacharacters as literal argv', () => {
    const args = [
      process.execPath,
      '-e',
      'process.stdout.write(JSON.stringify(process.argv.slice(1)))',
      'space separated',
      "single'quote",
      '$(printf command-substitution)',
      '`printf backtick-substitution`',
      String.raw`C:\Program Files\Happier\hook.cjs`,
      '&|<>^%!()[];, *?',
    ];
    const command = buildPosixShellCommand(args);
    const result = spawnSync('/bin/sh', ['-c', command], {
      encoding: 'utf8',
    });

    expect(result).toMatchObject({ status: 0, stderr: '' });
    expect(JSON.parse(result.stdout)).toEqual(args.slice(3));
  });

  it('serializes every argv token and environment value with POSIX single quotes', () => {
    expect(buildPosixShellCommand([
      '',
      "a'b",
      String.raw`C:\path\$HOME`,
    ])).toBe("'' 'a'\\''b' 'C:\\path\\$HOME'");
    expect(buildPosixShellEnvironmentAssignments({
      FIRST: 'space separated',
      SECOND: "$(printf injected) 'quoted'",
    })).toBe(
      "FIRST='space separated' SECOND='$(printf injected) '\\''quoted'\\'''",
    );
  });

  it('rejects NUL instead of emitting an unrepresentable shell argument', () => {
    expect(() => buildShellCommand(['node', 'bad\0arg'], 'posix')).toThrow(
      'must not contain NUL',
    );
    expect(() =>
      buildShellCommand(['node.exe', 'bad\0arg'], 'windows_cmd')
    ).toThrow('must not contain NUL');
  });
});

describe('Windows cmd command serialization', () => {
  const args = [
    String.raw`C:\Program Files\Happier\node.exe`,
    String.raw`C:\hook path\forwarder's \script.cjs`,
    '43127',
    'Stop',
    '--secret-file',
    '$(literal) `literal` "quoted" %PATH% ^caret &pipe| <in> !bang!',
    'line one\nline two',
    'ends-in-backslash\\',
  ];

  it('escapes cmd metacharacters while preserving the fixed argv order', () => {
    const command = buildWindowsCmdCommand(args);

    expect(command.startsWith(
      String.raw`C:\Program^ Files\Happier\node.exe ^"C:\hook^ path`,
    )).toBe(true);
    expect(command).toContain("^\"43127^\" ^\"Stop^\" ^\"--secret-file^\"");
    expect(command).toContain(
      String.raw`^"$^(literal^)^ ^` + '`literal^`^ ',
    );
    expect(command).toContain(String.raw`\^"quoted\^"^ ^%PATH^%^ ^^caret`);
    expect(command).toContain(String.raw`^&pipe^|^ ^<in^>^ ^!bang^!^"`);
    expect(command).toContain('^"line^ one\nline^ two^"');
    expect(command.endsWith(String.raw`^"ends-in-backslash\\^"`)).toBe(true);
  });

  it.runIf(process.platform === 'win32')(
    'round-trips sensitive argv through the actual cmd.exe /D /S /C parser',
    () => {
      const captureArgs = [
        process.execPath,
        '-e',
        'process.stdout.write(JSON.stringify(process.argv.slice(1)))',
        ...args.slice(1),
      ];
      const command = buildWindowsCmdCommand(captureArgs);
      const result = spawnSync(process.env.COMSPEC ?? 'cmd.exe', [
        '/D',
        '/S',
        '/C',
        `"${command}"`,
      ], {
        encoding: 'utf8',
        windowsVerbatimArguments: true,
      });

      expect(result).toMatchObject({ status: 0, stderr: '' });
      expect(JSON.parse(result.stdout)).toEqual(captureArgs.slice(3));
    },
  );
});
