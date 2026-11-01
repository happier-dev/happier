/** Global Git configuration must not inspect an inaccessible daemon cwd. */
export function globalGitConfigCommand(username: string, args: readonly string[]): { executable: 'runuser'; args: string[] } {
  return { executable: 'runuser', args: ['-u', username, '--', 'git', '-C', '/', 'config', '--global', ...args] };
}
