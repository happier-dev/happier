import type { AgentInputExtraActionChip } from '../agentInputContracts';
import type { ComposerRefV1 } from '@happier-dev/protocol/plugins/ui/composerRef';
import type { IconName } from '@/components/ui/icons/Icon';
import { t } from '@/text';
import {
    getAgentInputResetStartPlacement,
    getBrowserContextActionChipPlacement,
    getConnectedServicesAuthActionChipPlacement,
    getExecutionRunRequestedActionChipPlacement,
    getMentionActionChipPlacement,
    getRecipientActionChipPlacement,
    getReviewCommentsActionChipPlacement,
    getSessionSourceContextActionChipPlacement,
    getTemporaryComputerTeamAccessActionChipPlacement,
} from '../definitions/agentInputActionChipPlacements';
import { getCapabilitiesActionChipPlacement } from '@/components/sessions/capabilities/capabilitiesActionChipPlacement';
import { getNewSessionSpaceActionChipPlacement, getNewSessionTriggersActionChipPlacement } from '@/components/sessions/new/newSessionActionChipPlacements';
import { getExecutionRunReportChipPlacement, getExecutionRunStartChipDefinitions } from '@/components/sessions/runs/launcher/executionRunStartChipPlacements';
import { getWorkflowContextChipDefinitions, getWorkflowStartVisibilityChipPlacement, getWorkflowStartWhereChipPlacement, getWorkflowStepOptionsChipPlacement } from '@/components/workflows/workflowComposerControlPlacements';

import { AGENT_INPUT_CONTROL_REGISTRY, AGENT_INPUT_FIELD_ACCESSORY_REGISTRY, findAgentInputControlDescriptor, getAgentInputFieldAccessoryPlacement } from './agentInputControlRegistry';
import {
    isAgentInputPluginControlId,
    type AgentInputControlId,
    type AgentInputControlPlacement,
    type AgentInputHostControlId,
    type AgentInputPlacementDescriptor,
    type AgentInputPlacementContext,
} from './agentInputControlTypes';

type CoreControl = Readonly<{ id: AgentInputHostControlId; title?: string; icon?: IconName; pending?: boolean }>;
type Accessory = Readonly<{ id: 'promptLibrary' | 'dictate'; title: string; icon?: IconName; pending?: boolean }>;
type AdmittedDefinition = Readonly<{
    controlId: AgentInputControlId;
    placement: AgentInputControlPlacement;
    contexts?: readonly AgentInputPlacementContext[];
}>;
type ProjectionInput = Readonly<{
    coreControls: readonly CoreControl[];
    accessories?: readonly Accessory[];
    phone?: boolean;
    newSession?: boolean;
    containedControlIds?: readonly AgentInputControlId[];
}>;

export function resolveAgentInputPlacementContext(
    composerKind?: ComposerRefV1['kind'],
    conversation = false,
): AgentInputPlacementContext {
    if (composerKind === 'discussion') return 'discussion';
    if (composerKind === 'workflowAuthoring') return 'workflow';
    if (composerKind === 'newSession') return 'newSession';
    return composerKind || conversation ? 'session' : 'newSession';
}

function projectDescriptors(params: ProjectionInput, definitions: readonly AdmittedDefinition[]): readonly AgentInputPlacementDescriptor[] {
    const contained = params.containedControlIds ? new Set(params.containedControlIds) : null;
    const descriptors: AgentInputPlacementDescriptor[] = [];
    const seen = new Set<string>();
    const add = (controlId: AgentInputControlId, placement: AgentInputControlPlacement, slot: AgentInputPlacementDescriptor['slot']) => {
        if (controlId === 'actionMenu' || controlId === 'stop' || (contained && !contained.has(controlId))) return;
        const registry = isAgentInputPluginControlId(controlId) ? null : findAgentInputControlDescriptor(controlId);
        if (!registry && !isAgentInputPluginControlId(controlId)) return;
        if (seen.has(placement.id)) throw new Error(`Duplicate composer placement id: ${placement.id}`);
        seen.add(placement.id);
        const allowedPlacements = params.newSession && (controlId === 'machine' || controlId === 'path')
            ? ['pinned', 'overflow'] as const
            : registry?.allowedPlacements;
        const menu = registry?.menu || placement.menu ? { ...registry?.menu, ...placement.menu } : undefined;
        descriptors.push({
            ...placement,
            ...(menu ? { menu } : {}),
            controlId,
            line: registry?.line ?? 'primary',
            slot,
            defaultPlacement: (params.phone ? registry?.phoneDefaultPlacement : undefined)
                ?? placement.defaultPlacement
                ?? registry?.defaultPlacement
                ?? 'overflow',
            ...(allowedPlacements ? { allowedPlacements } : {}),
            pending: placement.pending === true,
        });
    };
    for (const core of params.coreControls) {
        if (core.id === 'actionMenu' || core.id === 'stop' || (contained && !contained.has(core.id))) continue;
        const registry = findAgentInputControlDescriptor(core.id);
        const title = core.title ?? (registry?.titleKey ? t(registry.titleKey) : undefined);
        if (!title) throw new Error(`Composer control requires factory catalog metadata: ${core.id}`);
        add(core.id, { id: core.id, title, icon: core.icon ?? registry?.icon, pending: core.pending }, 'chip');
    }
    for (const definition of definitions) add(definition.controlId, definition.placement, 'chip');
    for (const accessory of params.accessories ?? []) {
        // Field accessories have their own physical slot; the generic shortcuts
        // group supplies capability admission without turning them into chips.
        add('shortcuts', { ...getAgentInputFieldAccessoryPlacement(accessory.id, accessory.pending), ...accessory }, 'fieldAccessory');
    }
    return orderDescriptors(descriptors);
}

function orderDescriptors(descriptors: readonly AgentInputPlacementDescriptor[]): readonly AgentInputPlacementDescriptor[] {
    const groups = new Map<AgentInputControlId, AgentInputPlacementDescriptor[]>();
    const plugins: AgentInputPlacementDescriptor[] = [];
    const accessories: AgentInputPlacementDescriptor[] = [];
    for (const descriptor of descriptors) {
        if (descriptor.slot === 'fieldAccessory') {
            accessories.push(descriptor);
        } else if (isAgentInputPluginControlId(descriptor.controlId)) {
            plugins.push(descriptor);
        } else {
            const group = groups.get(descriptor.controlId);
            if (group) group.push(descriptor);
            else groups.set(descriptor.controlId, [descriptor]);
        }
    }
    return [...AGENT_INPUT_CONTROL_REGISTRY.flatMap(control => groups.get(control.id) ?? []), ...plugins, ...accessories];
}

function getStaticFactoryDefinitions(context: AgentInputPlacementContext): readonly AdmittedDefinition[] {
    const definitions: readonly AdmittedDefinition[] = [
        ...getExecutionRunStartChipDefinitions().map(definition => ({ ...definition, contexts: ['newSession'] as const })),
        ...getWorkflowContextChipDefinitions().map(definition => ({
            ...definition,
            contexts: definition.key === 'discussion-run-where' ? ['discussion'] as const : ['workflow'] as const,
        })),
        { controlId: 'connectedServices', placement: getConnectedServicesAuthActionChipPlacement(), contexts: ['session'] },
        { controlId: 'connectedServices', placement: getConnectedServicesAuthActionChipPlacement({ scoped: true }), contexts: ['newSession'] },
        { controlId: 'capabilities', placement: getCapabilitiesActionChipPlacement(), contexts: ['session'] },
        { controlId: 'capabilities', placement: getCapabilitiesActionChipPlacement({ scoped: true }), contexts: ['newSession'] },
        { controlId: 'recipient', placement: getRecipientActionChipPlacement(context === 'discussion' ? 'discussion' : 'session'), contexts: ['session', 'discussion'] },
        { controlId: 'delivery', placement: getAgentInputResetStartPlacement(), contexts: ['session'] },
        { controlId: 'delivery', placement: getExecutionRunRequestedActionChipPlacement(), contexts: ['session'] },
        { controlId: 'delivery', placement: getExecutionRunReportChipPlacement(), contexts: ['newSession'] },
        { controlId: 'reviewComments', placement: getReviewCommentsActionChipPlacement(), contexts: ['session'] },
        { controlId: 'shortcuts', placement: getMentionActionChipPlacement(), contexts: ['discussion'] },
        { controlId: 'shortcuts', placement: getBrowserContextActionChipPlacement(), contexts: ['session', 'newSession'] },
        { controlId: 'shortcuts', placement: getSessionSourceContextActionChipPlacement(), contexts: ['session'] },
        { controlId: 'shortcuts', placement: getWorkflowStepOptionsChipPlacement(), contexts: ['workflow'] },
        { controlId: 'sessionAccess', placement: getTemporaryComputerTeamAccessActionChipPlacement(), contexts: ['newSession'] },
        { controlId: 'sessionAccess', placement: getWorkflowStartVisibilityChipPlacement(), contexts: ['workflow'] },
        { controlId: 'organization', placement: getNewSessionSpaceActionChipPlacement(), contexts: ['newSession'] },
        { controlId: 'machine', placement: getWorkflowStartWhereChipPlacement(), contexts: ['workflow'] },
        { controlId: 'automation', placement: getNewSessionTriggersActionChipPlacement(), contexts: ['newSession'] },
    ];
    return definitions.filter(definition => definition.contexts?.includes(context));
}

/** Metadata only: this never renders chips or opens their detail owners. */
export function buildAgentInputPlacementDescriptors(params: ProjectionInput & Readonly<{
    chips?: readonly AgentInputExtraActionChip[];
}>): readonly AgentInputPlacementDescriptor[] {
    const definitions: AdmittedDefinition[] = [];
    for (const chip of params.chips ?? []) {
        if (chip.controlId && chip.placement) {
            const opensDetail = Boolean(chip.collapsedContentPopover || chip.collapsedOptionsPopover || chip.renderCollapsedPopover);
            const description = chip.collapsedContentPopover?.header?.description;
            definitions.push({ controlId: chip.controlId, placement: {
                ...chip.placement,
                ...(opensDetail ? { menu: { disclosure: true, ...(description ? { description } : {}), ...chip.placement.menu } } : {}),
            } });
        }
    }
    return projectDescriptors(params, definitions);
}

/**
 * Settings consumes the same registry and lightweight factory definitions without
 * mounting a composer. Definition-driven provider/plugin/Action entries arrive
 * from their admitted owners; no detail inventory is loaded to enumerate them.
 */
type CatalogInput = Readonly<{
    admittedDefinitions?: readonly AdmittedDefinition[];
    accessories?: readonly Accessory[];
    phone?: boolean;
    newSession?: boolean;
    context?: AgentInputPlacementContext;
    runtimeDescriptors?: readonly AgentInputPlacementDescriptor[];
}>;

const WORKFLOW_CONTROL_IDS = new Set<AgentInputControlId>(['workflow', 'workflowInputs', 'workflowRoles', 'workflowTargets']);
const NEW_SESSION_CONTROL_IDS = new Set<AgentInputControlId>(['server', 'storage', 'windowsRemoteSessionMode', 'checkout', 'organization', 'automation']);

export function buildAgentInputPlacementCatalog(params: CatalogInput = {}): readonly AgentInputPlacementDescriptor[] {
    const context = params.context ?? (params.newSession ? 'newSession' : 'session');
    const definitions = new Map(getStaticFactoryDefinitions(context).map(definition => [definition.placement.id, definition]));
    for (const definition of params.admittedDefinitions ?? []) {
        if (!definition.contexts || definition.contexts.includes(context)) definitions.set(definition.placement.id, definition);
    }
    const accessories = new Map<string, Accessory>(AGENT_INPUT_FIELD_ACCESSORY_REGISTRY.map(accessory => [accessory.id, getAgentInputFieldAccessoryPlacement(accessory.id)]));
    for (const accessory of params.accessories ?? []) accessories.set(accessory.id, accessory);
    // An admitted accessory retains the field slot even if its generic host
    // contribution group is shortcuts. Its stable id has one catalog entry.
    for (const accessory of AGENT_INPUT_FIELD_ACCESSORY_REGISTRY) {
        const definition = definitions.get(accessory.id);
        if (!definition) continue;
        accessories.set(accessory.id, { ...definition.placement, id: accessory.id });
        definitions.delete(accessory.id);
    }
    const coreControls = AGENT_INPUT_CONTROL_REGISTRY.filter(control => {
        if (!('titleKey' in control) || definitions.has(control.id)) return false;
        if (WORKFLOW_CONTROL_IDS.has(control.id)) return context === 'workflow';
        if (NEW_SESSION_CONTROL_IDS.has(control.id)) return context === 'newSession';
        if (control.id === 'connectedServices' || control.id === 'capabilities') return context === 'session';
        if (control.id === 'goal' || control.id === 'resume' || control.id === 'files') return context === 'session';
        if (control.id === 'tags' || control.id === 'sessionAccess') return context === 'session' || context === 'newSession';
        return true;
    });
    const descriptors = projectDescriptors({
        ...params,
        newSession: context === 'newSession',
        coreControls,
        accessories: [...accessories.values()],
    }, [...definitions.values()]);
    if (!params.runtimeDescriptors?.length) return descriptors;
    const merged = new Map(descriptors.map(descriptor => [descriptor.id, descriptor]));
    for (const descriptor of params.runtimeDescriptors) {
        if (descriptor.controlId === 'stop' || descriptor.controlId === 'actionMenu') continue;
        merged.set(descriptor.id, descriptor);
    }
    return orderDescriptors([...merged.values()]);
}

/** Each context uses the same placement ids/preferences, but only its own control inventory and live facts. */
export function buildAgentInputPlacementCatalogGroups(params: CatalogInput = {}): readonly Readonly<{
    id: AgentInputPlacementContext;
    descriptors: readonly AgentInputPlacementDescriptor[];
}>[] {
    return (['session', 'newSession', 'workflow', 'discussion'] as const).map(context => ({
        id: context,
        descriptors: buildAgentInputPlacementCatalog({
            ...params,
            context,
            runtimeDescriptors: context === (params.context ?? 'session') ? params.runtimeDescriptors : undefined,
        }),
    }));
}
