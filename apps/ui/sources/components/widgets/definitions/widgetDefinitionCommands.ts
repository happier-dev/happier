import { ActionApprovalRequestCreatedResultSchema, type ActionExecuteResult } from '@happier-dev/protocol/actions/actionExecutionResult';
import { getActionSpec, type PublicActionInputById, type PublicActionResultById } from '@happier-dev/protocol/actions/actionSpecs';
import type { ActionId } from '@happier-dev/protocol/actions/actionIds';
import type { ActionExecutorContext } from '@happier-dev/protocol/actions/executor/types';
import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import type { WidgetDefinitionV1, WidgetLayoutFragmentV1 } from '@happier-dev/protocol/widgets';

import { randomUUID } from '@/platform/randomUUID';
import { createFrontDoorActionExecute, type UiActionOperation } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';

const executeWidgetAction = createFrontDoorActionExecute();

/**
 * The definition, promotion and snapshot screens call the canonical `widgets.*` Actions — the very
 * operations an agent uses — and read back one of three facts: it happened (with the parsed result),
 * it is waiting for approval in the Inbox, or it was refused with a code. No screen writes an
 * Artifact or a Board item itself.
 */
export type WidgetDefinitionCommandOutcome<Result> =
    | Readonly<{ kind: 'applied'; result: Result }>
    | Readonly<{ kind: 'approvalPending' }>
    | Readonly<{ kind: 'refused'; errorCode: string; details?: unknown }>;

type CommandId = Extract<ActionId,
    | 'widgets.catalog.list'
    | 'widgets.fragment.list'
    | 'widgets.fragment.get'
    | 'widgets.fragment.create'
    | 'widgets.fragment.update'
    | 'widgets.fragment.duplicate'
    | 'widgets.fragment.delete'
    | 'widgets.group.add'
    | 'widgets.definition.get'
    | 'widgets.definition.list'
    | 'widgets.definition.duplicate'
    | 'widgets.definition.saveFromSession'
    | 'widgets.item.add'
    | 'widgets.item.list'
    | 'widgets.item.remove'
    | 'widgets.item.size.set'
    | 'widgets.item.network.set'
    | 'widgets.item.refresh'
    | 'widgets.snapshot.post'>;

/** The exact Home and Account the person is acting in; a call never drifts to another. */
export type WidgetCommandTarget = Readonly<{ serverId: string; accountId: string }>;

/** All widget Action adapters distinguish a committed result from approval custody. */
export function classifyWidgetDefinitionCommandResult<Id extends CommandId>(
    actionId: Id,
    result: ActionExecuteResult,
): WidgetDefinitionCommandOutcome<PublicActionResultById[Id]> {
    if (!result.ok) return { kind: 'refused', errorCode: result.errorCode ?? 'widget_command_failed',
        ...(result.details === undefined ? {} : { details: result.details }) };
    if (ActionApprovalRequestCreatedResultSchema.safeParse(result.result).success) return { kind: 'approvalPending' };
    const parsed = getActionSpec(actionId).outputSchema?.safeParse(result.result);
    if (!parsed?.success) return { kind: 'refused', errorCode: 'invalid_action_output' };
    return { kind: 'applied', result: parsed.data as PublicActionResultById[Id] };
}

type ArtifactWriteId = 'widgets.definition.saveFromSession' | 'widgets.definition.duplicate'
    | 'widgets.fragment.create' | 'widgets.fragment.duplicate';
type ArtifactWriteResult<Id extends ArtifactWriteId> = Id extends 'widgets.definition.saveFromSession' | 'widgets.definition.duplicate'
    ? Readonly<{ definition: WidgetDefinitionV1 }> : Readonly<{ fragment: WidgetLayoutFragmentV1 }>;

/**
 * One explicit Save/Duplicate owns its prepared identity until acknowledgement. A retry reads that
 * identity through the same Action first; an unavailable read never authorizes another create.
 * The caller starts another attempt only for a new intentional copy.
 */
export function createWidgetArtifactWriteAttempt<Id extends ArtifactWriteId>(actionId: Id, target: WidgetCommandTarget): Readonly<{
    run(input: PublicActionInputById[Id] | (() => PublicActionInputById[Id]), signal?: AbortSignal): Promise<WidgetDefinitionCommandOutcome<ArtifactWriteResult<Id>>>;
}> {
    let prepared: PublicActionInputById[Id] | undefined;
    let previous: WidgetDefinitionCommandOutcome<ArtifactWriteResult<Id>> | undefined;
    let pending: Promise<WidgetDefinitionCommandOutcome<ArtifactWriteResult<Id>>> | undefined;
    const account = { serverId: target.serverId, accountId: target.accountId };
    const definition = actionId === 'widgets.definition.saveFromSession' || actionId === 'widgets.definition.duplicate';
    // Both read and write schemas guarantee the projected entity. Save's suggested bindings and
    // About's placement census are operation-specific facts, not part of an Artifact write receipt.
    const applied = (result: Readonly<{ definition: WidgetDefinitionV1 }> | Readonly<{ fragment: WidgetLayoutFragmentV1 }>): WidgetDefinitionCommandOutcome<ArtifactWriteResult<Id>> => ({
        kind: 'applied', result: ('definition' in result ? { definition: result.definition } : { fragment: result.fragment }) as ArtifactWriteResult<Id>,
    });
    return {
        run(input: PublicActionInputById[Id] | (() => PublicActionInputById[Id]), signal?: AbortSignal): Promise<WidgetDefinitionCommandOutcome<ArtifactWriteResult<Id>>> {
            if (pending) return pending;
            if (previous?.kind === 'applied') return Promise.resolve(previous);
            pending = (async () => {
                if (prepared && previous) {
                    if (previous.kind === 'refused' && (previous.errorCode === 'widget_definition_already_exists'
                        || previous.errorCode === 'widget_fragment_already_exists')) return previous;
                    const artifactId = 'newArtifactId' in prepared ? prepared.newArtifactId : prepared.artifactId;
                    const read = definition
                        ? await runWidgetDefinitionCommand('widgets.definition.get', { account, artifactId }, target, signal)
                        : await runWidgetDefinitionCommand('widgets.fragment.get', { account, artifactId }, target, signal);
                    if (read.kind === 'applied') return applied(read.result);
                    if (previous.kind === 'approvalPending' || read.kind !== 'refused'
                        || read.errorCode !== (definition ? 'widget_definition_not_found' : 'widget_fragment_not_found')) return previous;
                }
                // Preparation belongs to the command boundary as well (UUID/platform failure is retryable).
                const outcome = await runWidgetDefinitionCommand(actionId, () => {
                    prepared ??= typeof input === 'function' ? input() : input;
                    return prepared;
                }, target, signal);
                return outcome.kind === 'applied' ? applied(outcome.result) : outcome;
            })().then(outcome => { previous = outcome; return outcome; }).finally(() => { pending = undefined; });
            return pending;
        },
    };
}

/** Gallery's prepared-instance custody, shared by Add-to and Save's destination setup. */
export function createWidgetItemAddAttempt(target: WidgetCommandTarget): Readonly<{
    run(input: () => PublicActionInputById['widgets.item.add'], widgetAreaContext: ActionExecutorContext['widgetAreaContext']): Promise<WidgetDefinitionCommandOutcome<PublicActionResultById['widgets.item.add']>>;
}> {
    type Input = PublicActionInputById['widgets.item.add'];
    type Outcome = WidgetDefinitionCommandOutcome<PublicActionResultById['widgets.item.add']>;
    let prepared: Input | undefined;
    let previous: Outcome | undefined;
    let pending: Promise<Outcome> | undefined;
    return {
        run(input: () => Input, widgetAreaContext: ActionExecutorContext['widgetAreaContext']): Promise<Outcome> {
            if (pending) return pending;
            if (previous?.kind === 'applied') return Promise.resolve(previous);
            pending = (async (): Promise<Outcome> => {
                let correctRefusedInput = false;
                if (prepared && previous) {
                    const read = await runWidgetDefinitionCommand('widgets.item.list', { surface: prepared.surface }, target);
                    if (read.kind !== 'applied') return previous;
                    const found = read.result.instances.find(entry => entry.instance.id === prepared!.instance.id);
                    if (found) return sameStrictJsonValue(read.result.surface, prepared.surface)
                        && sameStrictJsonValue(found.instance, prepared.instance)
                        && (prepared.size === undefined || prepared.size === found.size)
                        && (prepared.area === undefined || sameStrictJsonValue(prepared.area, found.area))
                        ? { kind: 'applied', result: { ref: { surface: read.result.surface, instanceId: found.instance.id }, instance: found.instance } }
                        : { kind: 'refused', errorCode: 'widget_instance_already_exists' };
                    if (previous.kind === 'approvalPending') return previous;
                    correctRefusedInput = previous.kind === 'refused' && previous.errorCode !== 'widget_add_unknown';
                }
                return runWidgetDefinitionCommand('widgets.item.add', () => {
                    if (correctRefusedInput && prepared) {
                        const corrected = input();
                        prepared = { ...corrected, instance: { ...corrected.instance, id: prepared.instance.id } };
                    }
                    prepared ??= input();
                    return prepared;
                },
                    target, undefined, widgetAreaContext);
            })().then(outcome => { previous = outcome; return outcome; }).finally(() => { pending = undefined; });
            return pending;
        },
    };
}

export async function runWidgetDefinitionCommand<Id extends CommandId>(
    actionId: Id,
    input: PublicActionInputById[Id] | (() => PublicActionInputById[Id] | Promise<PublicActionInputById[Id]>),
    target: WidgetCommandTarget,
    signal?: AbortSignal,
    widgetAreaContext?: ActionExecutorContext['widgetAreaContext'],
    /**
     * The screen itself was the person's confirmation of this exact Action (a preview they read and
     * pressed). It satisfies the policy's default UI confirmation once, so no second dialog follows; an
     * approval configured in Settings → Actions still applies, and agents never carry it.
     */
    operation?: Pick<UiActionOperation, 'confirmed'> & Readonly<{ callerContext?: ActionExecutorContext }>,
): Promise<WidgetDefinitionCommandOutcome<PublicActionResultById[Id]>> {
    try {
        // Preparing widget inputs can fail at the platform or validation boundary too.
        const preparedInput = typeof input === 'function' ? await input() : input;
        // The person pressed it: present-user authority, one request id, so a consequential
        // operation enters the existing approval policy exactly as any other UI Action does.
        const result = await (operation?.confirmed ? executeWidgetAction.confirmed : executeWidgetAction)(actionId, preparedInput, {
            ...(operation?.callerContext ?? { surface: 'ui' as const, authority: 'present_user' as const }),
            serverId: target.serverId, expectedAccountId: target.accountId,
            actionRequestId: randomUUID(), ...(signal ? { signal } : {}),
            ...(widgetAreaContext ? { widgetAreaContext } : {}),
        });
        return classifyWidgetDefinitionCommandResult(actionId, result);
    } catch (error) {
        if (signal?.aborted) return { kind: 'refused', errorCode: 'cancelled' };
        const code = error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : 'widget_command_failed';
        return { kind: 'refused', errorCode: code };
    }
}
