import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from "../../zodRuntimePolicy.js";

const AvailableAdmissionModeV1Schema = lazyZodSchema(() => z.strictObject({
  status: z.literal("available"),
}));

const UnavailableProvisionedAdmissionModeV1Schema = lazyZodSchema(() => z.strictObject({
  status: z.literal("unavailable"),
  reason: z.enum([
    "home_policy_unavailable",
    "home_policy_prohibited",
    "directory_source_required",
    "directory_projection_required",
    "team_connection_unavailable",
  ]),
}));

const UnavailableJitAdmissionModeV1Schema = lazyZodSchema(() => z.strictObject({
  status: z.literal("unavailable"),
  reason: z.enum([
    "home_policy_unavailable",
    "home_policy_prohibited",
    "team_connection_required",
    "team_connection_unavailable",
  ]),
}));

export const TeamAdmissionModeApplicabilityV1Schema = lazyZodSchema(() => z.strictObject({
  v: z.literal(1),
  modes: z.strictObject({
    invite_only: AvailableAdmissionModeV1Schema,
    provisioned: z.union([
      AvailableAdmissionModeV1Schema,
      UnavailableProvisionedAdmissionModeV1Schema,
    ]),
    jit: z.union([
      AvailableAdmissionModeV1Schema,
      UnavailableJitAdmissionModeV1Schema,
    ]),
  }),
}));
export type TeamAdmissionModeApplicabilityV1 = z.infer<typeof TeamAdmissionModeApplicabilityV1Schema>;
