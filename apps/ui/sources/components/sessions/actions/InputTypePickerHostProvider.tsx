import * as React from 'react';
import { HappierInputPickerProvider, useHappierInputPickerPort } from '@happier-dev/plugin-ui/presentation';
import type { PluginContributionIdentityV1 } from '@happier-dev/protocol/plugins/contribution-identity';
import { qualifyPluginContributionReferenceV1 } from '@happier-dev/protocol/plugins/contribution-identity';

import { useDaemonMergedProjectionInputs } from '@/agents/backendCatalog/useDaemonMergedProjectionInputs';
import { readReusableDaemonMergedProjectionCacheEntry } from '@/agents/backendCatalog/loadDaemonMergedProjectionInputs';
import { useSessionMachineTarget } from '@/components/sessions/model/useSessionMachineTarget';
import { captureActiveServerAccountScopeLifetime, type ActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { useServerCredentialAccountScopeBindings } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { resolveUiAccountActionFallbackMachineId } from '@/sync/ops/actions/accountActionDeps';
import { readPluginSurfaceEphemeralMountBinding } from '@/components/plugins/surfaces/pluginSurfaceMountBinding';
import { normalizePluginUiProjection } from '@/sync/domains/plugins/ui/projection';
import { resolvePluginLocalizedText } from '@/sync/domains/plugins/ui/i18n';
import { createInputTypePickerPort } from './inputTypePickerPort';
import { createHostInputTypePickerForm } from './hostInputTypePickerForm';

export type InputTypePickerHostContext = Readonly<{
    machineId?: string | null;
    sessionId?: string | null;
    serverId?: string | null;
    /** The admitted consumer and its current dependency context, not an authority token. */
    contextKey?: string;
    /** Semantic input dependencies only; Account/read authority remains captured separately. */
    draftInput?: Readonly<Record<string, unknown>>;
    accountLifetime?: ActiveServerAccountScopeLifetime;
}>;

type HostProps = InputTypePickerHostContext & Readonly<{
    children: React.ReactNode;
    enabled: boolean;
    isCurrent?: () => boolean;
}>;

/** A leaf-only adapter over the daemon's existing admitted input-type projection. */
export function InputTypePickerHostProvider(props: HostProps): React.ReactElement {
    const inherited = useHappierInputPickerPort();
    const serverId = props.serverId?.trim() || null;
    const routed = useServerCredentialAccountScopeBindings(serverId ? [serverId] : []);
    const accountLifetime = props.accountLifetime ?? (serverId
        ? routed.values().next().value ?? null
        : captureActiveServerAccountScopeLifetime());
    const sessionTarget = useSessionMachineTarget(props.sessionId ?? null, serverId);
    const machineId = props.machineId ?? sessionTarget?.machineId ?? (props.sessionId || !accountLifetime ? null
        : resolveUiAccountActionFallbackMachineId({ serverId: accountLifetime.scope.serverId }));
    const state = useDaemonMergedProjectionInputs({ machineId, serverId, enabled: props.enabled && !inherited });
    const current = React.useRef({ props, accountLifetime, machineId, serverId, state });
    current.current = { props, accountLifetime, machineId, serverId, state };
    const port = React.useMemo(() => {
        const readHost = () => {
            const now = current.current;
            return now.props.enabled && now.props.contextKey === props.contextKey
                && now.props.isCurrent === props.isCurrent && now.serverId === serverId
                && now.accountLifetime === accountLifetime && now.accountLifetime?.isCurrent()
                && now.props.isCurrent?.() !== false ? now : null;
        };
        const read = () => {
            const now = current.current;
            if (!now.props.enabled || now.props.contextKey !== props.contextKey
                || now.props.isCurrent !== props.isCurrent
                || now.machineId !== machineId || now.serverId !== serverId || now.accountLifetime !== accountLifetime
                || !now.machineId || !now.accountLifetime?.isCurrent() || now.props.isCurrent?.() === false) return null;
            const projection = now.state.phase === 'ready'
                ? readReusableDaemonMergedProjectionCacheEntry({
                    machineId: now.machineId, serverId: now.serverId, accountLifetime: now.accountLifetime,
                }) : null;
            const inputs = projection?.kind === 'ready' ? projection.inputs : null;
            return inputs ? { ...now, inputs } : null;
        };
        const entryFor = (identity: PluginContributionIdentityV1) => {
            const now = read();
            const entry = now?.inputs.pluginProjectionV2?.familiesById.inputTypes?.entriesById[`${identity.pluginId}/${identity.localId}`];
            const plugin = now?.inputs.pluginProjectionById[identity.pluginId];
            return now && entry?.occurrenceId && plugin?.enabled === true ? { now, entry } : null;
        };
        return createInputTypePickerPort({
            openHostPicker: async (request) => {
                const admitted = readHost();
                if (!admitted || request.signal.aborted || request.reference.hostType !== 'usageQuery') return { kind: 'cancelled' };
                // Reuse the incumbent generic form; host inputs do not require a daemon/plugin mount.
                const { presentActionInputForm } = await import('@/components/plugins/actions/presentActionInputForm');
                if (!readHost() || request.signal.aborted) return { kind: 'cancelled' };
                const picker = createHostInputTypePickerForm({ request, nowMs: Date.now(),
                    serverId: admitted.accountLifetime!.scope.serverId, draftInput: admitted.props.draftInput,
                    accountLifetime: admitted.accountLifetime, isCurrent: () => readHost() !== null });
                presentActionInputForm({ form: picker.form, signal: request.signal,
                    pickerContext: { serverId: admitted.accountLifetime!.scope.serverId,
                        accountLifetime: admitted.accountLifetime! } });
                return picker.result;
            },
            resolveType: (identity) => {
                const admitted = entryFor(identity);
                return admitted ? { identity, occurrenceId: admitted.entry.occurrenceId!, definition: admitted.entry.definition } : null;
            },
            canOpenPicker: (picker, type) => {
                const admitted = entryFor(type.identity);
                if (!admitted?.entry.definition.picker) return false;
                const declared = qualifyPluginContributionReferenceV1(admitted.entry.definition.picker, admitted.entry.pluginId);
                const surface = admitted.entry.pickerSurface;
                return declared.pluginId === picker.pluginId && declared.localId === picker.localId
                    && surface?.selectedRenderer.availability.state === 'available'
                    && surface.projectionGeneration === admitted.now.inputs.pluginProjectionV2?.generation
                    && readPluginSurfaceEphemeralMountBinding(surface) !== null;
            },
            openPicker: async (request) => {
                const admitted = entryFor(request.type.identity);
                const surface = admitted?.entry.pickerSurface;
                if (!admitted || !surface || admitted.entry.occurrenceId !== request.type.occurrenceId
                    || surface.selectedRenderer.availability.state !== 'available') return { kind: 'cancelled' };
                // The presenter imports PluginSurfaceHost, whose forms consume this provider.
                // Load the existing presenter only on demand rather than introduce an import cycle.
                const { presentPluginEphemeralInputSurface } = await import('@/components/automations/editor/presentPluginEventAutomationSetupSurface');
                return presentPluginEphemeralInputSurface({
                    surface, title: resolvePluginLocalizedText({
                        projection: normalizePluginUiProjection(admitted.now.inputs.pluginProjectionV2),
                        pluginId: admitted.entry.pluginId, value: admitted.entry.definition.title,
                    }),
                    launchInput: request.launchInput,
                    projection: admitted.now.inputs,
                    machineId: admitted.now.machineId!, serverId: admitted.now.serverId,
                    accountLifetime: admitted.now.accountLifetime!, signal: request.signal,
                });
            },
        });
    }, [accountLifetime, machineId, serverId, props.contextKey, props.isCurrent, state.phase, state.inputs]);
    return <HappierInputPickerProvider port={inherited ?? (props.enabled ? port : null)}>{props.children}</HappierInputPickerProvider>;
}
