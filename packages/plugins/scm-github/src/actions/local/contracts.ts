import {
  defineProtocolArray, defineProtocolLiteral, defineProtocolObject, defineProtocolString, defineProtocolUnion,
  ProtocolWorkspaceAddressV1Schema, ProtocolSecretReferenceOverlayV1Schema,
  ProtocolWorkspaceExecutionConfigAddressV1Schema, ProtocolWorkspaceWorkerPreferenceReadResultV1Schema,
  ProtocolProjectComputeExecResultV1Schema, ProtocolActionApprovalRequestCreatedResultSchema, ProtocolEnvVarRequirementV1Schema,
  type ProtocolComposableSchema,
} from '@happier-dev/plugin-sdk/protocol';
import type { ActionApprovalRequestCreatedResult } from '@happier-dev/plugin-sdk/actions';
import { GithubWorkflowShaV1Schema } from '../identity.js';

const closed = { policy: 'closed' } as const;
const text = defineProtocolString({ minLength: 1, pattern: '^[^\\u0000]+$' });
const optionalText = text.optional();
export const LocalActRunSeedV1Schema = defineProtocolObject({
  target: defineProtocolUnion([
    defineProtocolObject({ kind: defineProtocolLiteral('session'), sessionId: text }, closed),
    defineProtocolObject({ kind: defineProtocolLiteral('project'), projectId: text }, closed),
  ]),
  workspace: ProtocolWorkspaceAddressV1Schema,
  workflowPath: optionalText, event: optionalText, yamlJobId: optionalText, sourceHeadSha: GithubWorkflowShaV1Schema.optional(),
}, closed);
export type LocalActRunSeedV1 = ReturnType<typeof LocalActRunSeedV1Schema.parse>;
export const LocalRunSelectionV1Schema = defineProtocolObject({
  workspace: ProtocolWorkspaceAddressV1Schema, workflowPath: defineProtocolString({ pattern: '^[^\\u0000]*$' }),
  event: defineProtocolString({ pattern: '^(?:[A-Za-z_][A-Za-z0-9_]*)?$' }),
  yamlJobId: optionalText, eventPath: optionalText,
  matrix: defineProtocolArray(text).optional(),
  platforms: defineProtocolArray(defineProtocolObject({ label: text, image: text }, closed)),
  architecture: defineProtocolString({ pattern: '^[^\\u0000]*$' }),
  variables: defineProtocolArray(defineProtocolObject({
    name: defineProtocolString({ pattern: '^[A-Za-z_][A-Za-z0-9_]*$' }),
    value: defineProtocolString({ pattern: '^[^\\u0000]*$' }),
  }, closed)).optional(),
  secretFilePath: optionalText, environmentBindings: ProtocolSecretReferenceOverlayV1Schema.optional(), artifactServerPath: optionalText,
}, closed);
export type LocalRunSelection = ReturnType<typeof LocalRunSelectionV1Schema.parse>;
export const LocalActInspectInputV1Schema = defineProtocolObject({
  workspace: ProtocolWorkspaceAddressV1Schema, workflowPath: optionalText,
}, closed);
export const LocalActWorkflowJobV1Schema = defineProtocolObject({
  id: text, needs: defineProtocolArray(text), runsOn: defineProtocolUnion([defineProtocolArray(text), defineProtocolLiteral('dynamic')]),
}, closed);
export const LocalActWorkflowV1Schema = defineProtocolObject({
  events: defineProtocolArray(text), jobs: defineProtocolArray(LocalActWorkflowJobV1Schema),
}, closed);
export type LocalActWorkflow = ReturnType<typeof LocalActWorkflowV1Schema.parse>;
export const LocalActToolV1Schema = defineProtocolUnion([
  defineProtocolObject({ kind: defineProtocolLiteral('ready'), executablePath: text, version: text }, closed),
  defineProtocolObject({ kind: defineProtocolLiteral('unavailable'), code: text }, closed),
]);
export const LocalActInspectionV1Schema = defineProtocolObject({
  workspace: ProtocolWorkspaceAddressV1Schema, tool: LocalActToolV1Schema,
  preferenceAddress: ProtocolWorkspaceExecutionConfigAddressV1Schema,
  preference: ProtocolWorkspaceWorkerPreferenceReadResultV1Schema,
  secretRequirements: defineProtocolArray(ProtocolEnvVarRequirementV1Schema),
  workflows: defineProtocolArray(text), workflowPath: optionalText,
  workflow: LocalActWorkflowV1Schema.optional(), workflowError: optionalText,
}, closed);
export type LocalActInspection = ReturnType<typeof LocalActInspectionV1Schema.parse>;
export type LocalActInspectResultV1 = LocalActInspection | ActionApprovalRequestCreatedResult;
export const LocalActInspectResultV1Schema: ProtocolComposableSchema<LocalActInspectResultV1> = defineProtocolUnion([LocalActInspectionV1Schema, ProtocolActionApprovalRequestCreatedResultSchema]);
const unavailable = defineProtocolObject({ status: defineProtocolLiteral('unavailable') }, closed);
export const LocalActRunFormInputV1Schema = defineProtocolUnion([
  defineProtocolObject({ operation: defineProtocolObject({ kind: defineProtocolLiteral('open'), seed: LocalActRunSeedV1Schema }, closed) }, closed),
  defineProtocolObject({ mountId: text, operation: defineProtocolUnion([
    defineProtocolObject({ kind: defineProtocolLiteral('readSelection') }, closed),
    defineProtocolObject({ kind: defineProtocolLiteral('setSelection'), selection: LocalRunSelectionV1Schema }, closed),
  ]) }, closed),
]);
export type LocalActRunFormInput = ReturnType<typeof LocalActRunFormInputV1Schema.parse>;
export const LocalActRunFormResultV1Schema = defineProtocolUnion([
  defineProtocolObject({ kind: defineProtocolLiteral('opened'), mountId: text }, closed),
  defineProtocolObject({ status: defineProtocolLiteral('applied'), selection: LocalRunSelectionV1Schema }, closed),
  defineProtocolObject({ status: defineProtocolLiteral('applied') }, closed), unavailable,
]);
export type LocalActRunFormResult = ReturnType<typeof LocalActRunFormResultV1Schema.parse>;
export const LocalActRunResultV1Schema = defineProtocolUnion([ProtocolProjectComputeExecResultV1Schema, ProtocolActionApprovalRequestCreatedResultSchema]);
export type LocalActRunResultV1 = ReturnType<typeof LocalActRunResultV1Schema.parse>;
export const LOCAL_ACT_ACTION_IDS = { inspect: 'github/actions/local-inspect', run: 'github/actions/local-run', form: 'github/actions/local-form' } as const;
