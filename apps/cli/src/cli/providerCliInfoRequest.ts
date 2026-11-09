const HELP_FLAGS = new Set(['-h', '--help']);
const VERSION_FLAGS = new Set(['-v', '-V', '--version']);

export type ProviderCliInfoCommandPrefix = readonly string[];

function matchesInfoCommandPrefix(args: readonly string[], prefix: ProviderCliInfoCommandPrefix): boolean {
  if (prefix.length === 0 || args.length < prefix.length) return false;
  return prefix.every((part, index) => args[index] === part);
}

export function detectProviderCliInfoRequest(args: readonly string[]): string | null {
  const helpFlag = args.find((arg) => HELP_FLAGS.has(arg));
  if (helpFlag) return helpFlag;
  const versionFlag = args.find((arg) => VERSION_FLAGS.has(arg));
  if (versionFlag) return versionFlag;
  return null;
}

export function isProviderCliInfoCommandPrefixRequest(params: Readonly<{
  args: readonly string[];
  prefixes: readonly ProviderCliInfoCommandPrefix[];
}>): boolean {
  return params.prefixes.some((prefix) => matchesInfoCommandPrefix(params.args, prefix));
}
