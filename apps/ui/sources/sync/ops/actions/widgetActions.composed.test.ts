import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    createHomeGovernanceHarness, installHomeGovernanceBoundaries,
} from '@/dev/testkit/harness/homeGovernanceHarness';
import {
    installDisconnectedServerSocketBoundary, restoreServerAccountForTest,
} from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { standardCleanup, createSessionFixture } from '@/dev/testkit';
import { decodePlainArtifactStoredContent } from '@happier-dev/protocol/storage/artifactStoredContent';
import { ActionsSettingsV1Schema } from '@happier-dev/protocol/actions/actionSettings';
import { ApprovalRequestV2Schema } from '@happier-dev/protocol/approvals/approvalRequestV1';
import { HomeHubLayoutV1Schema, buildHomeHubArtifactIdV1, createHomeHubArtifactPortV1 } from '@happier-dev/protocol/home';
import { WorkBoardV1Schema, WorkBoardWidgetPlacementV1Schema } from '@happier-dev/protocol/boards/workBoardV1';
import {
    WidgetDefinitionV1Schema, WidgetInstanceV1Schema, WidgetInstanceActionOutputSchemasV1,
    WidgetAreaLayoutV1Schema, WidgetLayoutFragmentDraftV1Schema, WidgetLayoutFragmentV1Schema,
    WidgetLayoutFragmentActionOutputSchemasV1, captureWidgetLayoutFragmentGroupV1,
    buildWidgetSurfaceArtifactIdV1, USAGE_WIDGET_PRESET_IDS, flattenWidgetLayoutWidgetsV1, type WidgetSurfaceRefV1,
} from '@happier-dev/protocol/widgets';
import type { ActionApprovalContinuation } from '@/components/approvals/actionApprovalContinuation';
import { decideApprovalAsInbox } from '@/dev/testkit/harness/approvalInbox';
import { normalizePluginUiDestinationBindingV1 } from '@happier-dev/protocol/plugins/contributions/ui';
import { EMPTY_PLUGIN_UI_PROJECTION } from '@/sync/domains/plugins/ui/projection';
import { ArtifactHttpReadV1Schema } from '@happier-dev/protocol/artifacts/artifactAccessV1';
import { decodeBase64 } from 'privacy-kit';
import { projectArtifactHttpRead } from '../../../../../server/sources/app/artifacts/artifactHttpRead';

vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock().module);

// HTTP, device credentials and Socket.IO are the external boundaries. No
// executor, policy, domain port, reducer, Artifact codec or store is replaced.
installDisconnectedServerSocketBoundary();
const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
await loadSyncSingletonForTests();
const { createDefaultActionExecutor } = await import('./defaultActionExecutor');
const { executeHomeHubLayoutIntent } = await import('@/components/hub/layout/homeHubActionWriter');
const { captureLazyActionAccountContext } = await import('./actionAccountContext');
const { putSessionUnderLead } = await import('@/components/sessions/work/putSessionUnderLead');
const { storage } = await import('@/sync/domains/state/storage');
const { loadAccountSettings } = await import('@/sync/domains/state/accountSettingsPersistence');
const { Modal } = await import('@/modal');
let connection: Awaited<ReturnType<typeof restoreServerAccountForTest>> | undefined;
let serverId: string;
const accountId = 'widget-seam-account';

beforeEach(async () => {
    vi.mocked(Modal.confirm).mockReset().mockResolvedValue(false);
    await homes.reset();
    serverId = await homes.addHome({ name: 'Widget Home', serverUrl: 'https://widget-seams.test', accountId });
    connection = await restoreServerAccountForTest({ serverUrl: 'https://widget-seams.test', accountId, request: homes.request });
    installHomeGovernanceBoundaries(homes);
    // These are acknowledged semantic writes, not approval-creation cases.
    setActionPolicy({ v: 1, approvalWaivedSurfaces: {
            'widgets.item.add': ['ui'], 'widgets.item.rename': ['ui'], 'widgets.item.move': ['ui'],
            'widgets.item.size.set': ['ui'], 'widgets.group.create': ['ui'],
            'widgets.fragment.create': ['ui'], 'widgets.area.layout.create': ['ui'],
            'widgets.area.layout.reset': ['ui'], 'widgets.area.layout.undo': ['ui'],
            'home.hub.layout.update': ['ui'], 'boards.apply': ['ui'],
    } });
});
afterEach(async () => {
    standardCleanup();
    await connection?.dispose();
    connection = undefined;
});

function instance(id: string) {
    return WidgetInstanceV1Schema.parse({ v: 1, id, bindings: {}, definition: { kind: 'inline', definition:
        WidgetDefinitionV1Schema.parse({ v: 1, id: 'constant', name: 'Constant', inputs: { fields: [] },
            inputSchema: { type: 'object', properties: {}, additionalProperties: false },
            sizeDeclaration: { sizes: ['medium', 'full'], defaultSize: 'medium' },
            provenance: { source: { kind: 'authored' } },
            body: { kind: 'declarative', document: { version: 1, root: { kind: 'text', text: 'Checks' } } },
        }),
    } });
}
function storedBody(artifactId: string): unknown {
    const encoded = homes.artifacts(serverId).read(artifactId)?.body;
    if (!encoded) throw new Error(`Missing stored Artifact ${artifactId}`);
    const opened = decodePlainArtifactStoredContent(encoded);
    if (!opened || typeof opened !== 'object' || typeof Reflect.get(opened, 'body') !== 'string') {
        throw new Error('Expected Artifact text body');
    }
    return JSON.parse(String(Reflect.get(opened, 'body')));
}
function scope(owner: WidgetSurfaceRefV1['owner']): WidgetSurfaceRefV1 {
    return { serverId, accountId, owner };
}
function context() { return { surface: 'ui' as const, authority: 'present_user' as const, serverId, expectedAccountId: accountId }; }
function setActionPolicy(raw: unknown) {
    const state = storage.getState();
    const accountScope = state.settingsScope;
    if (!accountScope) throw new Error('Current Account settings scope missing');
    const settings = { ...state.settings,
        actionsSettingsV1: ActionsSettingsV1Schema.parse(raw) };
    const version = (loadAccountSettings(accountScope).version ?? 0) + 1;
    state.applySettingsForScope(accountScope, settings, version);
    homes.answer(serverId, '/v2/account/settings', { body: { content: { t: 'plain', v: settings }, version } });
}
function waiveUiAction(actionId: 'session.manager.set' | 'widgets.item.remove') {
    setActionPolicy({ v: 1, approvalWaivedSurfaces: { [actionId]: ['ui'] } });
}

describe('widget semantic Actions through production UI composition', () => {
    it('admits snapshot item/group copies and refuses private pins through the real public-area writer', async () => {
        const surface = scope({ kind: 'corePage', pageId: 'public-profile', area: 'main', layoutId: 'minimal' });
        const executor = createDefaultActionExecutor();
        const peak = WidgetInstanceV1Schema.parse({ v: 1, id: 'peak-copy', definition: { kind: 'builtin', id: 'usage_parallel' },
            bindings: { style: { kind: 'value', value: 'peak' } } });
        const added = await executor.execute('widgets.item.add', { surface, instance: peak }, context());
        expect(added, JSON.stringify(added)).toMatchObject({ ok: true });
        const leaked = await executor.execute('widgets.item.add', { surface, instance: { ...peak, id: 'private-copy', bindings: {
            ...peak.bindings, metric: { kind: 'value', value: 'cost' },
        } } }, context());
        expect(leaked).toMatchObject({ ok: false, errorCode: 'widget_inputs_invalid' });
        const group = { kind: 'group', id: 'public-group', width: 'full', frameStyle: 'plain', dividers: 'none',
            children: [{ kind: 'widget', instance: { ...peak, id: 'child-peak' }, size: 'medium' }] };
        const grouped = await executor.execute('widgets.group.add', { surface, group }, context());
        expect(grouped, JSON.stringify(grouped)).toMatchObject({ ok: true });
        const privateGroup = await executor.execute('widgets.group.add', { surface, group: { ...group, id: 'private-group',
            context: { period: { kind: 'value', value: { relative: '7days' } } },
            children: [{ kind: 'widget', instance: { ...peak, id: 'other-child' }, size: 'medium' }],
        } }, context());
        expect(privateGroup).toMatchObject({ ok: false, errorCode: 'widget_inputs_invalid' });
        const { runCopyWidgetGroupCommandV1 } = await import('@/components/widgets/definitions/widgetLayoutFragmentCommands');
        const { WidgetLayoutGroupV1Schema } = await import('@happier-dev/protocol/widgets');
        const copy = await runCopyWidgetGroupCommandV1(WidgetLayoutGroupV1Schema.parse({ ...group, id: 'private-source',
            context: { agents: { kind: 'value', value: ['private-agent'] } },
            children: [{ kind: 'widget', instance: { ...peak, id: 'source-child', displayName: 'private label', bindings: {
                style: { kind: 'value', value: 'lanes' }, metric: { kind: 'value', value: 'cost' },
            } }, size: 'medium' }],
        }), surface);
        expect(copy, JSON.stringify(copy)).toMatchObject({ kind: 'applied' });
        const read = await executor.execute('widgets.item.list', { surface }, context());
        expect(read).toMatchObject({ ok: true, result: { instances: expect.arrayContaining([
            expect.objectContaining({ instance: expect.objectContaining({ id: 'peak-copy' }) }),
            expect.objectContaining({ instance: expect.objectContaining({ bindings: { style: { kind: 'value', value: 'peak' } } }) }),
        ]) } });
        expect(JSON.stringify(read)).not.toMatch(/private-copy|private-group|7days|cost/);
        expect(JSON.stringify(read)).not.toMatch(/private-agent|private label/);
    });
    it('retains a bound human area edit through explicit Ask with the supplied scoped executor', async () => {
        const { scopedHomeActionExecutor } = await import('./scopedHomeActionExecutor');
        const { createBoundPluginSurfaceController } = await import('@/components/plugins/surfaces/boundPluginSurfaceController');
        const { captureActiveServerAccountScopeLifetime } = await import('@/sync/domains/scope/activeServerAccountScope');
        const pluginId = 'examples.widget-areas';
        const pageId = 'overview';
        const surfaceId = 'surfacePlacement:examples.widget-areas:overview';
        const surface = scope({ kind: 'pluginArea', pluginId, pageId, area: 'pinned' });
        const binding = normalizePluginUiDestinationBindingV1({ pluginId, destinationId: pageId,
            container: 'appPage', target: { kind: 'app' }, rendererId: 'native', instancePolicy: 'singleton' });
        if (!binding) throw new Error('Destination admission failed');
        let approvalId: string | undefined;
        const controller = createBoundPluginSurfaceController({ facts: {
            pluginId, contributionId: pageId, surfaceId, placement: 'appPage', platform: 'web', serverId,
            accountLifetime: captureActiveServerAccountScopeLifetime(), interactionEnabled: true, daemonInteractionEnabled: false,
            pluginUiProjection: { ...EMPTY_PLUGIN_UI_PROJECTION, surfacePlacementsById: {
                [surfaceId]: { id: surfaceId, pluginId, occurrenceId: 'widget-areas-current', contributionKind: 'surfacePlacement',
                    descriptorId: pageId, binding, target: {}, renderer: {}, display: {}, headerActions: [],
                    availability: { state: 'available', reason: 'available', diagnostics: [] },
                    widgetAreas: [{ name: 'pinned', contextSchema: { type: 'object', additionalProperties: false } }],
                },
            } },
        }, binding: { executeHostAction: scopedHomeActionExecutor({ serverId, accountId }, {
            onBlockingApprovalPending: ({ artifactId }) => { approvalId = artifactId; },
        }) } });
        setActionPolicy({ v: 1, actions: { 'widgets.item.add': { approvalRequiredSurfaces: ['ui'] } } });
        let settled = false;
        let observedResult: unknown;
        const pending = controller.widgetArea!({ area: 'pinned', operation: { actionId: 'widgets.item.add', instance: instance('asked-copy') } })
            .then(result => { observedResult = result; return result; })
            .finally(() => { settled = true; });
        try {
            await vi.waitFor(() => expect({ approvalId, observedResult }).toMatchObject({ approvalId: expect.any(String) }));
            expect(settled).toBe(false);
            expect(homes.artifacts(serverId).read(buildWidgetSurfaceArtifactIdV1(surface))).toBeNull();
            expect(ApprovalRequestV2Schema.parse(storedBody(approvalId!)))
                .toMatchObject({ status: 'open', approval: { flow: 'blocking' }, executionOriginV1: { caller: { kind: 'host' } } });
            expect(await decideApprovalAsInbox(serverId, approvalId!, 'approve')).toMatchObject({ ok: true });
            expect(await pending).toMatchObject({ ok: true, result: { instance: { id: 'asked-copy' } } });
            expect(WidgetAreaLayoutV1Schema.parse(storedBody(buildWidgetSurfaceArtifactIdV1(surface))).items)
                .toEqual(expect.arrayContaining([expect.objectContaining({ instance: expect.objectContaining({ id: 'asked-copy' }) })]));
        } finally { controller.dispose(); await pending; }
    });

    it('resizes a private Home widget through its real writer without a pre-admission confirmation', async () => {
        const executor = createDefaultActionExecutor();
        const account = await captureLazyActionAccountContext(serverId);
        try {
            await createHomeHubArtifactPortV1(account.homeHubArtifactTransport, { accountId }).apply({ kind: 'widget_add', instance: instance('one') });
            setActionPolicy({ v: 1 });
            const layout = await executeHomeHubLayoutIntent({ intent: { kind: 'widget_size', instanceId: 'one', size: 'full' },
                scope: { serverId, accountId }, transport: account.homeHubArtifactTransport, execute: executor.execute,
                onApprovalPending: () => { throw new Error('Private resize incorrectly entered approval custody'); } });
            expect(flattenWidgetLayoutWidgetsV1(layout.items).find(item => item.instance.id === 'one')?.size).toBe('full');
            expect(HomeHubLayoutV1Schema.parse(storedBody(buildHomeHubArtifactIdV1(accountId)))).toEqual(layout);
            expect(Modal.confirm).not.toHaveBeenCalled();
        } finally { account.dispose(); }
    });

    it.each(['private', 'shared', 'required', 'shared-required', 'waived'] as const)(
        'uses admitted widget sharing and the canonical UI approval decision (%s)', async mode => {
            const surface = scope({ kind: 'corePage', pageId: 'usage', area: 'main', layoutId: USAGE_WIDGET_PRESET_IDS[0] });
            const executor = createDefaultActionExecutor();
            const added = await executor.execute('widgets.item.add', { surface, instance: instance('one') }, context());
            expect(added, JSON.stringify(added)).toMatchObject({ ok: true });
            const artifactId = buildWidgetSurfaceArtifactIdV1(surface);
            if (mode !== 'private') homes.artifacts(serverId).seedAccountGrant(artifactId, 'recipient', 'view');
            const required = mode === 'required' || mode === 'shared-required';
            setActionPolicy(required ? { v: 1, actions: { 'widgets.item.rename': { approvalRequiredSurfaces: ['ui'] } } }
                : mode === 'waived' ? { v: 1, approvalWaivedSurfaces: { 'widgets.item.rename': ['ui'] } } : { v: 1 });
            const before = storedBody(artifactId);
            const result = await executor.execute('widgets.item.rename', { ref: { surface, instanceId: 'one' }, displayName: 'Updated' },
                context());
            if (required) {
                expect(result).toMatchObject({ ok: true, result: { kind: 'approval_request_created', actionId: 'widgets.item.rename' } });
                expect(storedBody(artifactId)).toEqual(before);
            } else {
                expect(result).toMatchObject({ ok: true, result: { instance: { id: 'one', displayName: 'Updated' } } });
                expect(flattenWidgetLayoutWidgetsV1(WidgetAreaLayoutV1Schema.parse(storedBody(artifactId)).items)
                    .find(item => item.instance.id === 'one')?.instance.displayName).toBe('Updated');
            }
            expect(Modal.confirm).not.toHaveBeenCalled();
        },
    );

    it('uses current Home relation evidence for Put under after an unopened list relation becomes stale', async () => {
        waiveUiAction('session.manager.set');
        storage.setState({ sessions: {
            child: createSessionFixture({ id: 'child', serverId, manager: { sessionId: 'old-lead' } }),
            lead: createSessionFixture({ id: 'lead', serverId }),
        } });
        homes.answer(serverId, '/v1/sessions/child/manager/options', { body: { sessionId: 'child', currentManagerSessionId: null,
            candidates: [{ sessionId: 'lead', allowed: true }] } });
        homes.answer(serverId, '/v1/sessions/child/manager', { body: { ok: true, sessionId: 'child', managerSessionId: 'lead', attachedAt: 1 } });
        const result = await putSessionUnderLead({ serverId, sessionId: 'child', managerSessionId: 'lead', accountId });
        expect(result, JSON.stringify(homes.requests.filter(request => request.path.includes('/manager')).map(request => ({ path: request.path, input: request.input })))).toBe('applied');
        expect(homes.requestsFor('/v1/sessions/child/manager').at(-1)?.input)
            .toEqual({ managerSessionId: 'lead', expectedManagerSessionId: null });
    });
    it('keeps a Home group and its children when removal is awaiting approval or canceled, and honors the removal waiver', async () => {
        const surface = scope({ kind: 'home' });
        const executor = createDefaultActionExecutor();
        for (const id of ['one', 'two']) {
            expect(await executor.execute('widgets.item.add', { surface, instance: instance(id) }, context())).toMatchObject({ ok: true });
        }
        expect(await executor.execute('widgets.group.create', { surface, groupId: 'group', instanceIds: ['one', 'two'] }, context()))
            .toMatchObject({ ok: true });
        const before = HomeHubLayoutV1Schema.parse(storedBody(buildHomeHubArtifactIdV1(accountId)));
        const account = await captureLazyActionAccountContext(serverId);
        setActionPolicy({ v: 1, actions: { 'widgets.item.remove': { approvalRequiredSurfaces: ['ui'] } } });
        let continuation: ActionApprovalContinuation | undefined;
        const pending = executeHomeHubLayoutIntent({ intent: { kind: 'remove', instanceId: 'group' },
            scope: { serverId, accountId }, transport: account.homeHubArtifactTransport, execute: executor.execute,
            onApprovalPending: registration => { continuation = registration; registration.onTerminal?.('canceled'); } });
        await expect(pending).rejects.toThrow();
        expect(continuation).toBeDefined();
        expect(HomeHubLayoutV1Schema.parse(storedBody(buildHomeHubArtifactIdV1(accountId)))).toEqual(before);
        setActionPolicy({ v: 1 });
        await expect(executeHomeHubLayoutIntent({ intent: { kind: 'remove', instanceId: 'group' },
            scope: { serverId, accountId }, transport: account.homeHubArtifactTransport, execute: executor.execute,
            onApprovalPending: () => { throw new Error('Default confirmation incorrectly entered approval custody'); } }))
            .rejects.toMatchObject({ code: 'approval_canceled' });
        expect(Modal.confirm).toHaveBeenCalledTimes(1);
        expect(HomeHubLayoutV1Schema.parse(storedBody(buildHomeHubArtifactIdV1(accountId)))).toEqual(before);
        waiveUiAction('widgets.item.remove');
        const after = await executeHomeHubLayoutIntent({ intent: { kind: 'remove', instanceId: 'group' },
            scope: { serverId, accountId }, transport: account.homeHubArtifactTransport, execute: createDefaultActionExecutor().execute,
            onApprovalPending: () => { throw new Error('Removal waiver was ignored'); } });
        expect(after.items.some(item => item.kind === 'group' && item.id === 'group')).toBe(false);
        expect(flattenWidgetLayoutWidgetsV1(after.items).some(item => ['one', 'two'].includes(item.instance.id))).toBe(false);
        expect(HomeHubLayoutV1Schema.parse(storedBody(buildHomeHubArtifactIdV1(accountId)))).toEqual(after);
        account.dispose();
    });
    it('projects untouched Usage defaults through the real host preset producer and preserves personalization through Reset and Undo', async () => {
        const executor = createDefaultActionExecutor();
        const base = scope({ kind: 'corePage', pageId: 'usage', area: 'main' });
        const list = await executor.execute('widgets.area.layout.list', { surface: base }, context());
        expect(list, JSON.stringify(list)).toMatchObject({ ok: true });
        if (!list.ok) throw new Error(list.errorCode);
        const views = WidgetInstanceActionOutputSchemasV1['widgets.area.layout.list'].parse(list.result).layouts;
        expect(views.map(view => view.surface.owner.kind === 'corePage' ? view.surface.owner.layoutId : null)).toEqual([...USAGE_WIDGET_PRESET_IDS]);
        const initial = [];
        for (const view of views) {
            expect(homes.artifacts(serverId).read(view.artifactId)).toBeNull();
            const read = await executor.execute('widgets.item.list', { surface: view.surface }, context());
            expect(read, JSON.stringify(read)).toMatchObject({ ok: true });
            if (!read.ok) throw new Error(read.errorCode);
            const state = WidgetInstanceActionOutputSchemasV1['widgets.item.list'].parse(read.result);
            expect(state).toMatchObject({ state: 'missing', preset: { isEdited: false } });
            expect(state.instances.length).toBeGreaterThan(0);
            initial.push(state);
        }
        const selected = views[0]!;
        const ref = { surface: selected.surface, instanceId: initial[0]!.instances[0]!.instance.id };
        expect(await executor.execute('widgets.item.rename', { ref, displayName: 'Mine' }, context())).toMatchObject({ ok: true });
        const edited = WidgetAreaLayoutV1Schema.parse(storedBody(selected.artifactId));
        expect(flattenWidgetLayoutWidgetsV1(edited.items)[0]!.instance.displayName).toBe('Mine');
        const read = await createDefaultActionExecutor().execute('widgets.item.list', { surface: selected.surface }, context());
        expect(read).toMatchObject({ ok: true, result: { preset: { isEdited: true }, items: edited.items } });
        if (!read.ok) throw new Error(read.errorCode);
        const current = WidgetInstanceActionOutputSchemasV1['widgets.item.list'].parse(read.result);
        const reset = await executor.execute('widgets.area.layout.reset', { surface: selected.surface, expectedRevision: current.revision }, context());
        expect(reset, JSON.stringify(reset)).toMatchObject({ ok: true });
        if (!reset.ok) throw new Error(reset.errorCode);
        const result = WidgetInstanceActionOutputSchemasV1['widgets.area.layout.reset'].parse(reset.result);
        expect(result.layout.items).toEqual(initial[0]!.items);
        expect(await executor.execute('widgets.area.layout.undo', { capture: result.undo }, context())).toMatchObject({ ok: true });
        expect(WidgetAreaLayoutV1Schema.parse(storedBody(selected.artifactId))).toEqual(edited);
        expect(await executor.execute('widgets.area.layout.list', { surface: { ...base, accountId: 'other' } }, context())).toMatchObject({ ok: false });
        expect(WidgetAreaLayoutV1Schema.parse(storedBody(selected.artifactId))).toEqual(edited);
    });

    it('persists independent Home copies, groups and fragments and reads actual producer bytes through strict consumers', async () => {
        const surface = scope({ kind: 'home' });
        const executor = createDefaultActionExecutor();
        for (const id of ['one', 'two']) {
            const added = await executor.execute('widgets.item.add', { surface, instance: instance(id) }, context());
            expect(added, JSON.stringify(added)).toMatchObject({ ok: true });
            if (!added.ok) throw new Error(added.errorCode);
            expect(WidgetInstanceActionOutputSchemasV1['widgets.item.add'].parse(added.result).instance).toEqual(instance(id));
        }
        expect(await executor.execute('home.hub.layout.update', { intent: { kind: 'widget_rename', instanceId: 'one', displayName: 'First' } }, context()))
            .toMatchObject({ ok: true });
        expect(await executor.execute('widgets.group.create', { surface, groupId: 'group', instanceIds: ['one', 'two'] }, context()))
            .toMatchObject({ ok: true });
        const layout = HomeHubLayoutV1Schema.parse(storedBody(buildHomeHubArtifactIdV1(accountId)));
        const group = layout.items.find(item => item.kind === 'group');
        if (!group || group.kind !== 'group') throw new Error('Group was not persisted');
        expect(group.children.map(child => child.instance.displayName)).toEqual(['First', undefined]);
        expect(HomeHubLayoutV1Schema.safeParse({ ...layout, authority: 'forged' }).success).toBe(false);
        expect(WidgetInstanceV1Schema.safeParse({ ...group.children[0]!.instance, machineId: 'forged' }).success).toBe(false);

        const draft = WidgetLayoutFragmentDraftV1Schema.parse({ name: 'Capacity and PRs', inputs: { fields: [] },
            inputSchema: { type: 'object', properties: {}, additionalProperties: false },
            group: captureWidgetLayoutFragmentGroupV1(group) });
        const saved = await executor.execute('widgets.fragment.create', { account: { serverId, accountId }, artifactId: 'saved-group', fragment: draft }, context());
        expect(saved, JSON.stringify(saved)).toMatchObject({ ok: true });
        if (!saved.ok) throw new Error(saved.errorCode);
        const output = WidgetLayoutFragmentActionOutputSchemasV1['widgets.fragment.create'].parse(saved.result);
        const stored = WidgetLayoutFragmentV1Schema.parse(storedBody('saved-group'));
        expect(stored).toEqual(output.fragment);
        const proposed = await executor.execute('widgets.fragment.delete', { account: { serverId, accountId }, artifactId: 'saved-group' }, {
            surface: 'cli', authority: 'account_automation', serverId, expectedAccountId: accountId,
            actionCaller: { kind: 'host' }, actionRequestId: 'delete-saved-group',
        });
        expect(proposed, JSON.stringify(proposed)).toMatchObject({ ok: true, result: { kind: 'approval_request_created' } });
        if (!proposed.ok || !proposed.result || typeof proposed.result !== 'object'
            || typeof Reflect.get(proposed.result, 'artifactId') !== 'string') throw new Error('Expected persisted approval');
        const request = ApprovalRequestV2Schema.parse(storedBody(String(Reflect.get(proposed.result, 'artifactId'))));
        expect(request.summary).toContain(output.fragment.name);
        expect(request.preview).toMatchObject({ widgetLibraryName: output.fragment.name, summary: expect.stringContaining(output.fragment.name) });
        expect(WidgetLayoutFragmentV1Schema.parse(storedBody('saved-group'))).toEqual(output.fragment);
        expect(stored.group.children.every(child => !('id' in child.instance))).toBe(true);
        expect(WidgetLayoutFragmentV1Schema.safeParse({ ...stored, group: { ...stored.group, accountId: 'forged' } }).success).toBe(false);
        const listed = await createDefaultActionExecutor().execute('widgets.item.list', { surface }, context());
        expect(listed).toMatchObject({ ok: true, result: { items: layout.items } });
        // A wrongly bound Account cannot reach or modify the Home persistence seam.
        const before = homes.artifacts(serverId).read(buildHomeHubArtifactIdV1(accountId));
        expect(await executor.execute('widgets.item.rename', { ref: { surface: { ...surface, accountId: 'other' }, instanceId: 'one' }, displayName: 'Wrong' }, context()))
            .toMatchObject({ ok: false, errorCode: 'account_target_mismatch' });
        expect(homes.artifacts(serverId).read(buildHomeHubArtifactIdV1(accountId))).toEqual(before);
    });

    it('writes Board placements through both native and widget Actions and refuses a mis-bound Board', async () => {
        const executor = createDefaultActionExecutor();
        const surface = scope({ kind: 'workBoard', boardId: '22222222-2222-4222-8222-222222222227' });
        const created = await executor.execute('boards.apply', { intent: { kind: 'create', board: { id: '22222222-2222-4222-8222-222222222227', name: 'Checks' } } }, context());
        expect(created, JSON.stringify(created)).toMatchObject({ ok: true });
        const ref = { surface, instanceId: 'board-copy' };
        expect(await executor.execute('boards.apply', { intent: { kind: 'widget_add', boardId: '22222222-2222-4222-8222-222222222227', ref, instance: instance(ref.instanceId) } }, context()))
            .toMatchObject({ ok: true });
        expect(await executor.execute('widgets.item.size.set', { ref, size: 'full' }, context())).toMatchObject({ ok: true });
        const persisted = WorkBoardV1Schema.parse(storedBody('22222222-2222-4222-8222-222222222227'));
        expect(persisted.widgets).toMatchObject([{ ref, instance: instance(ref.instanceId), size: 'full' }]);
        const listed = await createDefaultActionExecutor().execute('widgets.item.list', { surface }, context());
        expect(listed).toMatchObject({ ok: true });
        if (!listed.ok) throw new Error(listed.errorCode);
        const read = WidgetInstanceActionOutputSchemasV1['widgets.item.list'].parse(listed.result);
        expect(read.surface).toEqual(surface);
        expect(read.instances).toEqual([{ instance: instance(ref.instanceId), size: 'full' }]);
        const placement = WorkBoardWidgetPlacementV1Schema.parse(persisted.widgets![0]);
        expect(WorkBoardWidgetPlacementV1Schema.safeParse({ ...placement, authority: 'forged' }).success).toBe(false);
        expect(await executor.execute('widgets.item.rename', { ref: { ...ref, surface: scope({ kind: 'workBoard', boardId: 'missing' }) }, displayName: 'Wrong' }, context()))
            .toMatchObject({ ok: false });
        expect(WorkBoardV1Schema.parse(storedBody('22222222-2222-4222-8222-222222222227'))).toEqual(persisted);
    });

    it('routes a real drag admission into the Home semantic writer and refuses a mismatched source realm', async () => {
        const { resolveWidgetLayoutEntityDrop } = await import('@/components/ui/treeDragDrop/widgetLayoutEntityDrop');
        const surface = scope({ kind: 'home' });
        const executor = createDefaultActionExecutor();
        for (const id of ['moving', 'anchor']) {
            expect(await executor.execute('widgets.item.add', { surface, instance: instance(id) }, context())).toMatchObject({ ok: true });
        }
        const before = HomeHubLayoutV1Schema.parse(storedBody(buildHomeHubArtifactIdV1(accountId)));
        const input = { surface, items: before.items, topLevelIds: before.order, canEdit: true,
            destination: { anchorId: 'anchor', placement: 'after' as const }, preview: { verb: 'Move', target: 'Home' } };
        const admission = resolveWidgetLayoutEntityDrop({ ...input, item: { kind: 'widget-area-instance',
            scope: { serverId, accountId }, ref: { surface, instanceId: 'moving' } } });
        if (admission.status !== 'allowed') throw new Error(`Drag refused: ${JSON.stringify(admission)}`);
        expect(admission.effect.actionId).toBe('widgets.item.move');
        expect(await executor.execute('widgets.item.move', admission.effect.input, context())).toMatchObject({ ok: true });
        const after = HomeHubLayoutV1Schema.parse(storedBody(buildHomeHubArtifactIdV1(accountId)));
        expect(after.order.indexOf('moving')).toBe(after.order.indexOf('anchor') + 1);
        expect(after.items.find(item => item.kind === 'widget' && item.instance.id === 'moving'))
            .toEqual(before.items.find(item => item.kind === 'widget' && item.instance.id === 'moving'));
        expect(resolveWidgetLayoutEntityDrop({ ...input, item: { kind: 'widget-area-instance',
            scope: { serverId, accountId: 'wrong' }, ref: { surface: { ...surface, accountId: 'wrong' }, instanceId: 'moving' } } }))
            .toMatchObject({ status: 'refused' });
        expect(HomeHubLayoutV1Schema.parse(storedBody(buildHomeHubArtifactIdV1(accountId)))).toEqual(after);
    });

    it('stores a named layout through its producer and consumes it through the strict layout schema and fresh executor', async () => {
        // Keep the stateful HTTP persistence boundary, but emit its committed
        // create row through the server's real read/acknowledgement producer.
        homes.answer(serverId, 'POST /v1/artifacts', { select: async (_input, request) => {
            const response = await homes.artifacts(serverId).handle(new URL(request.url).pathname, request.init);
            if (!response) throw new Error('Artifact create boundary did not handle its route');
            if (!response.ok) return { status: response.status, body: await response.json() };
            const row = ArtifactHttpReadV1Schema.parse(await response.json());
            return { body: projectArtifactHttpRead({ ...row, kind: row.kind ?? null,
                header: decodeBase64(row.header), body: decodeBase64(row.body),
                dataEncryptionKey: decodeBase64(row.dataEncryptionKey),
                provenance: row.provenance ? decodeBase64(row.provenance) : null,
                provenanceDataEncryptionKey: row.provenanceDataEncryptionKey ? decodeBase64(row.provenanceDataEncryptionKey) : null,
                createdAt: new Date(row.createdAt), updatedAt: new Date(row.updatedAt),
            }) };
        } });
        const executor = createDefaultActionExecutor();
        const base = scope({ kind: 'corePage', pageId: 'usage', area: 'main' });
        const surface = scope({ kind: 'corePage', pageId: 'usage', area: 'main', layoutId: 'checks' });
        const created = await executor.execute('widgets.area.layout.create', { surface: base, layoutId: 'checks', name: 'Checks' }, context());
        expect(created, JSON.stringify(created)).toMatchObject({ ok: true, result: {
            surface, artifactId: buildWidgetSurfaceArtifactIdV1(surface),
            revision: { headerVersion: 1, bodyVersion: 1 },
        } });
        expect(await executor.execute('widgets.item.add', { surface, instance: instance('area-copy') }, context())).toMatchObject({ ok: true });
        const layout = WidgetAreaLayoutV1Schema.parse(storedBody(buildWidgetSurfaceArtifactIdV1(surface)));
        expect(layout).toMatchObject({ surface, items: [{ instance: instance('area-copy') }] });
        expect(WidgetAreaLayoutV1Schema.safeParse({ ...layout, surface: { ...layout.surface, executionMachineId: 'forged' } }).success).toBe(false);
        expect(await createDefaultActionExecutor().execute('widgets.item.list', { surface }, context()))
            .toMatchObject({ ok: true, result: { items: layout.items } });
        const misbound = scope({ kind: 'corePage', pageId: 'usage', area: 'other', layoutId: 'checks' });
        const other = await executor.execute('widgets.item.list', { surface: misbound }, context());
        expect(other, JSON.stringify(other)).toMatchObject({ ok: false });
        expect(WidgetAreaLayoutV1Schema.parse(storedBody(buildWidgetSurfaceArtifactIdV1(surface)))).toEqual(layout);
    });
});
