import * as React from 'react';
import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, flushHookEffects } from '@/dev/testkit';
import { DaemonMcpServersPreviewRequestSchema } from '@happier-dev/protocol/mcp/servers/previewV1';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { createRpcCallError } from '@happier-dev/protocol/rpcErrors';
import { SessionCurrentProjectionRecordV1Schema } from '@happier-dev/protocol/sessions/listing/response';
import { createSessionOwnerMetadataV1, createPlainSessionOwnerMetadataEnvelopeV1 } from '@happier-dev/protocol/sessions/metadata/sessionMetadataSchemasV1';
import { sealSessionOwnerMetadataEnvelopeV1 } from '@happier-dev/protocol/sessions/metadata/sessionMetadataEnvelopesV1';
import { createSessionAccessFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import type { SessionCapabilitySelectionV1 } from '@happier-dev/protocol/reach/sessionCapabilitySelectionV1';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { createSessionReadBatchFetchBoundary } from '@/dev/testkit/harness/sessionReadBatchHttpBoundary';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { createPromptLibraryCatalogBoundary } from '@/dev/testkit/harness/promptLibraryCatalogBoundary';
import { PROMPT_LIBRARY_ROWS_ROUTE_V1 } from '@happier-dev/protocol/prompts/library/promptLibraryRowsV1';
import { MCP_SERVER_CATALOG_ROWS_ROUTE_V1, McpServerCatalogV1Schema } from '@happier-dev/protocol/mcp/servers/serverRowsV1';
import { SpawnCapabilitiesPreviewOutputV1Schema } from '@happier-dev/protocol/actions/specs/sessionCapabilities';
import { EPHEMERAL_RUNNER_UNMATERIALIZED_MACHINE_ID_V1 } from '@happier-dev/protocol/ephemeralRunner/runnerMcpMaterial';

const homes = createHomeGovernanceHarness();
const httpBoundary = { ...homes, request: createSessionReadBatchFetchBoundary(homes.request) };
installHomeGovernanceBoundaries(httpBoundary);
installDisconnectedServerSocketBoundary();
// Assemble the invariant module graph outside per-test behavioral hooks; each
// beforeEach still disposes and restores the canonical Sync bridge after reset.
await loadSyncSingletonForTests();

const transport = vi.hoisted(() => vi.fn<(input: unknown) => Promise<unknown>>());
// The real RPC codec and all selection logic run beneath this network transport boundary.
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({ machineRpcWithServerScope: transport }));
let serverId: string;
const previewResponse = { ok: true, machinePlatform: 'posix', mcp: { strictMode: false, items: [], detected: [] },
    skills: { items: [], plan: { plan: 'none', items: [], nativeDisables: [], diagnostics: [] } },
    applyTiming: { mcp: { t: 'session_not_running' }, skills: { t: 'session_not_running' } } };
function isPreviewRequest(input: unknown): input is { payload: unknown } {
    return input !== null && typeof input === 'object' && 'method' in input && input.method === RPC_METHODS.DAEMON_MCP_SERVERS_PREVIEW && 'payload' in input;
}

describe('useNewSessionCapabilities', () => {
    beforeEach(async () => {
        await homes.reset();
        installHomeGovernanceBoundaries(httpBoundary);
        await loadSyncSingletonForTests();
        serverId = await homes.addHome({ name: 'Preview', serverUrl: 'https://capability-preview.test', accountId: 'preview-owner' });
        homes.answer(serverId, '/v1/account/encryption/currentness', { body: {
            mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1,
        } });
        transport.mockReset();
        transport.mockResolvedValue(previewResponse);
    });
    async function seedPortableCatalogs(enabled = true) {
        const { captureLazyActionAccountContext } = await import('@/sync/ops/actions/actionAccountContext');
        const account = await captureLazyActionAccountContext(serverId);
        let skillId: string;
        try {
            const created = await account.createArtifactDocument({ header: { v: 1, kind: 'prompt_bundle.v2', title: 'Review', bundleSchemaId: 'skills.skill_md_v1' },
                body: JSON.stringify({ v: 1, createdAtMs: 1, updatedAtMs: 1, entries: [{ path: 'SKILL.md', contentKind: 'utf8',
                    contentBase64: Buffer.from('---\nname: review\ndescription: Review changes\n---\nRead the changes.').toString('base64') }] }) });
            skillId = created.artifactId;
        } finally { account.dispose(); }
        const rules = createPromptLibraryCatalogBoundary({ records: [{ key: 'skill-rules', value: { v: 1, rules: [{
            id: 'review-everywhere', skillId, target: { t: 'allMachines' }, enabled, createdAt: 1, updatedAt: 1,
        }] } }] });
        homes.answer(serverId, PROMPT_LIBRARY_ROWS_ROUTE_V1, { select: async () => ({ body: await (await rules.handle(PROMPT_LIBRARY_ROWS_ROUTE_V1))!.json() }) });
        const catalog = McpServerCatalogV1Schema.parse({ v: 1, servers: [{ id: 'server-portable', name: 'portable',
            transport: 'stdio', stdio: { command: 'portable-mcp', args: [] }, env: {}, createdAt: 1, updatedAt: 1 }],
            bindings: [{ id: 'portable-everywhere', serverId: 'server-portable', target: { t: 'allMachines' }, enabled: true, createdAt: 1, updatedAt: 1 }] });
        homes.answer(serverId, MCP_SERVER_CATALOG_ROWS_ROUTE_V1, { body: { status: 'present', revision: 1, content: { t: 'plain', v: catalog } } });
        transport.mockClear();
        return skillId;
    }

    it('previews an ephemeral draft through the real Action and Account catalogs without inventing Machine delivery facts', async () => {
        const skillId = await seedPortableCatalogs();
        const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
        const receipt = await createDefaultActionExecutor().execute('sessions.spawn.capabilities.preview', {
            machineId: EPHEMERAL_RUNNER_UNMATERIALIZED_MACHINE_ID_V1, agentId: 'codex',
            capabilitySelection: { mcp: { forceExcludeServerIds: ['server-portable'] } },
        }, { serverId, surface: 'ui', authority: 'present_user' });
        const preview = SpawnCapabilitiesPreviewOutputV1Schema.parse(receipt.ok ? receipt.result : undefined);
        expect(preview).toMatchObject({ ok: true, machinePlatform: null,
            mcp: { strictMode: false, detected: [], items: [{ id: 'server-portable', selected: false, reason: 'session_removed',
                preview: { serverId: 'server-portable', selected: false, portability: 'portable' } }] },
            skills: { items: expect.arrayContaining([{ kind: 'skill', id: skillId, name: 'review', selected: true, reachEnabled: true, selectable: true,
                reason: 'rule_on', decidedBy: { ruleId: 'review-everywhere', target: 'allMachines', agentQualified: false }, sessionOverride: null }]),
                plan: { plan: 'none', items: [], nativeDisables: [], diagnostics: [] } },
            applyTiming: { mcp: { t: 'session_not_running' }, skills: { t: 'session_not_running' } } });
        expect(transport.mock.calls.some(([input]) => isPreviewRequest(input))).toBe(false);
    });

    it('demands a full temporary-computer draft preview and refreshes skill overrides through the same Action', async () => {
        const skillId = await seedPortableCatalogs();
        const { useNewSessionCapabilities } = await import('./useNewSessionCapabilities');
        const hook = await renderHook(() => {
            const [selection, setSelection] = React.useState<SessionCapabilitySelectionV1>({});
            return useNewSessionCapabilities({ machineId: null, directory: '/unobserved', agentId: 'codex',
                targetServerId: serverId, portableOnly: true, selection, setSelection });
        });
        expect(hook.getCurrent().previewStatus).toBe('idle');
        expect(hook.getCurrent().preview).toBeNull();
        await act(async () => { hook.getCurrent().demandPreview(); });
        await vi.waitFor(() => expect(hook.getCurrent().previewStatus, hook.getCurrent().error ?? '').toBe('ready'));
        expect(hook.getCurrent().preview?.skills.items.find(item => item.id === skillId)).toMatchObject({ selected: true, reason: 'rule_on' });
        expect(hook.getCurrent().mcpPreview?.managed).toEqual([expect.objectContaining({ serverId: 'server-portable', selected: true })]);
        await act(async () => { hook.getCurrent().setItem('skill', skillId, 'off'); });
        await vi.waitFor(() => expect(hook.getCurrent().preview?.skills.items.find(item => item.id === skillId))
            .toMatchObject({ selected: false, reason: 'session_removed', sessionOverride: 'removed' }));
        expect(hook.getCurrent().preview?.mcp.items[0]?.selected).toBe(true);
        expect(SpawnCapabilitiesPreviewOutputV1Schema.safeParse(hook.getCurrent().preview).success).toBe(true);
        expect(transport.mock.calls.some(([input]) => isPreviewRequest(input))).toBe(false);
    });
    it('rechecks the Account catalog on draft reopen and admits a newly created Off skill for this Session', async () => {
        await seedPortableCatalogs();
        const { useNewSessionCapabilities } = await import('./useNewSessionCapabilities');
        const hook = await renderHook(() => {
            const [selection, setSelection] = React.useState<SessionCapabilitySelectionV1>({});
            return useNewSessionCapabilities({ machineId: null, directory: '/repo', agentId: 'codex',
                targetServerId: serverId, portableOnly: true, selection, setSelection });
        });
        await act(async () => { hook.getCurrent().demandPreview(); });
        await vi.waitFor(() => expect(hook.getCurrent().previewStatus).toBe('ready'));
        const skillId = await seedPortableCatalogs(false);
        expect(hook.getCurrent().preview?.skills.items.some(item => item.id === skillId)).toBe(false);
        await act(async () => { hook.getCurrent().demandPreview(); });
        await vi.waitFor(() => expect(hook.getCurrent().preview?.skills.items.find(item => item.id === skillId))
            .toMatchObject({ selected: false, selectable: true, reason: 'rule_off' }));
        await act(async () => { hook.getCurrent().setItem('skill', skillId, 'on'); });
        await vi.waitFor(() => expect(hook.getCurrent().preview?.skills.items.find(item => item.id === skillId))
            .toMatchObject({ selected: true, selectable: true, reason: 'session_added', sessionOverride: 'added' }));
        expect(SpawnCapabilitiesPreviewOutputV1Schema.safeParse(hook.getCurrent().preview).success).toBe(true);
        expect(transport.mock.calls.some(([input]) => isPreviewRequest(input))).toBe(false);
    });

    it.each(['draft', 'session'] as const)('shares pending %s preview intent without suppressing refresh or reopen', async kind => {
        await seedPortableCatalogs();
        const sessionId = 'c123456789012345678901234';
        const metadata = { machineId: 'machine-1', path: '/repo', host: 'host', flavor: 'codex' };
        const owner = createSessionOwnerMetadataV1({ metadata });
        if (!owner.ok) throw new Error('Invalid owner metadata fixture');
        const row = SessionCurrentProjectionRecordV1Schema.parse({ id: sessionId, seq: 1, createdAt: 1, updatedAt: 1, active: false, activeAt: 1,
            encryptionMode: 'plain', metadataLayoutVersion: 1, metadata: JSON.stringify({ v: 1 }), metadataVersion: 1,
            ownerMetadata: createPlainSessionOwnerMetadataEnvelopeV1(owner.ownerMetadata), agentState: null, agentStateVersion: 1,
            dataEncryptionKey: null, share: null, responsibleAccountId: null, responsibleAccount: null,
            effectiveAccess: { v: 1, level: 'owner', sources: [{ kind: 'owner' }], capabilities: createSessionAccessFixture().capabilities } });
        for (const suffix of ['', '?accessProjectionVersion=1']) homes.answer(serverId, `GET /v2/sessions/${sessionId}${suffix}`, { body: { session: row } });
        let release!: () => void;
        const pending = new Promise<void>(resolve => { release = resolve; });
        let previews = 0;
        transport.mockImplementation(async input => {
            if (isPreviewRequest(input) && ++previews === 1) await pending;
            return previewResponse;
        });
        const { useNewSessionCapabilities } = await import('./useNewSessionCapabilities');
        const { useSessionCapabilities } = await import('./useSessionCapabilities');
        const hook = await renderHook(() => {
            const [selection, setSelection] = React.useState<SessionCapabilitySelectionV1>({});
            return kind === 'draft'
                ? useNewSessionCapabilities({ machineId: 'machine-1', directory: '/repo', agentId: 'codex', targetServerId: serverId, selection, setSelection })
                : useSessionCapabilities(sessionId, metadata, { serverId });
        });
        const ready = () => { const value = hook.getCurrent(); return 'previewStatus' in value ? value.previewStatus : value.status; };
        try {
            await act(async () => { hook.getCurrent().demandPreview(); });
            await vi.waitFor(() => expect(previews).toBe(1));
            // One interaction can produce hover, press-in and focus before its RPC settles.
            await act(async () => { hook.getCurrent().demandPreview(); hook.getCurrent().demandPreview(); hook.getCurrent().demandPreview(); });
            await flushHookEffects();
            expect(previews).toBe(1);
            // Multiple detail leaves can publish the same real input change.
            await act(async () => { await hook.getCurrent().refresh('facts-a'); await hook.getCurrent().refresh('facts-a'); });
            expect(previews).toBe(2);
            await act(async () => { await hook.getCurrent().refresh('facts-b'); });
            expect(previews).toBe(3);
            // Explicit Retry still refreshes even with the same current facts.
            await act(async () => { await hook.getCurrent().refresh(); });
            expect(previews).toBe(4);
            release();
            await vi.waitFor(() => expect(ready()).toBe('ready'));
            await act(async () => { hook.getCurrent().demandPreview(); });
            await vi.waitFor(() => expect(previews).toBe(kind === 'session' ? 4 : 5));
            await vi.waitFor(() => expect(ready()).toBe('ready'));
        } finally { release(); await hook.unmount(); }
    });

    it.each([true, false])('shares the Info read with the pane across unmount, including an empty selection (%s)', async enabled => {
        // Existing Sessions receive the Machine's resolved items; draft previews
        // separately resolve the Account catalog through their own Action.
        const sessionPreview = SpawnCapabilitiesPreviewOutputV1Schema.parse({ ...previewResponse, skills: { ...previewResponse.skills, items: [{
            kind: 'skill', id: 'review', name: 'review', selected: enabled, selectable: true,
            reason: enabled ? 'rule_on' : 'rule_off', decidedBy: null, sessionOverride: null,
        }] } });
        const sessionId = 'c123456789012345678901234';
        const metadata = { machineId: 'machine-1', path: '/repo', host: 'host', flavor: 'codex' };
        const owner = createSessionOwnerMetadataV1({ metadata });
        if (!owner.ok) throw new Error('Invalid owner metadata fixture');
        const row = SessionCurrentProjectionRecordV1Schema.parse({ id: sessionId, seq: 1, createdAt: 1, updatedAt: 1, active: false, activeAt: 1,
            encryptionMode: 'plain', metadataLayoutVersion: 1, metadata: JSON.stringify({ v: 1 }), metadataVersion: 1,
            ownerMetadata: createPlainSessionOwnerMetadataEnvelopeV1(owner.ownerMetadata), agentState: null, agentStateVersion: 1,
            dataEncryptionKey: null, share: null, responsibleAccountId: null, responsibleAccount: null,
            effectiveAccess: { v: 1, level: 'owner', sources: [{ kind: 'owner' }], capabilities: createSessionAccessFixture().capabilities } });
        for (const suffix of ['', '?accessProjectionVersion=1']) homes.answer(serverId, `GET /v2/sessions/${sessionId}${suffix}`, { body: { session: row } });
        let release!: () => void;
        const pending = new Promise<void>(resolve => { release = resolve; });
        let previews = 0;
        transport.mockImplementation(async input => {
            if (isPreviewRequest(input)) { previews++; await pending; }
            return sessionPreview;
        });
        const { useSessionSkillCount, useSessionCapabilities } = await import('./useSessionCapabilities');
        const info = await renderHook(() => useSessionSkillCount(sessionId, serverId));
        expect(info.getCurrent()).toBeNull();
        try {
            await vi.waitFor(() => expect(previews).toBe(1));
            // Navigate while the read is pending: the query belongs to the Session, not Info's mount.
            await info.unmount();
            const pane = await renderHook(() => useSessionCapabilities(sessionId, metadata, { serverId }));
            await act(async () => { pane.getCurrent().demandPreview(); });
            expect(previews).toBe(1);
            release();
            await vi.waitFor(() => expect(pane.getCurrent().status, pane.getCurrent().error ?? '').toBe('ready'));
            const reopenedInfo = await renderHook(() => useSessionSkillCount(sessionId, serverId));
            expect(reopenedInfo.getCurrent()).toBe(enabled ? 1 : 0);
            expect(pane.getCurrent().preview?.skills.items.filter(item => item.selected).length).toBe(reopenedInfo.getCurrent());
            expect(previews).toBe(1);
            transport.mockRejectedValue(createRpcCallError({ error: 'offline', errorCode: 'RPC_METHOD_NOT_AVAILABLE' }));
            await act(async () => { await pane.getCurrent().refresh(); });
            expect(pane.getCurrent().status).toBe('unavailable');
            expect(reopenedInfo.getCurrent()).toBeNull();
            transport.mockResolvedValue(sessionPreview);
            await act(async () => { await pane.getCurrent().refresh(); });
            expect(reopenedInfo.getCurrent()).toBe(enabled ? 1 : 0);
            await pane.unmount(); await reopenedInfo.unmount();
        } finally { release(); }
    });

    it('observes a host acknowledgment from metadata even while a demanded preview still says pending', async () => {
        const sessionId = 'c123456789012345678901234';
        const metadata = { machineId: 'machine-1', path: '/repo', host: 'host', flavor: 'codex',
            mcpSelectionV1: { v: 1 as const, managedServersEnabled: true, forceIncludeServerIds: ['server'], forceExcludeServerIds: [] },
            mcpSelectionRestartRequiredV1: { v: 1 as const, appliedSelection: { v: 1 as const, managedServersEnabled: true, forceIncludeServerIds: [], forceExcludeServerIds: [] } } };
        transport.mockResolvedValue(previewResponse);
        const owner = createSessionOwnerMetadataV1({ metadata });
        if (!owner.ok) throw new Error('Invalid metadata');
        const row = SessionCurrentProjectionRecordV1Schema.parse({ id: sessionId, seq: 1, createdAt: 1, updatedAt: 1, active: true, activeAt: 1,
            encryptionMode: 'plain', metadataLayoutVersion: 1, metadata: JSON.stringify({ v: 1 }), metadataVersion: 1,
            ownerMetadata: createPlainSessionOwnerMetadataEnvelopeV1(owner.ownerMetadata), agentState: null, agentStateVersion: 1,
            dataEncryptionKey: null, share: null, responsibleAccountId: null, responsibleAccount: null,
            effectiveAccess: { v: 1, level: 'owner', sources: [{ kind: 'owner' }], capabilities: createSessionAccessFixture().capabilities } });
        for (const suffix of ['', '?accessProjectionVersion=1']) homes.answer(serverId, `GET /v2/sessions/${sessionId}${suffix}`, { body: { session: row } });
        const { useSessionCapabilities } = await import('./useSessionCapabilities');
        const hook = await renderHook(() => {
            const [current, setCurrent] = React.useState<unknown>(metadata);
            return { ...useSessionCapabilities(sessionId, current, { serverId }), setCurrent };
        });
        await act(async () => { hook.getCurrent().demandPreview(); });
        await vi.waitFor(() => expect(hook.getCurrent().status).toBe('ready'));
        expect(hook.getCurrent().pendingApply.mcp).toBe(true);
        await act(async () => { const { mcpSelectionRestartRequiredV1: _marker, ...acknowledged } = metadata; hook.getCurrent().setCurrent(acknowledged); });
        expect(hook.getCurrent().pendingApply.mcp).toBe(false);
    });

    it('gets a stopped Session through its owned machine and reads pending apply from the exact metadata codec', async () => {
        const sessionId = 'c123456789012345678901234';
        const owner = createSessionOwnerMetadataV1({ metadata: { path: '/repo', host: 'host', machineId: 'machine-1', flavor: 'codex',
            mcpSelectionV1: { v: 1, managedServersEnabled: true, forceIncludeServerIds: ['server'], forceExcludeServerIds: [] },
            mcpSelectionRestartRequiredV1: { v: 1, appliedSelection: { v: 1, managedServersEnabled: true, forceIncludeServerIds: [], forceExcludeServerIds: [] } } } });
        if (!owner.ok) throw new Error('Invalid owner metadata fixture');
        const row = SessionCurrentProjectionRecordV1Schema.parse({ id: sessionId, seq: 1, createdAt: 1, updatedAt: 1, active: false, activeAt: 1,
            encryptionMode: 'plain', metadataLayoutVersion: 1, metadata: JSON.stringify({ v: 1 }), metadataVersion: 1,
            ownerMetadata: createPlainSessionOwnerMetadataEnvelopeV1(owner.ownerMetadata), agentState: null, agentStateVersion: 1,
            dataEncryptionKey: null, share: null, responsibleAccountId: null, responsibleAccount: null,
            effectiveAccess: { v: 1, level: 'owner', sources: [{ kind: 'owner' }], capabilities: createSessionAccessFixture().capabilities } });
        for (const suffix of ['', '?accessProjectionVersion=1']) homes.answer(serverId, `GET /v2/sessions/${sessionId}${suffix}`, { body: { session: row } });
        transport.mockImplementation(async input => {
            if (!isPreviewRequest(input)) return previewResponse;
            expect(input).toMatchObject({ machineId: 'machine-1', serverId, payload: { sessionId } });
            expect(DaemonMcpServersPreviewRequestSchema.safeParse(input.payload).success).toBe(true);
            return previewResponse;
        });
        const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
        const result = await createDefaultActionExecutor().execute('session.capabilities.get', { sessionId }, { serverId, surface: 'ui', authority: 'present_user' });
        expect(result, JSON.stringify({ result, calls: transport.mock.calls })).toMatchObject({ ok: true, result: { ok: true, pendingApply: { mcp: true, skills: false }, mcp: { items: [] } } });
    });

    it.each(['invalid_request', 'unreachable'] as const)('projects %s from the genuine preview transport to the strict Action failure', async failure => {
        transport.mockImplementation(async input => {
            if (!isPreviewRequest(input)) return previewResponse;
            if (failure === 'invalid_request') return { ok: false, errorCode: 'invalid_request', error: 'invalid input' };
            throw Object.assign(new Error('offline'), { code: 'machine_offline' });
        });
        const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
        const result = await createDefaultActionExecutor().execute('sessions.spawn.capabilities.preview', {
            machineId: 'machine-1', agentId: 'codex', directory: '/repo',
        }, { serverId, surface: 'ui', authority: 'present_user' });
        expect(result).toMatchObject({ ok: true, result: { ok: false, reason: failure === 'unreachable' ? 'machine_unreachable' : 'invalid_input' } });
    });

    it.each(['throw', 'result'] as const)('preserves missing-method truth and retry through the real preview Action (%s)', async carrier => {
        const { useNewSessionCapabilities } = await import('./useNewSessionCapabilities');
        const hook = await renderHook(() => {
            const [selection, setSelection] = React.useState<SessionCapabilitySelectionV1>({});
            return useNewSessionCapabilities({ machineId: 'machine-1', directory: '/repo', agentId: 'codex',
                targetServerId: serverId, selection, setSelection });
        });
        const fail = (errorCode: string) => {
            const error = { error: 'Preview method unavailable', errorCode };
            transport.mockImplementation(async input => {
                if (!isPreviewRequest(input)) return previewResponse;
                if (carrier === 'throw') throw createRpcCallError(error);
                return error;
            });
        };
        fail('RPC_METHOD_NOT_AVAILABLE');
        await act(async () => { hook.getCurrent().demandPreview(); await flushHookEffects(); });
        expect(hook.getCurrent()).toMatchObject({ previewStatus: 'error', unsupported: false, error: 'RPC_METHOD_NOT_AVAILABLE' });
        fail('RPC_METHOD_NOT_FOUND');
        await act(async () => hook.getCurrent().refresh());
        expect(hook.getCurrent()).toMatchObject({ previewStatus: 'error', unsupported: true });
        transport.mockResolvedValue(previewResponse);
        await act(async () => hook.getCurrent().refresh());
        expect(hook.getCurrent()).toMatchObject({ previewStatus: 'ready', unsupported: false, error: null });
    });

    it('rejects a malformed RPC success discriminator rather than laundering it into an Action success', async () => {
        transport.mockResolvedValue({ ...previewResponse, ok: 'true' });
        const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
        expect(await createDefaultActionExecutor().execute('sessions.spawn.capabilities.preview', { machineId: 'machine-1', agentId: 'codex' },
            { serverId, surface: 'ui', authority: 'present_user' }))
            .toMatchObject({ ok: true, result: { ok: false, reason: 'invalid_input' } });
    });

    it.each(['missing', 'unreadable', 'home_failure', 'ambiguous404'] as const)('refuses %s Session snapshots with a typed get/set result before mutation', async availability => {
        const sessionId = 'c123456789012345678901234';
        const row = SessionCurrentProjectionRecordV1Schema.parse({ id: sessionId, seq: 1, createdAt: 1, updatedAt: 1, active: false, activeAt: 1,
            encryptionMode: 'e2ee', metadataLayoutVersion: 1, metadata: 'unavailable-shared-ciphertext', metadataVersion: 1,
            ownerMetadata: sealSessionOwnerMetadataEnvelopeV1({ ownerMetadata: { v: 1 }, material: { type: 'legacy', secret: new Uint8Array(32).fill(7) },
                randomBytes: size => new Uint8Array(size).fill(5) }),
            agentState: null, agentStateVersion: 1, dataEncryptionKey: null, share: null,
            responsibleAccountId: null, responsibleAccount: null,
            effectiveAccess: { v: 1, level: 'owner', sources: [{ kind: 'owner' }], capabilities: createSessionAccessFixture().capabilities } });
        for (const suffix of ['', '?accessProjectionVersion=1']) homes.answer(serverId, `GET /v2/sessions/${sessionId}${suffix}`,
            availability === 'unreadable' ? { body: { session: row } } : { status: availability === 'missing' || availability === 'ambiguous404' ? 404 : 503,
                body: availability === 'missing' ? { error: 'Session not found' } : {} });
        const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
        const executor = createDefaultActionExecutor();
        const context = { serverId, surface: 'ui' as const, authority: 'present_user' as const };
        const code = availability === 'missing' ? 'not_found' : 'session_unavailable';
        expect(await executor.execute('session.capabilities.get', { sessionId }, context)).toMatchObject({ ok: true, result: { ok: false, code } });
        expect(await executor.execute('session.capabilities.set', { sessionId, kind: 'native_skill', id: 'lint', state: 'off' }, context))
            .toMatchObject({ ok: true, result: { ok: false, code } });
        expect(homes.requests.some(request => request.path.includes('/sessions/') && request.input !== null)).toBe(false);
        expect(transport.mock.calls.some(([input]) => isPreviewRequest(input))).toBe(false);
    });

    it('updates a draft optimistically without losing the other capability kind and previews only on demand', async () => {
        const { useNewSessionCapabilities } = await import('./useNewSessionCapabilities');
        const hook = await renderHook(() => {
            const [selection, setSelection] = React.useState<SessionCapabilitySelectionV1>({
                mcp: { v: 1, managedServersEnabled: true, forceIncludeServerIds: ['server-a'], forceExcludeServerIds: [] },
            });
            return useNewSessionCapabilities({ machineId: 'machine-1', directory: '/repo', agentId: 'codex', enabled: true, selection, setSelection });
        });
        expect(transport).not.toHaveBeenCalled();
        await act(async () => hook.getCurrent().setItem('skill', 'skill-a', 'on'));
        expect(hook.getCurrent().selection).toMatchObject({ mcp: { forceIncludeServerIds: ['server-a'] }, skills: { forceIncludeSkillIds: ['skill-a'] } });
        const unchanged = hook.getCurrent().selection;
        await act(async () => hook.getCurrent().setItem('skill', 'skill-a', 'on'));
        expect(hook.getCurrent().selection).toBe(unchanged);
        expect(hook.getCurrent().previewStatus).toBe('idle');
        await act(async () => { hook.getCurrent().demandPreview(); await flushHookEffects(); });
        expect(hook.getCurrent().previewStatus, JSON.stringify({ error: hook.getCurrent().error, calls: transport.mock.calls })).toBe('ready');
        expect(transport).toHaveBeenCalledWith(expect.objectContaining({ payload: expect.objectContaining({
            capabilitySelection: expect.objectContaining({ mcp: { v: 1, managedServersEnabled: true, forceIncludeServerIds: ['server-a'], forceExcludeServerIds: [] },
                skills: expect.objectContaining({ forceIncludeSkillIds: ['skill-a'] }) }),
        }) }));
        expect(hook.getCurrent().lastKnownPreview).toMatchObject({ ok: true, mcp: { items: [], detected: [] }, skills: { items: [] } });
        transport.mockRejectedValueOnce(Object.assign(new Error('Machine offline'), { code: 'machine_offline' }));
        await act(async () => hook.getCurrent().refresh());
        expect(hook.getCurrent().previewStatus).toBe('unreachable');
        expect(hook.getCurrent().lastKnownPreview).toMatchObject({ ok: true, mcp: { items: [] } });
        transport.mockRejectedValueOnce(createRpcCallError({ error: 'Method not found', errorCode: 'RPC_METHOD_NOT_AVAILABLE' }));
        await act(async () => hook.getCurrent().refresh());
        expect(hook.getCurrent().previewStatus).toBe('error');
        expect(hook.getCurrent().lastKnownPreview).not.toBeNull();
    });
});
