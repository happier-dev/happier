import { z } from '../../../../zodRuntimePolicy.js';
import { lazyZodSchema } from '../../../../lazyZodSchema.js';
import { MachineInstallationProofV1Schema } from '../../../identity/installationKeySchemas.js';

/** The installed Browser or Computer owner attests source access; host-private scope keys stay private. */
export const MachineLiveStreamSourceAdmissionBindingV1Schema = lazyZodSchema(() => z.strictObject({
  homeServerIdentityId: z.string().check(z.minLength(1)),
  actorAccountId: z.string().check(z.minLength(1)),
  streamFamily: z.string().check(z.minLength(1)),
  sourceId: z.string().check(z.minLength(1)),
  sourceOccurrenceId: z.string().check(z.minLength(1)),
  /** Installed Browser owner attests which Session owns this exact ephemeral source. */
  sessionBrowserSessionId: z.optional(z.string().check(z.minLength(1))),
}));
export type MachineLiveStreamSourceAdmissionBindingV1 = z.infer<typeof MachineLiveStreamSourceAdmissionBindingV1Schema>;

export const MachineLiveStreamSourceAdmissionPayloadV1Schema = lazyZodSchema(() => z.strictObject({
  version: z.literal(1),
  machineId: z.string().check(z.minLength(1)),
  installationId: z.string().check(z.minLength(1)),
  accountId: z.string().check(z.minLength(1)),
  liveStreamSourceAdmission: MachineLiveStreamSourceAdmissionBindingV1Schema,
}));
export type MachineLiveStreamSourceAdmissionPayloadV1 = z.infer<typeof MachineLiveStreamSourceAdmissionPayloadV1Schema>;

export const MachineLiveStreamSourceAdmissionV1Schema = lazyZodSchema(() => z.strictObject({
  payload: MachineLiveStreamSourceAdmissionPayloadV1Schema,
  proof: MachineInstallationProofV1Schema,
}));
export type MachineLiveStreamSourceAdmissionV1 = z.infer<typeof MachineLiveStreamSourceAdmissionV1Schema>;
