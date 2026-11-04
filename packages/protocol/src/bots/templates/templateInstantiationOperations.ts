import type { ActionExecutorContext, ActionExecutorDeps, ActionExecuteFailure, ActionExecuteResult, HostReviewedChildrenPreparationV1 } from '../../actions/executor/types.js';
import { readRecord } from '../../inputs/inputRecords.js';
import { projectNativeJsonValueForTransport, sameStrictJsonValue } from '../../json/strictJsonValue.js';
import { readActionFailureEnvelope } from '../../actions/executor/actionFailureEnvelope.js';
import { SKILL_ACTION_OUTPUT_SCHEMAS_V1 } from '../../prompts/library/skills/skillActionSchemasV1.js';
import { MemoryMutationResultV1Schema } from '../../prompts/library/memoryActionsV1.js';
import { readSkillFrontmatterV1 } from '../../prompts/library/skills/skillLibraryItemV1.js';
import { decodeBase64 } from '../../crypto/base64.js';
import { SessionSpawnNewActionInputV2Schema } from '../../sessions/creation/sessionSpawnNewInputV2.js';
import { readBotTemplateInstanceV1, type BotTemplateInstanceV1 } from './templateInstanceV1.js';
import { projectBotTemplateArtifactHeaderV1, type BotTemplateRequesterAuthorshipV1 } from './botTemplateV1.js';
import { BotTemplateInstantiateInputV1Schema, type BotTemplateInstantiateInputV1, type BotTemplatePreviewResultV1 } from './botTemplateActionsV1.js';
import type { BotTemplateOperationPortV1 } from './botTemplateOperations.js';
import { prepareBotTemplateSetupV1, applyBotTemplateMcpSetupV1, buildBotTemplateMachineSetupPlanInputV1 } from './templateSetupV1.js';
import type { MachineSetupV1 } from '../../machines/managed/machineSetupV1.js';
import type { MachineSetupPlanInputV1 } from '../../machines/managed/actionsV1.js';
import { bestEffortReportBotTemplateAcceptedVersionV1 } from './templateAcceptedVersionsV1.js';
import type { BotTemplateAcceptedVersionReporterV1 } from './templateAcceptedVersionsV1.js';
import type { BotTemplateUpdateApplyInputV1 } from './templateUpdateActionsV1.js';

export type BotTemplateRecipientPortV1 = BotTemplateAcceptedVersionReporterV1 & Readonly<{
  readSession(ref: Readonly<{ serverId: string; sessionId: string }>, context: ActionExecutorContext): Promise<Readonly<{
    metadata: Readonly<Record<string, unknown>>; revision: number;
    executionTarget?: Readonly<{ machineId: string; agentId: string }>;
  }>>;
  /** The registered private field writer preserves concurrent Session fields and expects an absent instance. */
  writeInstance(ref: Readonly<{ serverId: string; sessionId: string }>, instance: BotTemplateInstanceV1,
    context: ActionExecutorContext): Promise<void>;
  updateInstance?(ref: Readonly<{ serverId: string; sessionId: string }>, instance: BotTemplateInstanceV1,
    expectedInstance: BotTemplateInstanceV1, context: ActionExecutorContext): Promise<void>;
  /** Enrich the admitted root with source-owned authorship and resolved setup. */
  prepareRequesterAdmission?(request: Readonly<{ input: BotTemplateInstantiateInputV1; context: ActionExecutorContext;
    requesterAuthorship?: BotTemplateRequesterAuthorshipV1;
    machineSetup?: MachineSetupV1; machineSetupPlanInput?: MachineSetupPlanInputV1 }>): Promise<ActionExecutorContext>;
  /** The owned Session target admits the requester before any base/source/content read. */
  prepareUpdateRequesterAdmission?(request: Readonly<{ input: BotTemplateUpdateApplyInputV1; context: ActionExecutorContext;
    requesterAuthorship?: BotTemplateRequesterAuthorshipV1;
    executionTarget?: Readonly<{ machineId: string; agentId: string }>;
    machineSetup?: MachineSetupV1; machineSetupPlanInput?: MachineSetupPlanInputV1 }>): Promise<ActionExecutorContext>;
  content?: Pick<ActionExecutorDeps, 'promptDocGet' | 'skillActionExecute' | 'machineSetupPlan'>;
}>;
const fail = (code: string): never => { throw Object.assign(new Error(code), { code }); };
/** The live link supplies one release without granting future reads of its source. */
export type BotTemplateLiveCopyReleaseV1 = BotTemplatePreviewResultV1 & Readonly<{
  follow: false; reportAcceptedVersion: false;
}>;
function failure(error: unknown): ActionExecuteFailure {
  const observed = readActionFailureEnvelope(error);
  if (observed) return observed;
  const code = readRecord(error).code;
  const errorCode = typeof code === 'string' ? code : 'template_instantiation_failed';
  return { ok: false, errorCode, error: errorCode };
}

/** Invocation-local admitted release; only the existing reviewed-child owner dispatches effects. */
export async function prepareBotTemplateInstantiationV1(port: BotTemplateOperationPortV1,
  request: Readonly<{ input: unknown; context: ActionExecutorContext }>,
  resolve: () => Promise<BotTemplatePreviewResultV1 | BotTemplateLiveCopyReleaseV1>): Promise<HostReviewedChildrenPreparationV1 | ActionExecuteFailure> {
  try {
    const input = BotTemplateInstantiateInputV1Schema.parse(request.input);
    if (!port.recipient) return fail('unsupported_action');
    const recipient = port.recipient;
    const resolved = await resolve();
    if (!sameStrictJsonValue(input.source, resolved.source)) return fail('invalid_request');
    const follow = 'follow' in resolved ? resolved.follow : true;
    const reportAcceptedVersion = !('reportAcceptedVersion' in resolved) || resolved.reportAcceptedVersion;
    if (resolved.release.version !== input.expectedVersion || input.source.kind === 'artifact' && !input.expectedRevision
      || input.expectedRevision && !sameStrictJsonValue(input.expectedRevision, resolved.revision)) return fail('version_mismatch');
    const { creation } = input;
    if (!creation.creationKey || creation.environmentVariables !== undefined || creation.initialInput || creation.initialTriggers?.length || creation.sourceContext
      || creation.discussionParticipant || creation.managedCreation || creation.attestedContext
      || creation.agentSessionStartupInstructionsV1) return fail('invalid_request');
    const { content } = resolved.release;
    const setup = prepareBotTemplateSetupV1(content.needs, input.setup);
    const serverId = creation.executionTarget.serverId;
    if (!serverId || request.context.serverId && !port.isSameServerId?.(request.context.serverId, serverId)
      && request.context.serverId !== serverId) return fail('server_scope_mismatch');
    const machineSetupPlanInput = setup.machineSetup ? buildBotTemplateMachineSetupPlanInputV1(
      { homeId: serverId, machineId: creation.executionTarget.machineId }, setup.machineSetup) : undefined;
    // The parent settles after content and launch; a child-only early receipt cannot settle it.
    const { observeSessionCommit: _observeSessionCommit, ...creationSelection } = creation;
    const spawnInput = SessionSpawnNewActionInputV2Schema.parse({ ...creationSelection,
      ...(setup.connectedServices ? { connectedServices: setup.connectedServices } : {}),
      title: input.name ?? content.identity.name,
      identity: { bot: { kind: 'bot' }, createdAsBot: true, ...(input.face ?? content.identity.face ? { botFace: input.face ?? content.identity.face } : {}) } });
    const children: HostReviewedChildrenPreparationV1['children'] = [
      { action: 'session.spawn_new', role: 'create_bot', input: projectNativeJsonValueForTransport(spawnInput) },
      { action: 'prompt_doc.create', role: 'create_instructions' },
      { action: 'session.instructions.set', role: 'attach_instructions' },
      ...content.memoryRules.map(rule => ({ action: 'memory.remember' as const, role: `memory:${rule.key}` })),
      ...content.skills.map(skill => ({ action: 'skills.create' as const, role: `skill:${skill.key}` })),
      ...(setup.machineSetup ? [
        { action: 'machines.setup.plan' as const, role: 'template_setup_plan' },
        { action: 'machines.setup.apply' as const, role: 'template_setup_apply' },
      ] : []),
      ...(setup.mcp.length ? [
        { action: 'mcp.servers.list' as const, role: 'template_mcp_catalog' },
        { action: 'mcp.servers.create' as const, role: 'create_template_mcp' },
        ...setup.mcp.map(item => ({ action: 'session.capabilities.set' as const, role: `template_mcp:${item.key}` })),
      ] : []),
    ];
    const prepareRequesterAdmission = recipient.prepareRequesterAdmission;
    return { children, approvalPreview: projectNativeJsonValueForTransport(resolved),
      ...(prepareRequesterAdmission ? { prepareExecutionContext: (context: ActionExecutorContext) => prepareRequesterAdmission({ input, context,
        ...(resolved.requesterAuthorship ? { requesterAuthorship: resolved.requesterAuthorship } : {}),
        ...(setup.machineSetup ? { machineSetup: setup.machineSetup } : {}), ...(machineSetupPlanInput ? { machineSetupPlanInput } : {}) }) } : {}),
      executeAdmittedAction: async ({ context }) => {
        const execute = async (context: ActionExecutorContext): Promise<ActionExecuteResult> => {
        let knownSessionId: string | undefined;
        let contentFailure: { error: unknown } | undefined;
        let acceptedInstance: BotTemplateInstanceV1 | undefined;
        const resourceIds: string[] = [];
        try {
          const invoke = async (action: typeof children[number]['action'], role: string, value: unknown,
            invocationServices?: Parameters<NonNullable<typeof context.hostReviewedChild>['invoke']>[0]['invocationServices']) => {
            context.signal?.throwIfAborted();
            if (!context.hostReviewedChild) return fail('admission_unavailable');
            const result = await context.hostReviewedChild.invoke({ action, role, input: projectNativeJsonValueForTransport(value),
              ...(invocationServices ? { invocationServices } : {}) });
            if (!result.ok) throw result;
            const failed = readActionFailureEnvelope(result.result);
            if (failed) throw failed;
            return result.result;
          };
          const result = await invoke('session.spawn_new', 'create_bot', spawnInput, { sessionCreation: {
            ...(setup.machineSetup ? { machineSetup: setup.machineSetup } : {}),
            ...(machineSetupPlanInput ? { machineSetupPlanInput } : {}),
            hostOnboarding: { templateName: content.identity.name, templateVersion: resolved.release.version,
              ...(content.firstTask === undefined ? {} : { firstTask: content.firstTask }) },
            beforeLaunch: async birth => {
              try {
              knownSessionId = birth.sessionId;
              const ref = { serverId, sessionId: birth.sessionId };
              context.operationProgress?.update({ phase: 'content' });
              const snapshot = await recipient.readSession(ref, context);
              const existing = readBotTemplateInstanceV1(readRecord(snapshot.metadata.work).templateInstance);
              if (existing) {
                if (existing.acceptedVersion !== resolved.release.version || !sameStrictJsonValue(existing.source, resolved.source)) return fail('creation_conflict');
                acceptedInstance = existing; return;
              }
              const instructions = readRecord(await invoke('prompt_doc.create', 'create_instructions', {
                title: `${spawnInput.title} instructions`, markdown: content.instructions.markdown,
              }));
              if (typeof instructions.artifactId !== 'string') return fail('invalid_action_output');
              resourceIds.push(instructions.artifactId);
              const attached = readRecord(await invoke('session.instructions.set', 'attach_instructions', { ...ref,
                expectedMetadataRevision: snapshot.revision, ref: { kind: 'doc', serverId, artifactId: instructions.artifactId } }));
              let memoryTarget: { ref: NonNullable<ReturnType<typeof MemoryMutationResultV1Schema.parse>['ref']>;
                expectedRevision: NonNullable<ReturnType<typeof MemoryMutationResultV1Schema.parse>['revision']> } | undefined;
              for (const rule of content.memoryRules) {
                if (!memoryTarget && typeof attached.version !== 'number') return fail('invalid_action_output');
                const remembered = MemoryMutationResultV1Schema.parse(await invoke('memory.remember', `memory:${rule.key}`, {
                  ...(memoryTarget ?? { sessionRef: ref, expectedMetadataRevision: attached.version }),
                  text: rule.text, ...(rule.topic === undefined ? {} : { topic: rule.topic }),
                }));
                resourceIds.push(remembered.artifactId);
                if (remembered.attachment === 'conflict' || remembered.attachmentFailure) return fail('memory_target_unavailable');
                if (remembered.ref && remembered.revision) memoryTarget = { ref: remembered.ref, expectedRevision: remembered.revision };
                else if (content.memoryRules.at(-1) !== rule) return fail('invalid_action_output');
              }
              const skillIds: Record<string, string> = {};
              for (const skill of content.skills) {
                const entry = skill.entries.find(file => file.path === 'SKILL.md');
                const name = entry && readSkillFrontmatterV1(new TextDecoder().decode(decodeBase64(entry.contentBase64, 'base64'))).name;
                if (!name) return fail('invalid_skill_name');
                const created = SKILL_ACTION_OUTPUT_SCHEMAS_V1['skills.create'].parse(await invoke('skills.create', `skill:${skill.key}`,
                  { name, files: skill.entries }, { templateSkillSessionId: birth.sessionId }));
                resourceIds.push(created.skillId);
                if (!created.ok || created.incomplete || created.includedInSessionId !== birth.sessionId) return fail('skill_content_unavailable');
                skillIds[skill.key] = created.skillId;
              }
              const mcpServerIds = await applyBotTemplateMcpSetupV1({ mcp: setup.mcp, sessionId: birth.sessionId,
                invoke, randomId: port.randomId, nowMs: port.nowMs ?? Date.now,
                onCreated: ids => { resourceIds.push(...Object.values(ids)); } });
              const baseId = port.randomId();
              const envelope = { v: 1 as const, state: 'released' as const, release: resolved.release };
              await port.artifacts.create({ artifactId: baseId, header: projectBotTemplateArtifactHeaderV1(envelope),
                body: JSON.stringify(envelope), savedBy: null, signal: context.signal });
              resourceIds.push(baseId);
              acceptedInstance = { v: 1, source: resolved.source, acceptedVersion: resolved.release.version,
                acceptedBase: { serverId, artifactId: baseId }, skillIds, mcpServerIds, follow };
              await recipient.writeInstance(ref, acceptedInstance, context);
              } catch (error) {
                // Ordinary creation may project callback rejection to its spawn result; retain the content failure for this parent.
                contentFailure = { error };
                throw error;
              }
            },
          } });
          if (contentFailure) throw contentFailure.error;
          if (reportAcceptedVersion && readRecord(result).type === 'success' && readRecord(readRecord(result).initialInput).status === 'notRequested'
            && knownSessionId && acceptedInstance)
            await bestEffortReportBotTemplateAcceptedVersionV1(recipient, { instance: acceptedInstance, copyId: knownSessionId }, context);
          return { ok: true, result };
        } catch (error) {
          const refused = failure(error);
          return { ...refused, ...(knownSessionId ? { details: { sessionId: knownSessionId, resourceIds } } : {}) };
        }
        };
        const runOperation = context.runActionOperation ?? request.context.runActionOperation;
        return runOperation ? runOperation({ actionId: 'template.instantiate', input, context, execute }) : execute(context);
      } };
  } catch (error) { return failure(error); }
}
