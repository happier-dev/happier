import * as React from 'react';
import { useMachineSetupListingOption, type StoreSoftwareItem, type StoreSoftwareTarget } from './catalog/storeSoftware';
import type { StoreDemand } from './catalog/storeKinds';
import { MachineRecipeReferenceV1Schema, machineRecipeInputConstraintsSatisfiedV1 } from '@happier-dev/protocol/machines/setup/machineRecipeV1';
import { MachineSetupToolchainSoftwareChoiceV1Schema } from '@happier-dev/protocol/plugins/contributions/projectNativeAdapters';
import { MachineSetupV1Schema, type MachineSetupV1 } from '@happier-dev/protocol/machines/managed/machineSetupV1';
import { preparePluginJsonSchema } from '@happier-dev/protocol/plugins/actions/json-schema-validation';
import { isSameActionInputOptionValue, actionInputOptionValueKey } from '@happier-dev/protocol/actions/actionInputHintsRuntime';
import type { JsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import type { ActionExecuteFailure } from '@happier-dev/protocol/actions/actionExecutionResult';
import type { MachineSetupApplyInputV1 } from '@happier-dev/protocol/machines/managed/actionsV1';
import { createFrontDoorActionExecute } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';
import { prepareMachineSetupSoftwareApplyInput } from '@/components/settings/machines/managed/machineSetupSoftware';
import type { MachineSetupPreparedApply } from '@/components/settings/machines/managed/machineSetupReview';

const execute = createFrontDoorActionExecute();

export type StoreSoftwareConfiguration = Readonly<{ ok: true; setup: MachineSetupV1 }> | ActionExecuteFailure;
export type StoreSoftwareEntryState = ReturnType<typeof useMachineSetupListingOption>['state'] & Readonly<{
    recipeKind: 'setupRecipe' | 'softwareRecipe' | null;
    configure: (inputs: JsonValue) => StoreSoftwareConfiguration;
    prepare: (input: Readonly<{ inputs: JsonValue; targets: readonly StoreSoftwareTarget[]; selectedMachineId?: string }>) => Promise<MachineSetupPreparedApply>;
    apply: (input: MachineSetupApplyInputV1) => ReturnType<typeof execute>;
}>;

/** Selected declaration/configuration demand only; the composition lane owns fields and review anatomy. */
export function StoreSoftwareEntry(props: Readonly<{
    target: StoreSoftwareTarget;
    selection: StoreSoftwareItem;
    demand: StoreDemand;
    refreshKey?: string;
    children: (state: StoreSoftwareEntryState) => React.ReactNode;
}>): React.ReactNode {
    const native = useMachineSetupListingOption(props.target, props.demand, props.selection.value, props.refreshKey);
    const declaration = native.state.machineRecipeDetails?.[0]?.definition;
    const recipeKind = declaration ? declaration.software === true ? 'softwareRecipe' : 'setupRecipe' : null;
    const schema = React.useMemo(() => declaration ? preparePluginJsonSchema(declaration.inputSchema) : null, [declaration]);
    const latest = React.useRef({ native, props, schema, declaration, recipeKind });
    latest.current = { native, props, schema, declaration, recipeKind };
    const choiceKey = actionInputOptionValueKey(props.selection.value);
    const preparation = React.useRef<AbortController | null>(null);
    const scopeKey = JSON.stringify([props.target.scope, props.target.machine]);
    React.useEffect(() => () => { preparation.current?.abort(); }, [props.demand.presented, scopeKey, choiceKey]);
    const configure = React.useCallback((inputs: JsonValue): StoreSoftwareConfiguration => {
        const current = latest.current;
        const failure = (errorCode: string): ActionExecuteFailure => ({ ok: false, errorCode, error: errorCode });
        const state = current.native.state;
        if (state.status !== 'ready') return failure(state.errorCode ?? 'unavailable');
        const choice = state.options.find(option => isSameActionInputOptionValue(option.value, current.props.selection.value));
        if (!choice || choice.disabled) return failure('unavailable');
        const toolchain = MachineSetupToolchainSoftwareChoiceV1Schema.safeParse(choice.value);
        if (toolchain.success) {
            if (typeof inputs !== 'string') return failure('invalid_parameters');
            return { ok: true, setup: { toolchain: { adapterId: toolchain.data.adapterId, config: inputs } } };
        }
        const ref = MachineRecipeReferenceV1Schema.safeParse(choice.value);
        if (!ref.success || !current.recipeKind || !current.declaration || !current.schema?.validate(inputs)
            || !machineRecipeInputConstraintsSatisfiedV1(current.declaration, inputs)) return failure('invalid_parameters');
        return { ok: true, setup: MachineSetupV1Schema.parse({ items: [{ kind: current.recipeKind, selection: { ref: ref.data, inputs } }] }) };
    }, []);
    const prepare = React.useCallback(async (input: Parameters<StoreSoftwareEntryState['prepare']>[0]): Promise<MachineSetupPreparedApply> => {
        const configured = configure(input.inputs);
        if (!configured.ok) return configured;
        const current = latest.current;
        const root = current.native.target;
        if (!root?.scope || !root.machine) return { ok: false, errorCode: 'continuation_retired', error: 'continuation_retired' };
        const targets = input.targets.flatMap(target => target.machine
            ? [{ homeId: target.machine.serverIdentityId, machineId: target.machine.machineId }] : []);
        if (targets.length !== input.targets.length) return {
            ok: false, errorCode: 'machine_unavailable', error: 'machine_unavailable',
        };
        preparation.current?.abort();
        const controller = new AbortController();
        preparation.current = controller;
        try { return await prepareMachineSetupSoftwareApplyInput({ executeAction: execute, context: { surface: 'ui', serverId: root.scope.serverId,
            expectedAccountId: root.scope.accountId, signal: controller.signal }, homeId: root.machine.serverIdentityId, machineId: root.machine.machineId,
            targets,
            setup: configured.setup, selectedMachineId: input.selectedMachineId,
            isCurrent: () => !controller.signal.aborted });
        } finally { if (preparation.current === controller) preparation.current = null; }
    }, [configure]);
    const apply = React.useCallback((input: MachineSetupApplyInputV1): ReturnType<typeof execute> => {
        // Public Apply owns exact-input confirmation, currentness, operation custody and signed child admission.
        return execute.confirmed('machines.setup.apply', input, { surface: 'ui', serverId: props.target.scope?.serverId,
            expectedAccountId: props.target.scope?.accountId });
    }, [props.target.scope?.serverId, props.target.scope?.accountId]);
    return props.children({ ...native.state, recipeKind, configure, prepare, apply });
}
