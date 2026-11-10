import { AsyncLocalStorage } from 'node:async_hooks';
import { mkdtemp, rm } from 'node:fs/promises';
import { devNull, tmpdir } from 'node:os';
import { join } from 'node:path';
import { runScmCommand, type ScmCommandRunner } from '@/scm/runtime';
import { runScmExecutable } from './scmBackendContractFixtures';

/** Native credential custody can launch Git outside the injected workspace runner. */
export async function createLocalGitForgeHostConfig(input: Readonly<{ url: string; remotePath: string }>) {
  const directory = await mkdtemp(join(tmpdir(), 'local-git-forge-'));
  const path = join(directory, 'host.gitconfig');
  runScmExecutable(directory, 'git', ['config', '--file', path, `url.${input.remotePath}.pushInsteadOf`, input.url]);
  return { path, cleanup: () => rm(directory, { recursive: true, force: true }) };
}

/** Redirect only Git network effects; repository identity reads retain the real HTTPS URL. */
export function createLocalGitForgeTransport(input: Readonly<{ url: string; remotePath: string }>): ScmCommandRunner {
  // Resume the existing OS runner outside this injected adapter to avoid recursion.
  const runHost = AsyncLocalStorage.snapshot();
  return command => {
    // The OS adapter escapes its injected runner, while custody callbacks retain
    // the invoking Action's context rather than the fixture-construction context.
    const runCaller = AsyncLocalStorage.snapshot();
    const interaction = command.stdinInteraction;
    const network = command.bin === 'git' && (command.args.includes('push') || command.args.includes('fetch'));
    const args = network ? command.args.map(argument => argument === 'origin' || argument === input.url ? input.remotePath : argument) : command.args;
    return runHost(() => runScmCommand({ ...command, args, env: { ...command.env, GIT_CONFIG_GLOBAL: devNull },
      ...(interaction ? { stdinInteraction: { ...interaction, respond: () => runCaller(interaction.respond) } } : {}) }));
  };
}
