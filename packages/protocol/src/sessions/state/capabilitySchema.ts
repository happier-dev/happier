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

function createSessionStateCapabilitySchemas(strict: boolean) {
  const object = strict ? z.strictObject : z.object;
  const SessionStateHappierToProviderCapabilitySchema = lazyZodSchema(() => object({
      supported: z.boolean(),
      transport: z.optional(SessionStateHappierToProviderTransportSchema),
    }));

  const SessionStateProviderToHappierCapabilitySchema = lazyZodSchema(() => object({
      supported: z.boolean(),
      source: z.optional(SessionStateProviderToHappierSourceSchema),
    }));

  const UnsupportedHappierToProviderCapability = Object.freeze({ supported: false });
  const UnsupportedProviderToHappierCapability = Object.freeze({ supported: false });

  const SessionStateFieldCapabilitySchema = lazyZodSchema(() => object({
      supported: z.boolean(),
      happierToProvider: z._default(z.optional(SessionStateHappierToProviderCapabilitySchema), UnsupportedHappierToProviderCapability),
      providerToHappier: z._default(z.optional(SessionStateProviderToHappierCapabilitySchema), UnsupportedProviderToHappierCapability),
    }));

  const SessionStateCapabilitiesV1Schema = lazyZodSchema(() => object({
      identity: z.optional(object({
          runtimeDescriptor: z.optional(SessionStateFieldCapabilitySchema),
          providerSessionId: z.optional(SessionStateFieldCapabilitySchema),
        })),
      intent: z.optional(object({
          model: z.optional(SessionStateFieldCapabilitySchema),
          role: z.optional(SessionStateFieldCapabilitySchema),
          sessionRoles: z.optional(SessionStateFieldCapabilitySchema),
          memoryEnabled: z.optional(SessionStateFieldCapabilitySchema),
          approvalProfileId: z.optional(SessionStateFieldCapabilitySchema),
          voicePreference: z.optional(SessionStateFieldCapabilitySchema),
          templateDraftRef: z.optional(SessionStateFieldCapabilitySchema),
          templateInstance: z.optional(SessionStateFieldCapabilitySchema),
          context: z.optional(SessionStateFieldCapabilitySchema),
          permissionMode: z.optional(SessionStateFieldCapabilitySchema),
          acpSessionMode: z.optional(SessionStateFieldCapabilitySchema),
          acpConfigOption: z.optional(SessionStateFieldCapabilitySchema),
        })),
      display: z.optional(object({
          title: z.optional(SessionStateFieldCapabilitySchema),
          statusReason: z.optional(SessionStateFieldCapabilitySchema),
          bot: z.optional(SessionStateFieldCapabilitySchema),
          botFace: z.optional(SessionStateFieldCapabilitySchema),
        })),
      runtime: z.optional(object({
          workState: z.optional(SessionStateFieldCapabilitySchema),
          activity: z.optional(SessionStateFieldCapabilitySchema),
          externalAgent: z.optional(SessionStateFieldCapabilitySchema),
          externalSessionOperation: z.optional(SessionStateFieldCapabilitySchema),
          usageLimitRecovery: z.optional(SessionStateFieldCapabilitySchema),
          sessionRunner: z.optional(SessionStateFieldCapabilitySchema),
        })),
      view: z.optional(object({
          readState: z.optional(SessionStateFieldCapabilitySchema),
          attention: z.optional(SessionStateFieldCapabilitySchema),
          transcriptToolCalls: z.optional(SessionStateFieldCapabilitySchema),
        })),
    }));
  return { SessionStateHappierToProviderCapabilitySchema, SessionStateProviderToHappierCapabilitySchema, SessionStateFieldCapabilitySchema, SessionStateCapabilitiesV1Schema };
}

const authored = createSessionStateCapabilitySchemas(true);
export const SessionStateHappierToProviderCapabilitySchema = authored.SessionStateHappierToProviderCapabilitySchema;
export const SessionStateProviderToHappierCapabilitySchema = authored.SessionStateProviderToHappierCapabilitySchema;
export const SessionStateFieldCapabilitySchema = authored.SessionStateFieldCapabilitySchema;
export const SessionStateCapabilitiesV1Schema = authored.SessionStateCapabilitiesV1Schema;

/** Capability response projection; mutation and declaration schemas remain closed. */
export const SessionStateCapabilitiesV1ReadSchema = lazyZodSchema(() => createSessionStateCapabilitySchemas(false).SessionStateCapabilitiesV1Schema);
