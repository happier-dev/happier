import { z } from 'zod';

export function createAcpConfiguredBackendV1Schema(zod: typeof z) {
  return zod.object({
    v: zod.literal(1),
    updatedAt: zod.number().finite(),
    backendId: zod.string().min(1),
    title: zod.string().min(1),
  }).passthrough();
}

export const AcpConfiguredBackendV1Schema = createAcpConfiguredBackendV1Schema(z);
export type AcpConfiguredBackendV1 = z.infer<typeof AcpConfiguredBackendV1Schema>;

export function buildAcpConfiguredBackendV1(params: Readonly<{
  updatedAt: number;
  backendId: string;
  title: string;
}>): AcpConfiguredBackendV1 {
  return {
    v: 1,
    updatedAt: params.updatedAt,
    backendId: params.backendId,
    title: params.title,
  };
}

export function readAcpConfiguredBackendV1FromMetadata(metadata: unknown): AcpConfiguredBackendV1 | null {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return null;
  const raw = (metadata as Record<string, unknown>).acpConfiguredBackendV1;
  const parsed = AcpConfiguredBackendV1Schema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}
