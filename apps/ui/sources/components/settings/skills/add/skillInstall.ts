import {
  SKILL_ACTION_OUTPUT_SCHEMAS_V1,
  SkillInstallAcknowledgedEffectsV1Schema,
  SkillInstallPreviewV1Schema,
  type SkillFileInputV1,
  type SkillInstallPreviewV1,
} from '@happier-dev/protocol/prompts/library/skills/skillActionSchemasV1';
import { DEFAULT_CREATE_REACH_CHANGE_V1, type ReachRulesChangeV1 } from '@happier-dev/protocol/reach/reachRulesChangeV1';
import type { RegistrySkillContentRefV1 } from '@happier-dev/protocol/registries';

import type { MountedAuthoringActionExecute } from '@/sync/ops/actions/sessionAuthoringActions';
import { readRegistryFailureStatus, type RegistryFailureStatus } from '@/registries/describeRegistrySourceStatus';
import { readReachRulesAcknowledgment } from '@/sync/domains/capabilities/reach/reachRulesAcknowledgment';
import { t } from '@/text';

export type SkillInstallSource =
  | Readonly<{
      kind: 'registry';
      sourceId: string;
      itemId: string;
      version: string;
    }>
  | Readonly<{ kind: 'link'; url: string; refs?: readonly RegistrySkillContentRefV1[] }>
  | Readonly<{ kind: 'upload'; files: readonly SkillFileInputV1[] }>;

export type SkillInstallRequest = Readonly<{
  source: SkillInstallSource;
  selectPaths?: readonly string[];
  where?: ReachRulesChangeV1;
}>;

/** Content acknowledgments and later failed steps are independent of the batch's terminal content result. */
type SkillInstallEffects = Readonly<{
      skillIds: readonly string[];
      rulesMissing: readonly string[];
      incomplete: readonly Readonly<{ skillId: string; step: 'rules' | 'session_include' }>[];
}>;
export type SkillInstallOutcome = SkillInstallEffects & (
  | Readonly<{ ok: true }>
  | Readonly<{
      ok: false;
      error: string;
      status?: RegistryFailureStatus;
      request: SkillInstallRequest;
      /** Re-read through the canonical held identity owner; used by the existing checklist and recovery notice. */
      previews?: readonly SkillInstallPreviewV1[];
    }>
);

/** A failure keeps the registry's typed status when it has one ("Try again at 14:05"). */
function failure(result: Readonly<{ errorCode?: string; error: string; details?: unknown }>) {
  const status = readRegistryFailureStatus(result.details);
  return { ok: false as const, error: result.errorCode ?? result.error, ...(status ? { status } : {}) };
}

/**
 * `skills.install` commit (P6 U6.4): the pointer the details read (registry `version` = the pinned commit), a link,
 * or an upload, with the add flow's `where` only when the person changed it. A failure after the content landed
 * still reports the acknowledged skills, so the retry repeats only the missing step.
 */
export async function installSkills(
  execute: MountedAuthoringActionExecute,
  input: SkillInstallRequest,
): Promise<SkillInstallOutcome> {
  const result = await execute('skills.install', {
    source: input.source,
    ...(input.selectPaths ? { selectPaths: [...input.selectPaths] } : {}),
    ...(input.where ? { where: input.where } : {}),
  });
  if (!result.ok) {
    const effects = SkillInstallAcknowledgedEffectsV1Schema.safeParse(
      result.details,
    );
    if (effects.success && effects.data.skillIds.length > 0) {
      const preview = await previewSkillInstall(execute, input.source).catch(() => null);
      return {
        ...acknowledgeSkillCreation(effects.data),
        ...failure(result),
        request: input,
        ...(preview?.ok ? { previews: preview.items } : {}),
      };
    }
    return { ...failure(result), request: input, skillIds: [], rulesMissing: [], incomplete: [] };
  }
  const parsed = SKILL_ACTION_OUTPUT_SCHEMAS_V1['skills.install'].safeParse(
    result.result,
  );
  if (
    !parsed.success ||
    !('skillIds' in parsed.data) ||
    parsed.data.skillIds.length === 0
  ) {
    return { ok: false, error: 'skill_install_failed', request: input, skillIds: [], rulesMissing: [], incomplete: [] };
  }
  return acknowledgeSkillCreation(parsed.data);
}

/** The dry run behind From a link, Upload and a Browse detail's siblings: what would be added, pinned, before anything is written. */
export async function previewSkillInstall(
  execute: MountedAuthoringActionExecute,
  source: SkillInstallSource,
): Promise<
  | Readonly<{ ok: true; items: readonly SkillInstallPreviewV1[]; source: SkillInstallSource }>
  | Readonly<{ ok: false; error: string; status?: RegistryFailureStatus }>
> {
  const result = await execute('skills.install', { source, dryRun: true });
  if (!result.ok) return failure(result);
  const parsed = SKILL_ACTION_OUTPUT_SCHEMAS_V1['skills.install'].safeParse(
    result.result,
  );
  if (!parsed.success || !('items' in parsed.data))
    return { ok: false, error: 'skill_install_failed' };
  const items = parsed.data.items.map((item) => SkillInstallPreviewV1Schema.parse(item));
  const refs = items.map(item => {
    const provenance = item.provenance;
    if (provenance.kind === 'wellKnown') return provenance;
    const ref = provenance.kind === 'link' ? provenance.ref : provenance.kind === 'registry' ? provenance.registry.ref : null;
    return ref?.kind === 'gitTree' || ref?.kind === 'wellKnown' ? ref : null;
  });
  if (source.kind === 'link' && refs.some(ref => ref === null)) return { ok: false, error: 'skill_preview_pin_missing' };
  return {
    ok: true,
    items,
    source: source.kind === 'link' ? { ...source, refs: refs.filter(ref => ref !== null) } : source,
  };
}

/**
 * "Couldn't set where it's on · Try again" (IR-70/IR-93): the skill exists; only its rules are written now, through
 * `skills.rules.set` for that acknowledged id, never a second install.
 */
export async function retrySkillRules(
  execute: MountedAuthoringActionExecute,
  input: Readonly<{ skillId: string; change: ReachRulesChangeV1 }>,
): Promise<boolean> {
  const result = await execute('skills.rules.set', {
    items: [{ skillId: input.skillId }],
    change: input.change,
  });
  return readReachRulesAcknowledgment('skill', input.skillId, result).ok;
}

export type SkillInstallAcknowledgment = SkillInstallOutcome;
export type SkillCreationAcknowledgment = Extract<SkillInstallAcknowledgment, { ok: true }>;

/** All create entry points keep the same content identities and independently missing effects. */
export function acknowledgeSkillCreation(receipt:
  | Readonly<{ skillId: string; incomplete?: 'rules' | 'session_include' }>
  | Readonly<{ skillIds: readonly string[]; incomplete?: SkillInstallEffects['incomplete'] }>,
): SkillCreationAcknowledgment {
  const skillIds = 'skillId' in receipt ? [receipt.skillId] : receipt.skillIds;
  const incomplete = 'skillId' in receipt
    ? receipt.incomplete ? [{ skillId: receipt.skillId, step: receipt.incomplete }] : []
    : receipt.incomplete ?? [];
  return { ok: true, skillIds, incomplete, rulesMissing: incomplete.filter(step => step.step === 'rules').map(step => step.skillId) };
}

/** A later Add must not replace an earlier content acknowledgment that still needs rules. */
export function mergeSkillCreationAcknowledgments(previous: SkillCreationAcknowledgment | null, next: SkillCreationAcknowledgment): SkillCreationAcknowledgment {
  if (!previous) return next;
  const steps = new Map([...previous.incomplete, ...next.incomplete].map(step => [JSON.stringify([step.skillId, step.step]), step]));
  return acknowledgeSkillCreation({ skillIds: [...new Set([...previous.skillIds, ...next.skillIds])], incomplete: [...steps.values()] });
}

/** Keep every content acknowledgment; a subsequent retry only visits rules still missing. */
export function retrySkillInstallRules(
  execute: MountedAuthoringActionExecute,
  outcome: SkillCreationAcknowledgment,
  change?: ReachRulesChangeV1,
): Promise<SkillCreationAcknowledgment>;
export function retrySkillInstallRules(
  execute: MountedAuthoringActionExecute,
  outcome: SkillInstallAcknowledgment,
  change?: ReachRulesChangeV1,
): Promise<SkillInstallAcknowledgment>;
export async function retrySkillInstallRules(
  execute: MountedAuthoringActionExecute,
  outcome: SkillInstallAcknowledgment,
  change: ReachRulesChangeV1 = DEFAULT_CREATE_REACH_CHANGE_V1,
): Promise<SkillInstallAcknowledgment> {
  const incomplete: SkillInstallAcknowledgment['incomplete'][number][] = [];
  for (const step of outcome.incomplete) {
    if (step.step !== 'rules' || !await retrySkillRules(execute, { skillId: step.skillId, change }).catch(() => false))
      incomplete.push(step);
  }
  return { ...outcome, incomplete, rulesMissing: incomplete.filter(step => step.step === 'rules').map(step => step.skillId) };
}

/** Explicit Try again: repair acknowledged rules, then retry the pinned content through findHeldSkillV1. */
export async function retrySkillInstall(
  execute: MountedAuthoringActionExecute,
  outcome: SkillInstallAcknowledgment,
  change?: ReachRulesChangeV1,
): Promise<SkillInstallAcknowledgment> {
  const repaired = await retrySkillInstallRules(execute, outcome, change ?? (!outcome.ok ? outcome.request.where : undefined));
  if (repaired.ok) return repaired;
  // Repeating the selected source at the Action owner skips held content, including uploads by current digest.
  // Its receipt also acknowledges held identities, but does not repeat their failed rules writes.
  const retried = await installSkills(execute, repaired.request);
  const incomplete = [...repaired.incomplete];
  for (const step of retried.incomplete) {
    if (!incomplete.some(existing => existing.skillId === step.skillId && existing.step === step.step)) incomplete.push(step);
  }
  return { ...retried, ...(!retried.ok && !retried.previews && repaired.previews ? { previews: repaired.previews } : {}),
    skillIds: [...new Set([...repaired.skillIds, ...retried.skillIds])], incomplete,
    rulesMissing: incomplete.filter(step => step.step === 'rules').map(step => step.skillId) };
}

/** One recovery message for Link, Upload, Browse and the shelf, using their existing notice anatomy. */
export function describeSkillInstallIncomplete(outcome: SkillInstallAcknowledgment): string {
  if (outcome.ok) return t('capabilities.skillAdd.partial.rules');
  const names = outcome.previews?.filter(item => item.inLibrary === undefined
    && (!outcome.request.selectPaths || outcome.request.selectPaths.includes(item.path))).map(item => item.name) ?? [];
  return t('capabilities.skillAdd.partial.content', { names: names.join(', ') });
}
