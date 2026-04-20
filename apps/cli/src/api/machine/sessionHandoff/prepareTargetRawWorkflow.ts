import {
  SessionHandoffPrepareTargetRequestSchema,
} from '@happier-dev/protocol';

import { invalidRequest } from './prepareTargetState';
import {
  resolvePrepareTargetBootstrap,
  resolvePrepareTargetResponseAfterBootstrap,
  type ResolvePrepareTargetBootstrapInput,
} from './prepareTargetBootstrap';
import {
  resolvePrepareTargetDirectPeerMetadataPreflight,
  type SessionHandoffPrepareTargetResponse,
} from './prepareTargetResponse';

export type ResolvePrepareTargetResponseFromRawInput = Omit<ResolvePrepareTargetBootstrapInput, 'request'> & Readonly<{
  raw: unknown;
}>;

export async function resolvePrepareTargetResponseFromRaw(
  input: ResolvePrepareTargetResponseFromRawInput,
): Promise<
  | SessionHandoffPrepareTargetResponse
  | Readonly<{ ok: false; errorCode: string; error?: string }>
> {
  const parsed = SessionHandoffPrepareTargetRequestSchema.safeParse(input.raw);
  if (!parsed.success) return invalidRequest();

  const directPeerMetadataPreflightResult = await resolvePrepareTargetDirectPeerMetadataPreflight({
    request: parsed.data,
    sourceExportStore: input.sourceExportStore,
  });
  if (directPeerMetadataPreflightResult) {
    return directPeerMetadataPreflightResult;
  }

  const bootstrap = await resolvePrepareTargetBootstrap({
    ...input,
    request: parsed.data,
  });

  return resolvePrepareTargetResponseAfterBootstrap({
    handoffId: parsed.data.handoffId,
    bootstrap,
    prepareJobStore: input.prepareJobStore,
  });
}
