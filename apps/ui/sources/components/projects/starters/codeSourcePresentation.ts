import type { ProjectSourceRepositoryFacts } from '@/components/projects/sources/projectSourceRepositoryFacts';
import { t } from '@/text';

/**
 * Deploy an app → Your code: a repository Project's line (lab f1src "Next.js 15 · has a Dockerfile"), from the Source's
 * last observed repository facts (`projectSourceRepositoryFacts`). Only what was observed is said; unknown is never
 * read as absent, and with nothing observed the line names the repository and its provider.
 */
export function describeCodeSource(
  repository: Readonly<{ nameWithOwner: string; provider: string }>,
  facts: ProjectSourceRepositoryFacts | undefined,
): string {
  if (facts?.status !== 'observed') {
    return t('newApp.codeSubtitle', {
      repository: repository.nameWithOwner,
      provider: repository.provider,
    });
  }
  const { applications, rootFiles } = facts.observation;
  const app = applications[0];
  const stack =
    app?.framework ??
    (app?.runtime ? `${app.runtime.name} ${app.runtime.version}` : null);
  // A Compose file is what deploys, so it leads when both are there.
  const builds =
    rootFiles.compose === 'present'
      ? t('newApp.hasCompose')
      : rootFiles.dockerfile === 'present'
        ? t('newApp.hasDockerfile')
        : null;
  return [repository.nameWithOwner, stack, builds].filter(Boolean).join(' · ');
}
