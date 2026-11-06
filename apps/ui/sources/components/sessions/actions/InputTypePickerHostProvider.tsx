import * as React from 'react';
import { HappierInputPickerProvider, useHappierInputPickerPort, type HappierInputPickerPort } from '@happier-dev/plugin-ui/presentation';
import type { InputFieldHint } from '@happier-dev/protocol/inputs';
import type { PluginContributionIdentityV1 } from '@happier-dev/protocol/plugins/contribution-identity';
import { qualifyPluginContributionReferenceV1 } from '@happier-dev/protocol/plugins/contribution-identity';
import { normalizeExecutableParticipantSelectionV1, type ExecutableParticipantSelectionV1 } from '@happier-dev/protocol/discussions/executableParticipants';

import { useDaemonMergedProjectionInputs } from '@/agents/backendCatalog/useDaemonMergedProjectionInputs';
import { loadDaemonMergedProjectionCacheEntry, readReusableDaemonMergedProjectionCacheEntry } from '@/agents/backendCatalog/loadDaemonMergedProjectionInputs';
import { useSessionMachineTarget } from '@/components/sessions/model/useSessionMachineTarget';
import { captureActiveServerAccountScopeLifetime, type ActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { useServerCredentialAccountScopeBindings } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { resolveUiAccountActionFallbackMachineId } from '@/sync/ops/actions/accountActionDeps';
import { readPluginSurfaceEphemeralMountBinding } from '@/components/plugins/surfaces/pluginSurfaceMountBinding';
import { resolvePluginLocalizedText } from '@/sync/domains/plugins/ui/i18n';
import { createInputTypePickerPort } from './inputTypePickerPort';
import { createHostInputTypePickerForm } from './hostInputTypePickerForm';
import type { PluginUiProjectionModel } from '@/sync/domains/plugins/ui/projection';
import { readPluginUiContributionOrigin } from '@/sync/domains/plugins/ui/projectionUnion';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';

export type InputTypePickerHostContext = Readonly<{
    machineId?: string | null;
    sessionId?: string | null;
    serverId?: string | null;
    /** The admitted consumer and its current dependency context, not an authority token. */
    contextKey?: string;
    /** Semantic input dependencies only; Account/read authority remains captured separately. */
    draftInput?: Readonly<Record<string, unknown>>;
    accountLifetime?: ActiveServerAccountScopeLifetime;
    pluginUiProjection?: PluginUiProjectionModel | null;
    pluginUiMachineId?: string | null;
    /** Exact field targets supplied by the shared options owner, including bound Session inputs. */
    fieldTargets?: Readonly<Record<string, Readonly<{ machineId: string | null; serverId?: string; sessionId?: string; unavailable?: true }>>>;
}>;

type HostProps = InputTypePickerHostContext & Readonly<{
    children: React.ReactNode;
    enabled: boolean;
    /** Host-only fields borrow no daemon contribution inventory before their picker opens. */
    requiresPluginTypes?: boolean;
    isCurrent?: () => boolean;
    /** Supplied only by the demanded participant control; selection itself never starts a Session. */
    pickAgentParticipant?: (request: Readonly<{
        selected?: ExecutableParticipantSelectionV1 | readonly ExecutableParticipantSelectionV1[];
        multiple: boolean;
        serverId: string;
        accountLifetime: ActiveServerAccountScopeLifetime;
        signal: AbortSignal;
    }>) => Promise<ExecutableParticipantSelectionV1 | readonly ExecutableParticipantSelectionV1[] | null>;
}>;

function normalizeParticipantChoice(value: unknown): ExecutableParticipantSelectionV1 | readonly ExecutableParticipantSelectionV1[] | null {
    if (!Array.isArray(value)) return normalizeExecutableParticipantSelectionV1(value);
    const selections = value.map(normalizeExecutableParticipantSelectionV1);
    return selections.every((selection): selection is ExecutableParticipantSelectionV1 => selection !== null) ? selections : null;
}

const INPUT_PICKER_SECTIONS = ['familiesById.inputTypes', 'familiesById.pluginUi', 'actionsById', 'resourcesById'] as const;
const InputTypeProjectionDemandContext = React.createContext<(() => () => void) | null>(null);

/** Host menus acquire their descriptor inventory only while their choices are presented. */
export function useInputTypePickerProjectionDemand(presented: boolean): void {
    const acquire = React.useContext(InputTypeProjectionDemandContext);
    React.useLayoutEffect(() => presented ? acquire?.() : undefined, [acquire, presented]);
}

/** A leaf-only adapter over the daemon's existing admitted input-type projection. */
export function InputTypePickerHostProvider(props: HostProps): React.ReactElement {
    const inherited = useHappierInputPickerPort();
    const inheritedDemand = React.useContext(InputTypeProjectionDemandContext);
    const [projectionDemands, setProjectionDemands] = React.useState(0);
    const acquireProjectionDemand = React.useCallback(() => {
        setProjectionDemands(count => count + 1);
        return () => setProjectionDemands(count => count - 1);
    }, []);
    const serverId = props.serverId?.trim() || null;
    const routed = useServerCredentialAccountScopeBindings(serverId ? [serverId] : []);
    const accountLifetime = props.accountLifetime ?? (serverId
        ? routed.values().next().value ?? null
        : captureActiveServerAccountScopeLifetime());
    const sessionTarget = useSessionMachineTarget(props.sessionId ?? null, serverId);
    const machineId = props.pluginUiProjection !== undefined ? props.pluginUiMachineId ?? null
        : props.machineId ?? sessionTarget?.machineId ?? (props.sessionId || !accountLifetime ? null
            : resolveUiAccountActionFallbackMachineId(accountLifetime.scope));
    const state = useDaemonMergedProjectionInputs({ machineId, serverId,
        sections: INPUT_PICKER_SECTIONS,
        load: props.requiresPluginTypes !== false || projectionDemands > 0,
        enabled: props.enabled && !inherited && props.pluginUiProjection === undefined });
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
        const read = (identity: PluginContributionIdentityV1, field?: Pick<InputFieldHint, 'path'>) => {
            const now = current.current;
            if (!now.props.enabled || now.props.contextKey !== props.contextKey
                || now.props.isCurrent !== props.isCurrent
                || now.machineId !== machineId || now.serverId !== serverId || now.accountLifetime !== accountLifetime
                || !now.accountLifetime?.isCurrent() || now.props.isCurrent?.() === false) return null;
            const declaredType = now.props.pluginUiProjection?.inputTypesById[`${identity.pluginId}/${identity.localId}`];
            const origin = readPluginUiContributionOrigin(declaredType);
            const fieldTarget = field && now.props.fieldTargets?.[field.path];
            // A group can consume several plugins. Its fields reuse the exact
            // producers already admitted and loaded by the shell, never one
            // ambient relay for all of their pickers.
            if (fieldTarget && (fieldTarget.unavailable || !fieldTarget.machineId || fieldTarget.serverId
                && (!now.serverId || !areServerProfileIdentifiersEquivalent(fieldTarget.serverId, now.serverId)))) return null;
            if (!fieldTarget && now.props.pluginUiProjection !== undefined && (origin
                ? origin.phase !== 'current' || !origin.interactionEnabled || !origin.serverId || !now.serverId
                    || !areServerProfileIdentifiersEquivalent(origin.serverId, now.serverId)
                : !now.props.pluginUiMachineId)) return null;
            const producerMachineId = fieldTarget ? fieldTarget.machineId : origin?.machineId ?? now.machineId;
            if (!producerMachineId) return null;
            const projection = now.props.pluginUiProjection !== undefined || now.state.phase === 'ready'
                ? readReusableDaemonMergedProjectionCacheEntry({
                    machineId: producerMachineId, serverId: now.serverId, accountLifetime: now.accountLifetime,
                    sections: INPUT_PICKER_SECTIONS,
                }) : null;
            const inputs = projection?.kind === 'ready' ? projection.inputs : null;
            return { ...now, machineId: producerMachineId, inputs, declaredType,
                supplied: now.props.pluginUiProjection !== undefined && !fieldTarget?.sessionId };
        };
        const entryFor = (identity: PluginContributionIdentityV1, field?: Pick<InputFieldHint, 'path'>, requireInputs = false) => {
            const now = read(identity, field);
            const projectedEntry = now?.inputs?.pluginProjectionV2?.familiesById.inputTypes?.entriesById[`${identity.pluginId}/${identity.localId}`];
            const supplied = now?.supplied === true && !requireInputs && !now.inputs;
            const entry = supplied ? now?.declaredType : projectedEntry;
            if (now?.supplied && now.declaredType?.occurrenceId !== entry?.occurrenceId) return null;
            const plugin = supplied ? now?.props.pluginUiProjection?.installedPackagesById[identity.pluginId]
                : now?.inputs?.pluginProjectionById[identity.pluginId];
            return now && entry?.occurrenceId && plugin?.enabled === true ? { now, entry, supplied } : null;
        };
        return createInputTypePickerPort({
            readInputTypes: field => {
                const now = current.current;
                const target = now.props.fieldTargets?.[field.path];
                if (now.props.pluginUiProjection !== undefined && !target) return now.props.pluginUiProjection?.inputTypesById;
                const projection = target?.machineId ? readReusableDaemonMergedProjectionCacheEntry({
                    machineId: target.machineId, serverId: now.serverId, accountLifetime: now.accountLifetime,
                    sections: INPUT_PICKER_SECTIONS,
                }) : null;
                const inputs = target ? projection?.kind === 'ready' ? projection.inputs : null : now.state.inputs;
                return inputs?.pluginProjectionV2?.familiesById.inputTypes?.entriesById;
            },
            canOpenHostPicker: (reference) => reference.hostType === 'savedSecretReference' ? readHost() !== null
                : reference.hostType === 'agentParticipant' && readHost()?.props.pickAgentParticipant !== undefined,
            openHostPicker: async (request, field) => {
                const admitted = readHost();
                if (!admitted?.accountLifetime?.isCurrent() || request.signal.aborted) return { kind: 'cancelled' };
                if (request.reference.hostType === 'savedSecretReference') {
                    const { presentSavedSecretReferencePicker } = await import('@/components/ui/forms/valueRefs/presentSavedSecretReferencePicker');
                    if (!readHost() || request.signal.aborted) return { kind: 'cancelled' };
                    const selected = await presentSavedSecretReferencePicker({ accountLifetime: admitted.accountLifetime,
                        selected: request.value, signal: request.signal, isCurrent: () => readHost() !== null });
                    return selected ? { kind: 'completed', input: selected } : { kind: 'cancelled' };
                }
                if (request.reference.hostType === 'agentParticipant') {
                    const pick = admitted.props.pickAgentParticipant;
                    if (!pick) return { kind: 'cancelled' };
                    const selected = request.value === undefined ? undefined : normalizeParticipantChoice(request.value);
                    if (request.value !== undefined && selected === null) return { kind: 'cancelled' };
                    const choice = await pick({ ...(selected === undefined ? {} : { selected: selected! }),
                        multiple: field.widget === 'multiselect',
                        serverId: admitted.accountLifetime.scope.serverId, accountLifetime: admitted.accountLifetime,
                        signal: request.signal });
                    if (!readHost()?.accountLifetime?.isCurrent() || request.signal.aborted || choice === null) return { kind: 'cancelled' };
                    const normalized = normalizeParticipantChoice(choice);
                    // Let the canonical field validator report a miswired picker result.
                    return { kind: 'completed', input: normalized ?? choice };
                }
                if (request.reference.hostType !== 'usageQuery') return { kind: 'cancelled' };
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
            resolveType: (identity, field) => {
                const admitted = entryFor(identity, field);
                return admitted ? { identity, occurrenceId: admitted.entry.occurrenceId!, definition: admitted.entry.definition } : null;
            },
            canOpenPicker: (picker, type, field) => {
                const admitted = entryFor(type.identity, field);
                if (!admitted?.entry.definition.picker) return false;
                const declared = qualifyPluginContributionReferenceV1(admitted.entry.definition.picker, admitted.entry.pluginId);
                const surface = admitted.entry.pickerSurface;
                return declared.pluginId === picker.pluginId && declared.localId === picker.localId
                    && surface?.selectedRenderer.availability.state === 'available'
                    && (admitted.supplied || surface.projectionGeneration === admitted.now.inputs?.pluginProjectionV2?.generation)
                    && readPluginSurfaceEphemeralMountBinding(surface) !== null;
            },
            openPicker: async (request, field) => {
                const descriptor = entryFor(request.type.identity, field);
                if (!descriptor?.now.accountLifetime || request.signal.aborted
                    || descriptor.entry.occurrenceId !== request.type.occurrenceId) return { kind: 'cancelled' };
                await loadDaemonMergedProjectionCacheEntry({ machineId: descriptor.now.machineId,
                    serverId: descriptor.now.serverId, accountLifetime: descriptor.now.accountLifetime,
                    sections: INPUT_PICKER_SECTIONS, reuseFreshReady: true, signal: request.signal });
                const currentEntry = entryFor(request.type.identity, field, true);
                const inputs = currentEntry?.now.inputs;
                if (!currentEntry || !inputs || request.signal.aborted) return { kind: 'cancelled' };
                const admitted = { ...currentEntry, now: { ...currentEntry.now, inputs } };
                const surface = admitted?.entry.pickerSurface;
                if (!admitted || !surface || admitted.entry.occurrenceId !== request.type.occurrenceId
                    || surface.selectedRenderer.availability.state !== 'available') return { kind: 'cancelled' };
                // The presenter imports PluginSurfaceHost, whose forms consume this provider.
                // Load the existing presenter only on demand rather than introduce an import cycle.
                const { presentPluginEphemeralInputSurface } = await import('@/components/automations/editor/presentPluginEventAutomationSetupSurface');
                return presentPluginEphemeralInputSurface({
                    surface, title: resolvePluginLocalizedText({
                        projection: admitted.now.inputs.pluginUiProjection,
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
    const composed = React.useMemo<HappierInputPickerPort | null>(() => {
        if (!inherited) return props.enabled ? port : null;
        if (props.pluginUiProjection === undefined && props.fieldTargets === undefined) return inherited;
        // A containing plugin still owns its host input picker. Contributed
        // fields use their own admitted producer instead of inheriting its relay.
        return {
            resolveSemantic: port.resolveSemantic,
            describe: field => field.inputType && 'hostType' in field.inputType ? inherited.describe(field) : port.describe(field),
            pick: request => request.field.inputType && 'hostType' in request.field.inputType ? inherited.pick(request) : port.pick(request),
        };
    }, [inherited, port, props.enabled, props.pluginUiProjection, props.fieldTargets]);
    return <InputTypeProjectionDemandContext.Provider value={composed === inherited ? inheritedDemand : acquireProjectionDemand}>
        <HappierInputPickerProvider port={composed}>{props.children}</HappierInputPickerProvider>
    </InputTypeProjectionDemandContext.Provider>;
}
