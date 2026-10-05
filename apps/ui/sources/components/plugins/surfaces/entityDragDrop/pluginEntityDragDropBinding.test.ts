import { describe, expect, it } from 'vitest';
import type { EntityDropAdmissionV1, PluginUiJsonValueV1 } from '@happier-dev/protocol/plugins/ui';
import { createEntityDragDropRuntime } from '@/components/ui/treeDragDrop/entityDragDropRuntime';
import { createPluginEntityDragDropBinding, settlePluginEntityDropActionResult, type PluginEntityDragSourceRegistration, type PluginEntityDropTargetRegistration } from './pluginEntityDragDropBinding';
import { createPluginSurfaceHostApiError } from '../createPluginSurfaceHostApi';
import { PLUGIN_ACTION_OUTCOME_UNKNOWN_CODE } from '@happier-dev/protocol';
import { PluginDragSourceContributionV1Schema, PluginDropTargetContributionV1Schema } from '@happier-dev/protocol';
import { createPluginUiClientExecutableRegistrationIndex, resolvePluginUiClientDragSourceRegistration, resolvePluginUiClientDropTargetRegistration } from '../../reactNative/clientExecutableContributions';
import { plugin as authorPlugin, activate as activateAuthorPlugin } from '../../../../../../../packages/plugin-sdk/fixtures/authoring-inference/entityDragDrop';
import { createHostedEntityDragDropHandlers } from '../../hostApi/hostedEntityDragDrop';
import { createPluginSurfaceHostApi } from '../createPluginSurfaceHostApi';

const scope = { serverId: 'home', accountId: 'account' };
const effect: EntityDropAdmissionV1 = { status: 'allowed', effect: { actionId: 'plugin:acme.board/add', input: { title: 'Issue' }, preview: { verb: 'Add', target: 'Board' } } };
function fixture() {
    const runtime = createEntityDragDropRuntime();
    const writes: PluginUiJsonValueV1[] = [];
    let current = true;
    let admission = effect;
    const source: PluginEntityDragSourceRegistration = {
        descriptor: { id: 'issue', title: 'Issue', client: { artifactId: 'ui', exportName: 'activate' }, platforms: ['web'], referenceSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'], additionalProperties: false } },
        describe: () => ({ title: 'Issue' }), isCurrent: () => current,
    };
    const target: PluginEntityDropTargetRegistration = {
        descriptor: { id: 'board', title: 'Board', client: { artifactId: 'ui', exportName: 'activate' }, platforms: ['web'], acceptedKinds: ['plugin:acme.board/issue', 'session'], actions: [{ kind: 'plugin', action: 'add' }] },
        resolve: () => admission, isCurrent: () => current,
    };
    const binding = createPluginEntityDragDropBinding({ runtime, pluginId: 'acme.board', mountKey: 'surface', scope,
        isCurrent: () => current, readSource: () => source, readTarget: () => target,
        executeAction: async (_action, input) => { writes.push(input); return { status: 'applied' }; } });
    return { runtime, binding, writes, setCurrent: (next: boolean) => { current = next; }, setAdmission: (next: EntityDropAdmissionV1) => { admission = next; } };
}
describe('mounted plugin entity bridge', () => {
    it('mounts external author callbacks and admits host Session, repository file and custom reference to their declared Action', async () => {
        const index = createPluginUiClientExecutableRegistrationIndex();
        const activation = index.createScope({ pluginId: authorPlugin.manifest.id, pluginVersion: authorPlugin.manifest.version, contributes: authorPlugin.manifest.contributes ?? {},
            target: { artifactId: 'entity-runtime', exportName: 'activate', platform: 'web' }, executionOrigin: null, occurrenceId: 'author-occurrence', lifecycle: { signal: new AbortController().signal, isCurrent: () => true } });
        activateAuthorPlugin(activation.api);
        const sourceDefinition = PluginDragSourceContributionV1Schema.parse(authorPlugin.manifest.contributes?.dragSources?.[0]);
        const targetDefinition = PluginDropTargetContributionV1Schema.parse(authorPlugin.manifest.contributes?.dropTargets?.[0]);
        const projectedSource = { id: `${authorPlugin.manifest.id}/${sourceDefinition.id}`, pluginId: authorPlugin.manifest.id, pluginVersion: authorPlugin.manifest.version, occurrenceId: 'author-occurrence', definition: sourceDefinition };
        const projectedTarget = { id: `${authorPlugin.manifest.id}/${targetDefinition.id}`, pluginId: authorPlugin.manifest.id, pluginVersion: authorPlugin.manifest.version, occurrenceId: 'author-occurrence', definition: targetDefinition };
        const runtime = createEntityDragDropRuntime();
        const admitted: unknown[] = [];
        const binding = createPluginEntityDragDropBinding({ runtime, pluginId: authorPlugin.manifest.id, mountKey: 'external-author', scope, isCurrent: activation.isCurrent,
            subscribeRegistrations: index.subscribe, isSourceDeclared: () => true, isTargetDeclared: () => true,
            readSource: () => { const resolved = resolvePluginUiClientDragSourceRegistration({ source: projectedSource, platform: 'web', reader: index }); return resolved ? { descriptor: sourceDefinition, describe: resolved.runtime.describe, isCurrent: resolved.registration.lifecycle.isCurrent } : null; },
            readTarget: () => { const resolved = resolvePluginUiClientDropTargetRegistration({ target: projectedTarget, platform: 'web', reader: index }); return resolved ? { descriptor: targetDefinition, resolve: resolved.runtime.resolve, isCurrent: resolved.registration.lifecycle.isCurrent } : null; },
            executeAction: async (action, input) => { admitted.push({ action, input }); return { status: 'applied' }; } });
        const ready = binding.waitForSourceRegistration(sourceDefinition.id);
        const hosted = createHostedEntityDragDropHandlers({ binding, isCurrent: activation.isCurrent, readSessionItem: () => null });
        const surface = { pluginId: authorPlugin.manifest.id, contributionId: 'review', surfaceId: 'waiting', placement: 'sessionPane' as const, platform: 'web' as const, channel: 'internal' as const, resourceScope: [], diagnostics: [] };
        const hostApi = createPluginSurfaceHostApi({ surfaceContext: surface, handlers: hosted.handlers });
        const send = (payload: PluginUiJsonValueV1) => hostApi.handleRequest({ version: 1, requestId: 'waiting', surface, method: 'updateEntityDragDrop', payload });
        const pendingMount = send({ kind: 'mountSource', mountId: 'retired-before-ready', sourceId: sourceDefinition.id, reference: 'Issue 42' });
        const pendingBegin = send({ kind: 'begin', mountId: 'retired-before-ready', input: 'keyboard', pointer: { x: 0, y: 0 }, viewport: { width: 100, height: 100 } });
        hosted.dispose();
        expect(binding.mountSource({ mountId: 'early', sourceId: sourceDefinition.id, reference: 'Issue 42' })).toBeNull();
        activation.commit();
        expect(await ready).toBe(true);
        expect(await pendingMount).toMatchObject({ code: 'unavailable' });
        expect(await pendingBegin).toMatchObject({ code: 'unavailable' });
        expect(runtime.begin(binding.runtimeMountId('retired-before-ready'))).toBeNull();
        expect(admitted).toEqual([]);
        const custom = binding.mountSource({ mountId: 'issue', sourceId: sourceDefinition.id, reference: 'Issue 42' })!;
        binding.mountTarget({ mountId: 'review', targetId: targetDefinition.id, getBounds: () => ({ x: 0, y: 0, width: 100, height: 100 }) });
        runtime.registerSource({ id: 'session', scope, isCurrent: () => true, getItem: () => ({ kind: 'session', scope, address: { serverId: 'home', sessionId: 's1' } }) });
        runtime.registerSource({ id: 'file', scope, isCurrent: () => true, getItem: () => ({ kind: 'repository-file', scope, machineId: 'machine', path: '/repo/issue.ts' }) });
        for (const sourceId of [custom.id, 'session', 'file']) {
            const carry = runtime.begin(sourceId)!; carry.move({ x: 20, y: 20 });
            expect(await carry.release()).toEqual({ status: 'applied' });
        }
        expect(admitted).toHaveLength(3);
        expect(admitted).toEqual(expect.arrayContaining([expect.objectContaining({ action: { pluginId: authorPlugin.manifest.id, localId: 'add' } })]));
        binding.dispose(); await activation.unwind();
    });
    it('does not claim an approval artifact or lost Action acknowledgement applied a mutation', () => {
        expect(settlePluginEntityDropActionResult({ kind: 'approval_request_created', artifactId: 'approval-1' }, 'teams.members.remove')).toMatchObject({ status: 'refused', reason: { code: 'approval_required' } });
        expect(settlePluginEntityDropActionResult(createPluginSurfaceHostApiError('unavailable', [PLUGIN_ACTION_OUTCOME_UNKNOWN_CODE]), 'teams.members.remove')).toMatchObject({ status: 'unknown' });
        expect(settlePluginEntityDropActionResult(createPluginSurfaceHostApiError('timeout'), 'teams.members.remove')).toMatchObject({ status: 'unknown' });
        expect(settlePluginEntityDropActionResult(createPluginSurfaceHostApiError('unavailable'), 'teams.members.remove')).toMatchObject({ status: 'refused' });
        expect(settlePluginEntityDropActionResult({ kind: 'approval_request_created', artifactId: 'ordinary plugin data' }, { pluginId: 'acme.board', localId: 'add' })).toEqual({ status: 'applied' });
    });
    it('validates references and executes declared effects through the same realm owner', async () => {
        const f = fixture();
        expect(f.binding.mountSource({ mountId: 'bad', sourceId: 'issue', reference: { id: 'x', token: 'not-allowed' } })).toBeNull();
        const source = f.binding.mountSource({ mountId: 'source', sourceId: 'issue', reference: { id: 'x' } });
        expect(source).not.toBeNull();
        const target = f.binding.mountTarget({ mountId: 'target', targetId: 'board', getBounds: () => ({ x: 10, y: 10, width: 30, height: 30 }) });
        expect(target).not.toBeNull();
        const carry = source!.begin()!;
        carry.move({ x: 20, y: 20 });
        expect(f.runtime.getSnapshot().admission).toEqual(effect);
        expect(await carry.release()).toEqual({ status: 'applied' });
        expect(f.writes).toEqual([{ title: 'Issue' }]);
    });
    it('refuses undeclared Actions, nested refusal and retired occurrences without writes', async () => {
        const f = fixture();
        const source = f.binding.mountSource({ mountId: 'source', sourceId: 'issue', reference: { id: 'x' } })!;
        const parent = f.binding.mountTarget({ mountId: 'parent', targetId: 'board', getBounds: () => ({ x: 0, y: 0, width: 100, height: 100 }) })!;
        const child = f.binding.mountTarget({ mountId: 'child', targetId: 'board', parentId: parent.id, getBounds: () => ({ x: 10, y: 10, width: 20, height: 20 }) })!;
        f.setAdmission({ status: 'allowed', effect: { ...effect.effect, actionId: 'plugin:acme.board/erase' } });
        const carry = source.begin()!;
        carry.move({ x: 20, y: 20 });
        expect(f.runtime.getSnapshot().targetId).toBe(child.id);
        expect(f.runtime.getSnapshot().admission?.status).toBe('refused');
        await carry.release();
        expect(f.writes).toEqual([]);
        f.setAdmission(effect);
        const retiredCarry = source.begin()!;
        retiredCarry.move({ x: 20, y: 20 });
        f.setCurrent(false);
        expect(await retiredCarry.release()).toBeNull();
        expect(f.writes).toEqual([]);
        f.binding.dispose();
        expect(f.runtime.getDestinations(source.id)).toEqual([]);
    });
});
