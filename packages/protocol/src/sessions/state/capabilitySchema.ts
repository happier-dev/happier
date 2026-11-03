import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from 'zod/mini';

export const SessionStateHappierToProviderTransportSchema = lazyZodSchema(() => z.enum([
  'runtime-hook',
  'provider-api',
  'mcp-tool-observation',
  'spawn-argument',
]));

export const SessionStateProviderToHappierSourceSchema = lazyZodSchema(() => z.enum([
  'snapshot',
  'event',
  'inference',
]));

export const SessionStateHappierToProviderCapabilitySchema = lazyZodSchema(() => z.strictObject({
    supported: z.boolean(),
    transport: z.optional(SessionStateHappierToProviderTransportSchema),
  }));

export const SessionStateProviderToHappierCapabilitySchema = lazyZodSchema(() => z.strictObject({
    supported: z.boolean(),
    source: z.optional(SessionStateProviderToHappierSourceSchema),
  }));

const UnsupportedHappierToProviderCapability = Object.freeze({ supported: false });
const UnsupportedProviderToHappierCapability = Object.freeze({ supported: false });

export const SessionStateFieldCapabilitySchema = lazyZodSchema(() => z.strictObject({
    supported: z.boolean(),
    happierToProvider: z._default(z.optional(SessionStateHappierToProviderCapabilitySchema), UnsupportedHappierToProviderCapability),
    providerToHappier: z._default(z.optional(SessionStateProviderToHappierCapabilitySchema), UnsupportedProviderToHappierCapability),
  }));

export const SessionStateCapabilitiesV1Schema = lazyZodSchema(() => z.strictObject({
    identity: z.optional(z.strictObject({
        runtimeDescriptor: z.optional(SessionStateFieldCapabilitySchema),
        providerSessionId: z.optional(SessionStateFieldCapabilitySchema),
      })),
    intent: z.optional(z.strictObject({
        model: z.optional(SessionStateFieldCapabilitySchema),
        role: z.optional(SessionStateFieldCapabilitySchema),
        sessionRoles: z.optional(SessionStateFieldCapabilitySchema),
        memoryEnabled: z.optional(SessionStateFieldCapabilitySchema),
        voicePreference: z.optional(SessionStateFieldCapabilitySchema),
          templateDraftRef: z.optional(SessionStateFieldCapabilitySchema),
          templateInstance: z.optional(SessionStateFieldCapabilitySchema),
        context: z.optional(SessionStateFieldCapabilitySchema),
        permissionMode: z.optional(SessionStateFieldCapabilitySchema),
        acpSessionMode: z.optional(SessionStateFieldCapabilitySchema),
        acpConfigOption: z.optional(SessionStateFieldCapabilitySchema),
      })),
    display: z.optional(z.strictObject({
        title: z.optional(SessionStateFieldCapabilitySchema),
        statusReason: z.optional(SessionStateFieldCapabilitySchema),
        bot: z.optional(SessionStateFieldCapabilitySchema),
        botFace: z.optional(SessionStateFieldCapabilitySchema),
      })),
    runtime: z.optional(z.strictObject({
        workState: z.optional(SessionStateFieldCapabilitySchema),
        activity: z.optional(SessionStateFieldCapabilitySchema),
        externalAgent: z.optional(SessionStateFieldCapabilitySchema),
        externalSessionOperation: z.optional(SessionStateFieldCapabilitySchema),
        usageLimitRecovery: z.optional(SessionStateFieldCapabilitySchema),
        sessionRunner: z.optional(SessionStateFieldCapabilitySchema),
      })),
    view: z.optional(z.strictObject({
        readState: z.optional(SessionStateFieldCapabilitySchema),
        attention: z.optional(SessionStateFieldCapabilitySchema),
        transcriptToolCalls: z.optional(SessionStateFieldCapabilitySchema),
      })),
  }));
