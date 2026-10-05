import { existsSync } from 'node:fs';

// Checkout dependency preparation reaches this adapter before it can refresh
// Stack's installed workspace copy. Use the dependency-free source owner there;
// installed Stack carries that same owner in its bundled package.
const sourceOwner = new URL('../../../../../packages/cli-common/windowsCommandInvocation.mjs', import.meta.url);
const { resolveWindowsCommandInvocation } = await import(
  existsSync(sourceOwner) ? sourceOwner.href : '@happier-dev/cli-common/windowsCommandInvocation'
);

export function resolveCommandInvocation(params) {
  const command = String(params?.command ?? '').trim();
  const args = Array.isArray(params?.args) ? params.args.map((a) => String(a)) : [];
  // The running JS executable is already resolved and cannot be a command shim.
  // In particular, compiling cli-common itself must not require its dist first.
  if (process.platform !== 'win32' || command === process.execPath) return { command, args };
  const env = params?.env && typeof params.env === 'object' ? params.env : process.env;
  return resolveWindowsCommandInvocation({
    command,
    args,
    env,
    resolveCommandOnPath: true,
  });
}
