export const OPEN_CODE_CLI_DETECT = Object.freeze({
  versionArgsToTry: [['--version'], ['version'], ['-v']],
  loginStatusArgs: ['auth', 'list'],
} as const);
