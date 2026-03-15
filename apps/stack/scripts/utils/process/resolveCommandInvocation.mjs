import { resolveWindowsCommandInvocation } from '@happier-dev/cli-common/process';

export function resolveCommandInvocation(params) {
  const command = String(params?.command ?? '').trim();
  const args = Array.isArray(params?.args) ? params.args.map((a) => String(a)) : [];
  const env = params?.env && typeof params.env === 'object' ? params.env : process.env;
  return resolveWindowsCommandInvocation({
    command,
    args,
    env,
    resolveCommandOnPath: true,
  });
}

