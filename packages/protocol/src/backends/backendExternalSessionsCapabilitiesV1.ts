import { z } from 'zod';

export const BackendExternalSessionTakeoverCapabilitiesV1Schema = z.object({
  externalLinked: z.boolean(),
  persisted: z.boolean(),
  forceStop: z.boolean(),
  targetRuntimeModes: z.object({
    terminal: z.boolean(),
    remote: z.boolean(),
  }).passthrough(),
}).passthrough();
export type BackendExternalSessionTakeoverCapabilitiesV1 = z.infer<
  typeof BackendExternalSessionTakeoverCapabilitiesV1Schema
>;

export const BackendExternalSessionsCapabilitiesV1Schema = z.object({
  listCandidates: z.boolean(),
  attach: z.boolean(),
  transcript: z.object({
    page: z.boolean(),
    follow: z.boolean(),
    import: z.boolean(),
  }).passthrough(),
  takeover: BackendExternalSessionTakeoverCapabilitiesV1Schema,
}).passthrough();
export type BackendExternalSessionsCapabilitiesV1 = z.infer<typeof BackendExternalSessionsCapabilitiesV1Schema>;
