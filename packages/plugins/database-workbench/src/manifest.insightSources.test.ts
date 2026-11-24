import { expect, it } from 'vitest';
import { definePlugin, type JsonValue, type PluginServices } from '@happier-dev/plugin-sdk';
import type { StorageScopeService } from '@happier-dev/plugin-sdk/storage';
import { DATABASE_INSIGHT_SOURCES_POINT_REF_V1, DatabaseFindingBriefBuildResultV1Schema } from '@happier-dev/plugin-sdk/database';
import { createPluginTestkit, type PluginTestkit } from '@happier-dev/plugin-sdk/testing';
import { DATABASE_ACCESS_SET_ACTION_ID_V1, DATABASE_INSIGHTS_BRIEF_BUILD_ACTION_ID_V1, DATABASE_INSIGHTS_SOURCES_READ_ACTION_ID_V1, databaseActionLocalIdV1 } from '@happier-dev/database-protocol';
import { DatabaseInsightSourceContributionProtocolV1 as sourceProtocol, DatabaseInsightSourceOperationSchemasV1 as sourceSchemas } from '@happier-dev/database-protocol/v1';
import { PLUGIN_MANIFEST, plugin } from './manifest.js';

it('publishes the point external authors target for listing and reading findings', () => {
    const { pluginId, pointId, protocol } = DATABASE_INSIGHT_SOURCES_POINT_REF_V1;

    expect(PLUGIN_MANIFEST.id).toBe(pluginId);
    expect(PLUGIN_MANIFEST.contributes.pluginContributionPoints).toContainEqual(expect.objectContaining({
        id: pointId,
        protocols: expect.arrayContaining([expect.objectContaining({
            ...protocol,
            operations: expect.objectContaining({
                list: expect.objectContaining({ required: true }),
                detail: expect.objectContaining({ required: true }),
            }),
        })]),
    }));
});

it('admits selected source reads and briefs before invoking the provider and preserves typed refusal', async () => {
    const { pluginId, pointId, protocol } = DATABASE_INSIGHT_SOURCES_POINT_REF_V1;
    const source = { pluginId: 'acme.insight-source', localId: 'observations' };
    const workspace = { serverId: 'home', machineId: 'machine', workspaceId: 'workspace', rootPath: '/repo' };
    const target = { kind: 'worktree', accountId: 'account', installationId: 'installation', projectKey: 'project',
        workspace, source: { kind: 'service', serviceId: 'web', variable: 'DATABASE_URL' } } as const;
    const recordKey = 'finding-1';
    const finding = {
        v: 1, sourceRef: source, sourceScope: { serverId: workspace.serverId, machineId: workspace.machineId },
        evidenceIdentity: 'observation-1', kind: 'suspected_n_plus_one', title: 'Repeated reports queries',
        observedWindow: { fromMs: 10, toMs: 20 }, coverage: { status: 'complete' }, summary: { records: 17 },
        exercise: 'Open the project reports page once.',
    } as const;
    const refusal = { ok: false, status: 'unavailable', code: 'capture_read_expired', reason: 'trace_expired' } as const;
    let expired = false;
    let detailReads = 0;
    let listReads = 0;
    let contributorLookups = 0;
    const sourcePlugin = definePlugin({
        id: source.pluginId, version: '0.0.0',
        actions: {
            list: { title: 'List observations', surfaces: sourceProtocol.operations.list.declaration.surfaces,
                inputSchema: sourceSchemas.listInput,
                resultSchema: sourceSchemas.listResult,
                run: async input => {
                    expect(input).toEqual({ target });
                    listReads++;
                    return { ok: true as const, findings: [{ recordKey, title: finding.title, summary: finding.summary }] };
                } },
            detail: { title: 'Read observation', surfaces: sourceProtocol.operations.detail.declaration.surfaces,
                inputSchema: sourceSchemas.detailInput,
                resultSchema: sourceSchemas.detailResult,
                run: async input => {
                    expect(input).toEqual({ target, recordKey });
                    detailReads++;
                    return expired ? refusal : { ok: true as const, finding };
                } },
        },
        contributesTo: { [pluginId]: { [pointId]: { [source.localId]: sourceProtocol.contribute({
            descriptor: { displayName: 'Reports', targetKinds: ['worktree'], engineIds: ['postgresql'],
                evidenceSchema: { type: 'object' }, changeResourceRef: { pluginId: source.pluginId, localId: 'changes' } },
            operations: { list: sourceProtocol.operations.list.bind('list'), detail: sourceProtocol.operations.detail.bind('detail') },
        }) } } },
        resources: { changes: { kind: 'asset', path: 'changes.json', contentType: 'application/json' } },
    });
    const contributor = await createPluginTestkit({ manifest: sourcePlugin.manifest, module: sourcePlugin });
    let kit: PluginTestkit | undefined;
    const point = { targetPluginId: pluginId, id: pointId, protocol };
    const targetedContributions = { observeForSelf: () => ({
        readCurrent: async () => {
            contributorLookups++;
            return kit!.readTargetedContributionFixture(point);
        },
        dispose() {},
    }) } as PluginServices['targetedContributions'];
    const entries = new Map<string, JsonValue>();
    const storage: StorageScopeService = {
        async get<T extends JsonValue = JsonValue>(key: string) { return (entries.get(key) ?? null) as T | null; },
        async set(key, value) { entries.set(key, value); },
        async delete(key) { entries.delete(key); },
        async list() { return { items: [...entries.keys()].map(key => ({ key })) }; },
        consistency() { return { kind: 'authoritativeSerializable' }; },
        async transaction(run) { return run(storage); },
    };
    let release: (() => void | Promise<void>) | undefined;
    try {
        kit = await createPluginTestkit({ manifest: PLUGIN_MANIFEST, module: plugin,
            targetedContributionContributors: [contributor], services: { storage: {
                daemon: { ...storage, async database(): Promise<never> { throw new Error('No daemon database requested'); } },
                daemonSession: storage, ephemeral: storage,
            } } });
        const launch = kit.registration('serviceLaunchEnvironments', 'database-discovery');
        if (!launch) throw new Error('Missing database discovery contribution');
        const retained = await launch.prepare({
            workspace: { id: workspace.workspaceId, serverId: workspace.serverId, machineId: workspace.machineId,
                rootPath: workspace.rootPath, projectKey: target.projectKey },
            project: { serverId: workspace.serverId, projectId: target.projectKey },
            requester: { accountId: target.accountId, installationId: target.installationId },
            serviceId: target.source.serviceId, physicalRootIdentity: workspace.rootPath,
            executionPlacement: { mode: 'spawn', machineId: workspace.machineId }, assignedPorts: {},
            async readEnvironment() { return { projectedEnvironment: { DATABASE_URL: 'postgresql://localhost/selected' }, provenance: {} }; },
        });
        if (retained.kind === 'unchanged') release = retained.release;
        const snapshot = kit.readTargetedContributionFixture(point);
        expect(snapshot.contributions).toHaveLength(1);
        const selected = snapshot.contributions[0].contributor;
        const input = { target, recordKey, sourceSelection: { target: { pluginId, sourceCustody: snapshot.sourceCustody },
            point: { pointId, protocol }, contributor: { pluginId: selected.pluginId, contributionId: selected.contributionId,
                sourceCustody: selected.sourceCustody } } };
        const action = databaseActionLocalIdV1(DATABASE_INSIGHTS_BRIEF_BUILD_ACTION_ID_V1);
        const invocation = { services: { targetedContributions }, requesterAccount: { accountId: target.accountId },
            chosenMachine: { machineId: workspace.machineId, installationId: target.installationId },
            agentCaller: false, authority: 'present_user' as const };
        const agent = { ...invocation, agentCaller: true };
        const read = databaseActionLocalIdV1(DATABASE_INSIGHTS_SOURCES_READ_ACTION_ID_V1);
        const listInput = { target, role: 'list', sourceSelection: input.sourceSelection };
        const detailInput = { ...input, role: 'detail' };
        await expect(kit.invokeAction(read, listInput, agent)).resolves.toEqual({
            ok: true, findings: [{ recordKey, title: finding.title, summary: finding.summary }],
        });
        await expect(kit.invokeAction(read, detailInput, agent)).resolves.toEqual({ ok: true, finding });
        await expect(kit.invokeAction(read, { ...listInput, recordKey }, invocation)).rejects.toThrow();
        const reply = DatabaseFindingBriefBuildResultV1Schema.parse(await kit.invokeAction(action, input, agent));
        expect(reply).toMatchObject({ ok: true, brief: { text: expect.stringContaining(finding.exercise), evidence: { items: [
            expect.objectContaining({ source: { kind: 'databaseFinding', label: finding.title },
                text: expect.stringContaining(finding.evidenceIdentity) }),
        ] } } });
        if (!reply.ok) throw new Error('Expected a finding brief');
        expect(JSON.parse(reply.brief.evidence.items[0].text)).toMatchObject({
            currentDetail: finding, verification: { action: DATABASE_INSIGHTS_BRIEF_BUILD_ACTION_ID_V1, input },
        });
        expired = true;
        await expect(kit.invokeAction(action, input, agent)).resolves.toEqual(refusal);
        await expect(kit.invokeAction(read, detailInput, agent)).resolves.toEqual(refusal);
        const setAccess = databaseActionLocalIdV1(DATABASE_ACCESS_SET_ACTION_ID_V1);
        await expect(kit.invokeAction(setAccess, { target, agentAccess: 'none' }, invocation))
            .resolves.toEqual({ ok: true, agentAccess: 'none' });
        const admittedContributorLookups = contributorLookups;
        await expect(kit.invokeAction(action, input, agent)).rejects.toMatchObject({ code: 'database_agent_access_none' });
        await expect(kit.invokeAction(read, listInput, agent)).rejects.toMatchObject({ code: 'database_agent_access_none' });
        await expect(kit.invokeAction(read, detailInput, agent)).rejects.toMatchObject({ code: 'database_agent_access_none' });
        expect(contributorLookups).toBe(admittedContributorLookups);
        expect(listReads).toBe(1);
        expect(detailReads).toBe(4);
        await expect(kit.invokeAction(action, input, invocation)).resolves.toEqual(refusal);
        await contributor.dispose();
        const unavailable = { ok: false, status: 'unavailable', reason: 'contributor_unavailable' };
        await expect(kit.invokeAction(action, input, invocation)).resolves.toMatchObject(unavailable);
        await expect(kit.invokeAction(read, listInput, invocation)).resolves.toMatchObject(unavailable);
        await expect(kit.invokeAction(read, detailInput, invocation)).resolves.toMatchObject(unavailable);
        expect(listReads).toBe(1);
        expect(detailReads).toBe(5);
    } finally {
        await release?.();
        await kit?.dispose();
        await contributor.dispose();
    }
});
