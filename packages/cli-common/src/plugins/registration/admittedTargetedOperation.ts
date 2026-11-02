/** @moduleRealm any */
import type { JsonValue, PluginContributionRef } from './contracts.js';
import { normalizePluginSourceCustodyV1, pluginSourceCustodyV1Equal, type PluginSourceCustodyV1 } from '@happier-dev/protocol/plugins/runtime/sourceCustody';
import type { PluginError } from '../errors.js';
import type { AdmittedTargetedOperationExecutionHandle, AdmittedTargetedOperationIdentity } from './contracts.js';
import type { PluginUiTargetedContributionOperationV1 } from '@happier-dev/protocol/plugins/ui';
import type { RehydratedPluginContributionPointOperationV1 } from '@happier-dev/protocol';
import { createPluginActionHandlerNotStartedError } from './actionHandlerInvocation.js';
import { resolveManifestTargetedContributions, type TargetedContributionManifestDeclaration } from './targetedContributionAdmission.js';
import type { AdmittedTargetedContributionActionInputSelection } from './targetedContributionTypes.js';

/**
 * The original host-created handle is the only executable capability. Its
 * public identity can be copied for display or comparison, but no copied value
 * is present in this host-private binding map.
 */
export type AdmittedTargetedOperationSelectedActionInput = AdmittedTargetedContributionActionInputSelection;

export type AdmittedTargetedOperationExecutionBinding = Readonly<{
    action: PluginContributionRef;
    contributorOccurrenceId: string;
    /** Full exact operation identity; the public handle exposes only a copy. */
    operation: PluginUiTargetedContributionOperationV1;
    /** The target that admitted this operation, absent from the public operation shape. */
    targetPluginId: string;
    /** Exact process-local target occurrence that admitted this operation. */
    targetOccurrenceId: string;
    targetSourceCustody?: PluginSourceCustodyV1;
    unavailable?: true;
    /** Exact Action-definition selection fact, never carrier supplied. */
    selectedActionInput: AdmittedTargetedOperationSelectedActionInput;
    /** Exact target parser pair, retained only through this original handle. */
    targetProtocol: RehydratedPluginContributionPointOperationV1;
}>;

const admittedTargetedOperationExecutionBindings = new WeakMap<object, AdmittedTargetedOperationExecutionBinding>();

function freezeSelectedActionInput(
    selectedActionInput: AdmittedTargetedOperationSelectedActionInput | undefined,
): AdmittedTargetedOperationSelectedActionInput {
    if (!selectedActionInput || selectedActionInput.kind === 'none') {
        return Object.freeze({ kind: 'none' as const });
    }
    if (selectedActionInput.kind === 'unavailable') {
        return Object.freeze({ kind: 'unavailable' as const });
    }
    return Object.freeze({
        kind: 'connectedAccount' as const,
        fieldPath: selectedActionInput.fieldPath,
    });
}

export function createAdmittedTargetedOperationExecutionHandle<
    TInput extends JsonValue = JsonValue,
    TResult extends JsonValue | void = JsonValue | void,
    TRole extends string = string,
>(params: Readonly<{
    action: PluginContributionRef;
    identity: AdmittedTargetedOperationIdentity<TRole>;
    /** Exact target occurrence from the admitted snapshot, never public handle data. */
    targetOccurrenceId: string;
    targetSourceCustody?: PluginSourceCustodyV1;
    unavailable?: true;
    /** Host-private fact derived from the exact admitted Action definition. */
    selectedActionInput?: AdmittedTargetedOperationSelectedActionInput;
    /** Exact target parser pair selected by cold targeted-contribution admission. */
    targetProtocol: RehydratedPluginContributionPointOperationV1;
}>): AdmittedTargetedOperationExecutionHandle<TInput, TResult, TRole> {
    const identity = Object.freeze({
        target: Object.freeze({ pluginId: params.identity.target.pluginId }),
        point: Object.freeze({
            pointId: params.identity.point.pointId,
            protocol: Object.freeze({
                id: params.identity.point.protocol.id,
                version: params.identity.point.protocol.version,
            }),
        }),
        contributor: Object.freeze({
            pluginId: params.identity.contributor.pluginId,
            contributionId: params.identity.contributor.contributionId,
            occurrenceId: params.identity.contributor.occurrenceId,
            sourceCustody: normalizePluginSourceCustodyV1(params.identity.contributor.sourceCustody),
        }),
        role: params.identity.role,
    });
    const operation = Object.freeze({
        point: Object.freeze({
            pointId: identity.point.pointId,
            protocol: Object.freeze({
                id: identity.point.protocol.id,
                version: identity.point.protocol.version,
            }),
        }),
        contributor: Object.freeze({
            pluginId: identity.contributor.pluginId,
            contributionId: identity.contributor.contributionId,
            occurrenceId: identity.contributor.occurrenceId,
            sourceCustody: identity.contributor.sourceCustody,
        }),
        role: identity.role,
        action: Object.freeze({
            pluginId: params.action.pluginId,
            localId: params.action.localId,
        }),
    }) satisfies PluginUiTargetedContributionOperationV1;
    const handle = Object.freeze({
        identity,
        typeProjection: undefined,
    }) as AdmittedTargetedOperationExecutionHandle<
        TInput,
        TResult,
        TRole
    >;
    admittedTargetedOperationExecutionBindings.set(
        handle,
        Object.freeze({
            action: Object.freeze({
                pluginId: params.action.pluginId,
                localId: params.action.localId,
            }),
            contributorOccurrenceId: identity.contributor.occurrenceId,
            operation,
            targetPluginId: identity.target.pluginId,
            targetOccurrenceId: params.targetOccurrenceId,
            ...(params.targetSourceCustody === undefined ? {} : { targetSourceCustody: normalizePluginSourceCustodyV1(params.targetSourceCustody) }),
            ...(params.unavailable ? { unavailable: true } : {}),
            selectedActionInput: freezeSelectedActionInput(params.selectedActionInput),
            targetProtocol: params.targetProtocol,
        }),
    );
    return handle;
}

export function readAdmittedTargetedOperationExecutionBinding(
    operation: unknown,
): AdmittedTargetedOperationExecutionBinding | null {
    if (operation === null || typeof operation !== 'object') return null;
    return admittedTargetedOperationExecutionBindings.get(operation) ?? null;
}

/**
 * An opaque operation belongs to the exact target occurrenceId that admitted it.
 * The public identity deliberately omits that private fact, so a replacement
 * target cannot recover an old capability from the original object.
 */
export function requireAdmittedTargetedOperationExecutionBinding(
    operation: unknown,
    seed: Readonly<{ plugin: Readonly<{ id: string }>; occurrenceId: string }>,
    currentDeclarations?: readonly TargetedContributionManifestDeclaration[],
): AdmittedTargetedOperationExecutionBinding {
    const binding = readAdmittedTargetedOperationExecutionBinding(operation);
    if (binding === null || binding.targetPluginId !== seed.plugin.id) {
        throw invalidAdmittedTargetedOperationHandle();
    }
    if (!seed.occurrenceId || binding.targetOccurrenceId !== seed.occurrenceId) {
        throw createPluginActionHandlerNotStartedError({
            code: 'plugin_action_generation_retired',
            message: 'Admitted targeted operation target occurrenceId is no longer current',
        });
    }
    if (currentDeclarations !== undefined) {
        const currentTarget = currentDeclarations.find((row) => row.manifest.id === binding.targetPluginId && row.occurrenceId === binding.targetOccurrenceId);
        const currentContributor = currentDeclarations.find((row) => row.manifest.id === binding.action.pluginId && row.occurrenceId === binding.contributorOccurrenceId);
        if (!currentTarget || !currentContributor
            || currentTarget.occurrenceId !== binding.targetOccurrenceId
            || currentContributor.occurrenceId !== binding.contributorOccurrenceId
            || !binding.targetSourceCustody
            || !pluginSourceCustodyV1Equal(currentTarget.targetSourceCustody ?? currentTarget.sourceCustody, binding.targetSourceCustody)
            || !pluginSourceCustodyV1Equal(currentContributor.sourceCustody, binding.operation.contributor.sourceCustody)) {
            throw createPluginActionHandlerNotStartedError({
                code: 'plugin_action_generation_retired',
                message: 'Admitted targeted operation source is no longer current',
            });
        }
        const snapshot = resolveManifestTargetedContributions(currentDeclarations).read({
            targetPluginId: binding.targetPluginId,
            pointId: binding.operation.point.pointId,
            protocol: binding.operation.point.protocol,
        });
        const contribution = snapshot?.contributions.find((candidate) => (
            candidate.contributor.pluginId === binding.operation.contributor.pluginId
            && candidate.contributor.contributionId === binding.operation.contributor.contributionId
        ));
        const currentOperation = contribution?.operations.find((candidate) => (
            candidate.role === binding.operation.role
            && candidate.action.pluginId === binding.action.pluginId
            && candidate.action.localId === binding.action.localId
            && candidate.contributor.occurrenceId === binding.contributorOccurrenceId
        ));
        if (!currentOperation) throw invalidAdmittedTargetedOperationHandle();
        if (currentOperation.unavailable) throw targetedOperationUnavailable();
    }
    if (binding.unavailable) throw targetedOperationUnavailable();
    return binding;
}

function targetedOperationUnavailable(): PluginError {
    return createPluginActionHandlerNotStartedError({ code: 'plugin_targeted_contributions_unavailable',
        message: 'The current source cannot execute this declared targeted operation',
    });
}

export function invalidAdmittedTargetedOperationHandle(): PluginError {
    return createPluginActionHandlerNotStartedError({
        code: 'plugin_admitted_targeted_operation_handle_invalid',
        message: 'Admitted targeted operation handle is invalid',
    });
}
