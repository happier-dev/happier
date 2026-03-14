import { parseArgs } from '../utils/cli/args.mjs';

function resolveStackName(env) {
  return String(env?.HAPPIER_STACK_STACK ?? '').trim() || 'main';
}

export function shouldBuildStackArtifacts({ selection, argv = [], env = process.env }) {
  const { flags } = parseArgs(Array.isArray(argv) ? argv : []);
  const stackName = resolveStackName(env);

  if (selection.activateRuntime || selection.forceRebuild || selection.components.server || selection.components.daemon || flags.has('--all')) {
    return true;
  }

  if (flags.has('--web')) {
    return stackName !== 'main';
  }

  return false;
}
