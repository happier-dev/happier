import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { createWorkflowDefinitionFixture } from '@/dev/testkit/fixtures/workflowRunFixtures';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';

// The real Action owner asks for destructive confirmation before deleting.
vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock({ confirmResult: true }).module;
});

// HTTP, device credentials and confirmation presentation are boundaries. The
// front door, Artifact codec, definition owner and compare-and-set remain real.
const home = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(home);
installDisconnectedServerSocketBoundary();
// Resolve the real runtime graph during collection, outside behavioral hook timeouts.
await loadSyncSingletonForTests();
const { createWorkflowDefinition, getWorkflowDefinition, listWorkflowDefinitions,
    updateWorkflowDefinition, deleteWorkflowDefinition, exportSavedWorkflowDocument, isWorkflowDefinitionConflictError } = await import('./workflowDefinitionActions');
const { storage } = await import('@/sync/domains/state/storageStore');
const { getActiveServerSnapshot } = await import('@/sync/domains/server/serverRuntime');
const { getAppliedActiveServerSnapshot, isAppliedActiveServerRuntimeAvailable, publishAppliedActiveServerSnapshot } = await import('@/sync/runtime/orchestration/appliedActiveServerRuntime');
const definitionId = '00000000-0000-4000-8000-000000000001';
const definition = createWorkflowDefinitionFixture({ defaults: {
    agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.claude', localId: 'claude' } },
} });
const metadata = { title: 'Nightly triage' };
let serverId: string;
let previous = storage.getState();
let applied = getAppliedActiveServerSnapshot();
let available = isAppliedActiveServerRuntimeAvailable();

beforeEach(async () => {
    previous = storage.getState();
    applied = getAppliedActiveServerSnapshot();
    available = isAppliedActiveServerRuntimeAvailable();
    await home.reset();
    serverId = await home.addHome({ name: 'Workflow Home', serverUrl: 'https://workflow-definitions.test', accountId: 'definition-owner' });
    publishAppliedActiveServerSnapshot(getActiveServerSnapshot());
    storage.setState({ profileScope: { serverId, accountId: 'definition-owner' } });
    home.answer(serverId, '/v3/automations', { body: { automations: [], nextCursor: null } });
});
afterEach(async () => { await home.reset(); storage.setState(previous); publishAppliedActiveServerSnapshot(applied, available); });

describe('workflow definition Action client through Account Artifact storage', () => {
    it('saves the first Event reference with its intended trigger, rejects an invalid leaf, and copies without triggers', async () => {
        const event = { pluginId: 'com.acme.events', localId: 'pull-request' };
        const intendedTriggers = [{ kind: 'pluginEvent' as const, eventRef: event, observationTransport: {
            kind: 'checkpointedPull' as const, watcherMaterializationRef: {
                machineId: 'machine', pluginId: event.pluginId, materializationId: 'materialization',
            },
        } }];
        const eventDefinition = (path: readonly string[]) => ({ ...definition, blocks: [{
            kind: 'step', id: 'review', document: { text: 'Review Event', references: [], attachments: [] },
            input: [{ kind: 'trigger_event', event, path }], result: { kind: 'text' },
        }] });
        home.answer(serverId, 'POST /v3/automations/query', { body: { triggerEvents: [{ event,
            payloadSchema: { type: 'object', properties: { number: { type: 'number' }, repository: { type: 'object' } } },
        }] } });
        const created = await createWorkflowDefinition({ definitionId, definition: eventDefinition(['number']), metadata, intendedTriggers });
        expect(created.definition.blocks[0]).toMatchObject({ input: [{ kind: 'trigger_event', event, path: ['number'] }] });
        await expect(updateWorkflowDefinition({ definitionId, expectedRevision: created.revision,
            definition: eventDefinition(['repository']), metadata, intendedTriggers })).rejects.toMatchObject({ code: 'invalid_input' });
        expect((await getWorkflowDefinition({ definitionId })).definition).toEqual(created.definition);
        const copyId = '00000000-0000-4000-8000-000000000002';
        const copied = await createWorkflowDefinition({ definitionId: copyId, definition: created.definition, metadata, intendedTriggers: [] });
        expect((await getWorkflowDefinition({ definitionId: copyId })).definition).toEqual(copied.definition);
    });

    it('reads the library page with a continuation bound to the requested page size', async () => {
        await createWorkflowDefinition({ definitionId, definition, metadata });
        await createWorkflowDefinition({ definitionId: '00000000-0000-4000-8000-000000000002', definition, metadata: { title: 'Second' } });
        const page = await listWorkflowDefinitions({ limit: 1 });
        expect(page.definitions).toHaveLength(1);
        expect(page.nextCursor).toBeDefined();
        const next = await listWorkflowDefinitions({ limit: 1, cursor: page.nextCursor });
        expect(next.definitions).toHaveLength(1);
        expect(next.definitions[0]?.definitionId).not.toBe(page.definitions[0]?.definitionId);
    });

    it('reads one saved definition at its exact Artifact revision and access', async () => {
        const created = await createWorkflowDefinition({ definitionId, definition, metadata });
        const read = await getWorkflowDefinition({ definitionId });
        expect(read).toMatchObject({ definitionId, definition, metadata, access: 'owner', revision: created.revision });
    });

    it('exports the saved definition with its title, exact revision and portable document', async () => {
        const created = await createWorkflowDefinition({ definitionId, definition, metadata });
        const exported = await exportSavedWorkflowDocument({ definitionId });
        expect(exported).toMatchObject({ definitionId, metadata, revision: created.revision,
            document: { kind: 'happier.workflow', version: 1, definition: created.definition } });
        expect(JSON.parse(exported.json)).toEqual(exported.document);
    });

    it('creates canonical stored content that the saved definition reader can open', async () => {
        const created = await createWorkflowDefinition({ definitionId, definition: { ...definition, blocks: ['Do the thing'] }, metadata });
        expect(created.definitionId).toBe(definitionId);
        expect(home.artifacts(serverId).read(definitionId)).not.toBeNull();
        expect((await getWorkflowDefinition({ definitionId })).definition).toEqual(created.definition);
    });

    it('updates at the expected Artifact revision and reads the saved revision', async () => {
        const created = await createWorkflowDefinition({ definitionId, definition, metadata });
        const updated = await updateWorkflowDefinition({ definitionId, expectedRevision: created.revision,
            definition: { ...definition, blocks: ['Changed prompt'] }, metadata });
        expect(updated.revision.headerVersion).toBeGreaterThan(created.revision.headerVersion);
        expect(updated.revision.bodyVersion).toBeGreaterThan(created.revision.bodyVersion);
        expect((await getWorkflowDefinition({ definitionId })).definition).toEqual(updated.definition);
    });

    it('surfaces a stale update as currentness conflict without overwriting newer content', async () => {
        const created = await createWorkflowDefinition({ definitionId, definition, metadata });
        const newer = await updateWorkflowDefinition({ definitionId, expectedRevision: created.revision,
            definition: { ...definition, blocks: ['Other editor'] }, metadata });
        const failure = await updateWorkflowDefinition({ definitionId, expectedRevision: created.revision,
            definition: { ...definition, blocks: ['Stale editor'] }, metadata }).catch((error: unknown) => error);
        expect(isWorkflowDefinitionConflictError(failure)).toBe(true);
        expect((await getWorkflowDefinition({ definitionId })).definition).toEqual(newer.definition);
    });

    it('does not report unrelated read failures or error prose as currentness conflict', async () => {
        home.answer(serverId, `/v1/artifacts/${definitionId}`, { status: 403, body: { error: 'run_access_denied' } });
        const failure = await getWorkflowDefinition({ definitionId }).catch((error: unknown) => error);
        expect(isWorkflowDefinitionConflictError(failure)).toBe(false);
        expect(isWorkflowDefinitionConflictError(new Error('currentness_conflict'))).toBe(false);
    });

    it('refuses malformed saved content instead of handing a header without a body to a screen', async () => {
        await createWorkflowDefinition({ definitionId, definition, metadata });
        const row = home.artifacts(serverId).read(definitionId);
        home.answer(serverId, `/v1/artifacts/${definitionId}`, { body: { ...row, body: undefined } });
        await expect(getWorkflowDefinition({ definitionId })).rejects.toThrow();
    });

    it('rejects a malformed create before any persistence dispatch', async () => {
        await expect(createWorkflowDefinition({ definitionId, definition: { blocks: [] }, metadata })).rejects.toThrow();
        expect(home.requestsFor('/v1/artifacts')).toEqual([]);
    });

    it('deletes the saved Artifact and confirms the definition is no longer readable', async () => {
        await createWorkflowDefinition({ definitionId, definition, metadata });
        expect(await deleteWorkflowDefinition({ definitionId })).toEqual({ deleted: true, definitionId });
        expect(home.artifacts(serverId).read(definitionId)).toBeNull();
        await expect(getWorkflowDefinition({ definitionId })).rejects.toThrow();
    });
});
