import {
    MachinePresetActionInputSchemasV1, MachinePresetActionOutputSchemasV1,
    type MachinePresetActionIdV1, type MachinePresetActionInputV1, type MachinePresetActionOutputV1,
} from '@happier-dev/protocol/machines/managed/machinePresetActionsV1';
import type { ManagedMachinePresetV1 } from '@happier-dev/protocol/machines/managed/managedMachinePresetV1';
import { ManagedListOutputV1Schema } from '@happier-dev/protocol/machines/managed/actionsV1';
import type { ManagedMachineV1 } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import { mergeMachineSetupsV1 } from '@happier-dev/protocol/machines/managed/machineSetupV1';
import type { MachineSetupSourceV1 } from '@happier-dev/protocol/machines/setup/machineSetupSourcesV1';

import { scopedHomeActionExecutor } from '@/sync/ops/actions/scopedHomeActionExecutor';
import { captureLazyActionAccountContext } from '@/sync/ops/actions/actionAccountContext';
import { observeHomeActionOutcome } from '@/sync/ops/home/homeActionOutcome';
import { homeDomainFailureCode } from '@/sync/api/home/homeDomainActions';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { storage } from '@/sync/domains/state/storageStore';
import { resolveServerScopedMachine } from '@/sync/domains/machines/resolveServerScopedMachine';
import { readMachineName } from '@/utils/sessions/machineDisplayNames';
import {
    awaitActionApprovalResult,
    type ActionApprovalContinuation, type ActionApprovalRegistration,
} from '@/components/approvals/actionApprovalContinuation';
import { machinePresetEditDraftContent, machinePresetEditDraftUpdatePatch, type MachinePresetEditDraft } from '@/sync/domains/machines/presets/machinePresetEditDraft';

export type MachinePresetCollectionResult<T> =
    | Readonly<{ kind: 'succeeded'; value: T }>
    | Readonly<{ kind: 'approval_pending'; approval: ActionApprovalContinuation }>
    | Readonly<{ kind: 'failed'; code: string }>;
export type MachinePresetCollectionSettledResult<T> = Exclude<MachinePresetCollectionResult<T>, { kind: 'approval_pending' }>;
export type MachinePresetCollectionOptions<T> = Readonly<{
    signal?: AbortSignal;
    /** Existing record context for content-only edits; never a native controller mutation. */
    preset?: Readonly<Pick<ManagedMachinePresetV1, 'owner' | 'controller' | 'teamAcquireDelegated'>>;
    onApprovalPending?: (approval: ActionApprovalRegistration) => void;
    /** A deferred read has finished; subsequent ordinary reads are refreshable again. */
    onApprovalSettled?: () => void;
    onApprovalSucceeded?: (value: T) => void | Promise<void>;
    onApprovalFailed?: (code: string) => void;
}>;
export type MachinePresetHistoryData = Readonly<{ preset: ManagedMachinePresetV1; machines: readonly ManagedMachineV1[] }>;
export type MachinePresetDraftSaveInput = Readonly<{ draft: MachinePresetEditDraft } & (
    | { preset: Readonly<Pick<ManagedMachinePresetV1, 'id' | 'revision'>
        & Partial<Pick<ManagedMachinePresetV1, 'owner' | 'controller' | 'teamAcquireDelegated'>>> }
    | { id: string; owner: ManagedMachinePresetV1['owner'] }
)>;

function readPresetDomainFailureResult<T extends MachinePresetActionIdV1>(actionId: T, code: string,
    details: unknown): MachinePresetActionOutputV1<T> | null {
    const output = MachinePresetActionOutputSchemasV1[actionId].safeParse(details);
    if (!output.success) return null;
    const value = output.data;
    // Approval history classifies these exact domain answers as failures. The
    // preset client still owes its caller the same typed answer as a direct write.
    return value.kind === 'conflict' && code === 'conflict'
        || value.kind === 'refused' && value.code === code
        ? value as MachinePresetActionOutputV1<T> : null;
}

/** Settings reads and mutations all pass through the existing exact-Home Action front door. */
export function createMachinePresetCollectionClient(scope: ServerAccountScope, homeId: string) {
    const executeAction = scopedHomeActionExecutor(scope);
    const context = (signal?: AbortSignal) => ({ surface: 'ui' as const, authority: 'present_user' as const,
        serverId: scope.serverId, expectedAccountId: scope.accountId, ...(signal ? { signal } : {}) });

    const readControllerDisplayName = (controller: NonNullable<ManagedMachinePresetV1['controller']>) => {
        const machine = resolveServerScopedMachine(storage.getState(), scope.serverId, controller.machineId);
        return machine?.installationId === controller.installationId ? readMachineName(machine) : null;
    };

    async function isPlainAuthor(signal?: AbortSignal): Promise<boolean> {
        try {
            const account = await captureLazyActionAccountContext(scope.serverId, signal);
            try {
                if (account.accountId !== scope.accountId) return false;
                return await account.resolveAccountMode() === 'plain';
            } finally { account.dispose(); }
        } catch { return false; }
    }

    async function execute<T extends MachinePresetActionIdV1>(actionId: T, input: MachinePresetActionInputV1<T>,
        options?: MachinePresetCollectionOptions<MachinePresetActionOutputV1<T>>): Promise<MachinePresetCollectionResult<MachinePresetActionOutputV1<T>>> {
        // Keep mutation arms concrete while parsing each request exactly once.
        // Disclosure and dispatch below consume that same parsed object.
        const update = actionId === 'machines.presets.update'
            ? MachinePresetActionInputSchemasV1['machines.presets.update'].safeParse(input) : null;
        const create = actionId === 'machines.presets.create'
            ? MachinePresetActionInputSchemasV1['machines.presets.create'].safeParse(input) : null;
        const parsed = update ?? create ?? MachinePresetActionInputSchemasV1[actionId].safeParse(input);
        if (!parsed.success || parsed.data.homeId !== homeId) return { kind: 'failed', code: 'invalid_parameters' };
        // Only a Plain author's delegated Team recipe publishes this plaintext label.
        // Approval continuation retains these captured bytes without another disclosure.
        if (update?.success) {
            const patch = update.data.patch;
            const delegated = patch.teamAcquireDelegated ?? options?.preset?.teamAcquireDelegated;
            const controller = patch.controller === undefined && (patch.name !== undefined || patch.setup !== undefined || patch.launch !== undefined)
                ? options?.preset?.controller : patch.controller;
            if (options?.preset?.owner.kind !== 'team' || delegated !== true
                || (controller || typeof patch.controllerDisplayName === 'string') && !await isPlainAuthor(options?.signal)) {
                delete patch.controllerDisplayName;
            } else if (controller) {
                const name = readControllerDisplayName(controller);
                if (name === null) delete patch.controllerDisplayName;
                else patch.controllerDisplayName = name;
            }
        } else if (create?.success) {
            const presetInput = create.data;
            if (presetInput.owner.kind !== 'team' || presetInput.teamAcquireDelegated !== true
                || !await isPlainAuthor(options?.signal)) delete presetInput.controllerDisplayName;
            else if (presetInput.controller) {
                const name = readControllerDisplayName(presetInput.controller);
                if (name === null) delete presetInput.controllerDisplayName;
                else presetInput.controllerDisplayName = name;
            }
        }
        const outcome = observeHomeActionOutcome<MachinePresetActionOutputV1<T>, T>({
            result: await executeAction(actionId, parsed.data, context(options?.signal)),
            actionId, actionInput: parsed.data, scope, signal: options?.signal,
            onSucceeded: async value => await options?.onApprovalSucceeded?.(value),
            onFailed: (code, failure) => {
                const value = readPresetDomainFailureResult(actionId, code, failure?.details);
                if (value) {
                    void Promise.resolve().then(() => options?.onApprovalSucceeded?.(value))
                        .catch(() => options?.onApprovalFailed?.('operation_failed'));
                } else options?.onApprovalFailed?.(code);
            },
        });
        if (outcome.kind === 'failed') {
            const code = homeDomainFailureCode(outcome.failure);
            const value = readPresetDomainFailureResult(actionId, code, outcome.failure.details);
            return value ? { kind: 'succeeded', value } : { kind: 'failed', code };
        }
        if (outcome.kind === 'approval_pending') {
            options?.onApprovalPending?.(outcome.approval);
            return outcome;
        }
        const output = MachinePresetActionOutputSchemasV1[actionId].safeParse(outcome.result);
        return output.success ? { kind: 'succeeded', value: output.data as MachinePresetActionOutputV1<T> }
            : { kind: 'failed', code: 'invalid_action_output' };
    }

    function read<T extends MachinePresetActionIdV1>(actionId: T, input: MachinePresetActionInputV1<T>,
        options?: MachinePresetCollectionOptions<MachinePresetActionOutputV1<T>>) {
        let awaitingApproval = false;
        return awaitActionApprovalResult<MachinePresetActionOutputV1<T>, MachinePresetCollectionSettledResult<MachinePresetActionOutputV1<T>>>({
            execute: async callbacks => {
                const result = await execute(actionId, input, { ...options, ...callbacks, onApprovalPending: approval => {
                    awaitingApproval = true;
                    options?.onApprovalPending?.(approval);
                } });
                return result.kind === 'approval_pending' ? { approvalPending: true } : result;
            },
            succeeded: value => ({ kind: 'succeeded', value }), failed: code => ({ kind: 'failed', code }),
            aborted: () => ({ kind: 'failed', code: 'aborted' }), ...(options?.signal ? { signal: options.signal } : {}),
        }).finally(() => { if (awaitingApproval) options?.onApprovalSettled?.(); });
    }

    async function list(options?: MachinePresetCollectionOptions<readonly ManagedMachinePresetV1[]>): Promise<MachinePresetCollectionSettledResult<readonly ManagedMachinePresetV1[]>> {
        const presets: ManagedMachinePresetV1[] = [];
        let cursor: string | undefined;
        do {
            const result = await read('machines.presets.list', { homeId, includeArchived: true, ...(cursor ? { cursor } : {}) },
                { signal: options?.signal, onApprovalPending: options?.onApprovalPending, onApprovalSettled: options?.onApprovalSettled });
            if (result.kind === 'failed') return result;
            if (result.value.kind === 'refused') return { kind: 'failed', code: result.value.code };
            presets.push(...result.value.presets);
            cursor = result.value.cursor;
        } while (cursor);
        return { kind: 'succeeded', value: presets };
    }

    async function detail(id: string, options?: MachinePresetCollectionOptions<MachinePresetHistoryData>): Promise<MachinePresetCollectionSettledResult<MachinePresetHistoryData>> {
        const result = await read('machines.presets.get', { homeId, id }, { signal: options?.signal,
            onApprovalPending: options?.onApprovalPending, onApprovalSettled: options?.onApprovalSettled });
        if (result.kind === 'failed') return result;
        if (result.value.kind === 'refused') return { kind: 'failed', code: result.value.code };
        // Archived managed rows are not part of the ordinary inventory response. Both reads
        // are required for history; neither modifies a resource or counts client-side capacity.
        const results = await Promise.all([false, true].map(async archived => {
            const input = { homeId, presetId: id, ...(archived ? { archived: true } : {}) };
            let awaitingApproval = false;
            return awaitActionApprovalResult<ManagedMachineV1[], MachinePresetCollectionSettledResult<ManagedMachineV1[]>>({
                execute: async callbacks => {
                    const outcome = observeHomeActionOutcome<{ machines: ManagedMachineV1[] }, 'machines.managed.list'>({
                        result: await executeAction('machines.managed.list', input, context(options?.signal)),
                        actionId: 'machines.managed.list', actionInput: input, scope, signal: options?.signal,
                        onSucceeded: value => callbacks.onApprovalSucceeded(value.machines), onFailed: callbacks.onApprovalFailed,
                    });
                    if (outcome.kind === 'failed') return { kind: 'failed', code: homeDomainFailureCode(outcome.failure) };
                    if (outcome.kind === 'approval_pending') {
                        awaitingApproval = true;
                        options?.onApprovalPending?.(outcome.approval);
                        return { approvalPending: true };
                    }
                    const output = ManagedListOutputV1Schema.safeParse(outcome.result);
                    return output.success ? { kind: 'succeeded', value: output.data.machines }
                        : { kind: 'failed', code: 'invalid_action_output' };
                },
                succeeded: value => ({ kind: 'succeeded', value }), failed: code => ({ kind: 'failed', code }),
                aborted: () => ({ kind: 'failed', code: 'aborted' }), ...(options?.signal ? { signal: options.signal } : {}),
            }).finally(() => { if (awaitingApproval) options?.onApprovalSettled?.(); });
        }));
        const failed = results.find(item => item.kind === 'failed');
        if (failed?.kind === 'failed') return failed;
        const rows = results.flatMap(item => item.kind === 'succeeded' ? item.value : []);
        if (rows.some(machine => machine.homeId !== homeId || machine.preset?.id !== id)) return { kind: 'failed', code: 'invalid_action_output' };
        // A row can move to archive between the two reads; it remains one resource.
        const machines = [...new Map(rows.map(machine => [machine.id, machine])).values()];
        return { kind: 'succeeded', value: { preset: result.value.preset, machines } };
    }

    /** The editor's full draft has the same Save path with or without creation. */
    function saveDraft(input: MachinePresetDraftSaveInput,
        options?: MachinePresetCollectionOptions<MachinePresetActionOutputV1<'machines.presets.update'>>) {
        return 'preset' in input ? execute('machines.presets.update', {
            homeId, id: input.preset.id, expectedRevision: input.preset.revision,
            patch: machinePresetEditDraftUpdatePatch(input.draft),
        }, { ...options, ...(input.preset.owner ? { preset: { owner: input.preset.owner,
            controller: input.preset.controller, teamAcquireDelegated: input.preset.teamAcquireDelegated } } : {}) }) : execute('machines.presets.create', {
            homeId, id: input.id, owner: input.owner, ...machinePresetEditDraftContent(input.draft),
        }, options);
    }

    /** Save the reviewed retained copies without resolving their original Presets again. */
    function capture(input: Omit<MachinePresetActionInputV1<'machines.presets.create'>, 'setup'>,
        sources: MachineSetupSourceV1,
        options?: MachinePresetCollectionOptions<MachinePresetActionOutputV1<'machines.presets.create'>>) {
        const merged = mergeMachineSetupsV1(sources.map(source => source.setup));
        return merged.ok ? execute('machines.presets.create', { ...input, setup: merged.setup }, options)
            : Promise.resolve<MachinePresetCollectionResult<MachinePresetActionOutputV1<'machines.presets.create'>>>(
                { kind: 'failed', code: merged.errorCode });
    }

    return Object.freeze({ execute, read, list, detail, capture, saveDraft });
}
