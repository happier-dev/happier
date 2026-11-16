import { seedInputByFieldHints } from '@happier-dev/protocol/inputs/inputFieldRuntime';
import type { DeploymentSourceMethodV1 } from '@happier-dev/deployment-protocol/v1';
import type { PluginPortableReleaseManifestV1 } from '@happier-dev/protocol/plugins/availability';
import type { EffectiveActionInputField } from '@happier-dev/protocol/actions/actionInputHintsRuntime';
import { patchHappierActionInputPath, readHappierActionInputPath } from '@happier-dev/plugin-ui/presentation';
import { formatQualifiedPluginActionId } from '@happier-dev/protocol/plugins/actions/qualifiedActionId';
import {
  DeploymentTargetLinkProviderContentV1Schema,
  type DeploymentTargetLinkProviderContentV1,
} from '@happier-dev/protocol/plugins/contributions/v2';
import type { QualifiedConnectedAccountRef } from '@happier-dev/protocol/connect/qualifiedConnectedAccountPersistence';
import { resolvePluginActionConnectedAccountUseRequestsV2 } from '@happier-dev/protocol/plugins/manifest/v2';
import { projectConnectedAccountHostAccessScopes } from '@happier-dev/cli-common/connectedAccounts';
import type { DeploymentTargetCredentialPrincipalV1 } from '@happier-dev/protocol/plugins/contributions/deploymentTargetRolesV1';
import type { ScmHostingRepositoryIdentityV1 } from '@happier-dev/protocol/scm/hostingRepositoryIdentity';
import type { DeploymentTargetLinkCreateIntentInputV1 } from '@happier-dev/protocol/deployments/deploymentActionsV1';
import type { DeploySuggestionCatalogV1 } from '@happier-dev/protocol/deployments/suggestions/deploySuggestionsV1';
import { listDeploymentTargetsFromManifestsV1 } from '@happier-dev/deployments';
import { resolvePluginLocalizedStringV2Text } from '@happier-dev/protocol/plugins/contributions/public-types';

import { readDeploymentRefusal, type DeploymentRefusalReason } from './deploymentActionOutcome';

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
  accepts?: DeploySuggestionCatalogV1['targets'][number]['accepts'];
  needs?: DeploySuggestionCatalogV1['targets'][number]['needs'];
  runtimeLogs?: true;
  teardown?: true;
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
/** The Action's declared purpose and canonical HostAccess scope own its credential chooser. */
export function readPluginActionCredentialPurpose(manifest: PluginPortableReleaseManifestV1, localId: string) {
  const action = manifest.contributes.actions?.find(entry => entry.id === localId);
  const purpose = action?.connectedAccountPurposeBindings?.find(entry => entry.path === 'credentialRef')?.purpose;
  if (!purpose) return null;
  const requests = resolvePluginActionConnectedAccountUseRequestsV2(manifest, localId);
  const scope = requests ? projectConnectedAccountHostAccessScopes(manifest.id, requests).find(entry => entry.purpose === purpose) : undefined;
  const service = scope?.serviceRefs[0];
  return service ? { purpose, service: { pluginId: service.pluginId, localId: service.localId } } : null;
}
type UnknownRecord = Record<string, unknown>;
const record = (value: unknown): value is UnknownRecord =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0;

/** The teardown Action's declared confirmation names what the provider deletes with the resource. */
function readTeardownConsequence(actions: readonly unknown[], localId: string) {
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
  const environment = content?.providerEnvironment;
  if (environment?.kind === 'preview' && 'previewName' in environment) return environment.previewName;
  return content?.preparedNative?.projectName
    ?? (environment?.kind === 'script' ? environment.scriptName : null)
    ?? content?.providerIdentity?.providerResourceId ?? null;
}

export function readDeploymentPlatformTargets(
  declarations: readonly Declaration[],
): readonly DeploymentPlatformTarget[] {
  return declarations.flatMap(({ manifest }) => {
    const contributes = manifest.contributes as unknown as UnknownRecord;
    const normalizedTargets = listDeploymentTargetsFromManifestsV1([{ manifest }]);
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
      const credential = readPluginActionCredentialPurpose(manifest, inspect);
      if (!credential) return [];
      const { purpose, service } = credential;
      const createId = record(target.actions) ? target.actions.create : undefined;
      const createAction = text(createId) ? actions.find(entry => record(entry) && entry.id === createId) : undefined;
      const createCredential = text(createId) && createAction ? readPluginActionCredentialPurpose(manifest, createId) : null;
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
          ...(() => {
            const normalized = normalizedTargets.find(candidate => candidate.source.kind === 'plugin'
              && candidate.source.contribution.localId === target.id);
            return normalized?.role === 'runtime' ? {
              ...(normalized.accepts === undefined ? {} : { accepts: normalized.accepts }),
              ...(normalized.needs === undefined ? {} : { needs: normalized.needs }),
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
  | Readonly<{ kind: 'existing'; provider: DeploymentTargetLinkProviderContentV1 }>
  | Readonly<{ kind: 'create'; requestKey: string; providerCreate: PlatformTargetProviderCreate }>;

/** A reviewed platform draft's provider part: what a create intent asks the platform to make. */
export type PlatformTargetProviderCreate = Omit<ReturnType<typeof buildPlatformTargetDraft>, 'v' | 'serverId' | 'environmentId' | 'expectedRevision'>;
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
    targetKind: input.target.targetKind,
    machines: [],
    source: {
      kind: 'plugin' as const,
      contribution: {
        pluginId: input.target.pluginId,
        localId: input.target.targetId,
      },
    },
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
