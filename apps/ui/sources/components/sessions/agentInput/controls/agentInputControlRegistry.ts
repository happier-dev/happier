import type { AgentInputControlDescriptor, AgentInputControlMenuMetadata, AgentInputControlPlacement, AgentInputHostControlId } from './agentInputControlTypes';
import type { NavigationPlacement } from '@/sync/domains/settings/mobileSurfacePinning';
import { t, type TranslationKeyNoParams } from '@/text';
import type { IconName } from '@/components/ui/icons/Icon';

type AgentInputCatalogControlDescriptor = AgentInputControlDescriptor & Readonly<{
    titleKey?: TranslationKeyNoParams;
    icon?: IconName;
    defaultPlacement?: NavigationPlacement;
    phoneDefaultPlacement?: NavigationPlacement;
    allowedPlacements?: readonly NavigationPlacement[];
    menu?: AgentInputControlMenuMetadata;
}>;

/**
 * Rail order (owner, 2026-10-12): rail 1 reads as setup — the small attachment controls (paperclip, @),
 * then engine/model, permission, mode, the route it runs through, launch profile/environment, then the
 * rest (sharing, tags, ...). Rail 2 is where it runs — machine, folder, resume — then the Git checkout,
 * the session-list folder (`organization`), and automation.
 */
export const AGENT_INPUT_CONTROL_REGISTRY = [
    { id: 'attachments', line: 'primary', titleKey: 'settings.attachments', icon: 'paperclip', defaultPlacement: 'overflow' },
    { id: 'files', line: 'primary', titleKey: 'agentInput.actionMenu.files', icon: 'files', defaultPlacement: 'overflow', allowedPlacements: ['overflow', 'hidden'] },
    { id: 'linkedFiles', line: 'primary', titleKey: 'navigationPlacement.linkedFiles', icon: 'at', defaultPlacement: 'overflow' },
    { id: 'engine', line: 'primary', titleKey: 'newSession.wizardSection.model', icon: 'sparkle', defaultPlacement: 'pinned', menu: { disclosure: true } },
    { id: 'permission', line: 'primary', titleKey: 'newSession.wizardSection.permission', icon: 'shield-check', defaultPlacement: 'pinned', allowedPlacements: ['pinned', 'overflow'], menu: { disclosure: true } },
    { id: 'mode', line: 'primary', titleKey: 'agentInput.mode.sectionTitle', icon: 'rocket-launch', defaultPlacement: 'pinned', menu: { disclosure: true } },
    { id: 'connectedServices', line: 'primary', titleKey: 'connectedServices.authChip.popoverTitle', icon: 'path', defaultPlacement: 'overflow' },
    { id: 'profile', line: 'primary', titleKey: 'newSession.wizardSection.profile', icon: 'user-circle', defaultPlacement: 'overflow', menu: { disclosure: true } },
    { id: 'env', line: 'primary', titleKey: 'agentInput.envVars.title', icon: 'list', defaultPlacement: 'overflow', menu: { disclosure: true } },
    // Stop leads "the rest", so a running turn's stop never hides behind the rail's scroll.
    { id: 'stop', line: 'primary' },
    { id: 'goal', line: 'primary', titleKey: 'session.workState.goal.title', icon: 'target', defaultPlacement: 'overflow' },
    { id: 'workflow', line: 'primary', titleKey: 'workflows.start.workflow', icon: 'tree-structure', defaultPlacement: 'overflow' },
    { id: 'workflowInputs', line: 'primary', titleKey: 'workflows.start.inputs', icon: 'sliders-horizontal', defaultPlacement: 'overflow' },
    { id: 'workflowRoles', line: 'primary', titleKey: 'workflows.start.rolesTitle', icon: 'users', defaultPlacement: 'overflow' },
    { id: 'workflowTargets', line: 'primary', titleKey: 'navigationPlacement.workflowStepTargets', icon: 'crosshair', defaultPlacement: 'overflow' },
    { id: 'server', line: 'primary', titleKey: 'settings.servers', icon: 'hard-drives', defaultPlacement: 'overflow' },
    { id: 'capabilities', line: 'primary', titleKey: 'settingsAgents.capabilities', icon: 'stack', defaultPlacement: 'overflow' },
    { id: 'sessionAccess', line: 'primary', titleKey: 'session.access.title', icon: 'users', defaultPlacement: 'overflow' },
    { id: 'tags', line: 'primary', titleKey: 'settingsSession.sessionList.tagsTitle', icon: 'tag', defaultPlacement: 'hidden' },
    { id: 'recipient', line: 'primary', titleKey: 'session.participants.sendToTitle', icon: 'navigation-arrow', defaultPlacement: 'overflow' },
    { id: 'delivery', line: 'primary', defaultPlacement: 'overflow' },
    { id: 'reviewComments', line: 'primary', defaultPlacement: 'overflow' },
    { id: 'storage', line: 'primary', titleKey: 'settingsSession.defaultStorage.title', icon: 'floppy-disk', defaultPlacement: 'overflow' },
    { id: 'windowsRemoteSessionMode', line: 'primary', titleKey: 'machine.windows.remoteSessionModeTitle', icon: 'windows-logo', defaultPlacement: 'overflow' },
    { id: 'providerOption', line: 'primary', defaultPlacement: 'overflow' },
    { id: 'shortcuts', line: 'primary', defaultPlacement: 'overflow' },
    { id: 'actionMenu', line: 'primary' },
    { id: 'machine', line: 'secondary', titleKey: 'newSession.wizardSection.machine', icon: 'desktop', defaultPlacement: 'pinned', menu: { disclosure: true } },
    { id: 'path', line: 'secondary', titleKey: 'newSession.wizardSection.folder', icon: 'folder', defaultPlacement: 'pinned', menu: { disclosure: true } },
    { id: 'resume', line: 'secondary', titleKey: 'newSession.resume.title', icon: 'arrow-arc-left', defaultPlacement: 'overflow', menu: { disclosure: true } },
    { id: 'checkout', line: 'secondary', titleKey: 'newSession.sessionType.worktree', icon: 'git-branch', defaultPlacement: 'pinned', phoneDefaultPlacement: 'overflow' },
    { id: 'organization', line: 'secondary', titleKey: 'sessionsList.sectionTitle', icon: 'list', defaultPlacement: 'overflow' },
    { id: 'automation', line: 'secondary', titleKey: 'navigation.automation', icon: 'lightning', defaultPlacement: 'overflow' },
] as const satisfies ReadonlyArray<AgentInputCatalogControlDescriptor>;

export const AGENT_INPUT_FIELD_ACCESSORY_REGISTRY = [
    { id: 'promptLibrary', titleKey: 'actionFamilies.prompt_library', icon: 'book-open', defaultPlacement: 'pinned' },
    { id: 'dictate', titleKey: 'voicePresence.dictate', icon: 'microphone', defaultPlacement: 'pinned' },
] as const satisfies readonly Readonly<{
    id: 'promptLibrary' | 'dictate';
    titleKey: TranslationKeyNoParams;
    icon: IconName;
    defaultPlacement: 'pinned';
}>[];

export function getAgentInputFieldAccessoryPlacement<Id extends 'promptLibrary' | 'dictate'>(
    id: Id,
    pending = false,
): AgentInputControlPlacement & Readonly<{ id: Id; icon: IconName; defaultPlacement: 'pinned' }> {
    const definition = AGENT_INPUT_FIELD_ACCESSORY_REGISTRY.find(accessory => accessory.id === id)!;
    return { id, title: t(definition.titleKey), icon: definition.icon, defaultPlacement: definition.defaultPlacement, pending };
}

/**
 * The compact composer (an "Ask an agent" box on a page about one machine, lab `ra` A1): where it runs
 * and which model answers, on one rail. Everything else keeps its default for the new session.
 */
export const AGENT_INPUT_COMPACT_CONTROL_IDS = ['engine', 'machine'] as const satisfies readonly AgentInputHostControlId[];

export function findAgentInputControlDescriptor(id: AgentInputHostControlId): AgentInputCatalogControlDescriptor | null {
    return AGENT_INPUT_CONTROL_REGISTRY.find((control) => control.id === id) ?? null;
}
