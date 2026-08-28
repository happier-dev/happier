import type { GithubProjectedCheckRowV1 } from '../../triage/detail/projection.js';
import { isGithubFailingCheckConclusion } from '../../triage/checks.js';

export type GithubFixCiSessionSeedV1 = Readonly<{
  prompt: string;
}>;

export function buildGithubFixCiSessionSeed(input: Readonly<{
  repository: string;
  headRevision: string;
  check: GithubProjectedCheckRowV1;
}>): GithubFixCiSessionSeedV1 | null {
  const evidence = input.check.logExcerpt?.trim();
  if (!isGithubFailingCheckConclusion(input.check.conclusion) || !evidence) return null;
  return Object.freeze({
    prompt: [
        `Fix the failing GitHub check “${input.check.name}” in ${input.repository}`,
        `at head ${input.headRevision}. Diagnose the evidence before changing code,`,
        'then implement and verify the smallest canonical fix.',
        '',
        'Failed-check evidence:',
        evidence,
      ].join('\n'),
  });
}

export type GithubFixCiSessionHostV1 = Readonly<{
  version(): Readonly<{ methods: readonly string[] }>;
  openNewSession(request: GithubFixCiSessionSeedV1): Promise<void>;
}>;

export async function requestGithubFixCiSession(
  host: GithubFixCiSessionHostV1,
  seed: GithubFixCiSessionSeedV1,
): Promise<Readonly<{ status: 'seeded' | 'unsupported' | 'unavailable' }>> {
  let methods: readonly string[];
  try {
    methods = host.version().methods;
  } catch {
    return { status: 'unsupported' };
  }
  if (!methods.includes('openNewSession')) return { status: 'unsupported' };
  try {
    await host.openNewSession(seed);
    return { status: 'seeded' };
  } catch {
    return { status: 'unavailable' };
  }
}
