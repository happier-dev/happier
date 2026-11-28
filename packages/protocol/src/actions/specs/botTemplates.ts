import { lazyActionSpecArray } from '../lazyActionSpecValue.js';
import { isBotTemplatePluginReadActionIdV1 } from '../../bots/templates/botTemplateActionIdsV1.js';
import { BOT_TEMPLATE_ACTION_IDS_V1, BotTemplateActionInputSchemasV1, BotTemplateActionOutputSchemasV1,
  BotTemplateInstantiateAgentAuthoringInputV1Schema,
  type BotTemplateActionIdV1 } from '../../bots/templates/botTemplateActionsV1.js';
import type { PreNormalizedActionSpec } from './definition.js';
import { z } from '../../zodRuntimePolicy.js';
import { lazyZodSchema } from '../../lazyZodSchema.js';
import { BotTemplateSetupReviewSelectionsV1Schema, projectBotTemplateSetupSelectionsForReviewV1 } from '../../bots/templates/templateSetupSelectionsV1.js';
import { projectSessionSpawnNewObservationInput, SessionSpawnNewInputHints } from './session/lifecycle.js';
import { withoutClientActionInput } from '../clientActionInput.js';
import { readRecord } from '../../inputs/inputRecords.js';

function projectRecipientInput(id: 'template.instantiate' | 'template.updates.apply', value: unknown): unknown {
  const parsed = (id === 'template.instantiate' ? instantiateObservationSchema
    : BotTemplateActionInputSchemasV1[id]).safeParse(value);
  if (!parsed.success) return {};
  return { ...parsed.data,
    ...('creation' in parsed.data ? { creation: projectSessionSpawnNewObservationInput(parsed.data.creation) } : {}),
    ...(parsed.data.setup ? { setup: projectBotTemplateSetupSelectionsForReviewV1(parsed.data.setup) } : {}),
  };
}
const instantiateObservationSchema = lazyZodSchema(() => z.union([
  BotTemplateActionInputSchemasV1['template.instantiate'], BotTemplateInstantiateAgentAuthoringInputV1Schema,
]));
const instantiateReviewSchema = lazyZodSchema(() => z.union([
  z.extend(BotTemplateActionInputSchemasV1['template.instantiate'], { setup: z.optional(BotTemplateSetupReviewSelectionsV1Schema) }),
  z.extend(BotTemplateInstantiateAgentAuthoringInputV1Schema, { setup: z.optional(BotTemplateSetupReviewSelectionsV1Schema) }),
]));
const updateReviewSchema = lazyZodSchema(() => z.extend(BotTemplateActionInputSchemasV1['template.updates.apply'], {
  setup: z.optional(BotTemplateSetupReviewSelectionsV1Schema),
}));
const agentDraftSchema = lazyZodSchema(() => z.omit(BotTemplateActionInputSchemasV1['template.draft'], { expectedRevision: true }));
const instantiateInputHints = { fields: SessionSpawnNewInputHints.fields
  .filter(field => ('required' in field && field.required) || field.path === 'creationKey')
  .map(field => ({ ...field, path: `creation.${field.path}` })) };
const agentInstantiateInputHints = {
  description: 'Omit creation.executionTarget and creation.agentTarget to use the authenticated Session’s current Machine and Agent. Supply either choice explicitly to override it. Directory intent remains explicit.',
  fields: instantiateInputHints.fields.map(field => ({ ...field, required: field.path === 'creation.directory' })),
};

export const BOT_TEMPLATE_ACTION_SPECS_V1: readonly (PreNormalizedActionSpec & Readonly<{ requiredAuthority: 'account_automation' }>)[] =
  lazyActionSpecArray(() => BOT_TEMPLATE_ACTION_IDS_V1.map((id: BotTemplateActionIdV1) => ({
    id, title: id === 'template.draft' ? 'Draft Bot template' : id === 'template.release' ? 'Release Bot template'
      : id === 'template.preview' ? 'Preview Bot template' : id === 'template.export_file' ? 'Download template skill file'
        : id === 'template.instantiate' ? 'Make my own Bot' : id === 'template.updates.diff' ? 'Review Bot template update'
          : id === 'template.updates.apply' ? 'Update Bot from template' : id === 'template.updates.skip' ? 'Skip template version'
            : id === 'template.follow.stop' ? 'Stop following template' : 'Open Bot template',
    description: id === 'template.draft' ? 'Save selected reusable content in this Bot’s one private draft, then offer it for person review. Repeated requests update that draft; the host acquires its current revision. Drafting is allowed by default.'
      : id === 'template.release' ? 'Release the exact reviewed draft revision with an explicit version and notes. Optional named Can-copy grants are part of this single reviewed operation.'
        : id === 'template.preview' ? 'Read the complete released content without creating a Bot or acquiring credentials.'
          : id === 'template.export_file' ? 'Read one carried skill file for download before creating a Bot.'
            : id === 'template.instantiate' ? 'Create an independent Bot with the reviewed instructions, skills, memory and suggested automations, then start its greeting on the selected Machine. Restricted tokens with this grant are class-scoped: they can write any editable Artifact. Software setup uses the token’s ordinary Machine setup grants and approval policy. Scheduled and Session lifecycle suggestions start off. Weekly memory upkeep follows the Account preference. Conversation needs and source-bound automation suggestions are set up after creation.'
              : id === 'template.updates.diff' ? 'Compare the retained accepted release, local instructions and skills with the addressed release. Learned memory stays unchanged.'
                : id === 'template.updates.apply' ? 'Apply reviewed instruction hunks, skills and recipient setup, preserving learned memory. Advance the accepted version only after settlement. Restricted tokens with this grant are class-scoped: they can write any editable Artifact and delete any owned Artifact. Software setup uses the token’s ordinary Machine setup grants and approval policy.'
                  : id === 'template.updates.skip' ? 'Hide this offered version for this independent Bot. Later releases can still be offered.'
                    : id === 'template.follow.stop' ? 'Withdraw future update demand while retaining the independent Bot, source and accepted content.'
                      : 'Open the private Bot template editor on the answering client. A headless host returns surface_unavailable.',
    ...(id === 'template.preview' || id === 'template.export_file' ? {
      requesterAccountContentDemandForInput: (input: unknown) => readRecord(readRecord(input).source).kind === 'artifact',
    } : id === 'template.draft' || id === 'template.release' || id === 'template.instantiate'
      || id === 'template.updates.diff' || id === 'template.updates.apply' ? {
        requesterAccountContentDemandForInput: () => true,
      } : {}),
    approval: { result: 'required' }, safety: id === 'template.release' || id === 'template.instantiate' || id === 'template.updates.apply' ? 'danger' : 'safe',
    approvalPolicy: { uiConfirmation: 'direct' },
    ...(id === 'template.instantiate' || id === 'template.updates.apply' ? {
      projectObservationInput: (value: unknown) => projectRecipientInput(id, value),
      approvalPresentation: { summary: () => null, projectInput: (value: unknown) => projectRecipientInput(id, value),
        // The template a Copy starts from reads as that template, not its kind, Home and Artifact id.
        referenceForField: (path: string, value: unknown) => {
          const source = path === 'source' ? readRecord(value) : null;
          return source?.kind === 'artifact' && typeof source.artifactId === 'string'
            ? { kind: 'artifact' as const, id: source.artifactId } : undefined;
        },
        inputSchema: id === 'template.instantiate' ? instantiateReviewSchema : updateReviewSchema },
    } : {}),
    sideEffectClass: id === 'template.open' || id === 'template.preview' || id === 'template.export_file' || id === 'template.updates.diff' ? 'read' : 'write',
    requiredAuthority: 'account_automation', executionPlacement: id === 'template.open' ? 'client' : 'account', placements: [],
    ...(isBotTemplatePluginReadActionIdV1(id) ? { originalExecution: { nativePurpose: 'machine_npm_profile_acquisition' as const } } : {}),
    ...(id === 'template.release' ? {
      executionPlacements: ['account', 'client'] as const,
      executionPlacementForInput: (value: unknown) => {
        const parsed = BotTemplateActionInputSchemasV1['template.release'].safeParse(withoutClientActionInput(value));
        return parsed.success && parsed.data.share?.signedInLink === true ? 'client' as const : 'account' as const;
      },
    } : {}),
    ...(id === 'template.instantiate' ? {
      operation: { version: 1 as const, visibility: 'activity' as const, progress: 'reported' as const,
        presentation: { onStart: 'current' as const } },
      invocationServerIdForInput: (value: unknown) => {
        const parsed = BotTemplateActionInputSchemasV1['template.instantiate'].safeParse(value);
        return parsed.success ? parsed.data.creation.executionTarget?.serverId : undefined;
      },
    } : {}),
    ...(id === 'template.updates.apply' ? {
      operation: { version: 1 as const, visibility: 'activity' as const, progress: 'reported' as const,
        presentation: { onStart: 'current' as const } },
    } : {}),
    bindings: { rpcMethod: id, mcpToolName: id.replaceAll('.', '_'), voiceClientToolName: id.replaceAll('.', '_') },
    surfaces: { ui: true, cli: true, rpc: true, agent: true, mcp: true, voice: true },
    inputSchema: BotTemplateActionInputSchemasV1[id], outputSchema: BotTemplateActionOutputSchemasV1[id],
    ...(id === 'template.draft' ? { surfaceBindings: {
      agent: { inputSchema: agentDraftSchema }, mcp: { inputSchema: agentDraftSchema },
    } } : id === 'template.instantiate' ? { surfaceBindings: {
      agent: { inputSchema: BotTemplateInstantiateAgentAuthoringInputV1Schema, inputHints: agentInstantiateInputHints },
      mcp: { inputSchema: BotTemplateInstantiateAgentAuthoringInputV1Schema, inputHints: agentInstantiateInputHints },
    } } : {}),
    inputHints: { fields: [] }, cli: { acceptsServerId: true, commands: [{ path: id.split('.'), visibility: 'canonical' }] },
  })));
