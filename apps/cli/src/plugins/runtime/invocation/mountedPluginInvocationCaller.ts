import type { DaemonPluginStructuredMessageActionInvocationV1 } from '@happier-dev/protocol';
import { arePluginMachineMaterializationRefsEqual, arePluginMachineExecutionOriginsEqual } from '@happier-dev/protocol/machines/administration/pluginMachineExecutionOriginV1';
import { buildQualifiedPluginContributionKey, qualifyPluginContributionReferenceV1 } from '@happier-dev/protocol/plugins/contribution-identity';
import type { PluginAccountExecutionSelectionV1 } from '@happier-dev/protocol/plugins/availability';
import type { PluginInvocationCaller } from '@happier-dev/plugin-sdk';
import type { ResolvedExecutablePluginRuntimeRegistry } from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';
import { normalizePluginSourceCustody, pluginSourceCustodyEqual } from '@/plugins/runtime/sourceAuthority';
import { listComposerSurfaceDeclarations } from '@/plugins/projection/registry/composer';
import { readResolvedActionContribution } from '@/plugins/projection/registry/actions';
import { resolvePluginMachineExecutionOrigin } from '@/plugins/runtime/resolvePluginMachineExecutionOrigin';

export type MountedAccountPluginExecutionSelectionResolver = (
    pluginId: string,
    signal?: AbortSignal,
) => Promise<PluginAccountExecutionSelectionV1>;

/**
 * Convert a mounted UI or client Action binding into invocation provenance only
 * after matching its admitted Machine runtime lease or current Account Action
 * declaration. The wire record is a claim from the client, not caller authority.
 */
export async function deriveMountedPluginInvocationCaller(input: Readonly<{
    request: Readonly<{
        machineId: string;
        invocationSurface: 'cli' | 'ui' | 'voice' | 'agent' | 'mcp';
        invocation?: DaemonPluginStructuredMessageActionInvocationV1;
    }>;
    registry: Readonly<{
        contributes: Partial<ResolvedExecutablePluginRuntimeRegistry['contributes']>;
    }> & Pick<ResolvedExecutablePluginRuntimeRegistry,
        'readPluginOccurrenceId' | 'readPluginSourceCustody' | 'isPluginOccurrenceCurrent'>;
    /** Current authenticated Account selection, independent of Machine materialization. */
    resolveAccountExecutionSelection?: (pluginId: string) => Promise<PluginAccountExecutionSelectionV1>;
    resolveCurrentPluginMaterializationRef?: NonNullable<
        ResolvedExecutablePluginRuntimeRegistry['resolveCurrentPluginMaterializationRef']
    >;
    resolveExecutionOriginContext?: () => Promise<Readonly<{ serverIdentityId: string; machineId: string }> | null> | Readonly<{ serverIdentityId: string; machineId: string }> | null;
}>): Promise<
    | Readonly<{ status: 'absent' }>
    | Readonly<{ status: 'unavailable' }>
    | Readonly<{
        status: 'available';
        caller: Extract<PluginInvocationCaller, Readonly<{ kind: 'plugin' }>>;
        /** Re-read the admitted source authority immediately before target effect. */
        isMountedCallerCurrent: () => Promise<boolean>;
        /** Account callers retain their current source closure across Inbox decisions. */
        approvalInputCustody?: 'live_only';
    }>
> {
    const invocation = input.request.invocation;
    const binding = invocation?.kind === 'mountedPluginSurface'
        ? invocation.mountedBinding
        : invocation?.kind === 'clientPluginAction'
            ? invocation.clientActionBinding
            : undefined;
    if (!binding) return Object.freeze({ status: 'absent' as const });
    const matchesCallerContributionId = (localId: string) => localId === binding.contributionLocalId;
    const contributes = input.registry.contributes;
    let resolvedMachineContext: Readonly<{ serverIdentityId: string; machineId: string }> | null;
    try {
        resolvedMachineContext = await input.resolveExecutionOriginContext?.() ?? null;
    } catch {
        return Object.freeze({ status: 'unavailable' as const });
    }
    const machineContext = resolvedMachineContext;
    if (!machineContext || machineContext.machineId !== input.request.machineId) {
        return Object.freeze({ status: 'unavailable' as const });
    }

    const accountSourceCustody = binding.sourceCustody;
    if (accountSourceCustody?.kind === 'account_release'
        || (accountSourceCustody?.kind === 'bundled_first_party' && binding.pluginVersion !== undefined)) {
        const resolveSelection = input.resolveAccountExecutionSelection;
        if (!resolveSelection || !accountSourceCustody || binding.materializationRef !== undefined) {
            return Object.freeze({ status: 'unavailable' as const });
        }
        const matchesAccountDeclaration = (selection: PluginAccountExecutionSelectionV1): boolean => {
            if (selection.kind !== 'available' || selection.manifest.id !== binding.pluginId
                || (binding.pluginVersion !== undefined && binding.pluginVersion !== selection.manifest.version)) return false;
            const contributions = selection.manifest.contributes;
            // Account custody can supply a client Action, an Account Action, or a Work Items callback.
            const declaredCaller = invocation?.kind === 'clientPluginAction'
                ? contributions.actions?.some(action => matchesCallerContributionId(action.id)
                    && (action.execution.target === 'account' || action.execution.target === 'client'))
                    || contributions.workItems?.some(entry => entry.id === binding.contributionLocalId) === true
                : invocation?.kind === 'mountedPluginSurface' && [
                    ...contributions.ui.views, ...contributions.ui.settingsPages,
                    ...contributions.targetedPluginContributions,
                ].some(surface => matchesCallerContributionId(surface.id));
            if (!declaredCaller) return false;
            if (accountSourceCustody.kind === 'account_release') {
                return pluginSourceCustodyEqual(accountSourceCustody, selection.sourceCustody);
            }
            if (accountSourceCustody.kind !== 'bundled_first_party' || selection.sourceCustody.kind !== 'bundled_first_party'
                || binding.pluginVersion !== selection.manifest.version) return false;
            const claimedRuntime = accountSourceCustody.packagedRuntime;
            const selectedRuntime = selection.sourceCustody.packagedRuntime;
            return claimedRuntime.kind !== 'source_declaration' || selectedRuntime.kind !== 'source_declaration'
                || claimedRuntime.packageName === selectedRuntime.packageName;
        };
        try {
            const selection = await resolveSelection(binding.pluginId);
            if (selection.kind !== 'available' || !matchesAccountDeclaration(selection)) {
                return Object.freeze({ status: 'unavailable' as const });
            }
            return Object.freeze({
                status: 'available' as const,
                approvalInputCustody: 'live_only' as const,
                caller: Object.freeze({
                    kind: 'plugin' as const, pluginId: binding.pluginId,
                    contribution: Object.freeze({ id: binding.contributionLocalId, qualifiedId: buildQualifiedPluginContributionKey({
                        pluginId: binding.pluginId, localId: binding.contributionLocalId,
                    }) }),
                    // The invoking process owns this occurrence; it is never a Machine lease.
                    occurrenceId: binding.occurrenceId, sourceCustody: normalizePluginSourceCustody(accountSourceCustody),
                    originSurface: input.request.invocationSurface,
                }),
                isMountedCallerCurrent: async (): Promise<boolean> => {
                    try {
                        const currentMachineContext = await input.resolveExecutionOriginContext?.() ?? null;
                        if (currentMachineContext?.serverIdentityId !== machineContext.serverIdentityId
                            || currentMachineContext.machineId !== machineContext.machineId) return false;
                        const current = await resolveSelection(binding.pluginId);
                        return current.kind === 'available' && current.custodyId === selection.custodyId
                            && matchesAccountDeclaration(current);
                    } catch { return false; }
                },
            });
        } catch { return Object.freeze({ status: 'unavailable' as const }); }
    }

    const pluginId = binding.pluginId;
    const materialization = binding.materializationRef;
    let occurrenceId: ReturnType<NonNullable<ResolvedExecutablePluginRuntimeRegistry['readPluginOccurrenceId']>> = null;
    let sourceCustody: ReturnType<NonNullable<ResolvedExecutablePluginRuntimeRegistry['readPluginSourceCustody']>> = null;
    try {
        occurrenceId = input.registry.readPluginOccurrenceId?.(pluginId) ?? null;
        sourceCustody = input.registry.readPluginSourceCustody?.(pluginId) ?? null;
    } catch {
        return Object.freeze({ status: 'unavailable' as const });
    }
    if (
        !occurrenceId
        || !sourceCustody
        || (binding.sourceCustody !== undefined && !pluginSourceCustodyEqual(binding.sourceCustody, sourceCustody))
        || occurrenceId !== binding.occurrenceId
        || (materialization !== undefined && materialization.machineId !== machineContext.machineId)
    ) {
        return Object.freeze({ status: 'unavailable' as const });
    }
    if (materialization !== undefined) {
        try {
            const current = input.resolveCurrentPluginMaterializationRef?.(pluginId) ?? null;
            if (current === null || !arePluginMachineMaterializationRefsEqual(current, materialization)) {
                return Object.freeze({ status: 'unavailable' as const });
            }
        } catch {
            return Object.freeze({ status: 'unavailable' as const });
        }
    } else if (contributes.materializationIdsByPluginId?.[pluginId] !== undefined) {
        // Source-backed occurrences may omit a portable ref; a declared materialization must be supplied.
        return Object.freeze({ status: 'unavailable' as const });
    }
    const executionOrigin = resolvePluginMachineExecutionOrigin({
        pluginId, context: machineContext, sourceCustody,
        ...(materialization === undefined ? {} : { materializationId: materialization.materializationId }),
    });
    if (!executionOrigin) return Object.freeze({ status: 'unavailable' as const });

    let contributionIdentity: Readonly<{ pluginId: string; localId: string }> | null = null;
    if (invocation?.kind === 'clientPluginAction') {
        const mountedAction = readResolvedActionContribution(contributes, {
            pluginId,
            localId: binding.contributionLocalId,
        });
        // The plugin's declared Work Items registration is the other client caller family;
        // its callback reaches source Actions through context.services.actions.
        const workItems = mountedAction ? undefined : contributes.workItems?.find((entry) => (
            entry.pluginId === pluginId
            && entry.identity.pluginId === pluginId
            && entry.identity.localId === binding.contributionLocalId
        ));
        if (workItems) {
            contributionIdentity = workItems.identity;
        } else {
            if (!mountedAction || !mountedAction.pluginId || !('execution' in mountedAction.definition)) {
                return Object.freeze({ status: 'unavailable' as const });
            }
            const execution = mountedAction.definition.execution;
            if (
                typeof execution !== 'object'
                || execution === null
                || !('target' in execution)
                || execution.target !== 'client'
            ) {
                return Object.freeze({ status: 'unavailable' as const });
            }
            contributionIdentity = {
                pluginId: mountedAction.pluginId,
                localId: mountedAction.definition.id,
            };
        }
    } else {
        const mountedContribution = [
            ...(contributes.uiViewsV2 ?? []),
            ...(contributes.uiSettingsPagesV2 ?? []),
            ...listComposerSurfaceDeclarations(contributes).map(({ contribution }) => contribution),
            // Plugin manifest ingestion reserves local contribution IDs across
            // families, so this exact pluginId/localId pair is unambiguous for a
            // mounted app-shell Voice invocation too.
            ...(contributes.voiceProviders ?? []),
        ].find((entry) => (
            entry.pluginId === pluginId
            && entry.identity.pluginId === pluginId
            && entry.identity.localId === binding.contributionLocalId
        ));
        // Embedded setup and picker surfaces use the declaring Event/input type
        // as their caller, just as the projection's shared embedded-mount owner does.
        const setupEvent = mountedContribution ? undefined : contributes.automationEligibleEvents?.find(({ event }) => (
            event.identity.pluginId === pluginId
            && matchesCallerContributionId(event.identity.localId)
            && event.automation.source.setupSurface !== undefined
        ));
        const inputPicker = mountedContribution || setupEvent ? undefined : contributes.inputTypes?.find((entry) => {
            if (entry.pluginId !== pluginId || entry.identity.pluginId !== pluginId
                || !matchesCallerContributionId(entry.identity.localId) || !entry.definition.picker) return false;
            return qualifyPluginContributionReferenceV1(entry.definition.picker, pluginId).pluginId === pluginId;
        });
        const mountedIdentity = mountedContribution?.identity ?? setupEvent?.event.identity ?? inputPicker?.identity;
        if (mountedIdentity) {
            contributionIdentity = mountedIdentity;
        } else {
            // A target-owned embedded surface is mounted under its contributor
            // identity, rather than a top-level view id. Only cold admission's
            // current surfaces authorize this caller; a declaration alone does not.
            const declaration = contributes.targetedPluginContributions?.find((entry) => (
                entry.pluginId === pluginId
                && entry.identity.pluginId === pluginId
                && matchesCallerContributionId(entry.identity.localId)
            ));
            const admitted = declaration && contributes.readAdmittedTargetedContributions?.({
                targetPluginId: declaration.definition.target.pluginId,
                pointId: declaration.definition.target.pointId,
                protocol: declaration.definition.protocol,
            });
            const surface = admitted?.contributions.find((entry) => (
                entry.contributor.pluginId === pluginId
                && entry.contributor.contributionId === binding.contributionLocalId
                && entry.contributor.occurrenceId === occurrenceId
                && entry.surfaces.length > 0
            ));
            if (!declaration || !surface) return Object.freeze({ status: 'unavailable' as const });
            contributionIdentity = declaration.identity;
        }
    }
    if (!contributionIdentity) return Object.freeze({ status: 'unavailable' as const });

    return Object.freeze({
        status: 'available' as const,
        caller: Object.freeze({
            kind: 'plugin' as const,
            pluginId,
            contribution: Object.freeze({
                id: contributionIdentity.localId,
                qualifiedId: buildQualifiedPluginContributionKey(contributionIdentity),
            }),
            occurrenceId,
            sourceCustody,
            executionOrigin,
            ...(materialization === undefined
                ? {}
                : { materialization: Object.freeze({ ...materialization }) }),
            // Diagnostic provenance only. Target policy receives the independent
            // invocationSurface below.
            originSurface: input.request.invocationSurface,
        }),
        isMountedCallerCurrent: async (): Promise<boolean> => {
            let current: Readonly<{ serverIdentityId: string; machineId: string }> | null = null;
            let currentSource: typeof sourceCustody | null;
            try {
                current = await input.resolveExecutionOriginContext?.() ?? null;
                currentSource = input.registry.readPluginSourceCustody?.(pluginId) ?? null;
            } catch {
                return false;
            }
            let liveMaterialization: typeof materialization | null = null;
            if (materialization !== undefined) {
                try {
                    liveMaterialization = input
                        .resolveCurrentPluginMaterializationRef?.(pluginId)
                        ?? null;
                } catch {
                    return false;
                }
            }
            const currentOrigin = current ? resolvePluginMachineExecutionOrigin({
                pluginId, context: current, sourceCustody: currentSource,
                ...(liveMaterialization ? { materializationId: liveMaterialization.materializationId } : {}),
            }) : null;
            return current !== null && currentOrigin !== null
                && arePluginMachineExecutionOriginsEqual(executionOrigin, currentOrigin)
                && current.machineId === input.request.machineId
                && input.registry.isPluginOccurrenceCurrent?.(
                    pluginId,
                    occurrenceId,
                ) === true
                && (materialization === undefined
                    ? input.registry.contributes.materializationIdsByPluginId?.[pluginId] === undefined
                    : liveMaterialization !== null
                        && arePluginMachineMaterializationRefsEqual(liveMaterialization, materialization));
        },
    });
}
