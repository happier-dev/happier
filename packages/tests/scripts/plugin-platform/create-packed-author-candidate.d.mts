import type { PackedAuthorCandidate } from './run-packed-author-ui-compat.mjs';

export type PackedAuthorNpmPairInputs = Readonly<{
  runId: string;
  sdkTarballPath: string;
  pluginUiTarballPath: string;
  channelsProtocolTarballPath?: string;
  cliTarballPath: string;
}>;

export function createPackedAuthorCandidate(
  params: PackedAuthorNpmPairInputs,
): Promise<Pick<PackedAuthorCandidate, 'runId' | 'sdk' | 'pluginUi' | 'channelsProtocol' | 'cli'>>;
