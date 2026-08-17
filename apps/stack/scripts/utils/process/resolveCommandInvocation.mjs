const resolveWindowsCommandInvocation = process.platform === 'win32'
  ? (await import('@happier-dev/cli-common/process')).resolveWindowsCommandInvocation
  : null;

export function resolveCommandInvocation(params) {
  const command = String(params?.command ?? '').trim();
  const args = Array.isArray(params?.args) ? params.args.map((a) => String(a)) : [];
  if (process.platform !== 'win32') return { command, args };
  const env = params?.env && typeof params.env === 'object' ? params.env : process.env;
  return resolveWindowsCommandInvocation({
    command,
    args,
    env,
    resolveCommandOnPath: true,
  });
}
