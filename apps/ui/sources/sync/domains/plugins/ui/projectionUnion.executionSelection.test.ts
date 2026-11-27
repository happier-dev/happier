import { expect, it } from 'vitest';
import { PluginMachineExecutionOriginV1Schema } from '@happier-dev/protocol/machines/administration/pluginMachineExecutionOriginV1';
import { widgetProjectionOf } from '@/dev/testkit/fixtures/pluginWidgetProjectionFixtures';
import { resolvePluginMachineExecutionOriginState } from '@/sync/domains/machines/administration/pluginExecutionOrigin';
import { createPluginUiProjectionUnionPublication, readPluginUiContributionOrigin, readPluginUiContributionSupplies, readPluginUiExecutionOriginCandidates, resolvePluginUiExecutionDeclaration, unionPluginUiProjections } from './projectionUnion';

it('never appoints even a sole producer before Administration selects it', () => {
    const pluginId = 'acme.execution-selection';
    const sourceCustody = { kind: 'development' as const, registeredRootId: 'selection-root' };
    const origin = PluginMachineExecutionOriginV1Schema.parse({ serverIdentityId: 'srv_selection',
        sourceRef: { pluginId, machineId: 'machine-a', sourceCustody } });
    const projection = widgetProjectionOf([{ pluginId, localId: 'latest', target: 'app', occurrenceId: 'slot-a' }], {
        [pluginId]: { id: pluginId, displayName: 'Latest entries', enabled: true, version: '1.0.0', occurrenceId: 'slot-a',
            executionOrigin: origin, sourceCustody, source: { kind: 'localPath', locator: 'selection-root' } },
    });
    const members = [{ machineId: 'machine-a', serverId: 'home-a', serverIdentityId: 'srv_selection',
        phase: 'current' as const, interactionEnabled: true, projection }];
    const unselected = unionPluginUiProjections(members).pluginUiProjection!;
    const key = `surfacePlacement:${pluginId}:latest`;
    expect(readPluginUiContributionOrigin(unselected.surfacePlacementsById[key])).toBeNull();
    const facts = readPluginUiExecutionOriginCandidates({ projection: unselected, pluginId });
    const decision = resolvePluginMachineExecutionOriginState({ pluginId, storedOrigin: null,
        candidates: facts.sourceCandidates, ...facts });
    expect(decision.kind).toBe('selected');
    if (decision.kind !== 'selected') throw new Error('Expected the canonical automatic decision');
    const selected = unionPluginUiProjections(members, new Map([[pluginId, decision.origin]])).pluginUiProjection!;
    expect(readPluginUiContributionOrigin(selected.surfacePlacementsById[key])).toMatchObject({ machineId: 'machine-a', executionOrigin: origin });
});

it('keeps each surface Resource capability with its exact supplier and refreshes changed facts', () => {
    const pluginId = 'acme.execution-selection';
    const sourceCustody = { kind: 'development' as const, registeredRootId: 'selection-root' };
    const origin = PluginMachineExecutionOriginV1Schema.parse({ serverIdentityId: 'srv_selection',
        sourceRef: { pluginId, machineId: 'machine-a', sourceCustody } });
    const base = widgetProjectionOf(['live', 'local'].map(localId => ({ pluginId, localId, target: 'app' as const, occurrenceId: 'slot-a' })), {
        [pluginId]: { id: pluginId, displayName: 'Resource facts', enabled: true, version: '1.0.0', occurrenceId: 'slot-a',
            executionOrigin: origin, sourceCustody, source: { kind: 'localPath', locator: 'selection-root' } },
    });
    const liveKey = `surfacePlacement:${pluginId}:live`;
    const localKey = `surfacePlacement:${pluginId}:local`;
    const member = (dynamic: boolean) => ({ machineId: 'machine-a', serverId: 'home-a', serverIdentityId: 'srv_selection',
        phase: 'current' as const, interactionEnabled: true, projection: { ...base, surfacePlacementsById: {
            ...base.surfacePlacementsById,
            [liveKey]: { ...base.surfacePlacementsById[liveKey]!, runtime: { resourceCapability: { readable: true, dynamic } } },
        } } });
    const publication = createPluginUiProjectionUnionPublication();
    const selections = new Map([[pluginId, origin]]);
    const initial = publication.publish([member(true)], selections).pluginUiProjection!;
    expect(readPluginUiContributionSupplies(initial.surfacePlacementsById[liveKey])[0]?.resourceCapability)
        .toEqual({ readable: true, dynamic: true });
    expect(readPluginUiContributionSupplies(initial.surfacePlacementsById[localKey])[0]?.resourceCapability)
        .toEqual({ readable: false, dynamic: false });
    const changed = publication.publish([member(false)], selections).pluginUiProjection!;
    expect(readPluginUiContributionSupplies(changed.surfacePlacementsById[liveKey])[0]?.resourceCapability)
        .toEqual({ readable: true, dynamic: false });
});

it('does not replace a captured selected placement with a sibling Resource supplier', () => {
    const pluginId = 'acme.execution-selection';
    const key = `surfacePlacement:${pluginId}:latest`;
    const resourceKey = `${pluginId}/status`;
    const member = (machineId: string, occurrenceId: string) => {
        const sourceCustody = { kind: 'development' as const, registeredRootId: 'selection-root' };
        const executionOrigin = PluginMachineExecutionOriginV1Schema.parse({ serverIdentityId: 'srv_selection',
            sourceRef: { pluginId, machineId, sourceCustody } });
        return { machineId, serverId: 'home-a', serverIdentityId: 'srv_selection', phase: 'current' as const,
            interactionEnabled: true, projection: widgetProjectionOf([{ pluginId, localId: 'latest', target: 'app', occurrenceId }], {
                [pluginId]: { id: pluginId, displayName: 'Selected Resource', enabled: true, version: '1.0.0', occurrenceId,
                    executionOrigin, sourceCustody, source: { kind: 'localPath', locator: 'selection-root' } },
            }, { [resourceKey]: { id: 'status', pluginId, occurrenceId, executionOrigin,
                resourceKind: 'config', scope: 'global', contentType: 'application/json' } }) };
    };
    const selected = member('machine-a', 'slot-a');
    const sibling = member('machine-b', 'slot-b');
    const origin = selected.projection.installedPackagesById[pluginId]!.executionOrigin!;
    const projection = unionPluginUiProjections([selected, sibling], new Map([[pluginId, origin]])).pluginUiProjection!;
    const captured = projection.surfacePlacementsById[key]!;
    expect(readPluginUiContributionOrigin(captured)?.machineId).toBe('machine-a');
    expect(resolvePluginUiExecutionDeclaration(captured, { machineResource: projection.resourcesById[resourceKey] }))
        .toMatchObject({ occurrenceId: 'slot-a' });
    expect(resolvePluginUiExecutionDeclaration(captured, { machineResource: sibling.projection.resourcesById[resourceKey] }))
        .toBeNull();
});

it('settles absence for the selected replica only in the family it has answered', () => {
    const pluginId = 'acme.scoped-selection';
    const resourceKey = `${pluginId}/status`;
    const placementKey = `surfacePlacement:${pluginId}:sibling-only`;
    const sourceCustody = { kind: 'development' as const, registeredRootId: 'selection-root' };
    const replica = (machineId: string, hasSiblingPlacement: boolean) => {
        const executionOrigin = PluginMachineExecutionOriginV1Schema.parse({ serverIdentityId: 'srv_selection',
            sourceRef: { pluginId, machineId, sourceCustody } });
        const stamp = { occurrenceId: machineId, executionOrigin };
        const projection = widgetProjectionOf(hasSiblingPlacement
            ? [{ pluginId, localId: 'sibling-only', target: 'app', ...stamp }] : [], {
            [pluginId]: { id: pluginId, displayName: 'Scoped selection', enabled: true, version: '1.0.0',
                ...stamp, sourceCustody, source: { kind: 'localPath', locator: 'selection-root' } },
        }, { [resourceKey]: { id: 'status', pluginId, ...stamp,
            resourceKind: 'config', scope: 'global', contentType: 'application/json' } });
        return { machineId, serverId: 'home-a', serverIdentityId: executionOrigin.serverIdentityId,
            phase: 'current' as const, interactionEnabled: true, projection };
    };
    const selected = replica('machine-a', false);
    const sibling = replica('machine-b', true);
    const executionOrigin = selected.projection.installedPackagesById[pluginId]!.executionOrigin!;
    const selections = new Map([[pluginId, executionOrigin]]);
    const publish = createPluginUiProjectionUnionPublication();
    const resourcesOnly = { ...selected, phase: 'establishing' as const, interactionEnabled: false,
        currentPresentationSections: ['resourcesById'] as const };
    const first = publish.publish([resourcesOnly, sibling], selections);
    expect(first.hasEstablishingMembers).toBe(true);
    expect(readPluginUiContributionOrigin(first.pluginUiProjection?.resourcesById[resourceKey]))
        .toMatchObject({ phase: 'current', interactionEnabled: true, executionOrigin });
    const pendingPlacement = first.pluginUiProjection?.surfacePlacementsById[placementKey];
    expect(pendingPlacement).toBeDefined();
    expect(readPluginUiContributionOrigin(pendingPlacement)).toBeNull();
    const after = publish.publish([{ ...resourcesOnly,
        currentPresentationSections: ['resourcesById', 'familiesById.pluginUi'] as const }, sibling], selections);
    expect(after.pluginUiProjection?.surfacePlacementsById[placementKey]).toBeUndefined();
    expect(after.hasEstablishingMembers).toBe(true);

    const contextualProjection = { ...sibling.projection, resourcesById: {
        [resourceKey]: { ...sibling.projection.resourcesById[resourceKey]!, executionOrigin: undefined },
    } };
    const contextualOrigin = sibling.projection.installedPackagesById[pluginId]!.executionOrigin!;
    const partialUi = { ...sibling, projection: contextualProjection, phase: 'establishing' as const,
        interactionEnabled: false, currentPresentationSections: ['familiesById.pluginUi'] as const };
    const contextual = publish.publish([partialUi], new Map([[pluginId, contextualOrigin]])).pluginUiProjection;
    expect(readPluginUiContributionOrigin(contextual?.surfacePlacementsById[placementKey]))
        .toMatchObject({ phase: 'current', interactionEnabled: true });
    expect(readPluginUiContributionOrigin(contextual?.resourcesById[resourceKey])?.interactionEnabled ?? false).toBe(false);
});

it('retains the identity of every unchanged candidate fact when only establishing targets change', () => {
    const pluginId = 'acme.execution-fact-identity';
    const sourceCustody = { kind: 'development' as const, registeredRootId: 'fact-identity-root' };
    const origin = PluginMachineExecutionOriginV1Schema.parse({ serverIdentityId: 'srv_fact_identity',
        sourceRef: { pluginId, machineId: 'machine-a', sourceCustody } });
    const base = widgetProjectionOf([{ pluginId, localId: 'latest', target: 'app', occurrenceId: 'slot-a' }], {
        [pluginId]: { id: pluginId, displayName: 'Fact identity', enabled: true, version: '1.0.0', occurrenceId: 'slot-a',
            executionOrigin: origin, sourceCustody, source: { kind: 'localPath', locator: 'fact-identity-root' } },
    });
    const members = [{ machineId: 'machine-a', serverId: 'home-a', serverIdentityId: 'srv_fact_identity',
        phase: 'current' as const, interactionEnabled: true, projection: base }];
    const establishingTargets = [{ serverIdentityId: 'srv_fact_identity', machineId: 'machine-a' }];
    const first = readPluginUiExecutionOriginCandidates({ projection: base, pluginId, members, establishingTargets });
    expect(first.sourceCandidates).toHaveLength(1);
    expect(first.establishingTargets).toHaveLength(1);
    const settled = readPluginUiExecutionOriginCandidates({ projection: base, pluginId, members, previous: first });
    expect(settled.establishingTargets).toHaveLength(0);
    expect(settled.sourceCandidates).toBe(first.sourceCandidates);
    expect(settled.declaredDefaultOrigins).toBe(first.declaredDefaultOrigins);
    expect(settled.machineRejections).toBe(first.machineRejections);
});
