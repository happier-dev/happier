export function wrapCommandForPseudoTty(params: {
  platform: NodeJS.Platform;
  scriptPath: string | null;
  command: string;
  args: string[];
  needsTty: boolean;
}): { command: string; args: string[] } {
  if (!params.needsTty) {
    return { command: params.command, args: [...params.args] };
  }

  if (params.platform === 'win32') {
    throw new Error('Pseudo-TTY command wrapping is not supported on win32');
  }

  if (!params.scriptPath) {
    throw new Error('Pseudo-TTY command wrapping requires the `script` binary');
  }

  return {
    command: params.scriptPath,
    args: ['-q', '/dev/null', params.command, ...params.args],
  };
}

