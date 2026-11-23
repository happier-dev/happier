import { describe, expect, it } from 'vitest';
import { createCliWidgetInputActionDepsV1 } from './widgetInputActionDeps';
import { createCliWidgetAreaActionDepsV1 } from './widgetAreaActionDeps';
import { createUnavailableActionTransportDeps } from '@/testkit/actionTransportDeps';
import { buildWidgetDefinitionArtifactHeaderV1, createWidgetDefinitionArtifactPortV1, type WidgetDefinitionV1 } from '@happier-dev/protocol/widgets';
import { readBuiltinWidgetDescriptorV1 } from '@happier-dev/protocol/widgets/builtinWidgetDescriptorV1';
import { createWorkBoardArtifactBoundary } from '../../../../../packages/protocol/src/boards/workBoardArtifactV1.testkit';
import { createWorkBoardArtifactPortV1 } from '@happier-dev/protocol/boards/workBoardArtifactV1';
import { createActionExecutor, type ActionExecutorDeps } from '@happier-dev/protocol/actions/actionExecutor';
import { createHomeHubArtifactPortV1 } from '@happier-dev/protocol/home/homeHubArtifactV1';
import { normalizeUsageQuery } from '@happier-dev/protocol/inputs/usageQuery';
import { readInputPath } from '@happier-dev/protocol/inputs/inputPredicates';
import { StrictJsonValueSchema } from '@happier-dev/protocol/json/strictJsonValue';
import { captureWidgetLayoutFragmentGroupV1, instantiateWidgetLayoutFragmentGroupV1, WidgetSurfaceReadV1Schema, type WidgetInputBindingsV1, type WidgetLayoutGroupV1 } from '@happier-dev/protocol/widgets';

describe('Widget Action input transport authority', () => {
    it.each(['cli', 'mcp', 'agent', 'ui'] as const)('admits destination Project context through real %s Actions while Home requires a pin', async caller => {
        const scope = { serverId: 'home', accountId: 'viewer' };
        const project = { ...scope, owner: { kind: 'project' as const, projectId: 'destination-project' } };
        const home = { ...scope, owner: { kind: 'home' as const } };
        const boundary = createWorkBoardArtifactBoundary();
        const transport = boundary.forAccount(scope.accountId);
        const area = createCliWidgetAreaActionDepsV1({ scope, isCurrent: () => true, transport });
        let deps: ActionExecutorDeps = { ...createUnavailableActionTransportDeps(), ...area,
            widgetAccountScope: () => scope, homeHubArtifacts: createHomeHubArtifactPortV1(transport, { accountId: scope.accountId }) };
        deps = { ...deps, ...createCliWidgetInputActionDepsV1({ ...scope, getDeps: () => deps,
            readCandidates: async () => [], validateSession: async () => false }) };
        const executor = createActionExecutor(deps);
        const context = { surface: caller, bypassApprovals: true };
        const definition = { kind: 'builtin' as const, id: 'usage_period_summary' };
        const descriptor = readBuiltinWidgetDescriptorV1(definition)!;
        const query = normalizeUsageQuery({ period: { startMs: 1000 }, projects: ['original-project'] });
        const bindings: WidgetInputBindingsV1 = Object.fromEntries(descriptor.inputs!.fields.map(field => [field.path,
            field.path === 'projects' ? { kind: 'context', slot: 'projects' }
                : { kind: 'value', value: StrictJsonValueSchema.parse(readInputPath(query, field.path)) }]));
        const instance = { v: 1 as const, id: 'usage-copy', definition, bindings };
        const group: WidgetLayoutGroupV1 = { kind: 'group', id: 'copied-band', width: 'full', frameStyle: 'card', dividers: 'hairline',
            context: { projects: { kind: 'context', slot: 'projects' } }, children: [{ kind: 'widget', instance }] };
        const added = await executor.execute('widgets.group.add', { surface: project, group }, context);
        expect(added, JSON.stringify(added)).toMatchObject({ ok: true });
        expect(await executor.execute('widgets.item.inputs.validate', { ref: { surface: project, instanceId: instance.id }, bindings }, context))
            .toMatchObject({ ok: true, result: { status: 'ready', input: { projects: ['destination-project'] } } });
        // An attached layout retains its document owner's identity while its mounted
        // Project can supply a different authorized viewing context.
        expect(await executor.execute('widgets.item.inputs.validate', { ref: { surface: project, instanceId: instance.id }, bindings }, {
            ...context, widgetAreaContext: { surface: project, values: { projects: [['mounted-project']] } },
        })).toMatchObject({ ok: true, result: { status: 'ready', input: { projects: ['mounted-project'] } } });
        expect(await executor.execute('widgets.item.inputs.validate', { ref: { surface: project, instanceId: instance.id }, bindings }, {
            ...context, widgetAreaContext: { surface: project, values: { projects: [] } },
        })).toMatchObject({ ok: true, result: { status: 'selection_required', fields: [{ path: 'projects', reasonCode: 'widget_context_missing' }] } });
        const stored = await executor.execute('widgets.item.list', { surface: project }, context);
        if (!stored.ok) throw new Error(stored.errorCode);
        expect(WidgetSurfaceReadV1Schema.parse(stored.result).items).toContainEqual(group);
        const missing = { ok: false, errorCode: 'widget_inputs_invalid', details: { status: 'selection_required',
            fields: [{ path: 'projects', reasonCode: 'widget_context_missing' }] } };
        expect(await executor.execute('widgets.group.add', { surface: home, group }, context)).toMatchObject(missing);
        expect(await executor.execute('widgets.item.add', { surface: home, instance }, context)).toMatchObject(missing);
        const pinned = { ...instance, id: 'pinned-copy', bindings: { ...bindings, projects: { kind: 'value' as const, value: [] } } };
        expect(await executor.execute('widgets.item.add', { surface: home, instance: pinned }, context)).toMatchObject({ ok: true });
        expect(await executor.execute('widgets.item.add', { surface: project, instance: { ...instance, id: 'standalone-copy' } }, context)).toMatchObject({ ok: true });
        expect(await executor.execute('widgets.item.add', { surface: project, instance: pinned }, context)).toMatchObject({ ok: true });
        expect(await executor.execute('widgets.item.inputs.validate', { ref: { surface: project, instanceId: pinned.id }, bindings: pinned.bindings }, context))
            .toMatchObject({ ok: true, result: { status: 'ready', input: { projects: [] } } });
        const fragmentCopy = instantiateWidgetLayoutFragmentGroupV1(captureWidgetLayoutFragmentGroupV1(group), {
            groupId: 'fragment-band', childIds: ['fragment-copy'],
        });
        expect(await executor.execute('widgets.group.add', { surface: project, group: fragmentCopy }, context)).toMatchObject({ ok: true });
        expect(await executor.execute('widgets.item.inputs.validate', { ref: { surface: project, instanceId: 'fragment-copy' }, bindings }, context))
            .toMatchObject({ ok: true, result: { status: 'ready', input: { projects: ['destination-project'] } } });
        expect(await executor.execute('widgets.group.inputs.set', { ref: { surface: project, instanceId: group.id },
            bindings: { projects: { kind: 'value', value: [] } } }, context)).toMatchObject({ ok: true });
        expect(await executor.execute('widgets.item.inputs.validate', { ref: { surface: project, instanceId: instance.id }, bindings }, context))
            .toMatchObject({ ok: true, result: { status: 'ready', input: { projects: [] } } });
    });
    it('uses one placement read for a group input write with one or three changed children', async () => {
        async function writeGroup(childCount: number) {
            const scope = { serverId: 'home', accountId: 'viewer' };
            const surface = { ...scope, owner: { kind: 'project' as const, projectId: 'destination-project' } };
            const boundary = createWorkBoardArtifactBoundary();
            const area = createCliWidgetAreaActionDepsV1({ scope, isCurrent: () => true, transport: boundary.forAccount(scope.accountId) });
            const project = area.widgetSurfaceActions!.project!;
            let placementReads = 0;
            let deps: ActionExecutorDeps = { ...createUnavailableActionTransportDeps(), ...area, widgetAccountScope: () => scope,
                widgetSurfaceActions: { ...area.widgetSurfaceActions, project: { ...project, read: (...args) => {
                    placementReads++;
                    return project.read(...args);
                } } } };
            deps = { ...deps, ...createCliWidgetInputActionDepsV1({ ...scope, getDeps: () => deps,
                readCandidates: async () => [], validateSession: async () => false }) };
            const executor = createActionExecutor(deps);
            const context = { surface: 'cli', bypassApprovals: true } as const;
            const definition = { kind: 'builtin', id: 'usage_period_summary' } as const;
            const query = normalizeUsageQuery({ period: { startMs: 1000 } });
            const bindings: WidgetInputBindingsV1 = Object.fromEntries(readBuiltinWidgetDescriptorV1(definition)!.inputs!.fields.map(field => [
                field.path, field.path === 'period' ? { kind: 'context', slot: 'period' }
                    : { kind: 'value', value: StrictJsonValueSchema.parse(readInputPath(query, field.path)) },
            ]));
            const group: WidgetLayoutGroupV1 = {
                kind: 'group', id: 'usage-group', width: 'full', frameStyle: 'card', dividers: 'hairline',
                context: { period: { kind: 'value', value: { relative: '7days' } } },
                children: Array.from({ length: childCount }, (_, index) => ({
                    kind: 'widget', instance: { v: 1, id: `usage-child-${index}`, definition, bindings },
                })),
            };
            expect(await executor.execute('widgets.group.add', { surface, group }, context)).toMatchObject({ ok: true });

            const override = { period: { kind: 'value', value: { relative: 'today' } } } as const;
            const readsBeforeWrite = boundary.reads.length;
            placementReads = 0;
            expect(await executor.execute('widgets.group.inputs.set', {
                ref: { surface, instanceId: group.id }, bindings: override,
            }, context)).toMatchObject({ ok: true });
            const counts = { placement: placementReads, artifact: boundary.reads.length - readsBeforeWrite };

            const stored = await executor.execute('widgets.item.list', { surface }, context);
            if (!stored.ok) throw new Error(stored.errorCode);
            expect(WidgetSurfaceReadV1Schema.parse(stored.result).items).toContainEqual({ ...group, context: override });
            return counts;
        }
        expect({ one: await writeGroup(1), three: await writeGroup(3) }).toEqual({
            one: { placement: 1, artifact: 2 }, three: { placement: 1, artifact: 2 },
        });
    });

    it('admits a local Session profile pin only when the captured Home owner proves equivalence', async () => {
        const scope = { serverId: 'srv_widget_home', accountId: 'viewer',
            isSameServerId: (id: string) => ['srv_widget_home', 'local-profile'].includes(id) };
        let readable = true;
        const deps = createCliWidgetInputActionDepsV1({ serverId: scope.serverId, accountId: scope.accountId,
            getDeps: () => ({ ...createUnavailableActionTransportDeps(), widgetAccountScope: () => scope }),
            readCandidates: async () => [], validateSession: async () => readable });
        const request = { ref: { surface: { serverId: scope.serverId, accountId: scope.accountId,
            owner: { kind: 'home' as const } }, instanceId: 'summary' },
            instance: { v: 1 as const, id: 'summary', definition: { kind: 'builtin' as const, id: 'session_summary' },
                bindings: { session: { kind: 'context' as const, slot: 'session' } } },
            groupBindings: { session: { kind: 'value' as const, value: { serverId: 'local-profile', sessionId: 'B' } } },
            context: { surface: 'cli' as const } };
        expect(await deps.widgetInputs!.resolve(request)).toMatchObject({ status: 'ready', input: {
            session: { serverId: 'local-profile', sessionId: 'B' },
        } });
        readable = false;
        expect(await deps.widgetInputs!.resolve(request)).toMatchObject({ status: 'denied' });
        expect(await deps.widgetInputs!.resolve({ ...request, instance: { ...request.instance, bindings: {
            session: { kind: 'value', value: { serverId: 'foreign-home', sessionId: 'B' } },
        } } })).toMatchObject({ status: 'denied', fields: [{ reasonCode: 'widget_target_scope_mismatch' }] });
    });
    describe('admitting one picked Session through the real Action executor', () => {
        const scope = { serverId: 'home', accountId: 'viewer' };
        const picked = { serverId: 'home', sessionId: 'B' };
        const summary = { id: 'B', createdAt: 1, updatedAt: 1, active: true, activeAt: 1, encryptionMode: 'plain' as const, encryption: null };
        const awareness = (overrides: Record<string, unknown> = {}) => ({ v: 1, sessionId: 'B', title: 'Bound B', lifecycle: 'active', runtime: 'idle',
            freshness: 'live', operational: { primary: 'none', reasons: [] }, encryption: 'plain', availability: 'complete', ...overrides });
        // Only the Home transport is faked: the Session list pages and the single-Session read are counted.
        const admit = (status: NonNullable<ActionExecutorDeps['sessionStatusGet']>) => {
            const pages: unknown[] = [];
            const deps = createCliWidgetInputActionDepsV1({ ...scope, getDeps: () => ({ ...createUnavailableActionTransportDeps(), widgetAccountScope: () => scope,
                sessionList: async request => { pages.push(request); throw new Error('A picked Session must not page the Session list'); },
                sessionStatusGet: status }),
                readCandidates: async () => [], validateSession: async () => true });
            const resolve = () => deps.widgetInputs!.resolve({ ref: { surface: { ...scope, owner: { kind: 'home' as const } }, instanceId: 'summary' },
                instance: { v: 1 as const, id: 'summary', definition: { kind: 'builtin' as const, id: 'session_summary' },
                    bindings: { session: { kind: 'value' as const, value: picked } } },
                context: { surface: 'cli' as const, authority: 'present_user' as const } });
            return { pages, resolve };
        };

        it('admits a readable Session without paging the Session list', async () => {
            const { pages, resolve } = admit(async () => ({ ok: true, session: summary, awareness: awareness() }));
            expect(await resolve()).toEqual({ status: 'ready', input: { session: picked } });
            expect(pages).toHaveLength(0);
        });

        it('still refuses a locked Session and a deleted Session with the choice-unavailable reason', async () => {
            const refusal = { status: 'invalid', fields: [{ path: 'session', reasonCode: 'widget_input_option_unavailable' }] };
            expect(await admit(async () => ({ ok: true, session: summary,
                awareness: awareness({ title: undefined, encryption: 'locked', availability: 'locked' }) })).resolve()).toMatchObject(refusal);
            expect(await admit(async () => ({ ok: false, code: 'session_not_found' })).resolve()).toMatchObject(refusal);
        });
    });
    it.each(['inline', 'artifact'] as const)('preserves native Session admission for a saved %s builtin', async kind => {
        const native = readBuiltinWidgetDescriptorV1({ kind: 'builtin', id: 'changes' })!;
        const definition: WidgetDefinitionV1 = { v: 1, id: 'native-definition', name: 'Saved changes',
            body: { kind: 'builtin', id: 'changes' }, sizeDeclaration: native.sizeDeclaration,
            inputs: native.inputs!, inputSchema: native.inputSchema!, sessionInputPath: native.sessionInputPath,
            provenance: { source: { kind: 'authored' } } };
        const artifacts = createWidgetDefinitionArtifactPortV1({
            read: async artifactId => ({ artifactId, ownerAccountId: 'viewer', header: buildWidgetDefinitionArtifactHeaderV1(definition),
                body: JSON.stringify(definition), revision: { headerVersion: 1, bodyVersion: 1 } }),
            list: async () => ({ items: [] }),
            create: async () => { throw new Error('Input resolution must not create an Artifact'); },
            update: async () => { throw new Error('Input resolution must not update an Artifact'); },
            delete: async () => { throw new Error('Input resolution must not delete an Artifact'); },
        }, { accountId: 'viewer' });
        let readable = true;
        const deps = createCliWidgetInputActionDepsV1({ serverId: 'home', accountId: 'viewer',
            getDeps: () => ({ ...createUnavailableActionTransportDeps(), widgetAccountScope: () => ({ serverId: 'home', accountId: 'viewer' }),
                widgetDefinitionArtifacts: artifacts }),
            readCandidates: async () => [], validateSession: async () => readable,
        });
        const request = {
            ref: { surface: { serverId: 'home', accountId: 'viewer', owner: { kind: 'home' } }, instanceId: 'saved-native' },
            instance: { v: 1, id: 'saved-native', definition: kind === 'inline' ? { kind, definition }
                : { kind, artifactId: definition.id }, bindings: { session: { kind: 'value', value: { serverId: 'home', sessionId: 'private-session' } } } },
            context: { surface: 'cli', authority: 'present_user' },
        } satisfies Parameters<NonNullable<typeof deps.widgetInputs>['resolve']>[0];
        expect(await deps.widgetInputs!.resolve({ ...request, instance: { ...request.instance,
            bindings: { session: { kind: 'context', slot: 'session' } } }, groupBindings: request.instance.bindings }))
            .toEqual({ status: 'ready', input: { session: { serverId: 'home', sessionId: 'private-session' } } });
        readable = false;
        expect(await deps.widgetInputs!.resolve(request)).toMatchObject({ status: 'denied', fields: [{ path: 'session', reasonCode: 'widget_session_access_denied' }] });
    });
    it('resolves HTML copy inputs without treating its body as an installed plugin', async () => {
        const definition: WidgetDefinitionV1 = { v: 1, id: 'html-copy', name: 'HTML copy',
            sizeDeclaration: { sizes: ['small', 'medium', 'large'], defaultSize: 'medium' },
            provenance: { source: { kind: 'authored' } },
            body: { kind: 'html', source: { v: 1, entrypoint: 'index.html', files: { 'index.html': { mime: 'text/html', contentBase64: 'PGgxPkNvcHk8L2gxPg==' } } } },
            inputs: { fields: [{ path: 'period', title: 'Period', widget: 'text', required: true }] },
            inputSchema: { type: 'object', properties: { period: { type: 'string' } }, required: ['period'], additionalProperties: false } };
        const surface = { serverId: 'home', accountId: 'viewer', owner: { kind: 'home' as const } };
        const deps = createCliWidgetInputActionDepsV1({ serverId: 'home', accountId: 'viewer',
            getDeps: () => ({ ...createUnavailableActionTransportDeps(), widgetAccountScope: () => ({ serverId: 'home', accountId: 'viewer' }) }),
            readCandidates: async () => [], validateSession: async () => false,
        });
        expect(await deps.widgetInputs!.resolve({ ref: { surface, instanceId: 'copy' },
            instance: { v: 1, id: 'copy', definition: { kind: 'inline', definition }, bindings: { period: { kind: 'value', value: 'week' } } },
            context: { surface: 'cli' } })).toEqual({ status: 'ready', input: { period: 'week' } });
    });
    it('refuses an unreadable declared Session target without an explicit plugin path', async () => {
        const surface = { serverId: 'home', accountId: 'viewer', owner: { kind: 'home' as const } };
        const definition = { pluginId: 'com.acme.widgets', localId: 'checks' };
        const deps = createCliWidgetInputActionDepsV1({ serverId: 'home', accountId: 'viewer',
            getDeps: () => ({ ...createUnavailableActionTransportDeps(), widgetAccountScope: () => ({ serverId: 'home', accountId: 'viewer' }) }),
            readCandidates: async () => [{ surface: definition, availability: 'available', inputs: { fields: [
                { path: 'chosen', title: 'Session', widget: 'json', required: true, inputType: { hostType: 'session' } },
            ] } }], validateSession: async () => false,
        });
        expect(await deps.widgetInputs!.resolve({ ref: { surface, instanceId: 'copy' }, instance: { v: 1, id: 'copy',
            definition: { kind: 'installed', surface: definition }, bindings: { chosen: { kind: 'value', value: { serverId: 'home', sessionId: 'B' } } } },
            context: { surface: 'cli' } })).toMatchObject({ status: 'unavailable' });
    });
    it('admits the authorized checkout on every host and refuses changed, removed or retired authority', async () => {
        const surface = { serverId: 'home', accountId: 'viewer', owner: { kind: 'project' as const, projectId: 'project' } };
        const checkout = { id: 'checkout', serverId: 'home', machineId: 'machine', rootPath: '/repo', createdAtMs: 1 };
        let current = true;
        let workspaceRefs = [checkout];
        const boards = createWorkBoardArtifactPortV1(createWorkBoardArtifactBoundary().transport, { shouldContinue: () => current });
        await boards.apply({ kind: 'create', board: { id: 'board', name: 'Board' } });
        const area = createCliWidgetAreaActionDepsV1({ scope: surface, isCurrent: () => current, transport: {
            read: async () => null,
            create: async () => { throw new Error('Input resolution must not create an Artifact'); },
            update: async () => { throw new Error('Input resolution must not update an Artifact'); },
        } });
        const deps = createCliWidgetInputActionDepsV1({ serverId: 'home', accountId: 'viewer',
            getDeps: () => ({ ...createUnavailableActionTransportDeps(), ...area, workBoardArtifacts: boards,
                widgetAccountScope: () => current ? { serverId: 'home', accountId: 'viewer' } : null }),
            readCandidates: async () => { throw new Error('Native metadata has no plugin discovery'); },
            validateSession: async () => { throw new Error('A checkout grants no Session access'); },
            readWorkspaceRefs: async () => workspaceRefs,
        });
        const request = { ref: { surface, instanceId: 'copy' }, instance: { v: 1 as const, id: 'copy', definition: { kind: 'builtin' as const, id: 'project_code' },
            bindings: { checkout: { kind: 'value' as const, value: checkout } } },
            context: { surface: 'cli' as const, widgetAreaContext: { surface, values: { checkout: [checkout] } } } };
        expect(await deps.widgetInputs!.resolve(request)).toEqual({ status: 'ready', input: { checkout } });
        for (const owner of [{ kind: 'home' }, { kind: 'workBoard', boardId: 'board' },
            { kind: 'pluginArea', pluginId: 'acme.page', pageId: 'page', area: 'main' },
            { kind: 'corePage', pageId: 'usage', area: 'main' }] as const) {
            expect(await deps.widgetInputs!.resolve({ ...request, ref: { ...request.ref, surface: { ...surface, owner } },
                context: { surface: 'cli' } })).toEqual({ status: 'ready', input: { checkout } });
        }
        expect(await deps.widgetInputs!.resolve({ ...request, instance: { ...request.instance,
            bindings: { checkout: { kind: 'value', value: { ...checkout, rootPath: '/other' } } } } })).toMatchObject({ status: 'denied',
            fields: [{ path: 'checkout', reasonCode: 'widget_target_identity_mismatch' }] });
        expect(await deps.widgetInputs!.resolve({ ...request, context: { surface: 'cli' } })).toMatchObject({ status: 'ready' });
        expect(await deps.widgetInputs!.resolve({ ...request, context: { surface: 'cli' },
            instance: { ...request.instance, bindings: { checkout: { kind: 'context', slot: 'checkout' } } },
            groupBindings: { checkout: { kind: 'value', value: checkout } } })).toMatchObject({ status: 'ready' });
        expect(await deps.widgetInputs!.resolve({ ...request, instance: { ...request.instance,
            bindings: { checkout: { kind: 'value', value: { ...checkout, serverId: 'foreign-home' } } } } }))
            .toMatchObject({ status: 'denied', fields: [{ reasonCode: 'widget_target_scope_mismatch' }] });
        workspaceRefs = [];
        expect(await deps.widgetInputs!.resolve(request)).toMatchObject({ status: 'denied' });
        workspaceRefs = [checkout];
        current = false;
        expect(await deps.widgetInputs!.resolve(request)).not.toMatchObject({ status: 'ready' });
    });
    it('resolves app-read fields without Session or credential authority and refuses ambiguous target declarations', async () => {
        const surface = { serverId: 'home', accountId: 'viewer', owner: { kind: 'home' as const } };
        const definition = { pluginId: 'com.acme.widgets', localId: 'usage' };
        const deps = createCliWidgetInputActionDepsV1({ serverId: 'home', accountId: 'viewer',
            getDeps: () => ({ ...createUnavailableActionTransportDeps(), widgetAccountScope: () => ({ serverId: 'home', accountId: 'viewer' }) }),
            readCandidates: async () => [{ surface: definition, availability: 'available', inputs: { fields: [
                { path: 'period', title: 'Period', widget: 'text', required: true },
            ] } }], validateSession: async () => { throw new Error('App reads grant no Session authority'); },
            readViewerPurposeContext: async () => { throw new Error('App reads grant no credentials'); },
        });
        const request = { ref: { surface, instanceId: 'copy' }, instance: { v: 1 as const, id: 'copy',
            definition: { kind: 'installed' as const, surface: definition }, bindings: { period: { kind: 'value' as const, value: 'week' } } },
            context: { surface: 'cli' as const } };
        expect(await deps.widgetInputs!.resolve(request)).toEqual({ status: 'ready', input: { period: 'week' } });
        const ambiguous = createCliWidgetInputActionDepsV1({ serverId: 'home', accountId: 'viewer',
            getDeps: () => ({ ...createUnavailableActionTransportDeps(), widgetAccountScope: () => ({ serverId: 'home', accountId: 'viewer' }) }),
            readCandidates: async () => [{ surface: definition, availability: 'available', inputs: { fields: [
                { path: 'one', title: 'Session', widget: 'json', inputType: { hostType: 'session' } },
                { path: 'two', title: 'Checkout', widget: 'json', inputType: { hostType: 'workspace' } },
            ] } }], validateSession: async () => { throw new Error('Ambiguous targets must be refused'); },
        });
        expect(await ambiguous.widgetInputs!.resolve({ ...request, instance: { ...request.instance, bindings: {} } })).toMatchObject({ status: 'unavailable' });
    });
    it('discovers the exact group-selected Session and rechecks its access without rebinding a child pin', async () => {
        const surface = { serverId: 'home', accountId: 'viewer', owner: { kind: 'home' as const } };
        const definition = { pluginId: 'com.acme.widgets', localId: 'checks' };
        const instance = { v: 1 as const, id: 'copy', definition: { kind: 'installed' as const, surface: definition },
            bindings: { session: { kind: 'context' as const, slot: 'session' } } };
        const candidate = { surface: definition, availability: 'available' as const, sessionInputPath: 'session',
            inputs: { fields: [{ path: 'session', title: 'Session', widget: 'json' as const, required: true }] } };
        let allowed = true;
        const targets: string[] = [];
        const deps = createCliWidgetInputActionDepsV1({ serverId: 'home', accountId: 'viewer',
            getDeps: () => ({ ...createUnavailableActionTransportDeps(), widgetAccountScope: () => ({ serverId: 'home', accountId: 'viewer' }),
                widgetSurfaceActions: { home: {
                    read: async () => ({ surface, canEdit: true, instances: [{ instance }], items: [{ kind: 'group', id: 'group', width: 'full',
                        frameStyle: 'card', dividers: 'hairline', children: [{ kind: 'widget', instance }],
                        context: { session: { kind: 'value', value: { serverId: 'home', sessionId: 'B' } } } }] }),
                    apply: async () => { throw new Error('Resolution must not write a layout'); },
                } } }),
            readCandidates: async (_signal, session) => session?.sessionId === 'B' || session?.sessionId === 'C' ? [candidate] : [],
            validateSession: async session => { targets.push(session.sessionId); return allowed; },
        });
        const request = { ref: { surface, instanceId: instance.id }, instance, context: { surface: 'cli' as const } };
        expect(await deps.widgetInputs!.resolve(request)).toEqual({ status: 'ready', input: { session: { serverId: 'home', sessionId: 'B' } } });
        expect(await deps.widgetInputs!.resolve({ ...request, instance: { ...instance, bindings: {
            session: { kind: 'value', value: { serverId: 'home', sessionId: 'C' } },
        } } })).toEqual({ status: 'ready', input: { session: { serverId: 'home', sessionId: 'C' } } });
        expect(targets).toContain('B');
        expect(targets).toContain('C');
        allowed = false;
        expect(await deps.widgetInputs!.resolve(request)).toMatchObject({ status: 'unavailable' });
    });
    it('validates a picker-only typed pin before admitting executable widget input', async () => {
        const inputType = { pluginId: 'com.acme.widgets', localId: 'repository' };
        const surface = { pluginId: inputType.pluginId, localId: 'checks' };
        const type = { identity: inputType, occurrenceId: 'current', definition: { id: inputType.localId,
            title: 'Repository', semantic: 'repository', valueSchema: { type: 'object' as const,
                properties: { repositoryId: { type: 'string' as const } }, required: ['repositoryId'], additionalProperties: false } } };
        const deps = createCliWidgetInputActionDepsV1({ serverId: 'home', accountId: 'viewer',
            getDeps: () => ({ ...createUnavailableActionTransportDeps(), widgetAccountScope: () => ({ serverId: 'home', accountId: 'viewer' }) }),
            readInputTypes: async () => ({ family: 'inputTypes', entriesById: { [`${inputType.pluginId}/${inputType.localId}`]: {
                id: `${inputType.pluginId}/${inputType.localId}`, pluginId: inputType.pluginId, pluginVersion: '1.0.0',
                occurrenceId: type.occurrenceId, definition: type.definition,
            } } }),
            validateSession: async () => { throw new Error('Repository input grants no Session access'); },
            readCandidates: async () => [{ surface, availability: 'available', inputs: { fields: [
                { path: 'repository', title: 'Repository', widget: 'select', inputType },
            ] } }],
        });
        const request = { ref: { surface: { serverId: 'home', accountId: 'viewer', owner: { kind: 'home' as const } }, instanceId: 'copy' },
            instance: { v: 1 as const, id: 'copy', definition: { kind: 'installed' as const, surface },
                bindings: { repository: { kind: 'value' as const, value: { repositoryId: 'repo' } } } }, context: { surface: 'cli' as const } };
        expect(await deps.widgetInputs!.resolve(request)).toEqual({ status: 'ready', input: { repository: { repositoryId: 'repo' } } });
        expect(await deps.widgetInputs!.resolve({ ...request, instance: { ...request.instance,
            bindings: { repository: { kind: 'value', value: { repositoryId: 42 } } } } })).toMatchObject({ status: 'invalid',
            fields: [{ path: 'repository', reasonCode: 'input_type_value_invalid' }] });
    });
    it('admits native metadata without plugin discovery but refuses the exact unreadable bound Session', async () => {
        const targets: Array<{ serverId: string; sessionId: string }> = [];
        const deps = createCliWidgetInputActionDepsV1({ serverId: 'home', accountId: 'viewer',
            getDeps: () => ({ ...createUnavailableActionTransportDeps(), widgetAccountScope: () => ({ serverId: 'home', accountId: 'viewer' }) }),
            readCandidates: async () => { throw new Error('Native metadata does not come from a plugin daemon'); },
            validateSession: async target => { targets.push(target); return false; },
        });
        const result = await deps.widgetInputs!.resolve({
            ref: { surface: { serverId: 'home', accountId: 'viewer', owner: { kind: 'sessionBoard', sessionId: 'A' } }, instanceId: 'native-copy' },
            instance: { v: 1, id: 'native-copy', definition: { kind: 'builtin', id: 'changes' }, bindings: {
                session: { kind: 'value', value: { serverId: 'home', sessionId: 'B' } },
            } }, context: { surface: 'cli', authority: 'present_user' },
        });
        expect(result).toMatchObject({ status: 'denied', fields: [{ path: 'session', reasonCode: 'widget_session_access_denied' }] });
        expect(targets).toEqual([{ serverId: 'home', sessionId: 'B' }]);
    });
    it('admits bound Session input against current B rather than physical A declaration', async () => {
        const definition = { pluginId: 'com.acme.widgets', localId: 'checks' };
        const inputType = { pluginId: definition.pluginId, localId: 'count' };
        const reads: (string | undefined)[] = [];
        const deps = createCliWidgetInputActionDepsV1({ serverId: 'home', accountId: 'viewer',
            getDeps: () => ({ ...createUnavailableActionTransportDeps(), widgetAccountScope: () => ({ serverId: 'home', accountId: 'viewer' }) }),
            validateSession: async () => true,
            readInputTypes: async (_signal, session) => session?.sessionId === 'B' ? {
                family: 'inputTypes', entriesById: { 'com.acme.widgets/count': {
                    id: 'com.acme.widgets/count', pluginId: inputType.pluginId, pluginVersion: '1.0.0', occurrenceId: 'current-B',
                    definition: { id: inputType.localId, title: 'Count', semantic: 'count', valueSchema: { type: 'number' } },
                } },
            } : undefined,
            readCandidates: async (_signal, session) => {
                reads.push(session?.sessionId);
                return [{ surface: definition, availability: 'available', sessionInputPath: 'session',
                    inputs: { fields: [{ path: 'session', title: 'Session', widget: 'json', required: true },
                        { path: 'count', title: 'Count', widget: 'number', required: true, inputType }] },
                    inputSchema: { type: 'object', properties: { session: { type: 'object', properties: {
                        serverId: { type: 'string' }, sessionId: { type: 'string' },
                    }, required: ['serverId', 'sessionId'], additionalProperties: false },
                    count: { type: 'number', minimum: session?.sessionId === 'B' ? 3 : 1 } },
                    required: ['session', 'count'], additionalProperties: false } }];
            },
        });
        const request = {
            ref: { surface: { serverId: 'home', accountId: 'viewer', owner: { kind: 'sessionBoard', sessionId: 'A' } }, instanceId: 'copy' },
            instance: { v: 1, id: 'copy', definition: { kind: 'installed', surface: definition }, bindings: {
                session: { kind: 'value', value: { serverId: 'home', sessionId: 'B' } }, count: { kind: 'value', value: 2 },
            } }, context: { surface: 'cli', authority: 'present_user' },
        } satisfies Parameters<NonNullable<typeof deps.widgetInputs>['resolve']>[0];
        const result = await deps.widgetInputs!.resolve(request);
        expect(result.status).toBe('invalid');
        expect(reads).toEqual(['A', 'B']);
        expect(await deps.widgetInputs!.resolve({ ...request, instance: { ...request.instance,
            bindings: { ...request.instance.bindings, count: { kind: 'value', value: 3 } } } }))
            .toEqual({ status: 'ready', input: { session: { serverId: 'home', sessionId: 'B' }, count: 3 } });
    });
});
