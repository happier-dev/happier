import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { captureConsoleJsonOutput } from '@/testkit/logger/captureOutput';

import { runPackedPluginTest } from './packedTest';

const targetFixtureRoot = fileURLToPath(
  new URL('./fixtures/targetedContributionsConformanceTarget', import.meta.url),
);
const contributorFixtureRoot = fileURLToPath(
  new URL('./fixtures/targetedContributionsConformanceContributor', import.meta.url),
);
const unrelatedFixtureRoot = fileURLToPath(
  new URL('./fixtures/targetedContributionsConformanceUnrelated', import.meta.url),
);

const targetPluginId = 'acme.targeted-contributions-conformance-target';
const contributorPluginId = 'acme.targeted-contributions-conformance-contributor';
const unrelatedPluginId = 'acme.targeted-contributions-conformance-unrelated';

type PackedCliResult = Readonly<{
  ok: boolean;
  kind: string;
  data?: Readonly<{
    target: Readonly<{ plugin: Readonly<{ id: string }> }>;
    prerequisites: readonly Readonly<{ plugin: Readonly<{ id: string }> }>[];
    contributors: readonly Readonly<{ plugin: Readonly<{ id: string }> }>[];
    initialInvocation: Readonly<{
      actionId: string;
      result: Readonly<{
        contributors: readonly Readonly<{
          pluginId: string;
          contributionId: string;
        }>[];
        verifications: readonly Readonly<{
          result: unknown;
        }>[];
      }>;
    }> | null;
    invocation: Readonly<{
      actionId: string;
      result: Readonly<{
        contributors: readonly Readonly<{
          pluginId: string;
          contributionId: string;
        }>[];
        verifications: readonly Readonly<{
          result: unknown;
        }>[];
      }>;
    }> | null;
  }>;
}>;

async function runPackedTargetedCliTest(prerequisiteArgs: readonly string[]): Promise<PackedCliResult> {
  const { handlePluginsCommand } = await import('@/cli/commands/plugins');
  const output = captureConsoleJsonOutput();
  const previousExitCode = process.exitCode;
  process.exitCode = undefined;
  try {
    await handlePluginsCommand([
      'test',
      targetFixtureRoot,
      '--packed',
      ...prerequisiteArgs,
      '--json',
    ]);
    expect(process.exitCode).toBe(0);
    return output.json<PackedCliResult>();
  } finally {
    output.restore();
    process.exitCode = previousExitCode;
  }
}

function expectPackedTargetedCliResult(result: PackedCliResult): void {
  expect(result, JSON.stringify(result)).toMatchObject({
    ok: true,
    kind: 'plugins_test',
    data: {
      target: { plugin: { id: targetPluginId } },
      prerequisites: [{ plugin: { id: contributorPluginId } }],
      contributors: [{ plugin: { id: contributorPluginId } }],
      initialInvocation: {
        actionId: `${targetPluginId}/verify-targeted-admission`,
        result: {
          contributors: [{
            pluginId: contributorPluginId,
            contributionId: 'provider-a',
          }],
          verifications: [{ result: { verified: true } }],
        },
      },
      invocation: {
        actionId: `${targetPluginId}/verify-targeted-admission`,
        result: {
          contributors: [{
            pluginId: contributorPluginId,
            contributionId: 'provider-a',
          }],
          verifications: [{ result: { verified: true } }],
        },
      },
    },
  });
}

describe('packed public targeted-contribution conformance', () => {
  it.each([
    ['equals form', [`--with-plugin=${contributorFixtureRoot}`]],
    ['spaced form', ['--with-plugin', contributorFixtureRoot]],
  ])('exercises the packed target and contributor through the CLI %s', async (_form, prerequisiteArgs) => {
    expectPackedTargetedCliResult(await runPackedTargetedCliTest(prerequisiteArgs));
  }, 180_000);

  it('reports only contributors admitted at the target-owned point, not every installed prerequisite', async () => {
    const result = await runPackedPluginTest({
      projectRoot: targetFixtureRoot,
      prerequisiteLocators: [contributorFixtureRoot, unrelatedFixtureRoot],
    });

    expect(result, JSON.stringify(result)).toMatchObject({
      ok: true,
      mode: 'packed',
      pluginId: targetPluginId,
      initialInvocation: {
        actionId: `${targetPluginId}/verify-targeted-admission`,
        result: {
          contributors: [{
            pluginId: contributorPluginId,
            contributionId: 'provider-a',
          }],
          verifications: [{
            contributor: {
              pluginId: contributorPluginId,
              contributionId: 'provider-a',
            },
            result: { verified: true },
          }],
        },
      },
      invocation: {
        actionId: `${targetPluginId}/verify-targeted-admission`,
        result: {
          contributors: [{
            pluginId: contributorPluginId,
            contributionId: 'provider-a',
          }],
          verifications: [{
            contributor: {
              pluginId: contributorPluginId,
              contributionId: 'provider-a',
            },
            result: { verified: true },
          }],
        },
      },
    });
    if (!result.ok) throw new Error('Packed target/contributor fixture did not complete');

    expect(result.initialInvocation?.result).toMatchObject({
      targetGeneration: result.target.admission.appliedGeneration,
    });
    expect(result.invocation?.result).toMatchObject({
      targetGeneration: result.target.admission.appliedGeneration,
    });
    expect(result.target.admission.appliedGeneration).toEqual(
      result.target.admission.desiredGeneration,
    );

    // The target action consumes the production target-local service; this
    // runner result must carry the same canonical admission, rather than call
    // every successful install a contributor.
    expect(result.prerequisites.map((participant) => participant.plugin.id)).toEqual([
      contributorPluginId,
      unrelatedPluginId,
    ]);
    expect(result.contributors.map((participant) => participant.plugin.id)).toEqual([
      contributorPluginId,
    ]);
    expect(result.contributors.map((participant) => participant.plugin.id)).not.toContain(unrelatedPluginId);
    const admittedContributor = result.contributors[0];
    if (!admittedContributor) throw new Error('Expected the packed contributor admission');
    expect(admittedContributor.admission.appliedGeneration).toEqual(
      admittedContributor.admission.desiredGeneration,
    );
    const unrelatedPrerequisite = result.prerequisites.find((participant) => (
      participant.plugin.id === unrelatedPluginId
    ));
    if (!unrelatedPrerequisite) throw new Error('Expected the unrelated packed prerequisite');
    expect(unrelatedPrerequisite.admission).toEqual({
      decision: 'installAndTrust',
      desiredGeneration: expect.any(String),
      appliedGeneration: null,
    });
    expect(result.contributors[0]?.targetedAdmissions).toEqual([{
      target: expect.objectContaining({
        pluginId: targetPluginId,
        pointId: 'providers',
      }),
      protocol: { id: 'packed-targeted-provider', version: 1 },
      contributor: expect.objectContaining({
        pluginId: contributorPluginId,
        contributionId: 'provider-a',
      }),
    }]);
  }, 180_000);
});
