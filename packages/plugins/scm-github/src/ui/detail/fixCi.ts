import type { GithubProjectedCheckRowV1 } from '../../triage/detail/projection.js';
import { isGithubFailingCheckConclusion } from '../../triage/checks.js';

const FIX_CI_SESSION_REQUEST = Object.freeze({
  action: 'session.spawn_new',
  projection: 'serverStartDraft',
} as const);

export type GithubFixCiSessionSeedV1 = Readonly<{
  prompt: Readonly<{ text: string; mode: 'replace' }>;
}>;

export function buildGithubFixCiSessionSeed(input: Readonly<{
  repository: string;
  headRevision: string;
  check: GithubProjectedCheckRowV1;
}>): GithubFixCiSessionSeedV1 | null {
  const evidence = input.check.logExcerpt?.trim();
  if (!isGithubFailingCheckConclusion(input.check.conclusion) || !evidence) return null;
  return Object.freeze({
    prompt: Object.freeze({
      mode: 'replace' as const,
      text: [
        `Fix the failing GitHub check “${input.check.name}” in ${input.repository}`,
        `at head ${input.headRevision}. Diagnose the evidence before changing code,`,
        'then implement and verify the smallest canonical fix.',
        '',
        'Failed-check evidence:',
        evidence,
      ].join('\n'),
    }),
  });
}

export type GithubFixCiSessionHostV1 = Readonly<{
  version(): Readonly<{ methods: readonly string[] }>;
  selectActionInput(request: Readonly<{
    hostAction: typeof FIX_CI_SESSION_REQUEST;
    seed: GithubFixCiSessionSeedV1;
  }>): Promise<unknown>;
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
  if (!methods.includes('selectActionInput')) return { status: 'unsupported' };
  try {
    const selected = await host.selectActionInput({
      hostAction: FIX_CI_SESSION_REQUEST,
      seed,
    });
    return typeof selected === 'object'
      && selected !== null
      && (selected as Readonly<{ kind?: unknown }>).kind === 'newSessionSeeded'
      ? { status: 'seeded' }
      : { status: 'unavailable' };
  } catch {
    return { status: 'unavailable' };
  }
}
