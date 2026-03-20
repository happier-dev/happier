import { buildAcpConfiguredBackendV1 } from '@happier-dev/protocol';

export function buildConfiguredAcpBackendSessionMetadata(params: Readonly<{
  backendId: string;
  title: string;
}>): Readonly<{
  acpConfiguredBackendV1: ReturnType<typeof buildAcpConfiguredBackendV1>;
}> {
  return {
    acpConfiguredBackendV1: buildAcpConfiguredBackendV1({
      updatedAt: Date.now(),
      backendId: params.backendId,
      title: params.title,
    }),
  };
}
