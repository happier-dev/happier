import type { DeploymentTargetRepositoryAccessV1 } from '@happier-dev/plugin-sdk';
import { normalizeScmHostingRepositoryIdentity, sameScmHostingRepositoryIdentity } from '@happier-dev/plugin-sdk/scm';
import { isObject } from '../connectedAccounts/probe.js';

type Repository = DeploymentTargetRepositoryAccessV1['repository'];

export const cloudflareHostedGitKinds = ['github', 'gitlab'] as const;

/** GitLab owners can be nested groups. Cloudflare connects the hosted forges. */
export function cloudflareGitRepository(repository: Repository) {
  const kind = cloudflareHostedGitKinds.find(candidate => candidate === repository.kind);
  if (!kind || repository.deployment !== `https://${kind}.com`) return null;
  const separator = repository.repository.lastIndexOf('/');
  if (separator <= 0 || separator === repository.repository.length - 1) return null;
  return { kind, owner: repository.repository.slice(0, separator), name: repository.repository.slice(separator + 1) };
}

export function matchesCloudflareGitRepository(repository: Repository, kind: unknown, owner: unknown, name: unknown): boolean {
  if (!cloudflareGitRepository(repository) || typeof owner !== 'string' || typeof name !== 'string') return false;
  return sameScmHostingRepositoryIdentity(repository, normalizeScmHostingRepositoryIdentity({
    kind, deployment: repository.deployment, repository: `${owner}/${name}`,
  }));
}

export function pagesCreateSource(repository: NonNullable<ReturnType<typeof cloudflareGitRepository>>, productionBranch: string) {
  return { type: repository.kind, config: { owner: repository.owner, repo_name: repository.name, production_branch: productionBranch } };
}

export function workerBuildsRepositoryMatches(connection: unknown, repository: Repository): boolean {
  return isObject(connection) && connection.deleted_on == null
    && typeof connection.repo_id === 'string' && connection.repo_id.length > 0
    && matchesCloudflareGitRepository(repository, connection.provider_type, connection.provider_account_name, connection.repo_name);
}

/** Both creation and adoption consume the provider's observed source, never the requested mode. */
export function pagesRepositoryAccess(source: unknown, repository: Repository, accountId: string): DeploymentTargetRepositoryAccessV1 {
  const ready = isObject(source) && isObject(source.config)
    && matchesCloudflareGitRepository(repository, source.type, source.config.owner, source.config.repo_name);
  return ready ? { status: 'ready', repository } : { status: 'needsGitAccess', repository,
    grantUrl: cloudflareGitGrantUrl('pages', accountId) };
}

export function cloudflareGitGrantUrl(product: 'pages' | 'workers', accountId: string): string {
  const root = `https://dash.cloudflare.com/?to=/${encodeURIComponent(accountId)}/workers-and-pages`;
  return product === 'pages' ? `${root}/create/pages` : root;
}
