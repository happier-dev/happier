export function buildProviderInputGenerationEpochId(input: Readonly<{
  runtimeIdentityKey: string;
  targetRevision: number;
  serviceId: string;
  groupId: string;
  desired?: Readonly<{
    profileId: string | null;
    generation: number | null;
    credentialRevision: string | null;
  }>;
}>): string {
  return JSON.stringify([
    input.runtimeIdentityKey,
    input.targetRevision,
    input.serviceId,
    input.groupId,
    input.desired?.profileId ?? null,
    input.desired?.generation ?? null,
    input.desired?.credentialRevision ?? null,
  ]);
}
