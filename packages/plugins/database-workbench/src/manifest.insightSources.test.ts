import { expect, it } from 'vitest';
import { definePlugin, type PluginServices } from '@happier-dev/plugin-sdk';
import { DATABASE_INSIGHT_SOURCES_POINT_REF_V1, DatabaseFindingBriefBuildResultV1Schema } from '@happier-dev/plugin-sdk/database';
import { createPluginTestkit, type PluginTestkit } from '@happier-dev/plugin-sdk/testing';
import { DATABASE_INSIGHTS_BRIEF_BUILD_ACTION_ID_V1, databaseActionLocalIdV1 } from '@happier-dev/database-protocol';
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

it('prepares the shared brief from the selected public source and preserves its exact typed refusal', async () => {
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
    const sourcePlugin = definePlugin({
        id: source.pluginId, version: '0.0.0',
        actions: {
            list: { title: 'List observations', surfaces: sourceProtocol.operations.list.declaration.surfaces,
                inputSchema: sourceSchemas.listInput,
                resultSchema: sourceSchemas.listResult,
                run: async () => ({ ok: true as const, findings: [{ recordKey, title: finding.title, summary: finding.summary }] }) },
            detail: { title: 'Read observation', surfaces: sourceProtocol.operations.detail.declaration.surfaces,
                inputSchema: sourceSchemas.detailInput,
                resultSchema: sourceSchemas.detailResult,
                run: async input => {
                    expect(input).toEqual({ target, recordKey });
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
        readCurrent: async () => kit!.readTargetedContributionFixture(point),
        dispose() {},
    }) } as PluginServices['targetedContributions'];
    try {
        kit = await createPluginTestkit({ manifest: PLUGIN_MANIFEST, module: plugin,
            targetedContributionContributors: [contributor] });
        const snapshot = kit.readTargetedContributionFixture(point);
        expect(snapshot.contributions).toHaveLength(1);
        const selected = snapshot.contributions[0].contributor;
        const input = { target, recordKey, sourceSelection: { target: { pluginId, sourceCustody: snapshot.sourceCustody },
            point: { pointId, protocol }, contributor: { pluginId: selected.pluginId, contributionId: selected.contributionId,
                sourceCustody: selected.sourceCustody } } };
        const action = databaseActionLocalIdV1(DATABASE_INSIGHTS_BRIEF_BUILD_ACTION_ID_V1);
        const invocation = { services: { targetedContributions } };
        const reply = DatabaseFindingBriefBuildResultV1Schema.parse(await kit.invokeAction(action, input, invocation));
        expect(reply).toMatchObject({ ok: true, brief: { text: expect.stringContaining(finding.exercise), evidence: { items: [
            expect.objectContaining({ source: { kind: 'databaseFinding', label: finding.title },
                text: expect.stringContaining(finding.evidenceIdentity) }),
        ] } } });
        if (!reply.ok) throw new Error('Expected a finding brief');
        expect(JSON.parse(reply.brief.evidence.items[0].text)).toMatchObject({
            currentDetail: finding, verification: { action: DATABASE_INSIGHTS_BRIEF_BUILD_ACTION_ID_V1, input },
        });
        expired = true;
        await expect(kit.invokeAction(action, input, invocation)).resolves.toEqual(refusal);
        await contributor.dispose();
        await expect(kit.invokeAction(action, input, invocation)).resolves.toMatchObject({ ok: false, status: 'unavailable',
            reason: 'contributor_unavailable' });
    } finally {
        await kit?.dispose();
        await contributor.dispose();
    }
});
