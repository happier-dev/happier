// @ts-check

import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { validateCandidateVersions } from '../release/verify-release-candidate-identity.mjs';
import { resolveImmutableCandidateIdentity } from '../release/lib/immutable-release-candidate.mjs';

/** Promote only the immutable versions emitted by the completed channel's publishers. */
export function promoteReleaseLatest(env = process.env) {
  const { versions } = validateCandidateVersions({
    channel: 'production', versions: {
      cli: env.CLI_VERSION ?? '', stack: env.STACK_VERSION ?? '', server: env.SERVER_VERSION ?? '',
      'ui-web': env.UI_WEB_VERSION ?? '',
    },
  });
  for (const [product, version] of Object.entries(versions)) {
    if (!version) continue;
    const { sourceTag } = resolveImmutableCandidateIdentity({ product, version });
    execFileSync('gh', ['release', 'edit', sourceTag, '--repo', env.GH_REPO ?? '', '--latest'], { env, stdio: 'inherit' });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) promoteReleaseLatest();
