import * as React from 'react';
import { ACTION_INVOKE_ACTION_ID_V1 } from '@happier-dev/protocol/actions/actionIds';
import {
  isSameActionInputOptionValue, readActionInputOptionValue, type ActionInputOption,
} from '@happier-dev/protocol/actions/actionInputHintsRuntime';
import type { QualifiedConnectedAccountRef } from '@happier-dev/protocol/connect/qualifiedConnectedAccountPersistence';
import type { EffectiveInputField } from '@happier-dev/protocol/inputs/inputFieldRuntime';
import { readInputPath } from '@happier-dev/protocol/inputs/inputPredicates';
import { normalizePluginActionInputHintsV2 } from '@happier-dev/protocol/plugins/actions/v2';
import { formatQualifiedPluginActionId } from '@happier-dev/protocol/plugins/actions/qualifiedActionId';
import type { PluginPortableReleaseManifestV1 } from '@happier-dev/protocol/plugins/availability';
import { patchHappierActionInputPath } from '@happier-dev/plugin-ui/presentation';

import { useMountedActionExecution } from '@/components/approvals/useMountedActionExecution';
import { createActionInputForm } from '@/components/plugins/actions/actionInputForm';
import { presentActionInputForm } from '@/components/plugins/actions/presentActionInputForm';
import { usePluginLocalizedTextResolver } from '@/sync/domains/plugins/ui/i18n';
import { createPluginUiProjectedActionResolver, isPluginProjectedActionExecutable } from '@/sync/domains/plugins/ui/projection';
import type { InputTypePickerHostContext } from './InputTypePickerHostProvider';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import type { ResolveSessionActionFieldOptions } from './sessionActionFieldOptions';

type FieldCreation = NonNullable<EffectiveInputField['createNew']>;
type CreatedChoices = Readonly<Record<string, Readonly<{
  option: ActionInputOption;
  dependencies: readonly unknown[];
}>>>;

/** A declared picker choice opens an ordinary Action form and selects its successful result. */
export function useActionFieldCreation(params: Readonly<{
  declarations?: readonly Readonly<{ manifest: PluginPortableReleaseManifestV1 }>[];
  pickerContext?: InputTypePickerHostContext;
  lifetime: ServerAccountScopeLifetime;
  enabled: boolean;
  account: QualifiedConnectedAccountRef | null;
  fields: readonly EffectiveInputField[];
  values: Readonly<Record<string, unknown>>;
  onCreated: (patch: Record<string, unknown>) => void;
}>) {
  const enabled = params.enabled && params.fields.some(field => field.createNew);
  const execution = useMountedActionExecution(enabled ? params.lifetime.scope : null);
  const projection = params.pickerContext?.fieldCreationProjection ?? params.pickerContext?.pluginUiProjection;
  const localize = usePluginLocalizedTextResolver({ projection });
  const [selection, setSelection] = React.useState<Readonly<{
    account: QualifiedConnectedAccountRef | null;
    lifetime: ServerAccountScopeLifetime;
    choices: CreatedChoices;
  }> | null>(null);

  function choiceAction(field: EffectiveInputField, resolveOptions?: ResolveSessionActionFieldOptions) {
    const declaration = field.createNew;
    if (!enabled || !declaration) return undefined;
    const identity = declaration.action;
    const projected = createPluginUiProjectedActionResolver(projection?.actionsById)(identity);
    const admitted = isPluginProjectedActionExecutable(projected) ? projected : undefined;
    const action = params.declarations?.find(entry => entry.manifest.id === identity.pluginId)
      ?.manifest.contributes.actions?.find(entry => entry.id === identity.localId) ?? admitted?.accountActionDeclaration;
    const creator = action ?? admitted;
    if (!creator?.surfaces.includes('ui')) return undefined;
    const machineId = creator.execution.target === 'daemon' ? params.pickerContext?.machineId : null;
    if (creator.execution.target === 'daemon' && !machineId) return undefined;
    const hints = normalizePluginActionInputHintsV2(creator.inputHints, action?.inputSchema, text => localize(identity.pluginId, text));
    if (!hints) return undefined;
    const account = params.account;
    let initialInput: Record<string, unknown> = {};
    for (const [target, binding] of Object.entries(declaration.initialInput ?? {})) {
      const value = readInputPath(params.values, binding.path);
      if (value === undefined || value === null || value === '') {
        if (binding.required) return undefined;
      } else {
        initialInput = { ...initialInput, ...patchHappierActionInputPath(initialInput, target, value) };
      }
    }
    const boundPaths = new Set(Object.keys(declaration.initialInput ?? {})
      .filter(path => readInputPath(initialInput, path) !== undefined));
    const credential = action?.connectedAccountPurposeBindings?.find(binding => binding.path === 'credentialRef');
    if (credential && account) {
      initialInput = {
        ...initialInput,
        credentialRef: account,
        ...(action?.inputSchema?.properties?.credentialPrincipal ? {
          credentialPrincipal: {
            kind: 'account', accountId: params.lifetime.scope.accountId,
            purpose: { consumer: identity, purpose: credential.purpose },
            target: { kind: 'account', account },
          },
        } : {}),
      };
      boundPaths.add('credentialRef');
      boundPaths.add('credentialPrincipal');
    }
    const label = localize(identity.pluginId, creator.title);
    const duplicate = declaration.duplicateName;
    return {
      label,
      run: () => {
        const existing = duplicate ? resolveOptions?.(field) ?? [] : [];
        const form = createActionInputForm({
          presentation: {
            title: label,
            description: null,
            inputHints: { ...hints, fields: hints.fields.filter(entry =>
              ![...boundPaths].some(path => entry.path === path || entry.path.startsWith(path + '.'))) },
          },
          accountLifetime: params.lifetime,
          initialInput,
          async submit(candidate, { signal }) {
            const result = await execution.executeForPresentation(ACTION_INVOKE_ACTION_ID_V1, {
              action: identity,
              input: candidate,
              ...(machineId && admitted ? { expectedContributorOccurrenceId: admitted.occurrenceId } : {}),
            }, {
              signal,
              ...(machineId ? { externalActionTarget: { kind: 'machine', machineId } } : {}),
              ...(params.pickerContext?.sessionId ? { defaultSessionId: params.pickerContext.sessionId } : {}),
            });
            if (!result || signal.aborted) return { ok: false, cancelled: true };
            if (!result.ok) return { ...result, code: result.errorCode };
            const primary = readCreatedOption(result.result, declaration.result);
            if (!primary) return { ok: false, code: 'provider_response_invalid' };
            const source = duplicate?.source;
            const locator = source && readInputPath(candidate, source.inputPath);
            const created = new Map([[field.path, source && typeof locator === 'string'
              ? { ...primary, source: { kind: source.kind, locator } } : primary]]);
            for (const target of params.fields) {
              const mapping = declaration.alsoSelect?.[target.path];
              if (!mapping || target.path === field.path || target.widget !== 'select') continue;
              const option = readCreatedOption(result.result, mapping);
              if (!option) return { ok: false, code: 'provider_response_invalid' };
              created.set(target.path, option);
            }

            let patch: Record<string, unknown> = {};
            for (const [path, option] of created) {
              patch = { ...patch, ...patchHappierActionInputPath({ ...params.values, ...patch }, path, option.value) };
            }
            const next = { ...params.values, ...patch };
            const choices = Object.fromEntries(params.fields.flatMap(target => {
              const option = created.get(target.path);
              return option ? [[target.path, { option, dependencies: readDependencies(target, next) }]] : [];
            }));
            setSelection(current => ({
              account,
              lifetime: params.lifetime,
              choices: { ...(current?.account === account && current.lifetime === params.lifetime ? current.choices : undefined), ...choices },
            }));
            params.onCreated(patch);
            return { ok: true };
          },
        });
        presentActionInputForm({
          form,
          signal: execution.getSignal(),
          validateInput: duplicate ? input => {
            const name = readInputPath(input, duplicate.path);
            if (typeof name !== 'string' || !name.trim()) return {};
            const match = existing.some(option => {
              if (option.label.trim().toLowerCase() !== name.trim().toLowerCase()) return false;
              if (!duplicate.source) return true;
              const locator = readInputPath(input, duplicate.source.inputPath);
              if (typeof locator !== 'string') return false;
              return option.source?.kind === duplicate.source.kind
                ? option.source.locator === locator
                : readInputPath(initialInput, duplicate.source.inputPath) === locator;
            });
            return match ? { path: duplicate.path, message: localize(identity.pluginId, duplicate.message) } : undefined;
          } : undefined,
          actionId: formatQualifiedPluginActionId(identity),
          pickerContext: { ...params.pickerContext, serverId: params.lifetime.scope.serverId, accountLifetime: params.lifetime },
        });
      },
    };
  }

  function withCreatedChoices(resolve: ResolveSessionActionFieldOptions): ResolveSessionActionFieldOptions {
    if (!enabled || !selection || selection.lifetime !== params.lifetime || selection.account !== params.account) return resolve;
    return Object.assign((field: EffectiveInputField) => {
      const options = resolve(field);
      const created = selection.choices[field.path];
      if (!created || !readDependencies(field, params.values).every((value, index) => {
        const current = readActionInputOptionValue(value);
        const previous = readActionInputOptionValue(created.dependencies[index]);
        return current === undefined || previous === undefined
          ? current === previous : isSameActionInputOptionValue(current, previous);
      })) return options;
      return options.some(entry => isSameActionInputOptionValue(entry.value, created.option.value))
        ? options : [...options, created.option];
    }, resolve);
  }

  return { choiceAction, withCreatedChoices };
}

function readDependencies(field: EffectiveInputField, values: Readonly<Record<string, unknown>>): readonly unknown[] {
  return (field.optionsDraftDependencies ?? []).map(path => readInputPath(values, path));
}

function readCreatedOption(result: unknown, mapping: FieldCreation['result']): ActionInputOption | undefined {
  const value = readActionInputOptionValue(readInputPath(result, mapping.valuePath));
  const label = readInputPath(result, mapping.labelPath);
  return value !== undefined && typeof label === 'string' && label.trim() ? { value, label } : undefined;
}
