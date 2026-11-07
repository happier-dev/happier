import { describe, expect, it, vi } from 'vitest';

import { AGENT_INPUT_CONTROL_REGISTRY } from './agentInputControlRegistry';
import { buildAgentInputPlacementCatalog, buildAgentInputPlacementCatalogGroups, buildAgentInputPlacementDescriptors, resolveAgentInputPlacementContext } from './buildAgentInputPlacementDescriptors';
import type { AgentInputExtraActionChip } from '../agentInputContracts';
import type { AgentInputPlacementDescriptor } from './agentInputControlTypes';
import { buildConfiguredActionShortcutPlacementDefinitions } from '../sessionActions/agentInputActionShortcutPlacements';
import { getCapabilitiesActionChipPlacement } from '../../capabilities/capabilitiesActionChipPlacement';
import { getBrowserContextActionChipPlacement, getLinkedFilesActionChipPlacement } from '../definitions/agentInputActionChipPlacements';
import { getNewSessionCheckoutActionChipPlacement, getNewSessionOrganizationActionChipPlacement } from '../../new/newSessionActionChipPlacements';
import { getExecutionRunStartChipDefinition } from '../../runs/launcher/executionRunStartChipPlacements';
import { getAgentInputFieldAccessoryPlacement } from './agentInputControlRegistry';

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock();
});

describe('composer control catalog', () => {
    it('distinguishes run and step target controls and projects their own semantic glyphs', () => {
        const controls = buildAgentInputPlacementCatalogGroups().flatMap(group => group.descriptors);
        expect(controls.find(control => control.id === 'workflowTargets')).toMatchObject({
            title: 'navigationPlacement.workflowStepTargets', icon: 'crosshair',
        });
        expect(controls.find(control => control.id === 'workflowTargets:workflow-start-run-as')).toMatchObject({
            title: 'navigationPlacement.workflowRunTarget', icon: 'stack',
        });
        expect(controls.find(control => control.id === 'connectedServices:execution-run-start-route')).toMatchObject({
            title: 'agentInput.model.title', icon: 'sparkle',
        });
        expect(controls.find(control => control.id === 'engine:workflow-run-another-agent')).toMatchObject({
            title: 'agentInput.model.title', icon: 'sparkle',
        });
        expect(controls.find(control => control.id === 'sessionAccess:workflow-start-visibility')).toMatchObject({
            title: 'workflows.start.visibility.title', icon: 'users',
        });
        expect(controls.find(control => control.id === 'shortcuts:browser-context')).toMatchObject({
            title: 'actionFamilies.browser_context', icon: 'globe',
        });
        expect(controls.find(control => control.id === 'organization')).toMatchObject({
            title: 'sessionsList.sectionTitle', icon: 'list',
        });
        const route = getExecutionRunStartChipDefinition('route');
        expect(route.icon).toBe('path');
        expect(route.placement.icon).toBe('sparkle');
    });

    it('uses the existing Composer identity for customization context, not chip labels', () => {
        expect(resolveAgentInputPlacementContext('discussion')).toBe('discussion');
        expect(resolveAgentInputPlacementContext('workflowAuthoring')).toBe('workflow');
        expect(resolveAgentInputPlacementContext('newSession')).toBe('newSession');
        expect(resolveAgentInputPlacementContext('participantMessage')).toBe('session');
        expect(resolveAgentInputPlacementContext(undefined, true)).toBe('session');
        expect(resolveAgentInputPlacementContext()).toBe('newSession');
    });
    it('names controls independently of picker commands and current values', () => {
        expect(getAgentInputFieldAccessoryPlacement('promptLibrary').title).toBe('actionFamilies.prompt_library');
        expect(AGENT_INPUT_CONTROL_REGISTRY.find(control => control.id === 'linkedFiles')).toMatchObject({ titleKey: 'navigationPlacement.linkedFiles' });
        expect(getLinkedFilesActionChipPlacement().title).toBe('navigationPlacement.linkedFiles');
        expect(getBrowserContextActionChipPlacement().title).toBe('actionFamilies.browser_context');
        expect(getCapabilitiesActionChipPlacement().title).toBe('settingsAgents.capabilities');
        expect(getCapabilitiesActionChipPlacement({ scoped: true }).title).toBe('settingsAgents.capabilities');
        expect(AGENT_INPUT_CONTROL_REGISTRY.find(control => control.id === 'checkout')).toMatchObject({ titleKey: 'newSession.sessionType.worktree' });
        expect(AGENT_INPUT_CONTROL_REGISTRY.find(control => control.id === 'organization')).toMatchObject({ titleKey: 'sessionsList.sectionTitle' });
        expect(getNewSessionCheckoutActionChipPlacement().title).toBe('newSession.sessionType.worktree');
        expect(getNewSessionOrganizationActionChipPlacement('organization').title).toBe('sessionsList.sectionTitle');
        expect(getNewSessionOrganizationActionChipPlacement('tags').title).toBe('settingsSession.sessionList.tagsTitle');
        const reviewers = getExecutionRunStartChipDefinition('reviewersAdd');
        expect(reviewers.placement.title).toBe('runPage.review.reviewers');
        expect(reviewers.title).toBe('agentStart.chips.addReviewer');
    });

    it('excludes workflow-only controls from the ordinary session catalog and preview input', () => {
        const sessionIds = buildAgentInputPlacementCatalog({ context: 'session' }).map(control => control.id);
        expect(sessionIds).not.toContain('shortcuts:workflow-step-options');
        expect(sessionIds).not.toContain('machine:workflow-start-where');
    });
    it('declares placement defaults and locks at the canonical registry', () => {
        expect(AGENT_INPUT_CONTROL_REGISTRY.find(control => control.id === 'permission')).toMatchObject({
            defaultPlacement: 'pinned', allowedPlacements: ['pinned', 'overflow'],
        });
        expect(AGENT_INPUT_CONTROL_REGISTRY.find(control => control.id === 'files')).toMatchObject({
            defaultPlacement: 'overflow', allowedPlacements: ['overflow', 'hidden'],
        });
        expect(AGENT_INPUT_CONTROL_REGISTRY.find(control => control.id === 'checkout')).toMatchObject({
            defaultPlacement: 'pinned', phoneDefaultPlacement: 'overflow',
        });
        expect(AGENT_INPUT_CONTROL_REGISTRY.find(control => control.id === 'tags')).toMatchObject({ defaultPlacement: 'hidden' });
    });

    it('uses device defaults, location locks and field slots without changing identity', () => {
        const coreControls = (['checkout', 'path', 'resume', 'machine', 'permission', 'stop', 'actionMenu'] as const).map(id => ({ id, title: id }));
        const desktop = buildAgentInputPlacementDescriptors({ coreControls, newSession: true, accessories: [{ id: 'dictate', title: 'Dictate', pending: true }] });
        expect(desktop.map(control => control.id)).toEqual(['permission', 'machine', 'path', 'resume', 'checkout', 'dictate']);
        expect(desktop.find(control => control.id === 'path')?.allowedPlacements).toEqual(['pinned', 'overflow']);
        expect(desktop.find(control => control.id === 'checkout')?.defaultPlacement).toBe('pinned');
        expect(desktop.at(-1)).toMatchObject({ id: 'dictate', slot: 'fieldAccessory', defaultPlacement: 'pinned', pending: true });
        const phone = buildAgentInputPlacementDescriptors({ coreControls, phone: true });
        expect(phone.find(control => control.id === 'checkout')?.defaultPlacement).toBe('overflow');
        expect(phone.find(control => control.id === 'path')?.allowedPlacements).toBeUndefined();
    });

    it('keeps individual group members, admitted plugin order and explicit recipient context', () => {
        const chip = (controlId: AgentInputExtraActionChip['controlId'], id: string, defaultPlacement: 'pinned' | 'overflow' = 'overflow'): AgentInputExtraActionChip => ({
            key: id, controlId, placement: { id, title: id, defaultPlacement }, render: () => null,
        });
        const chips = [chip('plugin:control:fixture/second', 'plugin:control:fixture/second'), chip('recipient', 'recipient', 'pinned'), chip('delivery', 'delivery:first'), chip('delivery', 'delivery:second'), chip('plugin:action:fixture/first', 'plugin:action:fixture/first')];
        const descriptors = buildAgentInputPlacementDescriptors({ coreControls: [], chips });
        expect(descriptors.map(control => control.id)).toEqual(['recipient', 'delivery:first', 'delivery:second', 'plugin:control:fixture/second', 'plugin:action:fixture/first']);
        expect(descriptors[0].defaultPlacement).toBe('pinned');
        expect(buildAgentInputPlacementDescriptors({ coreControls: [], chips, containedControlIds: ['delivery'] }).map(control => control.id)).toEqual(['delivery:first', 'delivery:second']);
        expect(() => buildAgentInputPlacementDescriptors({ coreControls: [], chips: [chips[1], chips[1]] })).toThrow('Duplicate composer placement id');
    });

    it('exposes factory definitions to Settings without chip rendering or group placeholders', () => {
        const descriptors = buildAgentInputPlacementCatalog({ admittedDefinitions: [{ controlId: 'delivery', placement: { id: 'delivery:reset', title: 'Reset', pending: false } }] });
        expect(descriptors.find(control => control.id === 'delivery:reset')).toMatchObject({ controlId: 'delivery', defaultPlacement: 'overflow' });
        expect(descriptors.map(control => control.id)).not.toContain('delivery');
        expect(descriptors.map(control => control.id)).not.toContain('stop');
        expect(descriptors.filter(control => control.slot === 'fieldAccessory').map(control => control.id)).toEqual(['promptLibrary', 'dictate']);
        expect(buildAgentInputPlacementDescriptors({ coreControls: [] })).toEqual([]);
    });

    it('groups known controls by their actual composer context, with no duplicate placement ids', () => {
        const groups = buildAgentInputPlacementCatalogGroups();
        expect(groups.map(group => group.id)).toEqual(['session', 'newSession', 'workflow', 'discussion']);
        for (const group of groups) {
            expect(new Set(group.descriptors.map(control => control.id)).size).toBe(group.descriptors.length);
        }
        const ids = groups.flatMap(group => group.descriptors.map(control => control.id));
        expect(ids).toEqual(expect.arrayContaining([
            'shortcuts:mention',
            'shortcuts:browser-context',
            'shortcuts:session-source-context',
            'shortcuts:workflow-step-options',
            'reviewComments:review-comments',
            'delivery:resetStart',
            'delivery:execution-run-requested-action',
            'delivery:execution-run-start-report',
            'sessionAccess:new-session-temporary-computer-team-access',
            'sessionAccess:workflow-start-visibility',
            'automation:new-session-triggers',
            'machine:workflow-start-where',
            'capabilities:session-capabilities',
            'connectedServices:new-session-connected-services-auth',
            'workflowRoles:execution-run-start-role',
            'reviewComments:execution-run-start-reviewers-add',
            'permission:execution-run-start-permissions',
            'connectedServices:execution-run-start-route',
            'reviewComments:execution-run-start-scope',
            'providerOption:execution-run-start-advanced',
            'workflowTargets:workflow-start-run-as',
            'delivery:workflow-plan-report',
            'engine:workflow-run-another-agent',
            'machine:discussion-run-where',
        ]));
        const sessionIds = buildAgentInputPlacementCatalog({ context: 'session' }).map(control => control.id);
        expect(sessionIds).not.toContain('shortcuts:workflow-step-options');
        expect(sessionIds).not.toContain('machine:workflow-start-where');
        expect(sessionIds).not.toContain('automation:new-session-triggers');
        expect(sessionIds).not.toContain('shortcuts:mention');
        expect(buildAgentInputPlacementCatalog({ context: 'workflow' }).map(control => control.id)).toContain('shortcuts:workflow-step-options');
        expect(buildAgentInputPlacementCatalog({ context: 'discussion' }).map(control => control.id)).toContain('shortcuts:mention');
        const newSession = buildAgentInputPlacementCatalog({ context: 'newSession' });
        expect(newSession.map(control => control.id)).not.toContain('connectedServices');
        expect(newSession.find(control => control.id === 'path')?.allowedPlacements).toEqual(['pinned', 'overflow']);
        // "Runs through" defaults to In + (plan P3 §3.4, lab Kdef; owner 11-07), one registry decision for a running Session and a new one.
        expect(buildAgentInputPlacementCatalog({ context: 'session' }).find(control => control.id === 'connectedServices')?.defaultPlacement).toBe('overflow');
        expect(newSession.find(control => control.id === 'connectedServices:new-session-connected-services-auth')?.defaultPlacement).toBe('overflow');
        expect(buildAgentInputPlacementCatalog().find(control => control.id === 'recipient')?.defaultPlacement).toBe('overflow');
        expect(buildAgentInputPlacementCatalog({ context: 'discussion' }).find(control => control.id === 'recipient')?.defaultPlacement).toBe('pinned');
    });

    it('overlays admitted and runtime descriptors by individual id while retaining static inventory and field slots', () => {
        const runtime: AgentInputPlacementDescriptor = {
            id: 'dictate', controlId: 'shortcuts', title: 'Recording', icon: 'microphone',
            line: 'primary', slot: 'fieldAccessory', defaultPlacement: 'pinned',
            allowedPlacements: ['pinned'], pending: true,
        };
        const controls = buildAgentInputPlacementCatalog({
            admittedDefinitions: [{ controlId: 'shortcuts', placement: { id: 'dictate', title: 'Dictation' } }],
            runtimeDescriptors: [runtime],
        });
        expect(controls.filter(control => control.id === 'dictate')).toEqual([runtime]);
        expect(controls.some(control => control.id === 'shortcuts:session-source-context')).toBe(true);
    });

    it('admits configured Action shortcuts only in their declared contexts without rebuilding their keys', () => {
        const definitions = buildConfiguredActionShortcutPlacementDefinitions(['review.start']);
        const groups = buildAgentInputPlacementCatalogGroups({ admittedDefinitions: definitions });
        expect(groups.flatMap(group => group.descriptors).filter(control => control.id.includes('action:review.start')).map(control => control.id)).toEqual([
            'shortcuts:session-action:review.start', 'shortcuts:new-session-action:review.start',
        ]);
    });

    it('deduplicates metadata per context and only overlays live facts in the opener context', () => {
        const runtime: AgentInputPlacementDescriptor = {
            id: 'recipient', controlId: 'recipient', title: 'Recipient', line: 'primary', slot: 'chip',
            defaultPlacement: 'pinned', pending: true,
        };
        const definition = { controlId: 'shortcuts' as const, placement: { id: 'fixture', title: 'Fixture' }, contexts: ['discussion'] as const };
        const groups = buildAgentInputPlacementCatalogGroups({
            admittedDefinitions: [definition, definition], runtimeDescriptors: [runtime], context: 'discussion',
        });
        expect(groups.find(group => group.id === 'discussion')?.descriptors.find(control => control.id === 'recipient')).toBe(runtime);
        expect(groups.find(group => group.id === 'session')?.descriptors.find(control => control.id === 'recipient')?.pending).toBe(false);
        expect(groups.filter(group => group.descriptors.some(control => control.id === 'fixture')).map(group => group.id)).toEqual(['discussion']);
    });
});
