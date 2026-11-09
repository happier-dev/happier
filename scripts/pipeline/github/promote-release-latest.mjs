// @ts-check

import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { resolveCandidateVerificationTargets } from '../release/verify-release-candidate-identity.mjs';

/** Promote only the immutable versions emitted by the completed channel's publishers. */
export function promoteReleaseLatest(env = process.env) {
  const versions = {
    cli: env.CLI_VERSION ?? '', stack: env.STACK_VERSION ?? '', server: env.SERVER_VERSION ?? '',
    runner: env.RUNNER_VERSION ?? '', 'ui-web': env.UI_WEB_VERSION ?? '',
  };
  const { tags } = resolveCandidateVerificationTargets({
    channel: 'production', versions,
    verifyDeploy: { ui: false, server: false, website: false, docs: false },
    verifyRelease: { cli: !!versions.cli, stack: !!versions.stack, server: !!versions.server, runner: !!versions.runner, 'ui-web': !!versions['ui-web'] },
  });
  for (const tag of tags) {
    execFileSync('gh', ['release', 'edit', tag, '--repo', env.GH_REPO ?? '', '--latest'], { env, stdio: 'inherit' });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) promoteReleaseLatest();
