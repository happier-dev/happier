import { seedInputByFieldHints } from '@happier-dev/protocol/inputs/inputFieldRuntime';
import type { DeploymentRuntimeTargetV1, DeploymentSourceMethodV1 } from '@happier-dev/deployments/contracts/v1';
import type { PluginPortableReleaseManifestV1 } from '@happier-dev/protocol/plugins/availability';
import type { EffectiveActionInputField } from '@happier-dev/protocol/actions/actionInputHintsRuntime';
import { patchHappierActionInputPath, readHappierActionInputPath } from '@happier-dev/plugin-ui/presentation';
import { formatQualifiedPluginActionId } from '@happier-dev/protocol/plugins/actions/qualifiedActionId';
import {
  DeploymentTargetLinkProviderContentV1Schema,
  describeDeploymentTargetGitCreateV1,
  type DeploymentTargetLinkProviderContentV1,
} from '@happier-dev/protocol/plugins/contributions/v2';
import type { QualifiedConnectedAccountRef } from '@happier-dev/protocol/connect/qualifiedConnectedAccountPersistence';
import type { DeploymentTargetCredentialPrincipalV1 } from '@happier-dev/protocol/plugins/contributions/deploymentTargetRolesV1';
import type { ScmHostingRepositoryIdentityV1 } from '@happier-dev/protocol/scm/hostingRepositoryIdentity';
import type { DeploymentTargetLinkCreateIntentInputV1 } from '@happier-dev/protocol/deployments/deploymentActionsV1';
import type { DeploySuggestionCatalogV1 } from '@happier-dev/protocol/deployments/suggestions/deploySuggestionsV1';
import { listDeploymentTargetsFromManifestsV1, readPluginActionCredentialPurposeV1 } from '@happier-dev/deployments';
import { resolvePluginLocalizedStringV2Text } from '@happier-dev/protocol/plugins/contributions/public-types';

import { readDeploymentRefusal, type DeploymentRefusalReason } from './deploymentActionOutcome';
import { formatContentDigestPrefix } from '@/utils/formatContentDigestPrefix';

/**
 * One runtime platform a person can link (Vercel, Cloudflare Workers, Cloudflare Pages), read from the plugin's
 * own `deploymentTargets` descriptor, its declared inspect Action and that Action's credential purpose. The UI
 * holds no catalog of its own: every fact here is the descriptor's.
 */
export type DeploymentPlatformTarget = Readonly<{
  key: string;
  pluginId: string;
  targetId: string;
  title: string;
  description?: string;
  targetKind: string;
  inspectLocalId: string;
  inspectActionId: string;
  purpose: string;
  service: Readonly<{ pluginId: string; localId: string }>;
  fields: readonly EffectiveActionInputField[];
  sourceMethods: readonly DeploymentSourceMethodV1[];
  declaredInputTypes?: Readonly<{
    pluginId: string;
    definitions: NonNullable<PluginPortableReleaseManifestV1['contributes']['inputTypes']>;
  }>;
  accepts?: DeploySuggestionCatalogV1['targets'][number]['accepts'];
  needs?: DeploySuggestionCatalogV1['targets'][number]['needs'];
  /** The plugin's dated plan facts, printed as declared (Protocol DeploymentTargetPlanV1). */
  plans?: DeploymentRuntimeTargetV1['plans'];
  runtimeLogs?: true;
  logFollow?: false;
  generatedDomains?: true;
  gitSource?: DeploymentRuntimeTargetV1['gitSource'];
  teardown?: true;
  promote?: true;
  rollback?: true;
  /** The provider's own words for what its teardown deletes ("Delete this Vercel project and its deployments?"). */
  teardownConsequence?: string;
  create?: Readonly<{
    localId: string;
    actionId: string;
    purpose: string;
    service: Readonly<{ pluginId: string; localId: string }>;
    fields: readonly EffectiveActionInputField[];
  }>;
}>;

type Declaration = Readonly<{ manifest: PluginPortableReleaseManifestV1 }>;
type UnknownRecord = Record<string, unknown>;
const record = (value: unknown): value is UnknownRecord =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0;

/** A delete Action's declared confirmation names what the provider deletes with the resource (runtime and data targets). */
export function readTeardownConsequence(actions: readonly unknown[], localId: string) {
  const action = actions.find(entry => record(entry) && entry.id === localId);
  const title = record(action) && record(action.confirmation) ? action.confirmation.title : undefined;
  const consequence = title === undefined ? '' : resolvePluginLocalizedStringV2Text(title);
  return consequence ? { teardownConsequence: consequence } : {};
}

/**
 * The name a person knows a linked provider resource by, as the provider recorded it: a Preview's name, else the
 * project or Worker name captured at preparation, else the provider's resource id.
 */
export function readPlatformResourceName(content: Partial<DeploymentTargetLinkProviderContentV1> | undefined): string | null {
  const environment = content?.providerEnvironment?.selection;
  if (environment?.kind === 'preview' && typeof environment.previewName === 'string') return environment.previewName;
  return content?.preparedNative?.projectName
    ?? (environment?.kind === 'script' && typeof environment.scriptName === 'string' ? environment.scriptName : null)
    ?? content?.providerIdentity?.providerResourceId ?? null;
}

export function readDeploymentPlatformTargets(
  declarations: readonly Declaration[],
): readonly DeploymentPlatformTarget[] {
  return declarations.flatMap(({ manifest }) => {
    const contributes = manifest.contributes as unknown as UnknownRecord;
    const normalizedTargets = listDeploymentTargetsFromManifestsV1([{ manifest }]);
    const declaredInputTypes = manifest.contributes.inputTypes?.length
      ? { pluginId: manifest.id, definitions: manifest.contributes.inputTypes } : undefined;
    const targets = normalizedTargets.flatMap(target => {
      if (target.source.kind !== 'plugin' || target.role !== 'runtime') return [];
      const localId = target.source.contribution.localId;
      return (manifest.contributes.deploymentTargets ?? []).filter(declaration => declaration.id === localId);
    });
    const actions = Array.isArray(contributes.actions)
      ? contributes.actions
      : [];
    return targets.flatMap((target): DeploymentPlatformTarget[] => {
      if (
        !record(target) ||
        target.role !== 'runtime' ||
        !text(target.id) ||
        !text(target.title) ||
        !text(target.targetKind)
      )
        return [];
      const sourceMethods: DeploymentSourceMethodV1[] = [];
      if (record(target.actions) && text(target.actions.deploy)) sourceMethods.push('gitIntegration');
      if (record(target.actions) && text(target.actions.uploadDeploy)) sourceMethods.push('upload');
      const inspect = record(target.actions)
        ? target.actions.inspect
        : undefined;
      if (!text(inspect)) return [];
      const action = actions.find(
        (entry) => record(entry) && entry.id === inspect,
      );
      if (!record(action)) return [];
      const credential = readPluginActionCredentialPurposeV1(manifest, inspect);
      if (!credential) return [];
      const { purpose, service } = credential;
      const createId = record(target.actions) ? target.actions.create : undefined;
      const createAction = text(createId) ? actions.find(entry => record(entry) && entry.id === createId) : undefined;
      const createCredential = text(createId) && createAction ? readPluginActionCredentialPurposeV1(manifest, createId) : null;
      const create = text(createId) && record(createAction) && createCredential ? {
        localId: createId,
        actionId: formatQualifiedPluginActionId({ pluginId: manifest.id, localId: createId }),
        ...createCredential,
        fields: (record(createAction.inputHints) && Array.isArray(createAction.inputHints.fields)
          ? createAction.inputHints.fields : []) as EffectiveActionInputField[],
      } : undefined;
      const hints =
        record(action.inputHints) && Array.isArray(action.inputHints.fields)
          ? action.inputHints.fields
          : [];
      return [
        {
          key: `${manifest.id}/${target.id}`,
          pluginId: manifest.id,
          targetId: target.id,
          title: target.title,
          ...(text(target.description)
            ? { description: target.description }
            : {}),
          targetKind: target.targetKind,
          inspectLocalId: inspect,
          inspectActionId: formatQualifiedPluginActionId({
            pluginId: manifest.id,
            localId: inspect,
          }),
          purpose,
          service: { pluginId: service.pluginId, localId: service.localId },
          fields: hints as EffectiveActionInputField[],
          sourceMethods,
          ...(declaredInputTypes ? { declaredInputTypes } : {}),
          ...(() => {
            const normalized = normalizedTargets.find(candidate => candidate.source.kind === 'plugin'
              && candidate.source.contribution.localId === target.id);
            return normalized?.role === 'runtime' ? {
              ...(normalized.accepts === undefined ? {} : { accepts: normalized.accepts }),
              ...(normalized.needs === undefined ? {} : { needs: normalized.needs }),
              ...(normalized.plans?.length ? { plans: normalized.plans } : {}),
              ...(normalized.actions.promote ? { promote: true as const } : {}),
              ...(normalized.gitSource ? { gitSource: normalized.gitSource } : {}),
              ...(normalized.generatedDomains ? { generatedDomains: true as const } : {}),
              ...(normalized.logFollow === false ? { logFollow: false as const } : {}),
              ...(normalized.actions.rollback ? { rollback: true as const } : {}),
            } : {};
          })(),
          ...(record(target.actions) && text(target.actions.teardown) ? { teardown: true as const,
            ...readTeardownConsequence(actions, target.actions.teardown) } : {}),
          ...(record(target.actions) && record(target.actions.logs) && text(target.actions.logs.runtime)
            ? { runtimeLogs: true as const } : {}),
          ...(create ? { create } : {}),
        },
      ];
    });
  });
}

/** The options resolver and Inspect share this draft; saved Environments include their revision. */
export function buildPlatformTargetDraft(
  input: Readonly<{
    target: Pick<DeploymentPlatformTarget, 'pluginId' | 'inspectLocalId' | 'purpose'>;
    ownerAccountId: string;
    serverId: string;
    environment: Readonly<{ id?: string; revision?: number }>;
    account: QualifiedConnectedAccountRef;
    repository: ScmHostingRepositoryIdentityV1 | null;
    values: Readonly<Record<string, unknown>>;
    sourceMethod?: DeploymentSourceMethodV1;
  }>,
): Record<string, unknown> & { credentialPrincipal: DeploymentTargetCredentialPrincipalV1 } {
  return {
    v: 1,
    serverId: input.serverId,
    ...(input.environment.id ? { environmentId: input.environment.id } : {}),
    ...(input.environment.revision !== undefined ? { expectedRevision: input.environment.revision } : {}),
    credentialRef: input.account,
    credentialPrincipal: {
      kind: 'account',
      accountId: input.ownerAccountId,
      purpose: {
        consumer: {
          pluginId: input.target.pluginId,
          localId: input.target.inspectLocalId,
        },
        purpose: input.target.purpose,
      },
      target: { kind: 'account', account: input.account },
    },
    ...(input.repository ? { repository: input.repository } : {}),
    ...input.values,
    ...(input.sourceMethod ? { sourceMethod: input.sourceMethod } : {}),
  };
}

/** Link spends exactly the inspected provider content; the host Action authors and associates it. */
/**
 * A platform target chosen before its Environment exists (the new-Environment draft): an inspected existing resource,
 * or a reviewed create intent with its own retry key. The draft links it once Create has made the Environment.
 */
export type PreparedPlatformTargetLink =
  | Readonly<{ kind: 'existing'; provider: DeploymentTargetLinkProviderContentV1; reviewNotice: string | null }>
  | Readonly<{ kind: 'create'; requestKey: string; providerCreate: PlatformTargetProviderCreate; reviewNotice: string | null;
      reviewRuntime?: PlatformTargetReviewRuntime & Readonly<{ machineName: string }> }>;

/** The connected account a prepared platform draft acts through, when it names one Account-held account. */
export function readPreparedPlatformAccount(prepared: PreparedPlatformTargetLink | null): QualifiedConnectedAccountRef | null {
  if (!prepared) return null;
  const principal = prepared.kind === 'existing' ? prepared.provider.credentialPrincipal : prepared.providerCreate.credentialPrincipal;
  const target = 'target' in principal ? principal.target : null;
  return target && target.kind === 'account' ? target.account : null;
}

/**
 * The platform's own Review notice (`preparedNative.reviewNotice`), from its inspect reply: an inspected resource, or
 * a draft before Create, which names no resource and is answered with the notice alone. One field; the UI never
 * decides it per platform.
 */
export function readPlatformReviewNotice(value: unknown): string | null {
  if (typeof value !== 'object' || value === null || !('preparedNative' in value)) return null;
  const prepared = value.preparedNative;
  return typeof prepared === 'object' && prepared !== null && 'reviewNotice' in prepared
    && typeof prepared.reviewNotice === 'string' ? prepared.reviewNotice : null;
}

/** The declaration owns Git creation semantics; the draft supplies the user-reviewed operands. */
export function readPlatformGitCreateReview(target: DeploymentPlatformTarget, draft: PlatformTargetProviderCreate): string | null {
  const { resourceName, repository, productionBranch } = draft;
  return describeDeploymentTargetGitCreateV1(target.gitSource, target.title, {
    ...(text(resourceName) ? { resourceName } : {}),
    ...(record(repository) && text(repository.repository) ? { repository: repository.repository } : {}),
    ...(text(productionBranch) ? { productionBranch } : {}),
  }) ?? null;
}

type PlatformTargetReviewRuntime = Readonly<{
  name: string;
  version: string;
  pin: string;
  tool: string;
  toolVersion: string;
}>;

/** The provider names its build runtime. Review and Store Versions use the same abbreviated pin. */
export function readPlatformReviewRuntime(value: unknown): PlatformTargetReviewRuntime | null {
  const runtime = record(value) && record(value.preparedNative) ? value.preparedNative.buildRuntime : null;
  if (!record(runtime)) return null;
  const { name, version, pin, tool, toolVersion } = runtime;
  if (!text(name) || !text(version) || !text(pin) || !text(tool) || !text(toolVersion)) return null;
  return { name, version, pin: formatContentDigestPrefix(pin), tool, toolVersion };
}

/**
 * A reviewed platform draft's provider part: what a create intent asks the platform to make. Named as the record plus
 * its principal, since Omit over the draft's string index would erase the declared principal.
 */
export type PlatformTargetProviderCreate = Record<string, unknown> & Pick<ReturnType<typeof buildPlatformTargetDraft>, 'credentialPrincipal'>;
export function readProviderCreate(draft: ReturnType<typeof buildPlatformTargetDraft>): PlatformTargetProviderCreate {
  const { v: _v, serverId: _serverId, environmentId: _environmentId, expectedRevision: _revision, ...providerCreate } = draft;
  return providerCreate;
}

/**
 * The link Action's create intent: the platform makes the resource and links it to this Environment in one Action
 * (the editor's Create new, and the draft's Create once its Environment exists). Null when the intent is not admitted.
 */
export async function buildPlatformTargetCreateLinkInput(
  input: Readonly<{
    serverId: string;
    target: Pick<DeploymentPlatformTarget, 'targetId' | 'pluginId' | 'targetKind'>;
    environment: Readonly<{ id: string; revision: number }>;
    requestKey: string;
    providerCreate: PlatformTargetProviderCreate;
  }>,
): Promise<DeploymentTargetLinkCreateIntentInputV1 | null> {
  const { DeploymentTargetLinkCreateIntentInputV1Schema } = await import('@happier-dev/protocol/deployments/deploymentActionsV1');
  const parsed = DeploymentTargetLinkCreateIntentInputV1Schema.safeParse({
    serverId: input.serverId, environmentId: input.environment.id, expectedRevision: input.environment.revision,
    requestKey: input.requestKey, targetId: input.target.targetId, role: 'runtime', targetKind: input.target.targetKind,
    machines: [], source: { kind: 'plugin', contribution: { pluginId: input.target.pluginId, localId: input.target.targetId } },
    providerCreate: input.providerCreate,
  });
  return parsed.success ? parsed.data : null;
}

export function platformTargetAssociation(target: Pick<DeploymentPlatformTarget, 'pluginId' | 'targetId' | 'targetKind'>) {
  return {
    targetKind: target.targetKind,
    source: { kind: 'plugin' as const, contribution: { pluginId: target.pluginId, localId: target.targetId } },
  };
}

export function buildPlatformTargetLinkInput(
  input: Readonly<{
    target: Pick<DeploymentPlatformTarget, 'targetId' | 'pluginId' | 'targetKind'>;
    environment: Readonly<{ id: string; revision: number }>;
    provider: DeploymentTargetLinkProviderContentV1;
    title?: string;
    role?: 'runtime' | 'data';
  }>,
) {
  return {
    environmentId: input.environment.id,
    expectedRevision: input.environment.revision,
    ...(input.title ? { title: input.title } : {}),
    targetId: input.target.targetId,
    role: input.role ?? 'runtime',
    ...platformTargetAssociation(input.target),
    machines: [],
    provider: input.provider,
  };
}

export type PlatformInspectOutcome =
  | Readonly<{ kind: 'ready'; provider: DeploymentTargetLinkProviderContentV1 }>
  | Readonly<{
      kind: 'needsGitAccess';
      provider: DeploymentTargetLinkProviderContentV1;
      grantUrl: string | null;
    }>
  | Readonly<{ kind: 'refused'; reason: DeploymentRefusalReason; code: string }>;

export function readPlatformInspectOutcome(
  result:
    | Readonly<{ ok: true; value: unknown }>
    | Readonly<{ ok: false; code: string }>,
): PlatformInspectOutcome {
  if (!result.ok) return readDeploymentRefusal(result.code);
  const parsed = DeploymentTargetLinkProviderContentV1Schema.safeParse(
    result.value,
  );
  if (!parsed.success)
    return readDeploymentRefusal('provider_response_invalid');
  const provider = parsed.data;
  const access = provider.repositoryAccess;
  return access?.status === 'needsGitAccess'
    ? {
        kind: 'needsGitAccess',
        provider,
        grantUrl: access.grantUrl ?? null,
      }
    : { kind: 'ready', provider };
}

/**
 * The provider's choices a person can make now: each one is drawn once every required choice above it is made,
 * because its options are read from those answers. An optional choice never holds back the ones after it.
 */
export function disclosePlatformFields(
  fields: readonly EffectiveActionInputField[],
  values: Readonly<Record<string, unknown>>,
): readonly EffectiveActionInputField[] {
  const disclosed: EffectiveActionInputField[] = [];
  for (const field of fields) {
    disclosed.push(field);
    if (field.required && readHappierActionInputPath(values as Record<string, unknown>, field.path) === undefined) break;
  }
  return disclosed.length === fields.length ? fields : disclosed;
}

type PlatformFieldChoices = Readonly<{ status: 'loading' | 'ready' | 'failed'; options: readonly unknown[]; errorCode?: string; nextCursor?: string }>;

/**
 * The disclosed choices the sheet draws, and the one failed read it says once. A failed read stops the list: the
 * choices after it are read from its answer, and repeating the same failure under each row says one cause six
 * times. An optional choice the target has nothing for (a Worker's Pages project) is left out; a required or
 * answered one, one still loading or one being paged through always stays.
 */
export function drawPlatformFields<Field extends EffectiveActionInputField>(
  fields: readonly Field[],
  values: Readonly<Record<string, unknown>>,
  choicesOf: (field: Field) => PlatformFieldChoices,
  paged: (field: Field) => boolean,
): Readonly<{ fields: readonly Field[]; failure: Readonly<{ code: string }> | null; canCheck: boolean }> {
  const drawn: Field[] = [];
  // Check reads the provider for the chosen project: a failed choices read or no choice at all can only fail again.
  const answered = fields.length === 0
    || fields.some((field) => readHappierActionInputPath(values as Record<string, unknown>, field.path) !== undefined);
  for (const field of fields) {
    const choices = choicesOf(field);
    if (choices.status === 'failed') return { fields: drawn, failure: { code: choices.errorCode ?? 'unknown_error' }, canCheck: false };
    const value = readHappierActionInputPath(values as Record<string, unknown>, field.path);
    if (field.required && !field.allowCustomValue && (field.widget === 'select' || field.widget === 'multiselect')
      && value === undefined && choices.status === 'ready' && choices.options.length === 0
      && choices.nextCursor === undefined && !paged(field)) {
      return { fields: drawn, failure: { code: 'provider_options_empty' }, canCheck: false };
    }
    if (field.required || value !== undefined
      || choices.status !== 'ready' || choices.options.length > 0 || paged(field)) drawn.push(field);
  }
  return { fields: drawn, failure: null, canCheck: answered };
}

/** A changed choice clears the ones after it: they were read for the old answer. `changedIndex` is -1 when nothing changed. */
export function applyPlatformFieldPatch(
  fields: readonly EffectiveActionInputField[],
  values: Readonly<Record<string, unknown>>,
  next: Readonly<Record<string, unknown>>,
): Readonly<{ values: Record<string, unknown>; changedIndex: number }> {
  const merged: Record<string, unknown> = { ...values, ...next };
  const changedIndex = fields.findIndex(
    (field) => readHappierActionInputPath(merged, field.path) !== readHappierActionInputPath(values as Record<string, unknown>, field.path),
  );
  if (changedIndex === -1) return { values: merged, changedIndex };
  let kept: Record<string, unknown> = {};
  for (const field of fields.slice(0, changedIndex + 1)) {
    const value = readHappierActionInputPath(merged, field.path);
    if (value !== undefined) kept = { ...kept, ...patchHappierActionInputPath(kept, field.path, value) };
  }
  return { values: seedInputByFieldHints({ inputHints: { fields: [...fields.slice(changedIndex + 1)] } }, kept), changedIndex };
}
