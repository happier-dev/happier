export const codexCliDetect = {
  versionArgsToTry: [['--version'], ['version'], ['-v']],
  loginStatusArgs: ['login', 'status'],
} as const;

export type CodexCliStableVersion = Readonly<{
  major: number;
  minor: number;
  patch: number;
  value: string;
}>;

export function parseCodexCliStableVersion(output: string): CodexCliStableVersion | null {
  const match = /(?:^|\s)(\d+)\.(\d+)\.(\d+)(?:\s|$)/u.exec(output.trim());
  if (!match) return null;
  const major = Number.parseInt(match[1] ?? '', 10);
  const minor = Number.parseInt(match[2] ?? '', 10);
  const patch = Number.parseInt(match[3] ?? '', 10);
  if (![major, minor, patch].every(Number.isSafeInteger)) return null;
  return { major, minor, patch, value: `${major}.${minor}.${patch}` };
}
