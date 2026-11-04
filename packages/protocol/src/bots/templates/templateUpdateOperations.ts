import type { ActionExecutorContext, ActionExecuteFailure, ActionExecuteResult, HostReviewedChildrenPreparationV1 } from '../../actions/executor/types.js';
import { readActionFailureEnvelope } from '../../actions/executor/actionFailureEnvelope.js';
import { readRecord } from '../../inputs/inputRecords.js';
import { projectNativeJsonValueForTransport, sameStrictJsonValue } from '../../json/strictJsonValue.js';
import { compareThreeWayTextV1, resolveThreeWayTextV1 } from '../../diff/threeWayText.js';
import { SessionPromptStackV1StoredSchema } from '../../sessions/context/sessionContextV1.js';
import { readSessionCapabilitySelectionFromMetadataV1 } from '../../reach/sessionCapabilityMetadataV1.js';
import { readSessionCapabilityOverrideV1 } from '../../reach/sessionCapabilitySelectionV1.js';
import { SKILL_ACTION_OUTPUT_SCHEMAS_V1 } from '../../prompts/library/skills/skillActionSchemasV1.js';
import { compareSkillUpdateFilesV1 } from '../../prompts/library/skills/skillUpdateFilesV1.js';
import { decodeBase64 } from '../../crypto/base64.js';
import { readSkillFrontmatterV1 } from '../../prompts/library/skills/skillLibraryItemV1.js';
import { PromptDocReadResultV1Schema } from '../../prompts/library/promptDocV2.js';
import { ConnectedServiceBindingsV2IngressSchema } from '../../connect/connectedServiceBindings.js';
import { MachineSetupPlanResultV1Schema, MachineSetupApplyResultV1Schema, machineSetupApplyTargetFromPlanV1,
  buildMachineSetupTargetApplyInput } from '../../machines/managed/actionsV1.js';
import { BotTemplateUpdateApplyInputV1Schema, BotTemplateUpdateDiffInputV1Schema, BotTemplateUpdateDiffResultV1Schema,
  BotTemplateUpdateSkipInputV1Schema, BotTemplateFollowStopInputV1Schema, readBotTemplateUpdateOfferV1,
  type BotTemplateUpdateDiffResultV1 } from './templateUpdateActionsV1.js';
import { readBotTemplateInstanceV1, type BotTemplateInstanceV1 } from './templateInstanceV1.js';
import type { BotTemplatePreviewResultV1 } from './botTemplateActionsV1.js';
import { readBotTemplateArtifactV1, projectBotTemplateArtifactHeaderV1, type BotTemplateReleaseV1 } from './botTemplateV1.js';
import type { BotTemplateOperationPortV1 } from './botTemplateOperations.js';
import { applyBotTemplateMcpSetupV1, prepareBotTemplateSetupV1, buildBotTemplateMachineSetupPlanInputV1 } from './templateSetupV1.js';
import { bestEffortReportBotTemplateAcceptedVersionV1 } from './templateAcceptedVersionsV1.js';

const fail = (code: string): never => { throw Object.assign(new Error(code), { code }); };
function failure(error: unknown): ActionExecuteFailure {
  const observed = readActionFailureEnvelope(error);
  if (observed) return observed;
  const record = readRecord(error);
  const code = typeof record.code === 'string' ? record.code : 'template_update_failed';
  return { ok: false, errorCode: code, error: code };
}
async function readInstance(port: BotTemplateOperationPortV1, ref: { serverId: string; sessionId: string }, context: ActionExecutorContext) {
  const recipient = port.recipient ?? fail('unsupported_action');
  const snapshot = await recipient.readSession(ref, context);
  const instance = readBotTemplateInstanceV1(readRecord(snapshot.metadata.work).templateInstance) ?? fail('template_instance_unavailable');
  return { recipient, snapshot, instance };
}
function changedNeeds(base: BotTemplateReleaseV1, upstream: BotTemplateReleaseV1): BotTemplateReleaseV1['content']['needs'] {
  const changed = <T extends { key: string }>(before: readonly T[], next: readonly T[]) => {
    const byKey = new Map(before.map(need => [need.key, need]));
    return next.filter(need => !sameStrictJsonValue(byKey.get(need.key), need));
  };
  return { software: changed(base.content.needs.software, upstream.content.needs.software),
    connectedAccounts: changed(base.content.needs.connectedAccounts, upstream.content.needs.connectedAccounts),
    mcpServers: changed(base.content.needs.mcpServers, upstream.content.needs.mcpServers) };
}

/** A demanded review opens only the accepted release and bound recipient resources. Memory is never loaded. */
export async function readBotTemplateUpdateDiffV1(port: BotTemplateOperationPortV1, input: unknown, context: ActionExecutorContext,
  resolve: (source: BotTemplateInstanceV1['source'], context: ActionExecutorContext) => Promise<BotTemplatePreviewResultV1>,
  opened?: Awaited<ReturnType<typeof readInstance>>): Promise<BotTemplateUpdateDiffResultV1> {
  const { sessionRef } = BotTemplateUpdateDiffInputV1Schema.parse(input);
  const { recipient, snapshot, instance } = opened ?? await readInstance(port, sessionRef, context);
  const stored = await port.artifacts.read(instance.acceptedBase.artifactId, { signal: context.signal });
  const accepted = stored ? readBotTemplateArtifactV1(stored) : null;
  if (!accepted || accepted.state !== 'released' || accepted.release.version !== instance.acceptedVersion) return fail('template_base_unavailable');
  const upstream = await resolve(instance.source, context);
  const stack = SessionPromptStackV1StoredSchema.parse(readRecord(snapshot.metadata.work).promptStack ?? []);
  const instructionRef = stack.find(entry => entry.id === 'session.instructions')?.ref;
  let instructions: BotTemplateUpdateDiffResultV1['instructions'] = null;
  if (instructionRef?.kind === 'doc') {
    const get = recipient.content?.promptDocGet ?? fail('unsupported_action');
    const raw = await get({ artifactId: instructionRef.artifactId, signal: context.signal });
    const refused = readActionFailureEnvelope(raw); if (refused) throw refused;
    if (readRecord(raw).ok === false) return fail('prompt_doc_unavailable');
    const doc = PromptDocReadResultV1Schema.parse(raw);
    instructions = { ref: { serverId: instructionRef.serverId ?? sessionRef.serverId, artifactId: instructionRef.artifactId }, title: doc.title, revision: doc.revision,
      comparison: compareThreeWayTextV1(accepted.release.content.instructions.markdown, doc.markdown, upstream.release.content.instructions.markdown) };
  }
  const baseSkills = new Map(accepted.release.content.skills.map(skill => [skill.key, skill]));
  const nextSkills = new Map(upstream.release.content.skills.map(skill => [skill.key, skill]));
  const keys = [...new Set([...baseSkills.keys(), ...nextSkills.keys()])];
  const skills: BotTemplateUpdateDiffResultV1['skills'] = [];
  const capabilitySelection = readSessionCapabilitySelectionFromMetadataV1(snapshot.metadata);
  for (const key of keys) {
    const before = baseSkills.get(key); const next = nextSkills.get(key); const skillId = instance.skillIds[key];
    const title = next?.title ?? before!.title;
    if (skillId && readSessionCapabilityOverrideV1(capabilitySelection, 'skill', skillId) === 'off') {
      skills.push({ key, title, status: 'deleted', canTake: Boolean(next), files: compareSkillUpdateFilesV1([], next?.entries ?? [], before?.entries ?? []) });
      continue;
    }
    if (!skillId) {
      skills.push({ key, title, status: before ? 'deleted' : 'added', canTake: Boolean(next), files: compareSkillUpdateFilesV1([], next?.entries ?? [], before?.entries ?? []) });
      continue;
    }
    const execute = recipient.content?.skillActionExecute ?? fail('unsupported_action');
    const diff = await execute({ actionId: 'skills.updates.diff', input: { skillId,
      candidate: { baseFiles: before?.entries ?? [], files: next?.entries ?? [] } }, context });
    const refused = readActionFailureEnvelope(diff); if (refused) throw refused;
    const raw = readRecord(diff);
    if (raw.ok === false && raw.code === 'not_found') {
      skills.push({ key, title, status: 'deleted', canTake: Boolean(next), files: compareSkillUpdateFilesV1([], next?.entries ?? [], before?.entries ?? []) });
      continue;
    }
    if (raw.ok === false) return fail(typeof raw.code === 'string' ? raw.code : 'skill_content_unavailable');
    const result = SKILL_ACTION_OUTPUT_SCHEMAS_V1['skills.updates.diff'].parse(diff);
    skills.push({ key, title, skillId, revision: result.revision, canTake: Boolean(next), status: next ? 'existing' : 'removed', files: result.files });
  }
  return BotTemplateUpdateDiffResultV1Schema.parse({ sessionRef, metadataRevision: snapshot.revision, instance,
    ...(snapshot.executionTarget ? { executionTarget: snapshot.executionTarget } : {}),
    ...(snapshot.metadata.connectedServices ? { connectedServices: ConnectedServiceBindingsV2IngressSchema.parse(snapshot.metadata.connectedServices) } : {}),
    offer: readBotTemplateUpdateOfferV1(instance, upstream.release.version), upstream, instructions, skills,
    needs: changedNeeds(accepted.release, upstream.release) });
}

/** Private follow intent is a targeted CAS, with no release, content or credential reads. */
export async function mutateBotTemplateFollowV1(port: BotTemplateOperationPortV1, actionId: 'template.updates.skip' | 'template.follow.stop', input: unknown,
  context: ActionExecutorContext) {
  const skip = actionId === 'template.updates.skip' ? BotTemplateUpdateSkipInputV1Schema.parse(input) : undefined;
  const parsed = skip ?? BotTemplateFollowStopInputV1Schema.parse(input);
  const { recipient, instance } = await readInstance(port, parsed.sessionRef, context);
  const next: BotTemplateInstanceV1 = skip ? { ...instance, skippedVersion: skip.version } : { ...instance, follow: false };
  if (sameStrictJsonValue(instance, next)) return { instance, changed: false };
  if (!recipient.updateInstance) return fail('unsupported_action');
  await recipient.updateInstance(parsed.sessionRef, next, instance, context);
  return { instance: next, changed: true };
}

/** Admission captures one review; selected owner writes retain their existing revision checks. */
export async function prepareBotTemplateUpdateV1(port: BotTemplateOperationPortV1,
  request: Readonly<{ input: unknown; context: ActionExecutorContext }>,
  resolve: (source: BotTemplateInstanceV1['source'], context: ActionExecutorContext) => Promise<BotTemplatePreviewResultV1>): Promise<HostReviewedChildrenPreparationV1 | ActionExecuteFailure> {
  try {
    const input = BotTemplateUpdateApplyInputV1Schema.parse(request.input);
    const opened = await readInstance(port, input.sessionRef, request.context);
    let requesterContext = opened.recipient.prepareUpdateRequesterAdmission
      ? await opened.recipient.prepareUpdateRequesterAdmission({ input, context: request.context,
        executionTarget: opened.snapshot.executionTarget }) : request.context;
    const review = await readBotTemplateUpdateDiffV1(port, { sessionRef: input.sessionRef }, requesterContext, resolve, opened);
    if (review.offer !== 'available' && review.offer !== 'skipped') return fail('version_mismatch');
    if (review.upstream.release.version !== input.expectedVersion || review.metadataRevision !== input.expectedMetadataRevision
      || review.instance.source.kind === 'artifact' && !input.expectedRevision
      || input.expectedRevision && !sameStrictJsonValue(input.expectedRevision, review.upstream.revision)) return fail('version_mismatch');
    if (input.instructions && (!review.instructions || !sameStrictJsonValue(input.instructions.expectedRevision, review.instructions.revision))) return fail('revision_conflict');
    for (const [key, selection] of Object.entries(input.skills ?? {})) {
      const skill = review.skills.find(skill => skill.key === key) ?? fail('invalid_request');
      if (selection.choice === 'take' && !skill.canTake || selection.choice === 'remove' && skill.status !== 'removed') return fail('invalid_request');
      if (selection.expectedRevision && selection.expectedRevision !== skill.revision) return fail('revision_conflict');
      if (skill.skillId && (selection.choice === 'take' || selection.choice === 'remove') && !selection.expectedRevision) return fail('revision_conflict');
    }
    const createsSkill = (skill: BotTemplateUpdateDiffResultV1['skills'][number]) => skill.canTake && (skill.status === 'added' || skill.status === 'deleted');
    if (Object.keys(input.recovery?.skillIds ?? {}).some(key => !review.skills.some(skill => skill.key === key && createsSkill(skill)))) return fail('invalid_request');
    if (input.recovery?.acceptedBaseId) {
      const stored = await port.artifacts.read(input.recovery.acceptedBaseId, { signal: requesterContext.signal });
      const recovered = stored?.access === 'owner' ? readBotTemplateArtifactV1(stored) : null;
      if (!recovered || recovered.state !== 'released' || !sameStrictJsonValue(recovered.release, review.upstream.release)) return fail('invalid_request');
    }
    const setup = prepareBotTemplateSetupV1(review.needs, input.setup);
    // The common setup owners are attached by the admitted host below; never silently ignore selected effects.
    if ((setup.machineSetup || setup.connectedServices) && !review.executionTarget) return fail('machine_target_unavailable');
    if (setup.machineSetup && !requesterContext.serverIdentityId) return fail('server_identity_unavailable');
    const setupTarget = review.executionTarget && requesterContext.serverIdentityId
      ? { homeId: requesterContext.serverIdentityId, machineId: review.executionTarget.machineId } : undefined;
    let setupPlan: ReturnType<typeof MachineSetupPlanResultV1Schema.parse> | undefined;
    if (setup.machineSetup && setupTarget) {
      const planInput = buildBotTemplateMachineSetupPlanInputV1(setupTarget, setup.machineSetup);
      if (opened.recipient.prepareUpdateRequesterAdmission) requesterContext = await opened.recipient.prepareUpdateRequesterAdmission({
        input, context: requesterContext, executionTarget: review.executionTarget,
        machineSetup: setup.machineSetup, machineSetupPlanInput: planInput });
      const plan = port.recipient?.content?.machineSetupPlan ?? fail('unsupported_action');
      const result = await plan({ input: planInput, context: requesterContext, signal: requesterContext.signal });
      const refused = readActionFailureEnvelope(result); if (refused) throw refused;
      setupPlan = MachineSetupPlanResultV1Schema.parse(result);
      if (!setupPlan.recipePlans) return fail('invalid_action_output');
    }
    const setupApply = setupPlan && setupTarget ? buildMachineSetupTargetApplyInput(machineSetupApplyTargetFromPlanV1(setupTarget, setupPlan)) : undefined;
    if (Object.keys(input.recovery?.mcpServerIds ?? {}).some(key => !setup.mcp.some(item => item.key === key))) return fail('invalid_request');
    const children: HostReviewedChildrenPreparationV1['children'] = [
      ...(input.instructions && review.instructions ? [{ action: 'prompt_doc.update' as const, role: 'update_instructions' }] : []),
      ...review.skills.flatMap((skill): HostReviewedChildrenPreparationV1['children'] => {
        const choice = input.skills?.[skill.key]?.choice;
        if (!choice || choice === 'skip' || choice === 'keep' || skill.status === 'deleted' && !skill.canTake) return [];
        if (createsSkill(skill)) return [{ action: 'skills.create' as const, role: `skill:${skill.key}` },
          ...(input.recovery?.skillIds[skill.key] ? [{ action: 'session.capabilities.set' as const, role: `recover_skill:${skill.key}` }] : [])];
        if (skill.status === 'removed') return choice === 'remove' ? [{ action: 'session.capabilities.set' as const, role: `skill:${skill.key}` }] : [];
        return [{ action: 'skills.updates.apply' as const, role: `skill:${skill.key}` }];
      }),
      ...(input.takeIdentity ? [{ action: 'session.title.set' as const, role: 'update_title' }, { action: 'session.bot.face.set' as const, role: 'update_face' }] : []),
      ...(setup.mcp.length ? [{ action: 'mcp.servers.list' as const, role: 'template_mcp_catalog' },
        { action: 'mcp.servers.create' as const, role: 'create_template_mcp' },
        ...setup.mcp.filter(item => review.instance.mcpServerIds[item.key]).map(item => ({ action: 'mcp.servers.update' as const, role: `update_template_mcp:${item.key}` })),
        ...setup.mcp.map(item => ({ action: 'session.capabilities.set' as const, role: `template_mcp:${item.key}` }))] : []),
      ...(setupApply ? [{ action: 'machines.setup.apply' as const, role: 'template_setup_apply', input: projectNativeJsonValueForTransport(setupApply) }] : []),
      ...(setup.connectedServices ? [{ action: 'session.connected_services_auth.set' as const, role: 'template_accounts' }] : []),
    ];
    return { children, approvalPreview: projectNativeJsonValueForTransport({ ...review, ...(setupPlan ? { softwarePlan: setupPlan } : {}) }), executeAdmittedAction: async ({ context }) => {
      const execute = async (context: ActionExecutorContext): Promise<ActionExecuteResult> => {
        const applied: string[] = []; const kept: string[] = []; const resourceIds: string[] = [];
        const skillIds = { ...review.instance.skillIds, ...input.recovery?.skillIds };
        const mcpServerIds = { ...review.instance.mcpServerIds, ...input.recovery?.mcpServerIds };
        const createdSkillIds = { ...input.recovery?.skillIds };
        const createdMcpServerIds = { ...input.recovery?.mcpServerIds };
        let acceptedBaseId = input.recovery?.acceptedBaseId;
        const remaining = [...(input.instructions ? ['instructions'] : []), ...review.skills.map(skill => `skill:${skill.key}`),
          ...(input.takeIdentity ? ['identity'] : []), ...setup.mcp.map(item => `mcp:${item.key}`),
          ...(setup.machineSetup ? ['software'] : []), ...(setup.connectedServices ? ['accounts'] : []), 'settlement'];
        const invoke = async (action: HostReviewedChildrenPreparationV1['children'][number]['action'], role: string, value: unknown,
          invocationServices?: Parameters<NonNullable<ActionExecutorContext['hostReviewedChild']>['invoke']>[0]['invocationServices']) => {
          context.signal?.throwIfAborted(); if (!context.hostReviewedChild) return fail('admission_unavailable');
          const result = await context.hostReviewedChild.invoke({ action, role, input: projectNativeJsonValueForTransport(value), ...(invocationServices ? { invocationServices } : {}) });
          if (!result.ok) throw result;
          const refused = readActionFailureEnvelope(result.result); if (refused) throw refused;
          const raw = readRecord(result.result); if (raw.ok === false) return fail(typeof raw.code === 'string' ? raw.code : 'invalid_action_output');
          return result.result;
        };
        try {
          const { release } = review.upstream;
          if (setup.connectedServices && review.executionTarget) {
            context.operationProgress?.update({ phase: 'connections' });
            await invoke('session.connected_services_auth.set', 'template_accounts', {
              ...input.sessionRef, ...review.executionTarget,
              bindings: { v: 2, bindingsByServiceId: { ...review.connectedServices?.bindingsByServiceId, ...setup.connectedServices.bindingsByServiceId } } });
            applied.push('accounts'); remaining.splice(remaining.indexOf('accounts'), 1);
          }
          context.operationProgress?.update({ phase: 'content' });
          if (input.instructions && review.instructions) {
            const markdown = input.instructions.markdown ?? resolveThreeWayTextV1(review.instructions.comparison, input.instructions.choices);
            const mine = resolveThreeWayTextV1({ ...review.instructions.comparison, segments: review.instructions.comparison.segments.map(segment => ({ ...segment, kind: 'mine' })) });
            if (markdown !== mine) {
              await invoke('prompt_doc.update', 'update_instructions', { artifactId: review.instructions.ref.artifactId,
                expectedRevision: input.instructions.expectedRevision, title: review.instructions.title, markdown });
              applied.push('instructions');
            } else kept.push('instructions');
            remaining.splice(remaining.indexOf('instructions'), 1);
          }
          for (const skill of review.skills) {
            const selection = input.skills?.[skill.key];
            const key = `skill:${skill.key}`;
            if (!selection || selection.choice === 'keep' || selection.choice === 'skip' || skill.status === 'deleted' && !skill.canTake
              || skill.status === 'removed' && selection?.choice !== 'remove') { kept.push(key); remaining.splice(remaining.indexOf(key), 1); continue; }
            const next = release.content.skills.find(item => item.key === skill.key);
            if (createsSkill(skill)) {
              if (!createdSkillIds[skill.key]) {
                const entry = next!.entries.find(file => file.path === 'SKILL.md')!;
                const name = readSkillFrontmatterV1(new TextDecoder().decode(decodeBase64(entry.contentBase64, 'base64'))).name ?? fail('invalid_skill_name');
                const result = SKILL_ACTION_OUTPUT_SCHEMAS_V1['skills.create'].parse(await invoke('skills.create', key, { name, files: next!.entries }, { templateSkillSessionId: input.sessionRef.sessionId }));
                skillIds[skill.key] = result.skillId; createdSkillIds[skill.key] = result.skillId; resourceIds.push(result.skillId);
                if (result.incomplete || result.includedInSessionId !== input.sessionRef.sessionId) return fail('skill_content_unavailable');
              } else {
                await invoke('session.capabilities.set', `recover_skill:${skill.key}`, {
                  sessionId: input.sessionRef.sessionId, kind: 'skill', id: skillIds[skill.key], state: 'on' });
              }
              applied.push(key);
            } else if (skill.status === 'removed') {
              await invoke('session.capabilities.set', key, { sessionId: input.sessionRef.sessionId, kind: 'skill', id: skill.skillId, state: 'off' });
              delete skillIds[skill.key]; applied.push(key);
            } else {
              const result = SKILL_ACTION_OUTPUT_SCHEMAS_V1['skills.updates.apply'].parse(await invoke('skills.updates.apply', key, { skillId: skill.skillId, expectedRevision: selection.expectedRevision,
                candidate: { baseFiles: skill.files.flatMap(file => file.base ? [file.base] : []), files: next!.entries },
                ...(selection.choices ? { choices: selection.choices } : {}), ...(selection.hunkChoices ? { hunkChoices: selection.hunkChoices } : {}) }));
              (result.revision === skill.revision ? kept : applied).push(key);
            }
            remaining.splice(remaining.indexOf(key), 1);
          }
          if (input.takeIdentity) {
            await invoke('session.title.set', 'update_title', { ...input.sessionRef, title: release.content.identity.name });
            await invoke('session.bot.face.set', 'update_face', { ...input.sessionRef, face: release.content.identity.face ?? null });
            applied.push('identity');
            remaining.splice(remaining.indexOf('identity'), 1);
          }
          if (setup.mcp.length) {
            context.operationProgress?.update({ phase: 'setup' });
            const ids = await applyBotTemplateMcpSetupV1({ mcp: setup.mcp, sessionId: input.sessionRef.sessionId,
              invoke, randomId: port.randomId, nowMs: port.nowMs ?? Date.now, recoveryIds: input.recovery?.mcpServerIds,
              existingIds: review.instance.mcpServerIds,
              onCreated: ids => {
                for (const [key, id] of Object.entries(ids)) {
                  mcpServerIds[key] = id;
                  createdMcpServerIds[key] = id; resourceIds.push(id);
                }
              }, onIncluded: key => { const resource = `mcp:${key}`; applied.push(resource); remaining.splice(remaining.indexOf(resource), 1); } });
            Object.assign(mcpServerIds, ids);
          }
          if (setupApply) {
            context.operationProgress?.update({ phase: 'setup' });
            // Setup apply's ordinary promise settles its workflow; operationId is its settled receipt.
            MachineSetupApplyResultV1Schema.parse(await invoke('machines.setup.apply', 'template_setup_apply',
              setupApply));
            applied.push('software'); remaining.splice(remaining.indexOf('software'), 1);
          }
          context.operationProgress?.update({ phase: 'settlement' });
          if (!acceptedBaseId) {
            const baseId = port.randomId();
            const envelope = { v: 1 as const, state: 'released' as const, release };
            await port.artifacts.create({ artifactId: baseId, header: projectBotTemplateArtifactHeaderV1(envelope), body: JSON.stringify(envelope), savedBy: null, signal: context.signal });
            acceptedBaseId = baseId;
            resourceIds.push(baseId);
          }
          const { skippedVersion: _skipped, ...previous } = review.instance;
          const nextInstance = { ...previous, source: review.upstream.source, acceptedVersion: release.version,
            acceptedBase: { serverId: input.sessionRef.serverId, artifactId: acceptedBaseId }, skillIds, mcpServerIds };
          const recipient = port.recipient!; if (!recipient.updateInstance) return fail('unsupported_action');
          await recipient.updateInstance(input.sessionRef, nextInstance, review.instance, context);
          await bestEffortReportBotTemplateAcceptedVersionV1(recipient, { instance: nextInstance, copyId: input.sessionRef.sessionId }, context);
          // The private base is a replaceable accepted release, rather than a release-history store.
          if (port.artifacts.delete) {
            try { await port.artifacts.delete(review.instance.acceptedBase.artifactId, { signal: context.signal }); } catch { /* Settlement already succeeded. */ }
          }
          remaining.pop();
          return { ok: true, result: { acceptedVersion: release.version, applied, kept, resourceIds } };
        } catch (error) { return { ...failure(error), details: { applied, remaining, resourceIds, skillIds: createdSkillIds, mcpServerIds: createdMcpServerIds,
          ...(acceptedBaseId ? { acceptedBaseId } : {}) } }; }
      };
      const run = context.runActionOperation ?? request.context.runActionOperation;
      return run ? run({ actionId: 'template.updates.apply', input, context, execute }) : execute(context);
    } };
  } catch (error) { return failure(error); }
}
