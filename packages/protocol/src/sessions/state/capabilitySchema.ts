import { z } from 'zod';

export const SessionStateHappierToProviderTransportSchema = z.enum([
  'runtime-hook',
  'provider-api',
  'mcp-tool-observation',
  'spawn-argument',
]);

export const SessionStateProviderToHappierSourceSchema = z.enum([
  'snapshot',
  'event',
  'inference',
]);

export const SessionStateHappierToProviderCapabilitySchema = z
  .object({
    supported: z.boolean(),
    transport: SessionStateHappierToProviderTransportSchema.optional(),
  })
  .strict();

export const SessionStateProviderToHappierCapabilitySchema = z
  .object({
    supported: z.boolean(),
    source: SessionStateProviderToHappierSourceSchema.optional(),
  })
  .strict();

const UnsupportedHappierToProviderCapability = Object.freeze({ supported: false });
const UnsupportedProviderToHappierCapability = Object.freeze({ supported: false });

export const SessionStateFieldCapabilitySchema = z
  .object({
    supported: z.boolean(),
    happierToProvider: SessionStateHappierToProviderCapabilitySchema
      .optional()
      .default(UnsupportedHappierToProviderCapability),
    providerToHappier: SessionStateProviderToHappierCapabilitySchema
      .optional()
      .default(UnsupportedProviderToHappierCapability),
  })
  .strict();

export const SessionStateCapabilitiesV1Schema = z
  .object({
    identity: z
      .object({
        runtimeDescriptor: SessionStateFieldCapabilitySchema.optional(),
        providerSessionId: SessionStateFieldCapabilitySchema.optional(),
      })
      .strict()
      .optional(),
    intent: z
      .object({
        model: SessionStateFieldCapabilitySchema.optional(),
        permissionMode: SessionStateFieldCapabilitySchema.optional(),
        acpSessionMode: SessionStateFieldCapabilitySchema.optional(),
        acpConfigOption: SessionStateFieldCapabilitySchema.optional(),
      })
      .strict()
      .optional(),
    display: z
      .object({
        title: SessionStateFieldCapabilitySchema.optional(),
      })
      .strict()
      .optional(),
    runtime: z
      .object({
        workState: SessionStateFieldCapabilitySchema.optional(),
        activity: SessionStateFieldCapabilitySchema.optional(),
        usageLimitRecovery: SessionStateFieldCapabilitySchema.optional(),
        sessionRunner: SessionStateFieldCapabilitySchema.optional(),
      })
      .strict()
      .optional(),
    view: z
      .object({
        readState: SessionStateFieldCapabilitySchema.optional(),
        attention: SessionStateFieldCapabilitySchema.optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
