import { describe, expect, it } from 'vitest';

import type {
  PackedAuthorNpmPairInputs,
} from '../../../scripts/plugin-platform/create-packed-author-candidate.mjs';
import type {
  assertPackedNovelConnectedAccountQaCandidate,
  buildVerticalAResult,
  createPackedNovelConnectedAccountQaHandoff,
  PackedAuthorDirectArtifactsSmoke,
  runVerticalA,
} from '../../../scripts/plugin-platform/run-packed-author-ui-compat.mjs';

describe('packed author npm-pair attestor declaration', () => {
  it('accepts only the natural SDK, Plugin UI, and CLI npm trio', () => {
    const input = {
      runId: 'natural-admission-contract',
      sdkTarballPath: '/tmp/sdk.tgz',
      pluginUiTarballPath: '/tmp/plugin-ui.tgz',
      cliTarballPath: '/tmp/cli.tgz',
    } satisfies PackedAuthorNpmPairInputs;

    expect(Object.keys(input).sort()).toEqual([
      'cliTarballPath',
      'pluginUiTarballPath',
      'runId',
      'sdkTarballPath',
    ]);
  });

  it('models the natural artifact result without candidate-only custody fields', () => {
    const result = {
      runId: 'natural-admission-contract',
      sdk: {
        packageName: '@happier-dev/plugin-sdk',
        version: '0.0.0',
        integrity: 'sha512-c2Rr',
        tarballPath: '/tmp/sdk.tgz',
      },
      pluginUi: {
        packageName: '@happier-dev/plugin-ui',
        version: '0.0.0',
        pluginSdkVersion: '0.0.0',
        integrity: 'sha512-cGx1Z2luLXVp',
        tarballPath: '/tmp/plugin-ui.tgz',
      },
      cli: {
        packageName: '@happier-dev/cli',
        version: '0.2.10',
        integrity: 'sha512-Y2xp',
        tarballPath: '/tmp/cli.tgz',
        entrypoint: 'package/bin/happier.mjs',
      },
    } satisfies PackedAuthorDirectArtifactsSmoke;

    const verticalAResultInput = {
      candidate: result,
      stages: [],
      loadedIdentities: {},
    } satisfies Parameters<typeof buildVerticalAResult>[0];
    const verticalARunnerCandidate = result satisfies Parameters<typeof runVerticalA>[0];
    const packedNovelHandoffCandidate = result satisfies Parameters<
      typeof createPackedNovelConnectedAccountQaHandoff
    >[0]['candidate'];
    const packedNovelHandoffAssertionCandidate = result satisfies Parameters<
      typeof assertPackedNovelConnectedAccountQaCandidate
    >[0]['candidate'];

    expect(Object.keys(result).sort()).toEqual([
      'cli',
      'pluginUi',
      'runId',
      'sdk',
    ]);
    expect(verticalAResultInput.candidate).toBe(result);
    expect(verticalARunnerCandidate).toBe(result);
    expect(packedNovelHandoffCandidate).toBe(result);
    expect(packedNovelHandoffAssertionCandidate).toBe(result);
  });
});
