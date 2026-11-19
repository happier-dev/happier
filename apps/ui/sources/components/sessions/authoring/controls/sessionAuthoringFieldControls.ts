import type {
    AcpConfigOptionOverridesV1} from '@happier-dev/protocol/sessions/metadata/overrides';
import type { MachineAgentExecutionStateV1 } from '@happier-dev/protocol/capabilities/machineAgentInventory';
import type { MachineAgent } from '@/agents/machineAgents/machineAgentTypes';
import type {
    AgentExecutionTargetV1} from '@happier-dev/protocol/agents/executionTargetV1';
import type {
    PersistedBackendTargetRefV2} from '@happier-dev/protocol/backends/targets/backendTargetRefV2';
import type {
    PluginProjectedAgentConnectedAccountPurposeV2} from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import type {
    WindowsRemoteSessionLaunchMode,
} from '@happier-dev/protocol/sessions/metadata/windowsRemoteSessionLaunchMode';
import type { ResolvedBackendCatalogEntry } from '@/agents/backendCatalog/getResolvedBackendCatalogEntries';
import type { ProfileCatalogSnapshotV1 } from '@happier-dev/protocol/profiles/profileCatalogV1';
import { buildAcpConfigOptionOverridesV1 } from '@happier-dev/protocol/sessions/metadata/overrides';
import { AgentExecutionTargetV1Schema } from '@happier-dev/protocol/agents/executionTargetV1';
import { readBackendTargetKeyV2 } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';
import { PortableRuntimeDescriptorV1Schema } from '@happier-dev/protocol/sessions/metadata/runtime-descriptor';
import {
    type WorkflowSessionAuthoringSelection,
    type WorkflowSessionAuthoringSelectionFieldId,
} from '@happier-dev/protocol/workflows/workflowV1';

import { resolveBundledAgentIdFromContributionIdentity } from '@/agents/catalog/catalog';
import type { PermissionMode } from '@/sync/domains/permissions/permissionTypes';
import type { SessionConfigOptionControl } from '@/sync/domains/sessionControl/configOptionsControl';
import { WINDOWS_REMOTE_SESSION_LAUNCH_MODE_OPTIONS } from '@/sync/domains/session/spawn/windowsRemoteSessionLaunchModeOptions';
import { t } from '@/text';

import {
    buildSessionModelSelectionForAgentTarget,
    readSessionModelSelectionOptionId,
} from '../sessionModelSelectionValue';
import type { SessionAuthoringControls } from './useSessionAuthoringControls';

/**
 * What each Session-authoring field can actually offer right now, and what a
 * chosen option means as a value.
 *
 * This is deliberately a pure projection: the same descriptors drive the
 * standalone authoring row and the workflow step inspector, so a picker cannot
 * offer one set of choices in New Session and a different set for a workflow
 * step. Applying the chosen value stays with whoever owns it — nothing here
 * navigates, persists, or remembers a selection.
 */

export type SessionAuthoringFieldId = WorkflowSessionAuthoringSelectionFieldId;

/** Option id meaning "no value", kept distinct from "inherit" (absence). */
export const SESSION_AUTHORING_NONE_OPTION_ID = '__none__';

export type SessionAuthoringFieldOption = Readonly<{
    id: string;
    label: string;
    subtitle?: string;
    disabled?: boolean;
    /** Picking the existing engine retains its running model, mode and configuration. */
    preserveCurrentFields?: boolean;
}>;

export type SessionAuthoringFieldUnavailableReason =
    /** The Agent itself exposes nothing to choose for this field. */
    | 'agent_has_no_options'
    /**
     * The field is Agent-owned and no Agent is resolved, so there is no policy
     * to answer it. Guessing one is how a plugin Agent's step used to display
     * and persist the bundled default's models, modes and configuration.
     */
    | 'requires_agent_target'
    /** The exact run target does not have this control (e.g. non-Windows). */
    | 'not_supported_on_target'
    /** The Account's feature decision for this control is off. */
    | 'feature_disabled'
    /** The facts this control reads have not arrived yet; it says so instead of claiming there is nothing. */
    | 'loading'
    /** The Profile reader settled with a refusal, rather than an empty inventory. */
    | 'profile_catalog_unavailable'
    /** Another owner supplies this field's control and the host did not pass it. */
    | 'owned_by_host'
    /** A control aimed at several Sessions whose current values or scopes differ, so one value can't stand for all. */
    | 'differs_between_targets';

/**
 * The Machine, folder and Account scope an MCP selection is previewed against.
 * The incumbent New Session MCP owner reads the same three facts; a host that
 * cannot name them leaves the field explicitly unavailable.
 */
export type SessionAuthoringMcpContext = Readonly<{
    machineId: string;
    machineName: string | null;
    directory: string;
    serverId: string | null;
}>;

/**
 * The Account scope a Connected Service binding is authored against.
 *
 * The incumbent New Session Connected Services owner reads exactly these facts:
 * the Agent's own Connected Account declarations from the authoritative machine
 * catalog projection, the Home the credentials belong to, and the Team credential
 * resources that Home offers. A host that cannot name the declarations leaves the
 * field explicitly unavailable rather than offering an unscoped list.
 */
export type SessionAuthoringConnectedServicesContext = Readonly<{
    serverId: string | null;
}>;

export type SessionAuthoringFieldControlModel =
    | Readonly<{
        field: SessionAuthoringFieldId;
        kind: 'options';
        title: string;
        options: readonly SessionAuthoringFieldOption[];
        selectedOptionId: string;
        /**
         * What the chip says when `selectedOptionId` names no offered option.
         * Absent means the ordinary "Default" reading is true; a field whose
         * value is genuinely unresolved supplies its own honest label instead.
         */
        unselectedLabel?: string;        /**
         * A stored value the current catalog no longer offers (B7, L14): it stays
         * selected under its last-known label with the one-line repair, and is
         * never replaced by a default until the person chooses another.
         */
        preserved?: Readonly<{ label: string; repair: string }>;
    }>
    | Readonly<{
        field: SessionAuthoringFieldId;
        kind: 'optionGroups';
        title: string;
        groups: ReadonlyArray<Readonly<{
            id: string;
            title: string;
            options: readonly SessionAuthoringFieldOption[];
            selectedOptionId: string;
            /** Mixed selections use the same unselected display contract as ordinary options. */
            unselectedLabel?: string;
        }>>;
    }>
    | Readonly<{
        field: SessionAuthoringFieldId;
        kind: 'text';
        title: string;
        value: string;
        placeholder: string;
    }>
    /** Tool names typed as one list (`Read, mcp__server__tool`); the control keeps the typed text. */
    | Readonly<{
        field: 'allowedTools';
        kind: 'toolList';
        title: string;
        value: readonly string[];
        placeholder: string;
    }>
    /** The MCP selection, edited through the incumbent New Session MCP owner for the resolved Agent. */
    | Readonly<{
        field: 'capabilitySelection';
        kind: 'mcp';
        agentId: string;
        context: SessionAuthoringMcpContext;
    }>
    /**
     * The Connected Service bindings, edited through the incumbent New Session
     * Connected Services owner for the resolved Agent — including its Team
     * credential resource selection and recovery routing.
     */
    | Readonly<{
        field: 'connectedServices';
        kind: 'connectedServices';
        agentId: string;
        /** The Agent's contribution identity: it keys the Agent's default authentication. */
        agentIdentity: AgentExecutionTargetV1['identity'] | null;
        connectedAccounts: readonly PluginProjectedAgentConnectedAccountPurposeV2[];
        context: SessionAuthoringConnectedServicesContext;
    }>
    | Readonly<{
        field: SessionAuthoringFieldId;
        kind: 'unavailable';
        reason: SessionAuthoringFieldUnavailableReason;
    }>;

export type SessionAuthoringAgentTargetOption = Readonly<{
    pickerEntry?: ResolvedBackendCatalogEntry;
    id: string;
    label: string;
    subtitle?: string;
    target: AgentExecutionTargetV1;
    /** The catalog's capability-probe identity, consumed by the shared engine detail. */
    backendTarget?: PersistedBackendTargetRefV2;
    /**
     * The exact operational Agent id the canonical backend catalog resolved for
     * this target: the plugin contribution's own Agent id for a plugin Agent,
     * the bundled id for a bundled one. Agent-owned policy — models, permission
     * modes, session modes and configuration options — is answered for this id.
     */
    agentId: string;
    /**
     * This Agent's readiness on the exact Machine (installed, signed in or a
     * connected default), from the Machine Agent inventory. Absent while that
     * inventory has not answered: unknown never blocks a choice.
     */
    readiness?: MachineAgentExecutionStateV1;
    /**
     * The exact Machine's own inventory row for this Agent, when it has one. Every Agent picker
     * presents a not-ready Agent from it the same way (placement, marker, setup pane).
     */
    machineAgent?: MachineAgent;
    /**
     * Whether this Agent, on the exact Machine, offers direct (unpersisted)
     * transcripts — the canonical Agent-behavior answer, which is a per-Agent,
     * per-Machine fact rather than a property of the whole surface.
     */
    supportsDirectTranscriptStorage?: boolean;
    /**
     * This Agent's own Connected Account declarations on the exact Machine, as
     * the authoritative catalog projection resolved them. Connected Service
     * bindings are keyed by the canonical qualified keys of these declarations,
     * so they travel with the target rather than with the surface.
     */
    connectedAccounts?: readonly PluginProjectedAgentConnectedAccountPurposeV2[];
    /**
     * How this Agent names its own runtime launch choice and the modes it
     * offers, already localized by that Agent's settings presentation. The
     * projection names nothing here; an Agent that declares no runtime choice
     * contributes nothing and the field stays explicitly unavailable.
     */
    runtimeBackendMode?: Readonly<{ title: string; options: readonly SessionAuthoringFieldOption[] }>;
}>;

/**
 * Facts a host owns and this projection consumes. Nothing here is fetched: a
 * field whose owner did not contribute its facts stays explicitly unavailable
 * rather than silently disappearing.
 */
export type SessionAuthoringControlFacts = Readonly<{
    agentTargets?: readonly SessionAuthoringAgentTargetOption[];
    agentPickerContext?: Readonly<{ machineId: string | null; serverId: string | null; directory: string | null }>;
    /**
     * The Agent the canonical New Session resolver would preselect for this
     * exact Machine, present only once that Machine's projection has resolved
     * and only when it names one of `agentTargets`. It is a seeding fact for a
     * host that starts a pristine draft; the field projection never reads it,
     * so nothing here can turn an unresolved selection into a displayed value.
     */
    contextualDefaultAgentTarget?: AgentExecutionTargetV1 | null;
    profiles?: ReadonlyArray<Readonly<{ id: string; label: string; subtitle?: string }>>;
    /** The reader's Profiles setting; `false` means profiles are turned off, not merely absent. */
    profilesEnabled?: boolean;
    /** The Account's profile read has not answered yet: an empty list is not an answer. */
    profilesLoading?: boolean;
    profilesUnavailableReason?: Extract<ProfileCatalogSnapshotV1, { status: 'unavailable' }>['reason'];
    /** The exact Machine these facts describe, by its display name: the repair line names it. */
    machineName?: string | null;
    /** The exact run target runs Windows, so its launch controls apply. */
    targetIsWindows?: boolean;
    windowsTerminalAvailable?: boolean;
    /** The scope an MCP selection is previewed against; absent when the host has no exact Machine and folder. */
    mcp?: SessionAuthoringMcpContext;
    /**
     * The scope a Connected Service binding is authored against; absent when the
     * host cannot name the selected Agent's Connected Account declarations.
     */
    connectedServices?: SessionAuthoringConnectedServicesContext;
}>;

/**
 * The canonical localized name of one authoring field.
 *
 * The same string titles the field's own picker and names it wherever a host
 * lists fields — the workflow step inspector used to print the raw schema id.
 * Agent-contributed runtime copy wins when available; the generic fallback
 * keeps unresolved fields readable without exposing their schema identifier.
 */
export function resolveSessionAuthoringFieldTitle(
    field: SessionAuthoringFieldId,
    /** The selected Agent's option, when one is resolved: it names its own runtime choice. */
    selectedAgentTarget?: SessionAuthoringAgentTargetOption | null,
): string | null {
    switch (field) {
        case 'allowedTools': return t('settingsSession.toolPolicy.allowedTitle');
        case 'unlistedTools': return t('settingsSession.toolPolicy.unlistedTitle');
        case 'agentTarget': return t('agentInput.agent.sectionTitle');
        case 'modelSelection': return t('agentInput.model.sectionTitle');
        case 'permissionMode': return t('settingsSession.permissions.title');
        case 'acpSessionModeId': return t('agentInput.mode.sectionTitle');
        case 'profileId': return t('agentInput.profile.sectionTitle');
        case 'approvalProfileId': return t('workflows.editor.approvalProfile');
        case 'sessionConfigOptionOverrides': return t('agentInput.actionMenu.settings');
        // This Session's type, not the settings' default for new ones: it fits the label track (WF-ACCEPT-1118B item 6).
        case 'transcriptStorage': return t('workflows.editor.sessionType');
        case 'capabilitySelection': return t('capabilities.session.sheet.title');
        case 'connectedServices': return t('connectedServices.authChip.label');
        case 'terminal': return t('profiles.tmux.spawnSessionsTitle');
        case 'runtimeDescriptorV1': return selectedAgentTarget?.runtimeBackendMode?.title
            ?? t('workflows.editor.agentRuntime');
        case 'windowsRemoteSessionLaunchMode':
        case 'windowsRemoteSessionConsole': return t('machine.windows.remoteSessionModeTitle');
        case 'windowsTerminalWindowName': return t('settingsSession.windows.windowNameTitle');
    }
}

function unavailable(
    field: SessionAuthoringFieldId,
    reason: SessionAuthoringFieldUnavailableReason,
): SessionAuthoringFieldControlModel {
    return { field, kind: 'unavailable', reason };
}

/**
 * The offered option that is exactly this selected target, if any.
 *
 * The canonical key includes the contribution and, for configured ACP, the definition.
 */
export function findSessionAuthoringAgentTargetOption(
    targets: readonly SessionAuthoringAgentTargetOption[] | undefined,
    selected: AgentExecutionTargetV1 | null | undefined,
): SessionAuthoringAgentTargetOption | null {
    const selectedKey = readBackendTargetKeyV2(selected);
    if (selectedKey === null) return null;
    return targets?.find((option) => readBackendTargetKeyV2(option.target) === selectedKey) ?? null;
}

/**
 * The exact Agent whose policy answers this selection's Agent-owned fields.
 *
 * The canonical backend catalog already resolved an operational Agent id for
 * every selectable target, so a plugin Agent answers as itself. Without those
 * facts a bundled identity still names its own Agent exactly; a plugin identity
 * does not, and `null` is the truthful answer rather than a nearby default.
 */
export function resolveSessionAuthoringAgentId(params: Readonly<{
    agentTarget: AgentExecutionTargetV1 | null | undefined;
    facts?: SessionAuthoringControlFacts;
}>): string | null {
    const { agentTarget } = params;
    if (!agentTarget) return null;
    const option = findSessionAuthoringAgentTargetOption(params.facts?.agentTargets, agentTarget);
    const projected = option?.agentId.trim();
    if (projected) return projected;
    return resolveBundledAgentIdFromContributionIdentity(agentTarget.identity);
}

/**
 * Narrows one `onChangeField` value to the Agent target it carries.
 *
 * `onChangeField` reports a field id alongside the value union of every
 * authoring field. Several of those field values are open records, so the
 * canonical target schema is the only thing that can prove which one arrived.
 */
export function readSessionAuthoringAgentTargetValue(
    value: WorkflowSessionAuthoringSelection[SessionAuthoringFieldId],
): AgentExecutionTargetV1 | null {
    const parsed = AgentExecutionTargetV1Schema.safeParse(value);
    return parsed.success ? parsed.data : null;
}

/**
 * Retires an Agent-bound portable descriptor when an Agent selection changes
 * to a target that cannot own it. The selected target's catalog fact is the
 * authority; labels and option ids never participate in this identity check.
 */
export function retireUnavailableSessionAuthoringRuntimeDescriptor(params: Readonly<{
    runtimeDescriptorV1: WorkflowSessionAuthoringSelection['runtimeDescriptorV1'];
    agentTarget: AgentExecutionTargetV1 | null | undefined;
    facts?: SessionAuthoringControlFacts;
}>): WorkflowSessionAuthoringSelection['runtimeDescriptorV1'] {
    const descriptor = params.runtimeDescriptorV1;
    if (descriptor == null) return descriptor;
    const agentId = resolveSessionAuthoringAgentId({
        agentTarget: params.agentTarget,
        facts: params.facts,
    });
    return agentId === descriptor.agentId ? descriptor : null;
}

export function resolveSessionAuthoringRuntimeDescriptorAvailability(params: Readonly<{
    values: WorkflowSessionAuthoringSelection;
    facts?: SessionAuthoringControlFacts;
}>): 'available' | 'unavailable' | 'unknown' {
    const descriptor = params.values.runtimeDescriptorV1;
    if (descriptor == null) return 'available';
    const selected = findSessionAuthoringAgentTargetOption(
        params.facts?.agentTargets,
        params.values.agentTarget,
    );
    if (!selected) return 'unknown';
    if (selected.agentId !== descriptor.agentId) return 'unavailable';
    const runtime = selected.runtimeBackendMode;
    if (!runtime) return 'unavailable';
    return runtime.options.some((option) => option.id === descriptor.agent.backendMode)
        ? 'available'
        : 'unavailable';
}

function buildTranscriptStorageOptions(): readonly SessionAuthoringFieldOption[] {
    return [
        {
            id: 'persisted',
            label: t('sessionsList.storagePersistedTab'),
            subtitle: t('settingsSession.defaultStorage.persistedSubtitle'),
        },
        {
            id: 'direct',
            label: t('sessionsList.storageDirectTab'),
            subtitle: t('settingsSession.defaultStorage.directSubtitle'),
        },
    ];
}

function buildConfigOptionGroups(
    controls: readonly SessionConfigOptionControl[] | null,
    overrides: AcpConfigOptionOverridesV1 | null | undefined,
): ReadonlyArray<Readonly<{
    id: string;
    title: string;
    options: readonly SessionAuthoringFieldOption[];
    selectedOptionId: string;
}>> {
    if (!controls) return [];
    return controls.flatMap((control) => {
        const choices = control.option.options
            ?? control.option.groups?.flatMap((group) => group.options)
            ?? [];
        if (choices.length === 0) return [];
        const authored = overrides?.overrides?.[control.option.id]?.value;
        const authoredId = authored === undefined || authored === null ? null : String(authored);
        return [{
            id: control.option.id,
            title: control.option.name,
            options: choices.map((option) => ({
                id: option.value,
                label: option.name,
                ...(option.description === undefined ? {} : { subtitle: option.description }),
                ...(control.disabled === true ? { disabled: true } : {}),
            })),
            selectedOptionId: authoredId ?? control.effectiveValue,
        }];
    });
}

/** A stored value no offered option names, kept under its last-known label with its repair line. */
function preservedValue(label: string, facts: SessionAuthoringControlFacts) {
    return {
        unselectedLabel: label,
        preserved: {
            label,
            repair: facts.machineName
                ? t('agentInput.agent.noLongerAvailableOn', { machine: facts.machineName })
                : t('agentInput.agent.noLongerAvailable'),
        },
    } as const;
}

/**
 * The control for one field, given the resolved effective policy and the facts
 * the host contributed.
 */
export function resolveSessionAuthoringFieldControl(params: Readonly<{
    field: SessionAuthoringFieldId;
    values: WorkflowSessionAuthoringSelection;
    controls: SessionAuthoringControls;
    facts?: SessionAuthoringControlFacts;
    /**
     * The exact Agent `controls` were resolved for, or `null` when none is.
     * Agent-owned fields refuse to present a choice rather than pass off some
     * other Agent's policy as this selection's.
     */
    agentId: string | null;
}>): SessionAuthoringFieldControlModel {
    const { agentId, field, values, controls } = params;
    const facts = params.facts ?? {};
    const selectedAgentTarget = findSessionAuthoringAgentTargetOption(facts.agentTargets, values.agentTarget);
    // One title owner: the string a field's picker is titled with is the same
    // string a host lists the field under, so the two cannot drift apart.
    const fieldTitle = resolveSessionAuthoringFieldTitle(field, selectedAgentTarget) ?? field;

    switch (field) {
        case 'agentTarget': {
            const targets = facts.agentTargets ?? [];
            if (targets.length === 0) return unavailable(field, 'owned_by_host');
            const selectedOption = selectedAgentTarget;
            return {
                field,
                kind: 'options',
                title: fieldTitle,
                options: targets.map((option) => ({
                    id: option.id,
                    label: option.label,
                    ...(option.subtitle === undefined ? {} : { subtitle: option.subtitle }),
                })),
                selectedOptionId: selectedOption?.id ?? SESSION_AUTHORING_NONE_OPTION_ID,
                // Nothing selected, or an authored Agent this Machine does not
                // offer: either way there is no Agent, and reading that as the
                // ordinary "Default" hides the exact reason a strict Workflow
                // refuses to run.
                ...(selectedOption === null
                    ? (values.agentTarget
                        // An authored Agent this Machine does not offer keeps its own name.
                        ? preservedValue(values.agentTarget.identity.localId, facts)
                        : { unselectedLabel: t('agentInput.agent.unselected') })
                    : {}),
            };
        }

        case 'modelSelection': {
            // A model id is only durable bound to the Agent target it belongs to.
            if (!values.agentTarget || agentId === null) return unavailable(field, 'requires_agent_target');
            if (controls.modelOptions.length === 0) return unavailable(field, 'agent_has_no_options');
            return {
                field,
                kind: 'options',
                title: fieldTitle,
                options: controls.modelOptions.map((option) => ({
                    id: option.value,
                    label: option.label,
                    ...(option.description ? { subtitle: option.description } : {}),
                })),
                selectedOptionId: readSessionModelSelectionOptionId(values.modelSelection),
                ...(values.modelSelection
                    && !controls.modelOptions.some((option) => option.value === readSessionModelSelectionOptionId(values.modelSelection))
                    ? preservedValue(readSessionModelSelectionOptionId(values.modelSelection), facts)
                    : {}),
            };
        }

        case 'permissionMode': {
            if (agentId === null) return unavailable(field, 'requires_agent_target');
            if (controls.permissionModeOptions.length === 0) return unavailable(field, 'agent_has_no_options');
            return {
                field,
                kind: 'options',
                title: fieldTitle,
                options: controls.permissionModeOptions.map((option) => ({
                    id: option.value,
                    label: option.label,
                    ...(option.description ? { subtitle: option.description } : {}),
                })),
                selectedOptionId: values.permissionMode ?? 'default',
            };
        }

        case 'acpSessionModeId': {
            if (agentId === null) return unavailable(field, 'requires_agent_target');
            if (!controls.shouldRenderSessionModeChip) return unavailable(field, 'agent_has_no_options');
            return {
                field,
                kind: 'options',
                title: fieldTitle,
                options: controls.sessionModePickerOptions.map((option) => ({
                    id: option.id,
                    label: option.label,
                    ...(option.subtitle === undefined ? {} : { subtitle: option.subtitle }),
                })),
                selectedOptionId: values.acpSessionModeId ?? 'default',
            };
        }

        case 'approvalProfileId':
            return unavailable(field, 'owned_by_host');

        case 'profileId': {
            const profiles = facts.profiles ?? [];
            if (facts.profilesEnabled === false) return unavailable(field, 'feature_disabled');
            if (profiles.length === 0) {
                if (facts.profilesLoading === true) return unavailable(field, 'loading');
                if (facts.profilesUnavailableReason) return unavailable(field, 'profile_catalog_unavailable');
                return unavailable(field, 'owned_by_host');
            }
            return {
                field,
                kind: 'options',
                title: fieldTitle,
                options: [
                    { id: SESSION_AUTHORING_NONE_OPTION_ID, label: t('common.none') },
                    ...profiles.map((profile) => ({
                        id: profile.id,
                        label: profile.label,
                        ...(profile.subtitle === undefined ? {} : { subtitle: profile.subtitle }),
                    })),
                ],
                selectedOptionId: values.profileId ?? SESSION_AUTHORING_NONE_OPTION_ID,
                // A Launch Profile that was deleted keeps its id visible rather than reading as None.
                ...(values.profileId && !profiles.some((profile) => profile.id === values.profileId)
                    ? preservedValue(values.profileId, facts)
                    : {}),
            };
        }

        case 'sessionConfigOptionOverrides': {
            if (agentId === null) return unavailable(field, 'requires_agent_target');
            const groups = buildConfigOptionGroups(
                controls.acpConfigOptionControls,
                values.sessionConfigOptionOverrides,
            );
            if (groups.length === 0) return unavailable(field, 'agent_has_no_options');
            return {
                field,
                kind: 'optionGroups',
                title: fieldTitle,
                groups,
            };
        }

        case 'transcriptStorage': {
            // Direct transcripts are an Agent-on-this-Machine capability, so the
            // answer comes from the selected Agent's own option, not a surface-wide bit.
            if (agentId === null) return unavailable(field, 'requires_agent_target');
            if (selectedAgentTarget?.supportsDirectTranscriptStorage !== true) {
                return unavailable(field, 'not_supported_on_target');
            }
            return {
                field,
                kind: 'options',
                title: fieldTitle,
                options: buildTranscriptStorageOptions(),
                selectedOptionId: values.transcriptStorage ?? 'persisted',
            };
        }

        case 'windowsRemoteSessionLaunchMode': {
            if (facts.targetIsWindows !== true) return unavailable(field, 'not_supported_on_target');
            const windowsTerminalAvailable = facts.windowsTerminalAvailable === true;
            return {
                field,
                kind: 'options',
                title: fieldTitle,
                options: WINDOWS_REMOTE_SESSION_LAUNCH_MODE_OPTIONS.map((option) => ({
                    id: option.value,
                    label: t(option.labelKey),
                    subtitle: option.value === 'windows_terminal' && !windowsTerminalAvailable
                        ? `${t(option.subtitleKey)} ${t('machine.windows.windowsTerminalUnavailableSuffix')}`
                        : t(option.subtitleKey),
                    disabled: option.value === 'windows_terminal' && !windowsTerminalAvailable,
                })),
                selectedOptionId: values.windowsRemoteSessionLaunchMode ?? 'hidden',
            };
        }

        case 'windowsRemoteSessionConsole': {
            if (facts.targetIsWindows !== true) return unavailable(field, 'not_supported_on_target');
            return {
                field,
                kind: 'options',
                title: fieldTitle,
                options: [
                    { id: 'hidden', label: t('windowsRemoteSessionLaunchMode.hidden') },
                    { id: 'visible', label: t('windowsRemoteSessionLaunchMode.console') },
                ],
                selectedOptionId: values.windowsRemoteSessionConsole ?? 'hidden',
            };
        }

        case 'allowedTools':
            return {
                field,
                kind: 'toolList',
                title: fieldTitle,
                value: values.allowedTools ?? [],
                placeholder: t('settingsSession.toolPolicy.allowedPlaceholder'),
            };

        case 'unlistedTools':
            return {
                field,
                kind: 'options',
                title: fieldTitle,
                options: [
                    { id: 'ask', label: t('settingsSession.toolPolicy.unlistedAsk'), subtitle: t('settingsSession.toolPolicy.unlistedAskSubtitle') },
                    { id: 'deny', label: t('settingsSession.toolPolicy.unlistedDeny'), subtitle: t('settingsSession.toolPolicy.unlistedDenySubtitle') },
                ],
                selectedOptionId: values.unlistedTools ?? 'ask',
            };

        case 'windowsTerminalWindowName': {
            if (facts.targetIsWindows !== true) return unavailable(field, 'not_supported_on_target');
            return {
                field,
                kind: 'text',
                title: fieldTitle,
                value: values.windowsTerminalWindowName ?? '',
                placeholder: t('settingsSession.windows.windowNamePlaceholder'),
            };
        }

        case 'capabilitySelection': {
            // The MCP selection is previewed for one Agent against one Machine
            // and folder by the incumbent New Session owner; without an Agent
            // or that scope there is nothing truthful to offer.
            if (agentId === null) return unavailable(field, 'requires_agent_target');
            if (facts.mcp === undefined) return unavailable(field, 'owned_by_host');
            return { field, kind: 'mcp', agentId, context: facts.mcp };
        }

        case 'connectedServices': {
            // Bindings are authored for one Agent's own declared Connected
            // Accounts against one Home. Without the Agent or that scope there
            // is nothing truthful to offer, exactly as for MCP.
            if (!selectedAgentTarget) return unavailable(field, 'requires_agent_target');
            if (facts.connectedServices === undefined) return unavailable(field, 'owned_by_host');
            const declarations = selectedAgentTarget.connectedAccounts ?? [];
            // An Agent that declares no Connected Account has nothing to bind;
            // that is the Agent's own answer, not a missing host fact.
            if (declarations.length === 0) return unavailable(field, 'agent_has_no_options');
            return {
                field,
                kind: 'connectedServices',
                agentId: selectedAgentTarget.agentId,
                agentIdentity: selectedAgentTarget.target.identity,
                connectedAccounts: declarations,
                context: facts.connectedServices,
            };
        }

        case 'terminal': {
            // The incumbent New Session terminal owner offers exactly one
            // authored choice — whether a spawned Session runs inside tmux —
            // and the spawn resolver honours exactly `tmux` and `plain`.
            // Omission is not "off": it means this machine's own terminal
            // settings still decide, so it is offered as its own option.
            if (facts.targetIsWindows === true) return unavailable(field, 'not_supported_on_target');
            const mode = values.terminal?.mode;
            return {
                field,
                kind: 'options',
                title: fieldTitle,
                options: [
                    { id: SESSION_AUTHORING_NONE_OPTION_ID, label: t('common.default') },
                    {
                        id: 'tmux',
                        label: t('common.on'),
                        subtitle: t('profiles.tmux.spawnSessionsEnabledSubtitle'),
                    },
                    {
                        id: 'plain',
                        label: t('common.off'),
                        subtitle: t('profiles.tmux.spawnSessionsDisabledSubtitle'),
                    },
                ],
                selectedOptionId: mode ?? SESSION_AUTHORING_NONE_OPTION_ID,
                // An imported definition may carry a mode this target cannot be
                // offered (a Windows attachment mode, say). Reading that as the
                // ordinary "Default" would claim the authored value was dropped.
                ...(mode !== undefined && mode !== 'tmux' && mode !== 'plain'
                    ? { unselectedLabel: t('common.unavailable') }
                    : {}),
            };
        }

        case 'runtimeDescriptorV1': {
            // Agent-owned: the launch modes and their names belong to the Agent
            // that declares them, so an unresolved Agent or an Agent that
            // declares no runtime choice leaves the field explicitly
            // unavailable rather than borrowing another Agent's answer.
            if (agentId === null) return unavailable(field, 'requires_agent_target');
            const runtime = selectedAgentTarget?.runtimeBackendMode;
            if (runtime === undefined) return unavailable(field, selectedAgentTarget ? 'agent_has_no_options' : 'owned_by_host');
            if (runtime.options.length === 0) return unavailable(field, 'agent_has_no_options');
            const authoredMode = values.runtimeDescriptorV1?.agentId === agentId
                ? values.runtimeDescriptorV1.agent.backendMode
                : undefined;
            const authoredModeAvailable = authoredMode === undefined
                || runtime.options.some((option) => option.id === authoredMode);
            return {
                field,
                kind: 'options',
                title: runtime.title,
                options: [
                    { id: SESSION_AUTHORING_NONE_OPTION_ID, label: t('common.default') },
                    ...runtime.options,
                ],
                selectedOptionId: authoredMode ?? SESSION_AUTHORING_NONE_OPTION_ID,
                ...(values.runtimeDescriptorV1 != null && (authoredMode === undefined || !authoredModeAvailable)
                    // Authored for a different Agent than the one now selected:
                    // the descriptor is bound to its Agent and is not this
                    // selection's default.
                    ? { unselectedLabel: t('common.unavailable') }
                    : {}),
            };
        }
    }
}

/**
 * A typed tool list (`Read, mcp__server__tool`, commas or line breaks) as the
 * allowed-tools value; an empty list is no list.
 */
export function parseSessionAuthoringToolList(text: string): string[] | undefined {
    const tools = [...new Set(text.split(/[\s,]+/).map((tool) => tool.trim()).filter((tool) => tool.length > 0))];
    return tools.length === 0 ? undefined : tools;
}

export function formatSessionAuthoringToolList(tools: readonly string[] | undefined): string {
    return (tools ?? []).join(', ');
}

export type SessionAuthoringFieldSelection = Readonly<{
    field: SessionAuthoringFieldId;
    optionId: string;
    /** Present for `optionGroups` fields: which group the option belongs to. */
    groupId?: string;
}>;

/**
 * The value a chosen option means for its field.
 *
 * Returning the concrete value — including a value equal to the current
 * default — keeps an authored choice explicit. Clearing back to "inherit" is
 * the inspector's reset, never a side effect of choosing.
 */
export function resolveSessionAuthoringFieldValue(params: Readonly<{
    selection: SessionAuthoringFieldSelection;
    values: WorkflowSessionAuthoringSelection;
    facts?: SessionAuthoringControlFacts;
    now: number;
}>): WorkflowSessionAuthoringSelection[SessionAuthoringFieldId] {
    const { optionId } = params.selection;
    const facts = params.facts ?? {};

    switch (params.selection.field) {
        case 'agentTarget': {
            if (optionId === SESSION_AUTHORING_NONE_OPTION_ID) return null;
            return facts.agentTargets?.find((option) => option.id === optionId)?.target ?? null;
        }
        case 'modelSelection':
            return buildSessionModelSelectionForAgentTarget({
                agentTarget: params.values.agentTarget ?? null,
                modelId: optionId,
                updatedAt: params.now,
            });
        case 'permissionMode':
            return optionId as PermissionMode;
        case 'acpSessionModeId':
            return optionId === 'default' ? null : optionId;
        case 'profileId':
            return optionId === SESSION_AUTHORING_NONE_OPTION_ID ? null : optionId;
        case 'sessionConfigOptionOverrides': {
            const groupId = params.selection.groupId;
            if (groupId === undefined) return params.values.sessionConfigOptionOverrides ?? null;
            return buildAcpConfigOptionOverridesV1({
                updatedAt: params.now,
                overrides: {
                    ...(params.values.sessionConfigOptionOverrides?.overrides ?? {}),
                    [groupId]: { updatedAt: params.now, value: optionId },
                },
            });
        }
        case 'transcriptStorage':
            return optionId === 'direct' ? 'direct' : 'persisted';
        case 'windowsRemoteSessionLaunchMode':
            return optionId as WindowsRemoteSessionLaunchMode;
        case 'windowsRemoteSessionConsole':
            return optionId === 'visible' ? 'visible' : 'hidden';
        case 'unlistedTools':
            return optionId === 'deny' ? 'deny' : 'ask';
        case 'allowedTools':
            return parseSessionAuthoringToolList(optionId);
        case 'windowsTerminalWindowName':
            return optionId.trim().length === 0 ? null : optionId;
        case 'terminal': {
            if (optionId === SESSION_AUTHORING_NONE_OPTION_ID) return null;
            // Only the mode is chosen here. An authored tmux session name or
            // Windows attachment detail is part of the same authored value and
            // survives re-picking the mode rather than being silently reset.
            return { ...(params.values.terminal ?? {}), mode: optionId as 'tmux' | 'plain' };
        }
        case 'runtimeDescriptorV1': {
            if (optionId === SESSION_AUTHORING_NONE_OPTION_ID) return null;
            const agentId = resolveSessionAuthoringAgentId({
                agentTarget: params.values.agentTarget ?? null,
                facts,
            });
            // A descriptor is bound to the Agent it launches; without a resolved
            // Agent there is nothing to bind it to.
            if (agentId === null) return params.values.runtimeDescriptorV1 ?? null;
            const authored = params.values.runtimeDescriptorV1?.agentId === agentId
                ? params.values.runtimeDescriptorV1.agent
                : undefined;
            return PortableRuntimeDescriptorV1Schema.parse({
                v: 1,
                agentId,
                agent: { ...(authored ?? {}), backendMode: optionId },
            });
        }
        // Edited through their own owner's control, which reports the value
        // directly rather than resolving an option id.
        case 'capabilitySelection':
        case 'connectedServices':
        case 'approvalProfileId':
            return params.values[params.selection.field] ?? null;
    }
}
