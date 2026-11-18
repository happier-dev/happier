import { expect, it } from 'vitest';
import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { projectBulkSessionAuthoringFact } from './bulkSessionAuthoringFacts';

const address = { serverId: 'home-a', sessionId: 'session' };
const session = createSessionFixture({ id: address.sessionId, serverId: address.serverId, active: true,
    metadata: { path: '/repo', host: 'host', agent: 'codex', machineId: 'machine' } });

it('projects canonical Agent identity and separates hydration, archive, and resume outcomes', () => {
    expect(projectBulkSessionAuthoringFact(address, session)).toMatchObject({ status: 'ready',
        agentId: 'happier.agent.codex/codex', machineId: 'machine' });
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
