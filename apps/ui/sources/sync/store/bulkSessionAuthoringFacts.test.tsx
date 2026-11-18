import { expect, it } from 'vitest';
import { AcpBackendDefinitionV1Schema } from '@happier-dev/protocol/acp/catalog/settingsV1';
import { planExistingSessionChanges } from '@happier-dev/protocol/sessions/authoring/existingSessionPlanner';
import { buildConfiguredAcpAgentSelectionV1 } from '@happier-dev/protocol/agents/executionTargetV1';
import { getResolvedBackendCatalogEntries } from '@/agents/backendCatalog/getResolvedBackendCatalogEntries';
import { findSessionAuthoringAgentTargetOption } from '@/components/sessions/authoring/controls/sessionAuthoringFieldControls';
import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { projectBulkSessionAuthoringFact } from './bulkSessionAuthoringFacts';

const address = { serverId: 'home-a', sessionId: 'session' };
const session = createSessionFixture({ id: address.sessionId, serverId: address.serverId, active: true,
    metadata: { path: '/repo', host: 'host', agent: 'codex', machineId: 'machine' } });

it('keeps Send available when reselecting the configured engine from current Session metadata', () => {
    const configured = buildConfiguredAcpAgentSelectionV1('review-bot');
    const fact = projectBulkSessionAuthoringFact(address, { ...session, metadata: {
        ...session.metadata!, agent: configured.agentId, flavor: configured.flavor,
        runtimeDescriptorV1: configured.runtimeDescriptorV1,
        acpConfiguredBackendV1: { v: 1, updatedAt: 1, backendId: 'review-bot', title: 'Review Bot' },
    } });
    expect(fact.agentTarget).toEqual(configured.agentTarget);
    if (!fact.planningTarget) throw new Error('Configured ACP session must be ready');
    const ordinarySend = planExistingSessionChanges({}, [fact.planningTarget], 'hello');
    expect(ordinarySend.stages).toEqual([{ actionId: 'session.message.send', input: { message: 'hello' }, targets: [address] }]);
    expect(planExistingSessionChanges({ agentTarget: configured.agentTarget }, [fact.planningTarget], 'hello')).toEqual(ordinarySend);
});

it('keeps a Codex session on the built-in engine when the Machine also offers Q codex', () => {
    // Retained catalog projections can have an unqualified backend id equal to a bundled Agent id.
    const entries = getResolvedBackendCatalogEntries({
        enabledAgentIds: ['codex'],
        mergedBackendProjectionById: {
            codex: { backendId: 'codex', agentId: 'custom-acp', title: 'Q codex' },
        },
        acpCatalogSnapshot: { status: 'ready', revision: 1, record: { v: 1, definitions: [
            AcpBackendDefinitionV1Schema.parse({
                id: 'codex', name: 'codex', title: 'Q codex', launch: { kind: 'command', command: 'acp', args: [] },
                createdAt: 1, updatedAt: 1,
            }),
        ] } },
    });
    const options = entries.flatMap(entry => entry.backendTarget.kind === 'agent' ? [{
        id: entry.backendTargetKey, label: entry.title, agentId: entry.agentId, target: entry.backendTarget,
    }] : []);
    expect(options).toContainEqual(expect.objectContaining({ label: 'Q codex', target: expect.objectContaining({ definitionId: 'codex' }) }));

    const fact = projectBulkSessionAuthoringFact(address, session);
    if (!fact.planningTarget || !fact.agentTarget) throw new Error('Codex session must be ready');
    expect(planExistingSessionChanges({ agentTarget: fact.agentTarget }, [fact.planningTarget], 'hello').stages)
        .toMatchObject([{ actionId: 'session.message.send', targets: [address] }]);
    expect(findSessionAuthoringAgentTargetOption(options, fact.agentTarget)).toMatchObject({
        id: 'agent:happier.agent.codex/codex', label: 'Codex', agentId: 'codex',
    });
});

it('projects canonical Agent identity and separates hydration, archive, and resume outcomes', () => {
    expect(projectBulkSessionAuthoringFact(address, session)).toMatchObject({ status: 'ready',
        agentId: 'happier.agent.codex/codex', machineId: 'machine', directory: '/repo' });
    expect(projectBulkSessionAuthoringFact(address, null)).toMatchObject({ status: 'unavailable', reason: 'session_not_hydrated' });
    expect(projectBulkSessionAuthoringFact(address, { ...session, archivedAt: 12 })).toMatchObject({ status: 'skipped', reason: 'archived' });
    expect(projectBulkSessionAuthoringFact(address, { ...session, active: false,
        metadata: { ...session.metadata, flavor: 'unknown', agent: 'unknown' } })).toMatchObject({ status: 'skipped', reason: 'cannot_resume' });
    expect(projectBulkSessionAuthoringFact(address, { ...session, metadata: { ...session.metadata,
        sessionModesV2: { v: 2, agentId: 'codex', updatedAt: 1, currentModeId: 'default',
            availableModes: [{ id: 'default', name: 'Default' }, { id: 'plan', name: 'Plan' }] },
        sessionModeOverrideV1: { v: 1, updatedAt: 2, modeId: 'plan' } } })).toMatchObject({
        values: { acpSessionModeId: 'plan' }, planningTarget: { availableModeIds: ['default', 'plan'] } });
});
