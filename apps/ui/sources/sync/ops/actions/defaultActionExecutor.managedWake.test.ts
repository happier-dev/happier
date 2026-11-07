import { afterEach, expect, it, onTestFinished } from 'vitest';
import { ManagedMachineV1Schema } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import { ActionsSettingsV1Schema, setActionApprovalOverride } from '@happier-dev/protocol/actions/actionSettings';
import { installApprovalCommonModuleMocks } from '@/components/approvals/approvalsTestHelpers';
import { serveAccountHomes } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { createArtifactStoreBoundary } from '@/dev/testkit/harness/artifactStoreBoundary';
import { standardCleanup } from '@/dev/testkit';
import { createDefaultActionExecutor } from './defaultActionExecutor';
import { storage } from '@/sync/domains/state/storage';
import { createSessionReadBatchHttpBoundary } from '@/dev/testkit/harness/sessionReadBatchHttpBoundary';
import { createPlainSessionCurrentProjectionRecordFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { createMachineFixture, createMachineReadBatchResponseFixture, createPlainMachineRowFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { PluginPortableReleaseManifestV1Schema } from '@happier-dev/protocol/plugins/availability';
import { projectPluginPortableUiDeclarationsV1 } from '@happier-dev/protocol/plugins/contributions/ui';
import { installBundledPluginUiDeclarationsForTests } from '@/dev/testkit/mocks/bundledPluginUiAssets';
import { PLUGIN_MANIFEST } from '../../../../../../packages/plugins/machine-vercel/src/manifest';
import { captureLazyActionAccountContext } from './actionAccountContext';
import { replacePluginAccountAvailabilityProjection } from '@/sync/domains/plugins/availability/projection';
import { bindPresentUserActionConfirmation } from './presentUserConfirmation';
import { ExternalActionRequestEnvelopeV1Schema } from '@happier-dev/protocol/actions/externalActionApi';

installApprovalCommonModuleMocks();
afterEach(async () => { await standardCleanup(); });

it.each(['denied', 'transport', 'malformed', 'cancelled'] as const)(
    'keeps canonical control denial distinct from a failed power review read, read=%s', async read => {
    const homeId = `srv_power_read_${read}`;
    const cancellation = new AbortController();
    let admissions = 0;
    const nativeRequests: string[] = [];
    const homes = await serveAccountHomes({ homes: [{ key: 'a', serverUrl: `https://power-read-${read}.test`,
        serverIdentityId: homeId, accountId: 'requester', currentAccount: true }], route: request => {
        if (request.path === '/v1/machines/managed/actions/get') {
            if (read === 'denied') return Response.json({ code: 'permission_denied' }, { status: 403 });
            if (read === 'transport') throw new TypeError('Review transport unavailable');
            if (read === 'cancelled') {
                cancellation.abort();
                throw new DOMException('Review cancelled', 'AbortError');
            }
            return Response.json({ invalid: 'not a managed row' });
        }
        if (request.path.endsWith('/admit-control')) {
            admissions++;
            return Response.json({ code: 'managed_power_required' }, { status: 403 });
        }
        if (request.path.includes('/machines/managed/')) nativeRequests.push(request.path);
        return undefined;
    } });
    try {
        const state = storage.getState();
        state.applySettings({ ...state.settings, actionsSettingsV1: ActionsSettingsV1Schema.parse({ v: 1 }) },
            (state.settingsVersion ?? 0) + 1);
        const input = { homeId, managedId: 'foreign-managed', expectedRevision: 4, when: 'now' as const, intent: 'stop' as const };
        const result = await createDefaultActionExecutor().execute('machines.managed.power.set', input,
            bindPresentUserActionConfirmation('machines.managed.power.set', input, {
                surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' },
                serverId: homes.homes.a!.id, serverIdentityId: homeId, runtimeAccountId: 'requester',
                actionRequestId: `power-read-${read}`, signal: cancellation.signal,
            }));
        expect(result).toMatchObject({ ok: false, errorCode: read === 'denied' ? 'managed_power_required'
            : read === 'transport' ? 'managed_request_failed' : read === 'cancelled' ? 'cancelled' : 'managed_response_invalid' });
        expect(admissions).toBe(read === 'denied' ? 1 : 0);
        expect(nativeRequests).toEqual([]);
    } finally { await homes.dispose(); }
});

it.each(['power', 'send'] as const)('prepares original Account %s provider roles through the default app admission before native work', async mode => {
    const manifest = PluginPortableReleaseManifestV1Schema.parse(PLUGIN_MANIFEST);
    const unrelated = PluginPortableReleaseManifestV1Schema.parse({ ...manifest, id: 'acme.unrelated-compute' });
    const loaded: string[] = [];
    onTestFinished(installBundledPluginUiDeclarationsForTests([manifest, unrelated].map(declaration => {
        const full = { pluginId: declaration.id, pluginVersion: declaration.version,
            packageName: `@happier-dev/plugins-${declaration.id}`, displayName: typeof declaration.displayName === 'string'
                ? declaration.displayName : declaration.displayName.fallback,
            normalizedManifest: declaration, hasMachineProvisioners: true,
            entriesById: projectPluginPortableUiDeclarationsV1(declaration, []) };
        // App asset suppliers are the boundary; discovery and exact selection remain real.
        return { ...full, normalizedManifest: undefined, presentationManifest: declaration,
            loadDeclaration: async () => { loaded.push(declaration.id); return full; } };
    })));
    const provisioner = manifest.contributes.machineProvisioners![0]!;
    const bootstrapTransport = provisioner.bootstrapTransport;
    if (bootstrapTransport?.kind !== 'native') throw new Error('The enrolled Vercel fixture requires native guest startup');
    const homeId = `srv_account_${mode}_review`;
    const launch = { provider: { pluginId: manifest.id, localId: provisioner.id }, schemaVersion: 1,
        name: 'Guest', choices: {} };
    const machine = ManagedMachineV1Schema.parse({ id: 'managed', homeId, custodianAccountId: 'owner', launch,
        allocation: 'bound', enrolledMachineId: 'guest', resource: { contributionRef: launch.provider, schemaVersion: 1, value: {} },
        creationState: 'active', desired: 'start', desiredWhen: 'now', intentRevision: 4,
        retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false,
        observation: { availability: 'present', power: 'stopped', storage: 'retained', observedAt: 1 },
        reviewedFacts: { launch, provisioner, optionStatus: 'current', prerequisites: [], billing: provisioner.billing,
            retentionCapabilities: provisioner.retention, retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false } });
    const artifacts = createArtifactStoreBoundary({ ownerAccountId: () => 'owner', encryptionMode: 'plain' });
    const queries: unknown[] = [];
    const guest = createPlainMachineRowFixture({ id: 'guest', accountId: 'owner', machine: createMachineFixture({
        id: 'guest', active: false, managedMachineRef: { homeId, managedId: machine.id },
    }) });
    const sessions = createSessionReadBatchHttpBoundary(async request => request.path === '/v2/sessions/account-send'
        ? Response.json({ session: createPlainSessionCurrentProjectionRecordFixture({ id: 'account-send',
            metadata: { machineId: 'guest', path: '/workspace', host: 'qa-host' } }) }) : undefined);
    const homes = await serveAccountHomes({ homes: [{ key: 'a', serverUrl: `https://account-${mode}-review.test`,
        serverIdentityId: homeId, accountId: 'owner', currentAccount: true }], route: request => {
        if (request.path === '/v1/machines') return Response.json([guest]);
        if (request.path === '/v1/machines/read-batch') return createMachineReadBatchResponseFixture(request.body,
            machineId => machineId === guest.id ? guest : null);
        const artifact = artifacts.handle(request.path, { method: request.method, body: JSON.stringify(request.body) });
        if (artifact) return artifact;
        if (request.path === '/v1/machines/managed/actions/get') {
            queries.push(request.body);
            return Response.json(machine);
        }
        if (request.path.includes('/machines/managed/')) throw new Error('Preparation cannot issue native work');
        return sessions.handle(request);
    } });
    try {
        const account = await captureLazyActionAccountContext(homes.homes.a!.id);
        onTestFinished(() => account.dispose());
        // Account bootstrap is a persisted network projection boundary, not an uninitialised catalog.
        replacePluginAccountAvailabilityProjection({ scope: account.accountLifetime.scope,
            snapshot: { availabilityCursor: 1, intentReads: [], materializations: [], snapshots: [] } });
        const state = storage.getState();
        state.applySettings({ ...state.settings, actionsSettingsV1: ActionsSettingsV1Schema.parse({ v: 1 }) },
            (state.settingsVersion ?? 0) + 1);
        const prepared = await createDefaultActionExecutor().prepare(mode === 'power' ? 'machines.managed.power.set' : 'session.message.send',
            mode === 'power' ? { homeId, managedId: machine.id, when: 'now', expectedRevision: 4, intent: 'start' }
                : { sessionId: 'account-send', message: 'Requested Send', reply: 'none' }, {
            surface: 'agent', authority: 'account_automation', actionCaller: { kind: 'host' },
            ...(mode === 'send' ? { defaultSessionId: 'caller', callerPermissionMode: 'default',
                causalPermissionAuthority: { kind: 'admittedSessionInputV1' as const, admittedPermissionCeiling: 'default' },
                sessionInputSource: { sourceSessionId: 'caller', sourceTurnId: 'turn-1', via: 'action' as const } } : {}),
            serverId: homes.homes.a!.id, expectedAccountId: 'owner', actionRequestId: 'original-power',
            externalActionTarget: mode === 'power' ? { kind: 'machine', machineId: 'guest' }
                : { kind: 'session', sessionId: 'account-send' } });
        expect(prepared, JSON.stringify({ prepared, queries }))
            .toMatchObject({ kind: 'settled', result: { ok: true, result: { kind: 'approval_request_created' } } });
        const rows = artifacts.list();
        expect(rows).toHaveLength(1);
        expect(JSON.parse(artifacts.readPlainBody(rows[0]!.id)!)).toMatchObject({ preview: { hostReviewedChildren: { children: [
            ...(mode === 'send' ? [{ action: 'machines.managed.power.set', role: 'managed-wake' }] : []),
            { action: { pluginId: manifest.id, localId: provisioner.actions.bootstrap }, role: 'bootstrap' },
            { action: { pluginId: manifest.id, localId: provisioner.actions.inspect }, role: 'inspect' },
            { action: { pluginId: manifest.id, localId: provisioner.actions.power }, role: 'power' },
            { action: { pluginId: manifest.id, localId: bootstrapTransport.exec }, role: 'exec' },
        ] } } });
        expect(queries).toEqual([{ homeId, managedId: machine.id }]);
        // The app may reuse already-loaded declarations, but never acquire an unrelated provider.
        expect(loaded.filter(pluginId => pluginId !== manifest.id)).toEqual([]);
    } finally { await homes.dispose(); }
});

it.each(['agent', 'person', 'running', 'manual', 'passive', 'required', 'waived', 'agent-send', 'person-send', 'person-send-now'] as const)(
    'prepares %s runtime demand through default UI admission without extra effects or passive reads', async mode => {
    // Each external Account has its own real Settings baseline; retained live Settings must not mask a new fixture document.
    const homeId = `srv_wake_${mode}`;
    const settings = setActionApprovalOverride({ settings: ActionsSettingsV1Schema.parse({ v: 1 }),
        actionId: 'machines.managed.power.set', surface: mode === 'required' ? 'ui' : 'agent',
        approvalRequired: mode === 'required' ? true : mode === 'waived' ? false : null });
    const machine = ManagedMachineV1Schema.parse({ id: 'managed-guest', homeId, custodianAccountId: 'owner',
        controller: { machineId: 'controller', installationId: 'installation' },
        enrolledMachineId: 'guest', allocation: 'bound', creationState: 'active', desired: 'start', desiredWhen: 'now', intentRevision: 4,
        launch: { provider: { pluginId: 'custom.compute', localId: 'vm' }, schemaVersion: 1, name: 'Guest', choices: {} },
        resource: { contributionRef: { pluginId: 'custom.compute', localId: 'vm' }, schemaVersion: 1, value: {} },
        retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false,
        observation: { availability: 'present', power: mode === 'running' ? 'running' : 'stopped', storage: 'retained', observedAt: 1 },
    });
    const artifacts = createArtifactStoreBoundary({ ownerAccountId: () => 'owner', encryptionMode: 'plain' });
    const queries: unknown[] = [];
    const wakeAdmissions: unknown[] = [];
    const inventoryRequests: string[] = [];
    const guest = createPlainMachineRowFixture({ id: 'guest', accountId: 'owner', machine: createMachineFixture({
        id: 'guest', active: mode === 'running', presenceProtocolVersion: 1,
        managedMachineRef: mode === 'manual' ? null : { homeId, managedId: machine.id },
    }) });
    const sessions = createSessionReadBatchHttpBoundary(async request => request.path === '/v2/sessions/requested-session'
        ? Response.json({ session: createPlainSessionCurrentProjectionRecordFixture({ id: 'requested-session',
            metadata: { machineId: 'guest', path: '/workspace', host: 'qa-host' } }) }) : undefined);
    const homes = await serveAccountHomes({ homes: [{ key: 'a', serverUrl: `https://wake-${mode}.test`,
        serverIdentityId: homeId, accountId: 'owner', currentAccount: true,
        settings: { actionsSettingsV1: settings } }], route: request => {
        if (request.path === '/v1/machines') {
            inventoryRequests.push(request.path);
            return Response.json([guest]);
        }
        if (request.path === '/v1/machines/read-batch') {
            inventoryRequests.push(request.path);
            return createMachineReadBatchResponseFixture(request.body, machineId => machineId === guest.id ? guest : null);
        }
        const artifact = artifacts.handle(request.path, { method: request.method, body: JSON.stringify(request.body) });
        if (artifact) return artifact;
        if (request.path === '/v1/machines/managed/actions/get') {
            queries.push(request.body);
            return Response.json(machine);
        }
        if (mode === 'person-send-now' && request.path === '/v1/actions/machines.managed.power.set') {
            const envelope = ExternalActionRequestEnvelopeV1Schema.parse(request.body);
            expect(envelope.target).toEqual({ kind: 'machine', machineId: 'controller' });
            expect(envelope.input).toMatchObject({ managedId: machine.id, intent: 'start' });
            wakeAdmissions.push(envelope);
            return Response.json({ v: 1, actionId: 'machines.managed.power.set', requestId: envelope.requestId,
                execution: { ok: false, errorCode: 'native_resource_unavailable', error: 'native_resource_unavailable' } });
        }
        if (mode === 'person-send-now' && request.path.endsWith('/actions/list')) return Response.json({ machines: [] });
        if (request.path.includes('/machines/managed/')) throw new Error('Preparation cannot issue native work');
        return sessions.handle(request);
    } });
    try {
        // Admission consumes the active Account's admitted Settings projection, not an incidental bootstrap fetch.
        const state = storage.getState();
        state.applySettings({ ...state.settings, actionsSettingsV1: settings }, (state.settingsVersion ?? 0) + 1);
        const person = mode === 'person' || mode === 'required' || mode === 'person-send' || mode === 'person-send-now';
        const send = mode === 'agent-send' || mode === 'person-send' || mode === 'person-send-now';
        const actionId = send ? 'session.message.send' : mode === 'passive' ? 'daemon.filesystem.listDirectory' : 'daemon.filesystem.readFile';
        const prepared = await createDefaultActionExecutor().prepare(actionId, send
            ? { sessionId: 'requested-session', message: 'Wake only after accepted input', reply: 'none',
                ...(mode === 'person-send-now' ? { requestedAction: { v: 1, kind: 'send_now' } } : {}) }
            : { rootPath: '/workspace', path: 'README.md' }, {
            surface: person ? 'ui' : 'agent', authority: person ? 'present_user' : 'account_automation', actionCaller: { kind: 'host' },
            ...(mode === 'agent-send' ? { defaultSessionId: 'caller', callerPermissionMode: 'default',
                causalPermissionAuthority: { kind: 'admittedSessionInputV1' as const, admittedPermissionCeiling: 'default' },
                sessionInputSource: { sourceSessionId: 'caller', sourceTurnId: 'turn-1', via: 'action' as const } } : {}),
            serverId: homes.homes.a!.id, expectedAccountId: 'owner', actionRequestId: 'original-read',
            externalActionTarget: send ? { kind: 'session', sessionId: 'requested-session' } : { kind: 'machine', machineId: 'guest' } });
        if (mode === 'agent' || mode === 'required' || mode === 'agent-send') {
            expect(prepared, JSON.stringify(prepared)).toMatchObject({ kind: 'settled', result: { ok: true,
                result: { kind: 'approval_request_created' } } });
            const rows = artifacts.list();
            expect(rows).toHaveLength(1);
            expect(JSON.parse(artifacts.readPlainBody(rows[0]!.id)!)).toMatchObject({
                actionId,
                preview: { hostReviewedChildren: { children: [{ action: 'machines.managed.power.set', role: 'managed-wake',
                    input: { homeId, managedId: machine.id, expectedRevision: 4, when: 'now', intent: 'start' } }] } },
            });
        } else {
            expect(prepared, JSON.stringify(prepared)).toMatchObject({ kind: 'ready' });
            expect(artifacts.list()).toHaveLength(0);
        }
        expect(queries).toEqual(mode === 'passive' || mode === 'manual' ? [] : [{ homeId, managedId: machine.id }]);
        expect(inventoryRequests).toEqual(mode === 'passive' ? [] : ['/v1/machines']);
        if (mode === 'person-send-now') {
            if (prepared.kind !== 'ready') throw new Error('expected_ready_send');
            const result = await prepared.invocation.run();
            expect(wakeAdmissions, JSON.stringify(result)).toHaveLength(1);
            expect(result).toMatchObject({ ok: false, errorCode: 'native_resource_unavailable' });
        }
    } finally { await homes.dispose(); }
});

it('refuses a prepared Resume whose exact Home Session moved Machines before any native transport', async () => {
    let machineId = 'machine-a';
    const nativeRequests: unknown[] = [];
    const machines = ['machine-a', 'machine-b'].map(id => createPlainMachineRowFixture({ id, accountId: 'owner',
        machine: createMachineFixture({ id, presenceProtocolVersion: 1 }) }));
    const sessionBoundary = createSessionReadBatchHttpBoundary(async request => {
        if (request.path === '/v2/sessions/moving-session') return Response.json({
            session: createPlainSessionCurrentProjectionRecordFixture({ id: 'moving-session',
                metadata: { machineId, path: '/workspace', host: 'qa-host', flavor: 'claude', claudeSessionId: 'runtime' } }),
        });
        if (request.path === '/v1/sessions/moving-session/turns') {
            return Response.json({ v: 1, sessionId: 'moving-session', updatedAt: 1, turns: [] });
        }
        return undefined;
    });
    const homes = await serveAccountHomes({ homes: [{ key: 'a', serverUrl: 'https://moving-resume.test',
        serverIdentityId: 'srv_moving_resume', accountId: 'owner', currentAccount: true }], route: request => {
        if (request.path === '/v1/machines') return Response.json(machines);
        if (request.path === '/v1/machines/read-batch') return createMachineReadBatchResponseFixture(request.body,
            id => machines.find(machine => machine.id === id) ?? null);
        if (request.path.startsWith('/v1/machines/')) nativeRequests.push({ path: request.path, body: request.body });
        return sessionBoundary.handle(request);
    } });
    try {
        const prepared = await createDefaultActionExecutor().prepare('session.open', {
            sessionId: 'moving-session', intent: 'resume',
        }, { surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' },
            serverId: homes.homes.a!.id, expectedAccountId: 'owner', actionRequestId: 'original-resume',
            externalActionTarget: { kind: 'session', sessionId: 'moving-session' } });
        expect(prepared, JSON.stringify(prepared)).toMatchObject({ kind: 'ready' });
        if (prepared.kind !== 'ready') throw new Error('The original Resume must prepare');
        machineId = 'machine-b';
        const result = await prepared.invocation.run();
        expect(nativeRequests, JSON.stringify({ result, nativeRequests })).toEqual([]);
        expect(result, JSON.stringify({ result, nativeRequests, reads: sessionBoundary.componentRequests }))
            .toMatchObject({ ok: false, errorCode: 'machine_target_mismatch' });
    } finally { await homes.dispose(); }
});
