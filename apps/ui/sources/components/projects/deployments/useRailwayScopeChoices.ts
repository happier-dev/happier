import * as React from 'react';
import { ACTION_INVOKE_ACTION_ID_V1 } from '@happier-dev/protocol/actions/actionIds';
import type { EffectiveInputField } from '@happier-dev/protocol/inputs/inputFieldRuntime';
import { normalizePluginActionInputHintsV2 } from '@happier-dev/protocol/plugins/actions/v2';
import { formatQualifiedPluginActionId } from '@happier-dev/protocol/plugins/actions/qualifiedActionId';
import type { PluginPortableReleaseManifestV1 } from '@happier-dev/protocol/plugins/availability';
import { useMountedActionExecution } from '@/components/approvals/useMountedActionExecution';
import { createActionInputForm } from '@/components/plugins/actions/actionInputForm';
import { presentActionInputForm } from '@/components/plugins/actions/presentActionInputForm';
import { t } from '@/text';
import { usePluginLocalizedTextResolver } from '@/sync/domains/plugins/ui/i18n';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { StrictJsonValueSchema, isJsonObject } from '@happier-dev/protocol/json/strictJsonValue';
import type { QualifiedConnectedAccountRef } from '@happier-dev/protocol/connect/qualifiedConnectedAccountPersistence';
import type { ResolveSessionActionFieldOptions } from '@/components/sessions/actions/sessionActionFieldOptions';
import { isSameActionInputOptionValue, type ActionInputOption } from '@happier-dev/protocol/actions/actionInputHintsRuntime';

const railway = 'happier.deploy.railway';
const railwayData = 'happier.deploy.railway-data';
const creation = { project: 'project-create', environment: 'environment-create' } as const;

function scopeOf(field: EffectiveInputField) {
  const type = field.inputType;
  if (!type || !('pluginId' in type)) return null;
  if (type.pluginId === railway) {
    if (type.localId === 'railway-project') return 'project';
    if (type.localId === 'railway-environment' || type.localId === 'railway-create-environment') return 'environment';
  }
  if (type.pluginId === railwayData) {
    if (type.localId === 'postgresql-project' || type.localId === 'mysql-project') return 'project';
    if (type.localId === 'postgresql-environment' || type.localId === 'mysql-environment') return 'environment';
  }
  return null;
}

function readChoice(value: Parameters<typeof isJsonObject>[0]) {
  return isJsonObject(value) && typeof value.id === 'string' && typeof value.name === 'string'
    ? { id: value.id, name: value.name } : null;
}

export function useRailwayScopeChoices(params: Readonly<{
  declarations: readonly Readonly<{ manifest: PluginPortableReleaseManifestV1 }>[] | undefined;
  lifetime: ServerAccountScopeLifetime;
  account: QualifiedConnectedAccountRef | null;
  fields: readonly EffectiveInputField[];
  values: Readonly<Record<string, unknown>>;
  onCreated: (values: Record<string, unknown>) => void;
}>) {
  const manifest = params.declarations?.find(entry => entry.manifest.id === railway)?.manifest;
  const project = params.fields.find(field => scopeOf(field) === 'project');
  const environment = params.fields.find(field => scopeOf(field) === 'environment');
  const active = Boolean(manifest && project && params.account);
  const execution = useMountedActionExecution(active ? params.lifetime.scope : null);
  const localize = usePluginLocalizedTextResolver({});
  const [selection, setSelection] = React.useState<Readonly<{
    account: QualifiedConnectedAccountRef;
    projectId: string;
    project?: ActionInputOption;
    environment: ActionInputOption;
  }> | null>(null);

  function choiceAction(field: EffectiveInputField, resolveOptions?: ResolveSessionActionFieldOptions) {
    if (!manifest || !project || !params.account) return undefined;
    const account = params.account;
    const scope = scopeOf(field);
    if (!scope || (scope === 'environment' && (!environment || typeof params.values[project.path] !== 'string'))) return undefined;
    const action = manifest.contributes.actions?.find(entry => entry.id === creation[scope]);
    const hints = action && normalizePluginActionInputHintsV2(action.inputHints);
    const purpose = action?.connectedAccountPurposeBindings?.find(entry => entry.path === 'credentialRef')?.purpose;
    if (!action || !hints || !purpose) return undefined;
    const label = localize(railway, action.title);
    return {
      label,
      run: () => {
        const identity = { pluginId: railway, localId: action.id };
        const selectedProject = params.values[project.path];
        const workspaceId = params.values.workspaceId;
        const existing = resolveOptions?.(field) ?? [];
        const form = createActionInputForm({
          presentation: {
            title: label,
            description: null,
            inputHints: { ...hints, fields: hints.fields.filter(entry => scope === 'environment'
              ? entry.path !== 'projectId' : entry.path !== 'workspaceId' || typeof workspaceId !== 'string')
              // A blank name still says what goes there.
              .map(entry => entry.path === 'name' ? { ...entry, placeholder: t(scope === 'project'
                ? 'projects.deployments.platformLink.projectNamePlaceholder'
                : 'projects.deployments.platformLink.environmentNamePlaceholder') } : entry) },
          },
          accountLifetime: params.lifetime,
          initialInput: {
            credentialRef: account,
            credentialPrincipal: {
              kind: 'account', accountId: params.lifetime.scope.accountId,
              purpose: { consumer: identity, purpose },
              target: { kind: 'account', account },
            },
            ...(scope === 'environment' ? { projectId: selectedProject } : typeof workspaceId === 'string' ? { workspaceId } : {}),
          },
          async submit(candidate, { signal }) {
            const result = await execution.executeForPresentation(ACTION_INVOKE_ACTION_ID_V1, { action: identity, input: candidate }, { signal });
            if (!result || signal.aborted) return { ok: false, cancelled: true };
            if (!result.ok) return { ...result, code: result.errorCode };
            const parsed = StrictJsonValueSchema.safeParse(result.result);
            if (!parsed.success) return { ok: false, code: 'provider_response_invalid' };
            const value = parsed.data;
            const createdProject = scope === 'project' && isJsonObject(value) ? readChoice(value.project) : null;
            const createdEnvironment = readChoice(scope === 'project' && isJsonObject(value) ? value.environment : value);
            const projectId = createdProject?.id ?? (scope === 'environment' ? selectedProject : undefined);
            if (!createdEnvironment || typeof projectId !== 'string') return { ok: false, code: 'provider_response_invalid' };
            const environmentValue = environment?.inputType?.localId === 'railway-create-environment'
              ? { kind: 'native', selection: { projectId, environmentId: createdEnvironment.id } }
              : createdEnvironment.id;
            const projectOption = createdProject ? { value: projectId, label: createdProject.name,
              ...(typeof candidate.workspaceId === 'string'
                ? { source: { kind: 'railway-workspace', locator: candidate.workspaceId } } : {}),
            } : undefined;
            setSelection(current => ({
              account, projectId, project: projectOption ?? (current?.projectId === projectId ? current.project : undefined),
              environment: { value: environmentValue, label: createdEnvironment.name },
            }));
            params.onCreated({
              [project.path]: projectId,
              ...(environment ? { [environment.path]: environmentValue } : {}),
            });
            return { ok: true };
          },
        });
        presentActionInputForm({
          form,
          validateInput: (input) => {
            const name = typeof input.name === 'string' ? input.name.trim().toLowerCase() : '';
            if (!name) return {};
            const duplicate = existing.some(option => {
              if (option.label.trim().toLowerCase() !== name) return false;
              if (scope === 'environment') return true;
              if (option.source?.kind === 'railway-workspace') return option.source.locator === input.workspaceId;
              return typeof workspaceId === 'string' && workspaceId === input.workspaceId;
            });
            if (!duplicate) return undefined;
            return { path: 'name', message: scope === 'project'
              ? t('plugins.railway.picker.duplicateProject')
              : t('plugins.railway.picker.duplicateEnvironment') };
          },
          actionId: formatQualifiedPluginActionId(identity),
          pickerContext: { serverId: params.lifetime.scope.serverId, accountLifetime: params.lifetime },
        });
      },
    };
  }

  function withCreatedChoices(resolve: ResolveSessionActionFieldOptions): ResolveSessionActionFieldOptions {
    if (!selection || selection.account !== params.account) return resolve;
    return Object.assign((field: EffectiveInputField) => {
      const options = resolve(field);
      const scope = scopeOf(field);
      const created = scope === 'project' ? selection.project
        : scope === 'environment' && project && params.values[project.path] === selection.projectId ? selection.environment : undefined;
      return created && !options.some(entry => isSameActionInputOptionValue(entry.value, created.value))
        ? [...options, created] : options;
    }, resolve);
  }
  return { choiceAction, withCreatedChoices };
}
