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
import type { ScmHostingRepositoryIdentityV1 } from '@happier-dev/protocol/scm/hostingRepositoryIdentity';

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
}>;

type Declaration = Readonly<{ manifest: PluginPortableReleaseManifestV1 }>;
type UnknownRecord = Record<string, unknown>;
const record = (value: unknown): value is UnknownRecord =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0;

export function readDeploymentPlatformTargets(
  declarations: readonly Declaration[],
): readonly DeploymentPlatformTarget[] {
  return declarations.flatMap(({ manifest }) => {
    const contributes = manifest.contributes as unknown as UnknownRecord;
    const targets = Array.isArray(contributes.deploymentTargets)
      ? contributes.deploymentTargets
      : [];
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
      const inspect = record(target.actions)
        ? target.actions.inspect
        : undefined;
      if (!text(inspect)) return [];
      const action = actions.find(
        (entry) => record(entry) && entry.id === inspect,
      );
      if (!record(action)) return [];
      const bindings = Array.isArray(action.connectedAccountPurposeBindings)
        ? action.connectedAccountPurposeBindings
        : [];
      const binding = bindings.find(
        (entry) => record(entry) && entry.path === 'credentialRef',
      );
      const purpose = record(binding) ? binding.purpose : undefined;
      if (!text(purpose)) return [];
      // The purpose's service comes from the canonical HostAccess owner, which qualifies a plugin-local ref.
      const requests = resolvePluginActionConnectedAccountUseRequestsV2(manifest, inspect);
      const scope = requests
        ? projectConnectedAccountHostAccessScopes(manifest.id, requests).find((entry) => entry.purpose === purpose)
        : undefined;
      const service = scope?.serviceRefs[0];
      if (!service) return [];
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
        },
      ];
    });
  });
}

/** The partial draft the options resolver and Inspect both read: recorded credential, exact Environment revision. */
export function buildPlatformTargetDraft(
  input: Readonly<{
    target: DeploymentPlatformTarget;
    ownerAccountId: string;
    serverId: string;
    environment: Readonly<{ id: string; revision: number }>;
    account: QualifiedConnectedAccountRef;
    repository: ScmHostingRepositoryIdentityV1 | null;
    values: Readonly<Record<string, unknown>>;
  }>,
): Record<string, unknown> {
  return {
    v: 1,
    serverId: input.serverId,
    environmentId: input.environment.id,
    expectedRevision: input.environment.revision,
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
  };
}

/** Link spends exactly the inspected provider content; the host Action authors and associates it. */
export function buildPlatformTargetLinkInput(
  input: Readonly<{
    target: DeploymentPlatformTarget;
    environment: Readonly<{ id: string; revision: number }>;
    provider: DeploymentTargetLinkProviderContentV1;
  }>,
) {
  return {
    environmentId: input.environment.id,
    expectedRevision: input.environment.revision,
    targetId: input.target.targetId,
    role: 'runtime' as const,
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
  const access = parsed.data.repositoryAccess;
  return access?.status === 'needsGitAccess'
    ? {
        kind: 'needsGitAccess',
        provider: parsed.data,
        grantUrl: access.grantUrl ?? null,
      }
    : { kind: 'ready', provider: parsed.data };
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

type PlatformFieldChoices = Readonly<{ status: 'loading' | 'ready' | 'failed'; options: readonly unknown[]; errorCode?: string }>;

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
    if (field.required || readHappierActionInputPath(values as Record<string, unknown>, field.path) !== undefined
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
  return { values: kept, changedIndex };
}
