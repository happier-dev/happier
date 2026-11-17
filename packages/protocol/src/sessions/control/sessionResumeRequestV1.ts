import { z } from '../../zodRuntimePolicy.js';
import { lazyZodSchema } from '../../lazyZodSchema.js';
import { AgentExecutionTargetV1Schema } from '../../agents/executionTargetV1.js';
import { BackendTargetRefV2Schema, normalizeBackendTargetRefV2InputToV2, type BackendTargetRefV2Input } from '../../backends/targets/backendTargetRefV2.js';
import { SpawnSessionExecutionAuthorizationSchema, SpawnSessionTerminalSchema } from '../spawnSession.js';
import { RuntimeDescriptorV1Schema } from '../metadata/runtimeDescriptorV1.js';
import { SESSION_PERMISSION_MODES } from '../metadata/sessionPermissionModes.js';
import { SessionModelSelectionSchema } from '../../providers/selection/v2.js';
import { SessionAttachMetadataIdentityPolicySchema } from '../attach/metadataIdentityPolicy.js';
import { SessionAuthoringValueV1Schema } from '../authoring/index.js';
import { SessionInitialGoalRequestV1Schema } from '../work/state/sessionWorkStateRpc.js';
import type { ProtocolJsonValue } from '../../plugins/actions/protocolComposableSchema.js';

/** Resume launch intent only. Home admission and requester custody are host-private. */
export const SessionResumeRequestV1Schema = lazyZodSchema(() => z.strictObject({
    type: z.literal('resume-session'),
    sessionId: z.string().check(z.minLength(1)),
    directory: z.string().check(z.minLength(1)),
    agentTarget: z.optional(AgentExecutionTargetV1Schema),
    backendTarget: z.optional((<I extends z.core.$ZodType, O extends z.core.$ZodType>(input: I, output: O) => new z.ZodMiniPipe({ type: 'pipe', in: input, out: output }) as z.ZodMiniPipe<I, O>)(z.transform((input: BackendTargetRefV2Input) => normalizeBackendTargetRefV2InputToV2(input)), BackendTargetRefV2Schema)),
    resume: z.optional(z.string().check(z.minLength(1))),
    runtimeDescriptorV1: z.optional((<I extends z.core.$ZodType, O extends z.core.$ZodType>(input: I, output: O) => new z.ZodMiniPipe({ type: 'pipe', in: input, out: output }) as z.ZodMiniPipe<I, O>)(z.transform((input: ProtocolJsonValue) => input), RuntimeDescriptorV1Schema)),
    environmentVariables: z.optional(z.record(z.string(), z.string())),
    terminal: z.optional(SpawnSessionTerminalSchema),
    connectedServices: z.optional((<I extends z.core.$ZodType, O extends z.core.$ZodType>(input: I, output: O) => new z.ZodMiniPipe({ type: 'pipe', in: input, out: output }) as z.ZodMiniPipe<I, O>)(z.transform((input: ProtocolJsonValue) => input), SessionAuthoringValueV1Schema.shape.connectedServices)),
    connectedServicesUpdatedAt: z.optional(z.number()),
    transcriptStorage: z.optional(z.enum(['direct', 'persisted'])),
    attachMetadataIdentityPolicy: z.optional(SessionAttachMetadataIdentityPolicySchema),
    permissionMode: z.optional(z.enum(SESSION_PERMISSION_MODES)),
    permissionModeUpdatedAt: z.optional(z.number()),
    modelSelection: z.optional(SessionModelSelectionSchema),
    accountSettingsVersionHint: z.optional(z.number().check(z.int(), z.nonnegative())),
    initialTranscriptAfterSeq: z.optional(z.number().check(z.int(), z.nonnegative())),
    executionAuthorization: z.optional(SpawnSessionExecutionAuthorizationSchema),
    approvedNewDirectoryCreation: z.optional(z.boolean()),
    initialGoal: z.optional((<I extends z.core.$ZodType, O extends z.core.$ZodType>(input: I, output: O) => new z.ZodMiniPipe({ type: 'pipe', in: input, out: output }) as z.ZodMiniPipe<I, O>)(z.transform((input: ProtocolJsonValue) => input), SessionInitialGoalRequestV1Schema)),
    spawnNonce: z.optional(z.string().check(z.minLength(1))),
}).check(z.superRefine((value, context) => {
    if (!value.agentTarget && !value.backendTarget) context.addIssue({
        code: 'custom', path: ['agentTarget'], message: 'agentTarget or configured backendTarget is required',
    });
})));

export type SessionResumeRequestV1 = z.infer<typeof SessionResumeRequestV1Schema>;
