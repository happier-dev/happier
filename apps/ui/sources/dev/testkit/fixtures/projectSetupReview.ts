import { ProjectSetupReviewV1Schema } from '@happier-dev/protocol/actions/projectSetupConsentFailure';

/** Literal Linux setup as projected by the daemon's Project preparation owner. */
export function createProjectSetupReviewFixture(
  commands: readonly string[],
  reviewedEffectDigest = 'a'.repeat(64),
  configEnvironment: Record<string, string> = {},
) {
  const setup = commands.map(command => ({ kind: 'command', command, cwd: '.', os: 'linux' }));
  return ProjectSetupReviewV1Schema.parse({
    reviewedEffectDigest,
    reviewedEffect: {
      v: 1,
      purpose: 'setup',
      commands: setup,
      lifecycle: { setup, teardown: [] },
      toolchain: { selection: { kind: 'host' } },
      files: [], setupInputs: [], bindings: [], configEnvironment,
      presentation: { bindings: [], provenance: { file: '.happier/project.json', kind: 'repository', fileState: 'unknown' } },
    },
  });
}
