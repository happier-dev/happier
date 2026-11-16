import type { DeploymentTargetRepositoryAccessV1 } from '@happier-dev/plugin-sdk';
import { isObject } from '../connectedAccounts/probe.js';

type Repository = DeploymentTargetRepositoryAccessV1['repository'];

/** Pages accepts hosted GitHub/GitLab sources; GitLab owners can be nested groups. */
export function pagesCreateSource(repository: Repository, productionBranch: string) {
  if ((repository.kind !== 'github' && repository.kind !== 'gitlab')
    || repository.deployment !== `https://${repository.kind}.com`) return null;
  const separator = repository.repository.lastIndexOf('/');
  if (separator <= 0 || separator === repository.repository.length - 1) return null;
  return { type: repository.kind, config: { owner: repository.repository.slice(0, separator),
    repo_name: repository.repository.slice(separator + 1), production_branch: productionBranch } };
}

/** Both creation and adoption consume the provider's observed source, never the requested mode. */
export function pagesRepositoryAccess(source: unknown, repository: Repository, accountId: string): DeploymentTargetRepositoryAccessV1 {
  const expected = pagesCreateSource(repository, '');
  const config = isObject(source) && isObject(source.config) ? source.config : undefined;
  const ready = expected && isObject(source) && source.type === expected.type
    && config?.owner === expected.config.owner && config.repo_name === expected.config.repo_name;
  return ready ? { status: 'ready', repository } : { status: 'needsGitAccess', repository,
    grantUrl: `https://dash.cloudflare.com/?to=/${encodeURIComponent(accountId)}/workers-and-pages/create/pages` };
}
