import { afterEach, describe, expect, it, vi } from 'vitest';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION,
    createActionExecutor, ArtifactActionOutputSchemasV1, decodePlainArtifactStoredContent, encodePlainArtifactStoredContent, withArtifactExcerptV1,
    ActionsSettingsV1Schema, isApprovalRequiredByActionsSettings, normalizeActionsSettingsV1, type ActionExecutorContext } from '@happier-dev/protocol';
import { TokenStorage } from '@/auth/storage/tokenStorage';
import * as credentialStorage from '@/auth/storage/tokenStorage';
import { decodeBase64, encodeBase64 } from '@/encryption/base64';
import { upsertAndActivateServer } from '@/sync/domains/server/serverRuntime';
import type { Artifact, ArtifactCreateRequest, ArtifactUpdateRequest } from '@/sync/domains/artifacts/artifactTypes';
import { ArtifactEncryption } from '@/sync/encryption/artifactEncryption';
import { openArtifactPrivateRevisionMetadata } from '@/sync/domains/artifacts/accountArtifactEnvelope';
import { ARTIFACT_UPLOAD_PATH_V1, decodeArtifactUploadMetadataV1 } from '@happier-dev/transfers';
import { captureLazyActionAccountContext } from './actionAccountContext';
import { createUiArtifactAction } from './artifactActionDeps';
import { createFrontDoorActionExecute } from './frontDoorRuntimeActionExecutor';
import { storage } from '@/sync/domains/state/storage';
import { createSessionAccessFixture, createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { createActionExecutorBoundaryFixture } from '@/dev/testkit/fixtures/actionExecutorBoundary';
import { createSettingsDeclarationAction } from './settingsDeclarationAction';
import { readSettingsPageGate } from '@/components/settings/catalog/pageCatalog';
import { SettingsDeclarationActionOutputSchemasV1 } from '@happier-dev/protocol/actions/settingsDeclarationActionFamily';
import { normalizeUsageQuery } from '@happier-dev/protocol/inputs/usageQuery';
import { UsageCoachReversalSchema } from '@happier-dev/protocol/usage/coach/coachActions';
import { UsageCoachPreferencesV1Schema } from '@happier-dev/protocol/account/settings/usageCoachPreferencesV1';
import { createUiUsageActionPorts } from './usageActionDeps';
import { UsageQueryBatchResultSchema } from '@happier-dev/protocol/usage/resolveUsagePageAggregation';
import { createUiMcpServerActionExecuteV1 } from './mcpServerActionDeps';
import { MCP_SERVER_CATALOG_ROWS_ROUTE_V1, McpServerCatalogRowMutationV1Schema, McpServerCatalogV1Schema } from '@happier-dev/protocol/mcp/servers/serverRowsV1';
import { UsageCoachApplyResultSchema } from '@happier-dev/protocol/usage/coach/coachActions';

// HTTP, device credential storage and the native theme runtime are substituted boundaries.
const runtimeFetch = vi.hoisted(() => vi.fn());
vi.mock('@/utils/system/runtimeFetch', () => ({ runtimeFetch: (...args: unknown[]) => runtimeFetch(...args) }));
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});
vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock();
});
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
afterEach(() => { runtimeFetch.mockReset(); vi.restoreAllMocks(); });

describe('scoped Account workflow Artifact operations', () => {
    it('queries retained unused MCP evidence, conditionally applies, exactly undoes and refuses an intervening binding edit', async () => {
        const previous = storage.getState();
        const home = await upsertAndActivateServer({ serverUrl: 'https://coach-binding.test', scope: 'tab' });
        const token = `header.${encodeBase64(new TextEncoder().encode(JSON.stringify({ sub: 'coach-account' })), 'base64url')}.signature`;
        vi.spyOn(TokenStorage, 'getCredentialsForServerUrl').mockResolvedValue({ token });
        const actionsSettings = ActionsSettingsV1Schema.parse({ v: 1, approvalWaivedSurfaces: {
            'usage.coach.apply': ['ui'], 'usage.coach.undo': ['ui'], 'mcp.bindings.disable': ['ui'], 'mcp.bindings.enable': ['ui'],
        } });
        let catalog = McpServerCatalogV1Schema.parse({ v: 1,
            servers: [{ id: 'server', name: 'unused', transport: 'stdio', stdio: { command: 'fixture-mcp', args: [] }, env: {}, createdAt: 1, updatedAt: 10 }],
            bindings: [{ id: 'binding', serverId: 'server', enabled: true, target: { t: 'machine', machineId: 'machine' }, createdAt: 1, updatedAt: 20 }],
        });
        let revision = 3;
        let witnessedRevision = 3;
        let witnessSequence = 1;
        let calls = 0;
        let coverage: 'complete' | 'partial' = 'complete';
        runtimeFetch.mockImplementation(async (url: unknown, init?: RequestInit) => {
            const path = new URL(String(url)).pathname;
            if (path === '/health' || path === '/v1/auth/ping') return json({});
            if (path === '/v1/features') return json({ features: {}, capabilities: { accountStoredContentCompatibility: {
                v: 1, minimumProtocolVersion: CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION,
                currentProtocolVersion: CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION, declarationTransport: 'http-header-and-socket-auth-v1',
            } } });
            if (path === '/v1/account/encryption') return json({ mode: 'plain', updatedAt: 0 });
            if (path === '/v1/account/encryption/currentness') return json({ mode: 'plain', version: 1,
                signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 });
            if (path === '/v2/account/settings') return json({ content: { t: 'plain', v: { actionsSettingsV1: actionsSettings } }, version: 1 });
            if (path === '/v2/usage/query') return json({ v: 1, totals: { eventCount: 0,
                tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
                cost: { reportedUsd: 0, estimatedUsd: 0, currency: 'USD' } } });
            if (path === MCP_SERVER_CATALOG_ROWS_ROUTE_V1) {
                if (init?.method !== 'POST') return json({ status: 'present', revision, content: { t: 'plain', v: catalog } });
                const mutation = McpServerCatalogRowMutationV1Schema.parse(JSON.parse(String(init.body)));
                if (mutation.expectedRevision !== revision) return json({ status: 'conflict', revision });
                if (mutation.content?.t !== 'plain') throw new Error('Expected exact plain catalog mutation');
                catalog = mutation.content.v;
                revision += 1;
                return json({ status: 'updated', revision, cursor: revision });
            }
            if (path === '/v2/sessions/coach-session') return json({ session: {
                id: 'coach-session', createdAt: 1, updatedAt: 900, seq: 1, active: true, activeAt: 900,
                encryptionMode: 'plain', dataEncryptionKey: null, metadataLayoutVersion: 0,
                effectiveAccess: { v: 1, level: 'owner', sources: [{ kind: 'owner' }], capabilities: createSessionAccessFixture().capabilities },
                responsibleAccountId: null, responsibleAccount: null,
                metadataVersion: 1, metadata: JSON.stringify({ path: '/workspace/project', machineId: 'machine', agent: 'claude',
                    agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.claude', localId: 'claude' } } }),
                agentStateVersion: 1, agentState: null, share: null,
            } });
            if (path === '/v1/sessions/coach-session/messages') {
                const usage = { v: 1, evidenceId: `mcp-window-${witnessSequence}`, sessionId: 'coach-session', turnId: `turn-${witnessSequence}`, observedAtMs: 300 + witnessSequence,
                    window: { startMs: 200 + witnessSequence, endMs: 300 + witnessSequence }, coverage, bindings: [{ serverId: 'server', bindingId: 'binding', catalogRevision: witnessedRevision,
                        bindingRevision: 20, serverRevision: 10, toolCallCount: calls, schemaBytes: null }] };
                return json({ messages: [{ id: 'usage-row', seq: 1, localId: null, createdAt: 300,
                    content: { t: 'plain', v: { role: 'agent', content: { type: 'event', id: 'mcp-event', data: { type: 'mcp-binding-usage', usage } } } } }], hasMore: false });
            }
            return json({ error: 'unexpected' }, 404);
        });
        storage.setState({ settingsScope: { serverId: home.id, accountId: 'coach-account' }, settingsVersion: 1 });
        const account = await captureLazyActionAccountContext(home.id);
        try {
            const executor = createActionExecutor(createActionExecutorBoundaryFixture({
                usageActions: createUiUsageActionPorts(account), mcpServerAction: createUiMcpServerActionExecuteV1(account),
                isActionApprovalRequired: (id, context, input) => isApprovalRequiredByActionsSettings(id,
                    context.actionsSettings ?? ActionsSettingsV1Schema.parse({ v: 1 }), context, undefined, undefined, input),
            }));
            const context = { surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' }, actionsSettings } as const;
            const query = normalizeUsageQuery({ period: { startMs: 0, endMs: 1000 }, session: 'coach-session', timeZoneOffsetMinutes: 0 });
            const find = async () => {
                const result = await executor.execute('usage.query', { queries: [query] }, context);
                const batch = UsageQueryBatchResultSchema.parse(result.ok ? result.result : undefined);
                return batch.results[0]!.coach!.findings.find(row => row.detectorId === 'mcp_overhead');
            };
            let finding = await find();
            expect(finding).toMatchObject({ remedy: { kind: 'mcp_binding', bindingId: 'binding', enabled: false, expectedRevision: 3 } });
            if (!finding) throw new Error('Expected witnessed unused binding finding from retained HTTP evidence');
            const refused = await executor.execute('usage.coach.apply', { query, evidenceKey: finding.evidenceKey }, {
                ...context, actionsSettings: ActionsSettingsV1Schema.parse({ v: 1 }),
            });
            expect(refused).toMatchObject({ ok: false, errorCode: 'approvals_not_supported' });
            expect(catalog.bindings[0]!.enabled).toBe(true);
            const apply = async (evidenceKey: string) => {
                const result = await executor.execute('usage.coach.apply', { query, evidenceKey }, context);
                expect(result.ok, JSON.stringify(result)).toBe(true);
                const receipt = UsageCoachApplyResultSchema.parse(result.ok ? result.result : undefined);
                if (!receipt.reversal) throw new Error('Expected exact MCP owner reversal');
                return receipt.reversal;
            };
            const reversal = await apply(finding.evidenceKey);
            expect(catalog.bindings[0]!.enabled).toBe(false);
            expect(reversal).toMatchObject({ kind: 'mcp_binding', owner: { bindingId: 'binding', before: true, applied: false, revision: 4 } });
            // A successful remedy can remove its current proposal; its owner receipt still admits Undo.
            expect((await find())?.remedy ?? null).toBeNull();
            expect(await executor.execute('usage.coach.undo', { query, evidenceKey: finding.evidenceKey, reversal }, context))
                .toMatchObject({ ok: true, result: { kind: 'undone' } });
            expect(catalog.bindings[0]!.enabled).toBe(true);
            // A new successful native window witnesses the configuration after Undo.
            witnessedRevision = revision;
            witnessSequence += 1;
            finding = await find();
            if (!finding) throw new Error('Expected fresh binding witness after Undo');
            const staleReversal = await apply(finding.evidenceKey);
            expect(await executor.execute('mcp.bindings.enable', { bindingId: 'binding' }, context)).toMatchObject({ ok: true, result: { status: 'updated' } });
            const edited = JSON.stringify(catalog);
            expect(await executor.execute('usage.coach.undo', { query, evidenceKey: finding.evidenceKey, reversal: staleReversal }, context))
                .toMatchObject({ ok: false, errorCode: 'coach_owner_refused', details: { status: 'conflict' } });
            expect(JSON.stringify(catalog)).toBe(edited);
            calls = 1;
            expect(await find()).toBeUndefined();
            calls = 0;
            coverage = 'partial';
            expect(await find()).toBeUndefined();
            coverage = 'complete';
            catalog = { ...catalog, servers: catalog.servers.map(server => ({ ...server, updatedAt: 11 })) };
            revision += 1;
            expect((await find())?.remedy ?? null).toBeNull();
        } finally { account.dispose(); storage.setState(previous); }
    });
    it.each([
        { scenario: 'owner', name: 'captures a setting at the committed CAS winner and restores its historical unset state, refusing intervening edits' },
        { scenario: 'coach', name: 'public Coach Undo re-queries actual Account HTTP and restores a real setting receipt, refusing intervening edits' },
        { scenario: 'coachPreferences', name: 'public Coach dismiss and snooze use retained Session composition HTTP and conditional Account preferences' },
        { scenario: 'scope', name: 'refuses a retained setting receipt in another Home and Account with the same settings version' },
        { scenario: 'history', name: 'restores exact captured unset state when Account settings history is disabled' },
        { scenario: 'preferences', name: 'updates declared Coach preferences with exact Account revision CAS' },
        { scenario: 'unset', name: 'preserves visible unset when restoring a scalar with no default' },
    ])('$name', async ({ scenario }) => {
        const previous = storage.getState();
        const home = await upsertAndActivateServer({ serverUrl: 'https://settings-reversal.test', scope: 'tab' });
        const token = `header.${encodeBase64(new TextEncoder().encode(JSON.stringify({ sub: 'settings-account' })), 'base64url')}.signature`;
        vi.spyOn(TokenStorage, 'getCredentialsForServerUrl').mockResolvedValue({ token });
        let raw: Record<string, unknown> = { futureSibling: { retained: true } };
        if (scenario === 'coach' || scenario === 'coachPreferences') raw.actionsSettingsV1 = ActionsSettingsV1Schema.parse({ v: 1,
            approvalWaivedSurfaces: { 'usage.coach.apply': ['ui'], 'usage.coach.undo': ['ui'], 'usage.coach.dismiss': ['ui'],
                'usage.coach.snooze': ['ui'], 'settings.set': ['ui'] } });
        if (scenario === 'coach' || scenario === 'coachPreferences') raw.usageCoachPreferencesV1 = {
            v: 1, digestCadence: 'weekly', suppressions: [{ kind: 'dismissed', evidenceKey: 'another-finding' }],
        };
        let version = 4;
        let race = true;
        let retainHistory = true;
        const history = new Map<number, Record<string, unknown>>();
        runtimeFetch.mockImplementation(async (url: unknown, init?: RequestInit) => {
            const path = new URL(String(url)).pathname;
            if (path === '/health' || path === '/v1/auth/ping') return json({});
            if (path === '/v1/features') return json({ features: {}, capabilities: { accountStoredContentCompatibility: {
                v: 1, minimumProtocolVersion: CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION,
                currentProtocolVersion: CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION, declarationTransport: 'http-header-and-socket-auth-v1',
            } } });
            if (path === '/v1/account/encryption') return json({ mode: 'plain', updatedAt: 0 });
            if (path === '/v1/account/encryption/currentness') return json({ mode: 'plain', version: 1,
                signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 });
            if (path === '/v2/usage/query') return json({ v: 1, totals: { eventCount: 0,
                tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
                cost: { reportedUsd: 0, estimatedUsd: 0, currency: 'USD' } } });
            if (path === '/v2/sessions/coach-session') return json({ session: {
                id: 'coach-session', createdAt: 1, updatedAt: 900, seq: 1, active: true, activeAt: 900,
                encryptionMode: 'plain', dataEncryptionKey: null, metadataLayoutVersion: 0,
                effectiveAccess: { v: 1, level: 'owner', sources: [{ kind: 'owner' }], capabilities: createSessionAccessFixture().capabilities },
                responsibleAccountId: null, responsibleAccount: null,
                metadataVersion: 1, metadata: JSON.stringify({ path: '/workspace/project', machineId: 'machine', agent: 'codex',
                    agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } } }),
                agentStateVersion: 1, agentState: null, share: null,
            } });
            if (path === '/v1/sessions/coach-session/messages') {
                // This retained host event is an HTTP fixture, not model-native evidence or a prebuilt Coach evaluation.
                const composition = { v: 1, evidenceId: 'composition', sessionId: 'coach-session', turnId: 'turn', inputId: 'input',
                    observedAtMs: 300, boundary: 'host_pre_dispatch', deliveryKind: 'newTurn', coverage: 'host_only',
                    components: ['a', 'c'].map(source => ({ sourceId: source.repeat(64), digest: 'b'.repeat(64), kind: 'instructions',
                        location: 'user', byteLength: 200, tokenCount: null, tokenizerId: null, cacheClass: 'unknown', overlap: 'none' })),
                    nativePrefix: null, contextWindowTokens: null };
                const admitsEvents = new URL(String(url)).searchParams.get('roles')?.split(',').includes('event');
                return json({ messages: admitsEvents ? [{ id: 'composition-row', seq: 1, localId: null, createdAt: 300,
                    content: { t: 'plain', v: { role: 'agent', content: { type: 'event', id: 'composition-event',
                        data: { type: 'prompt-composition', composition } } } } }] : [], hasMore: false });
            }
            if (path.startsWith('/v2/account/settings/history/')) {
                const snapshotVersion = Number(path.split('/').at(-1));
                const snapshot = history.get(snapshotVersion);
                return snapshot ? json({ version: snapshotVersion, content: { t: 'plain', v: snapshot }, createdAt: '2026-10-09T00:00:00.000Z' }) : json({}, 404);
            }
            if (path === '/v2/account/settings') {
                if (init?.method !== 'POST') return json({ content: { t: 'plain', v: raw }, version });
                const write = JSON.parse(String(init.body)) as { expectedVersion: number; content: { t: string; v: Record<string, unknown> } };
                if (race) { race = false; raw = { ...raw, futureSibling: { retained: 'winner' } }; ++version; }
                if (write.expectedVersion !== version) return json({ success: false, error: 'version-mismatch', currentVersion: version,
                    currentContent: { t: 'plain', v: raw } });
                if (retainHistory) history.set(version, raw);
                raw = write.content.v;
                ++version;
                if (retainHistory) history.set(version, raw);
                return json({ success: true, version });
            }
            return json({ error: 'unexpected' }, 404);
        });
        storage.setState({ settingsScope: { serverId: home.id, accountId: 'settings-account' }, settingsVersion: 4 });
        const account = await captureLazyActionAccountContext(home.id);
        const createAction = (captured: typeof account) => createSettingsDeclarationAction({ host: { os: 'web', desktop: false }, tauriDesktop: false,
            readPageGate: readSettingsPageGate, isFeatureEnabled: async () => true, isCurrent: captured.accountLifetime.isCurrent,
            readAccountSettings: captured.readSettings,
            accountScope: captured.accountLifetime.scope,
            readAccountSettingsSnapshot: captured.readRawSettingsSnapshot,
            writeAccountSettings: async delta => { await captured.mutateRawSettings(current => ({ ...current, ...delta })); },
            mutateAccountSettings: captured.mutateRawSettings,
            readLocalSettings: () => storage.getState().localSettings, writeLocalSettings: () => { throw new Error('unexpected local write'); },
        });
        const action = createAction(account);
        try {
            if (scenario === 'unset') {
                const anchor = 'sourceControl.includeCoAuthoredBy';
                expect.soft(await action({ actionId: 'settings.get', input: { anchor, includeVersion: true } }))
                    .toEqual({ anchor, unset: true, settingsVersion: 4 });
                const applied = SettingsDeclarationActionOutputSchemasV1['settings.set'].parse(await action({ actionId: 'settings.set',
                    input: { anchor, value: true, reversal: { kind: 'capture' } } }));
                expect(applied).toMatchObject({ reversal: { before: { unset: true }, applied: { value: true } } });
                const restored = await action({ actionId: 'settings.set', input: { anchor, value: false,
                    reversal: { kind: 'restore', ...applied.reversal } } });
                expect.soft(restored).toEqual({ anchor, unset: true });
                expect(SettingsDeclarationActionOutputSchemasV1['settings.set'].safeParse(restored).success).toBe(true);
                expect(Object.hasOwn(raw, 'scmIncludeCoAuthoredBy')).toBe(false);
                return;
            }
            if (scenario === 'preferences') {
                expect(await action({ actionId: 'settings.get', input: { anchor: 'usage.coachPreferences', includeVersion: true } }))
                    .toEqual({ anchor: 'usage.coachPreferences', value: { v: 1, suppressions: [] }, settingsVersion: 4 });
                const value = { v: 1, suppressions: [{ kind: 'dismissed', evidenceKey: 'finding' }] };
                race = false;
                expect(await action({ actionId: 'settings.set', input: { anchor: 'usage.coachPreferences', value, expectedSettingsVersion: 4 } }))
                    .toEqual({ anchor: 'usage.coachPreferences', value, settingsVersion: 5 });
                expect(raw).toEqual({ futureSibling: { retained: true }, usageCoachPreferencesV1: value });
                expect(await action({ actionId: 'settings.set', input: { anchor: 'usage.coachPreferences',
                    value: { ...value, suppressions: [] }, expectedSettingsVersion: 4 } }))
                    .toMatchObject({ ok: false, errorCode: 'account_settings_mutation_conflict' });
                expect(raw.usageCoachPreferencesV1).toEqual(value);
                return;
            }
            if (scenario === 'history') {
                retainHistory = false;
                const applied = SettingsDeclarationActionOutputSchemasV1['settings.set'].parse(await action({ actionId: 'settings.set',
                    input: { anchor: 'sourceControl.showLineNumbersInDiffs', value: false, reversal: { kind: 'capture' } } }));
                expect(applied).toMatchObject({ reversal: { beforeVersion: 5, appliedVersion: 6, before: { unset: true }, applied: { value: false } } });
                expect(history.size).toBe(0);
                expect(await action({ actionId: 'settings.set', input: { anchor: applied.anchor, value: 'ignored caller value',
                    reversal: { kind: 'restore', ...applied.reversal } } })).toMatchObject({ anchor: applied.anchor, value: true });
                expect(raw).toEqual({ futureSibling: { retained: 'winner' } });
                const inverted = SettingsDeclarationActionOutputSchemasV1['settings.set'].parse(await action({ actionId: 'settings.set',
                    input: { anchor: 'account.analytics', value: false, reversal: { kind: 'capture' } } }));
                expect(inverted).toMatchObject({ value: false, reversal: { before: { unset: true }, applied: { value: true } } });
                expect(raw.analyticsOptOut).toBe(true);
                expect(await action({ actionId: 'settings.set', input: { anchor: inverted.anchor, value: false,
                    reversal: { kind: 'restore', ...inverted.reversal } } })).toMatchObject({ anchor: inverted.anchor, value: true });
                expect(raw).toEqual({ futureSibling: { retained: 'winner' } });
                return;
            }
            if (scenario === 'scope') {
                const applied = SettingsDeclarationActionOutputSchemasV1['settings.set'].parse(await action({ actionId: 'settings.set',
                    input: { anchor: 'sourceControl.showLineNumbersInDiffs', value: false, reversal: { kind: 'capture' } } }));
                if (!applied.reversal) throw new Error('Missing owner reversal');
                const otherHome = await upsertAndActivateServer({ serverUrl: 'https://settings-other-home.test', scope: 'tab' });
                const otherToken = `header.${encodeBase64(new TextEncoder().encode(JSON.stringify({ sub: 'other-account' })), 'base64url')}.signature`;
                vi.spyOn(TokenStorage, 'getCredentialsForServerUrl').mockResolvedValue({ token: otherToken });
                storage.setState({ settingsScope: { serverId: otherHome.id, accountId: 'other-account' }, settingsVersion: version });
                const otherAccount = await captureLazyActionAccountContext(otherHome.id);
                try {
                    expect(await createAction(otherAccount)({ actionId: 'settings.set', input: { anchor: applied.anchor, value: true,
                    reversal: { kind: 'restore', ...applied.reversal } } }))
                        .toMatchObject({ ok: false, errorCode: 'setting_reversal_scope_mismatch' });
                    expect(version).toBe(6);
                    expect(raw.showLineNumbers).toBe(false);
                } finally { otherAccount.dispose(); }
                return;
            }
            if (scenario === 'owner') {
            const applied = await action({ actionId: 'settings.set', input: { anchor: 'sourceControl.showLineNumbersInDiffs', value: false, reversal: { kind: 'capture' } } });
            const firstReceipt = SettingsDeclarationActionOutputSchemasV1['settings.set'].parse(applied);
            expect(firstReceipt).toEqual({
                anchor: 'sourceControl.showLineNumbersInDiffs', value: false, reversal: { beforeVersion: 5, appliedVersion: 6,
                    scope: { serverId: home.id, accountId: 'settings-account' },
                    before: { unset: true }, applied: { value: false } },
            });
            for (const scope of [{ serverId: 'another-home', accountId: 'settings-account' }, { serverId: home.id, accountId: 'another-account' }]) {
                expect(await action({ actionId: 'settings.set', input: { anchor: 'sourceControl.showLineNumbersInDiffs', value: true,
                    reversal: { kind: 'restore', ...firstReceipt.reversal, scope } } }))
                    .toMatchObject({ ok: false, errorCode: 'setting_reversal_scope_mismatch' });
                expect(version).toBe(6);
                expect(raw.showLineNumbers).toBe(false);
            }
            expect(raw).toEqual({ futureSibling: { retained: 'winner' }, showLineNumbers: false });
            const restore = () => action({ actionId: 'settings.set', input: { anchor: 'sourceControl.showLineNumbersInDiffs', value: 'forged restore',
                reversal: { kind: 'restore', ...firstReceipt.reversal } } });
            expect(await restore()).toMatchObject({ anchor: 'sourceControl.showLineNumbersInDiffs', value: true });
            expect(raw).toEqual({ futureSibling: { retained: 'winner' } });
            expect(await restore()).toMatchObject({ ok: false, errorCode: 'account_settings_mutation_conflict' });
            expect(raw).toEqual({ futureSibling: { retained: 'winner' } });
            expect(await action({ actionId: 'settings.get', input: { anchor: 'sourceControl.showLineNumbersInDiffs', includeVersion: true } }))
                .toEqual({ anchor: 'sourceControl.showLineNumbersInDiffs', value: true, settingsVersion: 7 });
            expect(await action({ actionId: 'settings.set', input: { anchor: 'sourceControl.showLineNumbersInDiffs', value: false, expectedSettingsVersion: 7 } }))
                .toEqual({ anchor: 'sourceControl.showLineNumbersInDiffs', value: false, settingsVersion: 8 });
            expect(await action({ actionId: 'settings.set', input: { anchor: 'sourceControl.showLineNumbersInDiffs', value: true, expectedSettingsVersion: 7 } }))
                .toMatchObject({ ok: false, errorCode: 'account_settings_mutation_conflict' });
            expect(raw).toEqual({ futureSibling: { retained: 'winner' }, showLineNumbers: false });
            expect(await action({ actionId: 'settings.set', input: { anchor: 'sourceControl.showLineNumbersInDiffs', value: false, reversal: { kind: 'capture' } } }))
                .toEqual({ anchor: 'sourceControl.showLineNumbersInDiffs', value: false, reversalUnavailableReason: 'no_change' });
            const secondApply = await action({ actionId: 'settings.set', input: { anchor: 'sourceControl.showLineNumbersInDiffs', value: true, reversal: { kind: 'capture' } } });
            const secondReceipt = SettingsDeclarationActionOutputSchemasV1['settings.set'].parse(secondApply);
            expect(secondApply).toMatchObject({ reversal: { beforeVersion: 8, appliedVersion: 9, before: { value: false }, applied: { value: true } } });
            race = true;
            expect(await action({ actionId: 'settings.set', input: { anchor: 'sourceControl.showLineNumbersInDiffs', value: false,
                reversal: { kind: 'restore', ...secondReceipt.reversal } } }))
                .toMatchObject({ ok: false, errorCode: 'account_settings_mutation_conflict' });
            expect(raw).toEqual({ futureSibling: { retained: 'winner' }, showLineNumbers: true });
            expect.soft(await action({ actionId: 'settings.get', input: { anchor: 'usage.coachPreferences', includeVersion: true } }))
                .toEqual({ anchor: 'usage.coachPreferences', value: { v: 1, suppressions: [] }, settingsVersion: 10 });
                return;
            }
            await action({ actionId: 'settings.set', input: { anchor: 'sourceControl.showLineNumbersInDiffs', value: true } });
            const beforeVersion = version;
            const query = normalizeUsageQuery({ period: { startMs: 0, endMs: 1000 }, timeZoneOffsetMinutes: 0,
                ...(scenario === 'coachPreferences' ? { session: 'coach-session' } : {}) });
            // Undo deliberately needs no surviving finding. Its proof is the real
            // setting owner's receipt plus an authorized read through the actual query owner.
            const evidenceKey = 'captured-setting-receipt';
            const actionsSettings = (await account.readSettings()).actionsSettingsV1;
            const executor = createActionExecutor(createActionExecutorBoundaryFixture({
                settingsDeclarationAction: args => action({ actionId: args.actionId, input: args.input, context: args.context }),
                usageActions: createUiUsageActionPorts(account),
                // This authenticated Account explicitly permits these effects. Its real parsed policy owns every nested decision.
                isActionApprovalRequired: (actionId, context, input) => isApprovalRequiredByActionsSettings(actionId,
                    actionsSettings, context, undefined, undefined, input),
            }));
            const context = { surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' }, actionsSettings } as const;
            if (scenario === 'coachPreferences') {
                const queried = await executor.execute('usage.query', { queries: [query] }, context);
                const batch = UsageQueryBatchResultSchema.parse(queried.ok ? queried.result : undefined);
                const finding = batch.results[0]?.coach?.findings.find(row => row.detectorId === 'duplicated_instructions');
                expect(finding).toMatchObject({ remedy: { kind: 'prepared_session' } });
                if (!finding) throw new Error('Expected actual retained-composition finding');
                const evidenceKey = finding.evidenceKey;
                const preferences = () => UsageCoachPreferencesV1Schema.parse(raw.usageCoachPreferencesV1);
                const otherSuppression = { kind: 'dismissed', evidenceKey: 'another-finding' };
                expect(await executor.execute('usage.coach.dismiss', { query, evidenceKey, dismissed: true }, context))
                    .toMatchObject({ ok: true, result: { kind: 'preference_updated', evidenceKey, dismissed: true } });
                expect(preferences()).toEqual({ v: 1, suppressions: [otherSuppression, { kind: 'dismissed', evidenceKey }] });
                const untilMs = Date.now() + 60_000;
                expect(await executor.execute('usage.coach.snooze', { query, evidenceKey, untilMs }, context))
                    .toMatchObject({ ok: true, result: { kind: 'preference_updated', evidenceKey, untilMs } });
                expect(preferences().suppressions).toEqual([otherSuppression, { kind: 'snoozed', evidenceKey, untilMs }]);
                expect(await executor.execute('usage.coach.snooze', { query, evidenceKey, untilMs: null }, context))
                    .toMatchObject({ ok: true, result: { kind: 'preference_updated', evidenceKey, untilMs: null } });
                expect(preferences().suppressions).toEqual([otherSuppression]);
                await executor.execute('usage.coach.dismiss', { query, evidenceKey, dismissed: true }, context);
                race = true;
                expect(await executor.execute('usage.coach.dismiss', { query, evidenceKey, dismissed: false }, context))
                    .toMatchObject({ ok: false, errorCode: 'account_settings_mutation_conflict' });
                expect(preferences().suppressions).toEqual([otherSuppression, { kind: 'dismissed', evidenceKey }]);
                expect(await executor.execute('usage.coach.dismiss', { query, evidenceKey, dismissed: false }, context))
                    .toMatchObject({ ok: true, result: { kind: 'preference_updated', evidenceKey, dismissed: false } });
                expect(preferences()).toEqual({ v: 1, suppressions: [otherSuppression] });
                return;
            }
            const capture = async () => {
                const applied = await executor.execute('settings.set', { anchor: 'sourceControl.showLineNumbersInDiffs', value: false,
                    reversal: { kind: 'capture' } }, context);
                expect(applied.ok, JSON.stringify(applied)).toBe(true);
                const receipt = SettingsDeclarationActionOutputSchemasV1['settings.set'].parse(applied.ok ? applied.result : undefined);
                if (!('value' in receipt) || !receipt.reversal) throw new Error('Expected real setting owner capture');
                return UsageCoachReversalSchema.parse({ kind: 'setting', anchor: receipt.anchor, appliedValue: receipt.value, owner: receipt.reversal });
            };
            const reversal = await capture();
            expect(reversal).toMatchObject({ kind: 'setting', owner: { beforeVersion, appliedVersion: beforeVersion + 1,
                before: { value: true }, applied: { value: false } } });
            expect(raw.showLineNumbers).toBe(false);
            const queried = await executor.execute('usage.query', { queries: [query] }, context);
            expect(queried).toMatchObject({ ok: true, result: { results: [{ accounting: { totals: { eventCount: 0 } } }] } });
            const undone = await executor.execute('usage.coach.undo', { query, evidenceKey, reversal }, context);
            expect(undone, JSON.stringify(undone))
                .toMatchObject({ ok: true, result: { kind: 'undone', evidenceKey } });
            expect(raw.showLineNumbers).toBe(true);
            const staleReversal = await capture();
            await action({ actionId: 'settings.set', input: { anchor: 'sourceControl.showLineNumbersInDiffs', value: true } });
            expect(await executor.execute('usage.coach.undo', { query, evidenceKey, reversal: staleReversal }, context))
                .toMatchObject({ ok: false, errorCode: 'account_settings_mutation_conflict' });
            expect(raw.showLineNumbers).toBe(true);
        } finally { account.dispose(); storage.setState(previous); }
    });
    it('admits a public-link-only WorkBoard audience for native reads without assuming unavailable publications are absent', async () => {
        const previous = storage.getState();
        const home = await upsertAndActivateServer({ serverUrl: 'https://artifact-public-audience.test', scope: 'tab' });
        const token = `header.${encodeBase64(new TextEncoder().encode(JSON.stringify({ sub: 'artifact-account' })), 'base64url')}.signature`;
        vi.spyOn(TokenStorage, 'getCredentialsForServerUrl').mockResolvedValue({ token });
        const artifactId = '11111111-1111-4111-8111-111111111111';
        const row: Artifact = { id: artifactId, ownerAccountId: 'artifact-account', access: 'owner', encryptionMode: 'plain',
            dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER, header: encodePlainArtifactStoredContent({ kind: 'work-board.v1', title: 'Board' }),
            body: encodePlainArtifactStoredContent({ body: '{}' }), headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 };
        let publicAudience: unknown = 'retained';
        runtimeFetch.mockImplementation(async (url: unknown) => {
            const path = new URL(String(url)).pathname;
            if (path === '/health' || path === '/v1/auth/ping') return json({});
            if (path === '/v1/features') return json({ features: {}, capabilities: { accountStoredContentCompatibility: {
                v: 1, minimumProtocolVersion: CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION,
                currentProtocolVersion: CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION, declarationTransport: 'http-header-and-socket-auth-v1',
            } } });
            if (path === '/v1/account/encryption') return json({ mode: 'plain', updatedAt: 0 });
            if (path === `/v1/artifacts/${artifactId}`) return json({ ...row, publicAudience });
            if (path === `/v1/artifacts/${artifactId}/access/grants`) return json({ artifactId, ownerAccountId: 'artifact-account', access: 'owner', grants: [] });
            if (path === '/v1/public-shares') return json({ error: 'not_found' }, 404);
            throw new Error(`Unexpected route ${path}`);
        });
        storage.setState({ settingsScope: { serverId: home.id, accountId: 'artifact-account' }, artifacts: {} });
        const account = await captureLazyActionAccountContext(home.id);
        try {
            await expect(account.workflowArtifacts.read(artifactId)).resolves.toMatchObject({ shared: true, publicAudience: 'retained' });
            expect(storage.getState().artifacts[artifactId]).toMatchObject({ publicAudience: 'retained' });
            const ordinary = createUiArtifactAction(account);
            expect(ArtifactActionOutputSchemasV1['artifact.get'].parse(await ordinary({ actionId: 'artifact.get',
                input: { artifactId }, context: { surface: 'ui' } }))).toMatchObject({ artifact: { publicAudience: 'retained' } });
            publicAudience = 'none';
            await expect(account.workflowArtifacts.read(artifactId)).resolves.toMatchObject({ shared: false });
            for (const value of [undefined, 'future-audience']) {
                publicAudience = value;
                await expect(account.workflowArtifacts.read(artifactId)).rejects.toMatchObject({ code: 'content_unavailable' });
                expect(storage.getState().artifacts[artifactId]).toMatchObject({ publicAudience: 'unknown' });
            }
            expect(runtimeFetch.mock.calls.some(([url]) => new URL(String(url)).pathname === '/v1/public-shares')).toBe(false);
        } finally { account.dispose(); storage.setState(previous); }
    });
    it('publishes admitted current reads once and removes a self-revoked Artifact without reopening it', async () => {
        const previous = storage.getState();
        const home = await upsertAndActivateServer({ serverUrl: 'https://artifact-read-publication.test', scope: 'tab' });
        const token = `header.${encodeBase64(new TextEncoder().encode(JSON.stringify({ sub: 'artifact-account' })), 'base64url')}.signature`;
        vi.spyOn(TokenStorage, 'getCredentialsForServerUrl').mockResolvedValue({ token });
        const artifactId = '11111111-1111-4111-8111-111111111111';
        const row: Artifact = { id: artifactId, ownerAccountId: 'owner', access: 'view', encryptionMode: 'plain',
            dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER, header: encodePlainArtifactStoredContent({ title: 'Admitted' }),
            body: encodePlainArtifactStoredContent({ body: 'readable' }), headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 };
        let revoked = false;
        runtimeFetch.mockImplementation(async (url: unknown, init?: RequestInit) => {
            const path = new URL(String(url)).pathname;
            if (path === '/health' || path === '/v1/auth/ping') return json({});
            if (path === '/v1/features') return json({ features: {}, capabilities: { accountStoredContentCompatibility: {
                v: 1, minimumProtocolVersion: CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION,
                currentProtocolVersion: CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION, declarationTransport: 'http-header-and-socket-auth-v1',
            } } });
            if (path === '/v1/account/encryption') return json({ mode: 'plain', updatedAt: 0 });
            if (path === `/v1/artifacts/${artifactId}/access/grants` && init?.method === 'DELETE') {
                revoked = true;
                return json({ artifactId, ownerAccountId: 'owner', access: null, grants: [], changed: true });
            }
            if (path === `/v1/artifacts/${artifactId}`) return revoked ? json({ error: 'Artifact not found' }, 404) : json(row);
            throw new Error(`Unexpected route ${path}`);
        });
        storage.setState({ settingsScope: { serverId: home.id, accountId: 'artifact-account' }, artifacts: {} });
        const account = await captureLazyActionAccountContext(home.id);
        try {
            expect(storage.getState().artifacts[artifactId]).toBeUndefined();
            await account.fetchArtifact(artifactId);
            const published = storage.getState().artifacts[artifactId];
            expect(published).toMatchObject({ access: 'view', ownerAccountId: 'owner', isDecrypted: true, body: 'readable' });
            await account.fetchArtifact(artifactId);
            expect(storage.getState().artifacts[artifactId]).toBe(published);
            await account.artifactAccessGrants.remove({ artifactId, principal: { kind: 'account', accountId: 'artifact-account' } });
            expect(storage.getState().artifacts[artifactId]).toBeUndefined();
            await expect(account.fetchArtifact(artifactId)).resolves.toBeNull();
            expect(storage.getState().artifacts[artifactId]).toBeUndefined();
        } finally { account.dispose(); storage.setState(previous); }
    });
    it.each([
        ['create', 'credential'], ['update', 'credential'], ['create', 'caller'], ['update', 'caller'],
    ] as const)('keeps the %s acknowledgement after %s retirement without publishing stale content', async (operation, retirement) => {
        const previousState = storage.getState();
        const home = await upsertAndActivateServer({ serverUrl: `https://artifact-retired-${operation}.test`, scope: 'tab' });
        const token = `header.${encodeBase64(new TextEncoder().encode(JSON.stringify({ sub: 'artifact-account' })), 'base64url')}.signature`;
        vi.spyOn(TokenStorage, 'getCredentialsForServerUrl').mockResolvedValue({ token });
        let retire: Parameters<typeof credentialStorage.subscribeHomeCredentialMutations>[0] | undefined;
        // Device credential subscription is the retirement boundary; codecs and Account fencing remain real.
        vi.spyOn(credentialStorage, 'subscribeHomeCredentialMutations').mockImplementation(listener => { retire = listener; return () => {}; });
        const artifactId = '11111111-1111-4111-8111-111111111111';
        const caller = new AbortController();
        const header = { title: 'Acknowledged', kind: 'home-hub-layout.v1', v: 1 };
        const body = 'acknowledged body';
        const before: Artifact = { id: artifactId, ownerAccountId: 'artifact-account', access: 'owner', encryptionMode: 'plain',
            dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER, header: encodePlainArtifactStoredContent({ title: 'Before' }),
            body: encodePlainArtifactStoredContent({ body: 'before' }), headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 };
        storage.setState({ settingsScope: { serverId: home.id, accountId: 'artifact-account' }, artifacts: {} });
        runtimeFetch.mockImplementation(async (url: unknown, init?: RequestInit) => {
            const path = new URL(String(url)).pathname;
            if (path === '/health' || path === '/v1/auth/ping') return json({});
            if (path === '/v1/features') return json({ features: {}, capabilities: { accountStoredContentCompatibility: {
                v: 1, minimumProtocolVersion: CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION,
                currentProtocolVersion: CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION, declarationTransport: 'http-header-and-socket-auth-v1',
            } } });
            if (path === '/v1/account/encryption') return json({ mode: 'plain', updatedAt: 0 });
            if (path === `/v1/artifacts/${artifactId}` && init?.method !== 'POST') return json(before);
            if (init?.method === 'POST' && (path === '/v1/artifacts' || path === `/v1/artifacts/${artifactId}`)) {
                if (retirement === 'credential') retire?.({ kind: 'credentials_removed', serverId: home.id, serverUrl: home.serverUrl });
                else caller.abort();
                if (operation === 'create') return json({ ...before, header: encodePlainArtifactStoredContent(header),
                    body: encodePlainArtifactStoredContent({ body }), headerVersion: 2, bodyVersion: 2 });
                return json({ success: true, headerVersion: 2, bodyVersion: 2 });
            }
            throw new Error(`Unexpected route ${path}`);
        });
        const account = await captureLazyActionAccountContext(home.id, caller.signal);
        try {
            if (operation === 'create') await expect(account.createArtifactDocument({ artifactId, header, body }))
                .resolves.toMatchObject({ artifactId, revision: { headerVersion: 2, bodyVersion: 2 }, artifact: { rawHeader: header, body } });
            else await expect(account.updateArtifactDocument({ artifactId, expectedRevision: { headerVersion: 1, bodyVersion: 1 }, header, body }))
                .resolves.toMatchObject({ ok: true, revision: { headerVersion: 2, bodyVersion: 2 } });
            expect(account.accountLifetime.isCurrent()).toBe(false);
            if (operation === 'create') expect(storage.getState().artifacts[artifactId]).toBeUndefined();
            else expect(storage.getState().artifacts[artifactId]).toMatchObject({ body: 'before', headerVersion: 1, bodyVersion: 1 });
            await expect(account.fetchArtifact(artifactId)).rejects.toMatchObject(retirement === 'credential'
                ? { code: 'action_account_scope_changed' } : { name: 'AbortError' });
        } finally { account.dispose(); storage.setState(previousState); }
    });

    it('admits a typed binary body through the captured public-link keyholding resource', async () => {
        const home = await upsertAndActivateServer({ serverUrl: 'https://artifact-binary-resource.test', scope: 'tab' });
        const token = `header.${encodeBase64(new TextEncoder().encode(JSON.stringify({ sub: 'artifact-account' })), 'base64url')}.signature`;
        vi.spyOn(TokenStorage, 'getCredentialsForServerUrl').mockResolvedValue({ token });
        const body = { blobId: '11111111-1111-4111-8111-111111111111', mime: 'image/png', sizeBytes: 4, sha256: 'a'.repeat(64) };
        runtimeFetch.mockImplementation(async (url: unknown) => {
            const target = new URL(String(url));
            if (target.pathname === '/health' || target.pathname === '/v1/auth/ping') return json({});
            if (target.pathname === '/v1/features') return json({ features: {}, capabilities: { accountStoredContentCompatibility: {
                v: 1, minimumProtocolVersion: CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION, currentProtocolVersion: CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION,
                declarationTransport: 'http-header-and-socket-auth-v1',
            } } });
            if (target.pathname === '/v1/account/encryption') return json({ mode: 'plain', updatedAt: 0 });
            if (target.pathname === '/v1/artifacts/binary-artifact') return json({ id: 'binary-artifact',
                ownerAccountId: 'artifact-account', access: 'owner', encryptionMode: 'plain', dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
                header: encodePlainArtifactStoredContent({ title: 'Image', kind: 'published.v1' }), body: encodePlainArtifactStoredContent({ body }),
                headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 });
            return json({ error: 'unexpected_route' }, 404);
        });
        const account = await captureLazyActionAccountContext(home.id);
        try {
            expect(await account.readArtifactPublicLinkResource('binary-artifact')).toMatchObject({ body, encryptionMode: 'plain', dataKey: null, access: 'owner' });
        } finally { account.dispose(); }
    });
    it('returns the committed Artifact create acknowledgement without depending on a subsequent read', async () => {
        const home = await upsertAndActivateServer({ serverUrl: 'https://artifact-create-acknowledgement.test', scope: 'tab' });
        await upsertAndActivateServer({ serverUrl: 'https://artifact-create-other-home.test', scope: 'tab' });
        const token = `header.${encodeBase64(new TextEncoder().encode(JSON.stringify({ sub: 'artifact-account' })), 'base64url')}.signature`;
        vi.spyOn(TokenStorage, 'getCredentialsForServerUrl').mockResolvedValue({ token });
        const artifactId = '11111111-1111-4111-8111-111111111111';
        const reads: string[] = [];
        let committed: Artifact | undefined;
        runtimeFetch.mockImplementation(async (url: unknown, init?: RequestInit) => {
            const target = new URL(String(url));
            if (target.pathname === '/health' || target.pathname === '/v1/auth/ping') return json({});
            if (target.pathname === '/v1/features') return json({ features: {}, capabilities: { accountStoredContentCompatibility: {
                v: 1, minimumProtocolVersion: CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION,
                currentProtocolVersion: CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION, declarationTransport: 'http-header-and-socket-auth-v1',
            } } });
            expect(target.origin).toBe(home.serverUrl);
            if (target.pathname === '/v1/account/encryption') return json({ mode: 'plain', updatedAt: 0 });
            if (target.pathname === '/v1/artifacts' && init?.method === 'POST') {
                const write = JSON.parse(String(init.body)) as ArtifactCreateRequest;
                // Exact-id create may acknowledge an incumbent row after a same-id race.
                committed = { ...write, ownerAccountId: 'artifact-account', access: 'owner', encryptionMode: 'plain',
                    header: encodePlainArtifactStoredContent({ title: 'Incumbent' }), body: encodePlainArtifactStoredContent({ body: 'incumbent body' }),
                    provenance: null, provenanceDataEncryptionKey: null,
                    headerVersion: 3, bodyVersion: 4, seq: 4, createdAt: 1, updatedAt: 2 };
                return json(committed);
            }
            reads.push(target.pathname);
            return json({ error: 'read_transport_unavailable' }, 403);
        });
        const account = await captureLazyActionAccountContext(home.id);
        try {
            const execute = createFrontDoorActionExecute(createActionExecutor(createActionExecutorBoundaryFixture({ artifactAction: createUiArtifactAction(account) })));
            const caller = { surface: 'ui' as const, authority: 'present_user' as const, actionCaller: { kind: 'host' as const } };
            expect(await execute('artifact.create', { artifactId, header: { title: 'Attempted' }, body: 'attempted body' }, caller))
                .toEqual({ ok: true, result: { artifactId, revision: { headerVersion: 3, bodyVersion: 4 } } });
            expect(committed?.id).toBe(artifactId);
            expect(reads).toEqual([]);
            expect(await account.workflowArtifacts.create({ artifactId, header: {}, body: 'workflow body' })).toBe(artifactId);
            expect(reads).toEqual([]);
        } finally { account.dispose(); }
    });
    it('selects ordinary Artifact lists across structural pages without leaking filters or truncating omitted limits', async () => {
        const home = await upsertAndActivateServer({ serverUrl: 'https://ordinary-artifact-selection.test', scope: 'tab' });
        const token = `header.${encodeBase64(new TextEncoder().encode(JSON.stringify({ sub: 'artifact-account' })), 'base64url')}.signature`;
        vi.spyOn(TokenStorage, 'getCredentialsForServerUrl').mockResolvedValue({ token });
        const row = (id: string, title: string, kind: string, updatedAt: number, createdAt = updatedAt): Artifact => ({
            id, ownerAccountId: 'artifact-account', access: 'owner', encryptionMode: 'plain',
            header: encodePlainArtifactStoredContent({ title, kind }), body: encodePlainArtifactStoredContent({ body: 'retained body' }),
            dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER, headerVersion: 1, bodyVersion: 1, seq: 1, createdAt, updatedAt,
        });
        const rows = [...Array.from({ length: 500 }, (_, index) => row(`other-${index}`, 'Other', 'other.v1', 1000 - index)),
            row('zebra', 'Private zebra', 'published.v1', 2, 6000), row('alpha', 'Private alpha', 'published.v1', 1, 5000)];
        const urls: URL[] = [];
        runtimeFetch.mockImplementation(async (url: unknown) => {
            const target = new URL(String(url));
            if (target.pathname === '/health' || target.pathname === '/v1/auth/ping') return json({});
            if (target.pathname === '/v1/features') return json({ features: {}, capabilities: { accountStoredContentCompatibility: {
                v: 1, minimumProtocolVersion: CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION,
                currentProtocolVersion: CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION, declarationTransport: 'http-header-and-socket-auth-v1',
            } } });
            expect(target.origin).toBe(home.serverUrl);
            if (target.pathname === '/v1/account/encryption') return json({ mode: 'plain', updatedAt: 0 });
            if (target.pathname !== '/v1/artifacts') return json({ error: 'unexpected_route' }, 404);
            urls.push(target);
            const cursor = target.searchParams.get('cursor');
            const after = cursor ? JSON.parse(new TextDecoder().decode(decodeBase64(cursor, 'base64url'))) as { id: string } : null;
            const start = after ? rows.findIndex(item => item.id === after.id) + 1 : 0;
            const limit = Number(target.searchParams.get('limit') ?? 100);
            if (limit > 500) return json({ error: 'invalid_limit' }, 400);
            return json(rows.slice(start, start + limit));
        });
        const account = await captureLazyActionAccountContext(home.id);
        try {
            const execute = createFrontDoorActionExecute(createActionExecutor(createActionExecutorBoundaryFixture({ artifactAction: createUiArtifactAction(account) })));
            const caller = { surface: 'ui' as const, authority: 'present_user' as const, actionCaller: { kind: 'host' as const } };
            const selected = await execute('artifact.list', { search: 'PRIVATE', kind: 'published.v1', sort: 'title_asc', limit: 1 }, caller);
            expect(selected, JSON.stringify(selected)).toMatchObject({ ok: true, result: { items: [{ artifactId: 'alpha' }], nextCursor: expect.any(String) } });
            if (!selected.ok) throw new Error(selected.error);
            const first = ArtifactActionOutputSchemasV1['artifact.list'].parse(selected.result);
            expect(first.items.map(item => item.artifactId)).toEqual(['alpha']);
            const next = await execute('artifact.list', { search: 'PRIVATE', kind: 'published.v1', sort: 'title_asc', limit: 1, cursor: first.nextCursor }, caller);
            expect(next).toMatchObject({ ok: true, result: { items: [{ artifactId: 'zebra' }] } });
            if (!next.ok) throw new Error(next.error);
            expect(ArtifactActionOutputSchemasV1['artifact.list'].parse(next.result).nextCursor).toBeUndefined();
            const created = await execute('artifact.list', { search: 'PRIVATE', kind: 'published.v1', sort: 'created_desc' }, caller);
            if (!created.ok) throw new Error(created.error);
            expect(ArtifactActionOutputSchemasV1['artifact.list'].parse(created.result).items.map(item => item.artifactId)).toEqual(['zebra', 'alpha']);
            const complete = await execute('artifact.list', {}, caller);
            if (!complete.ok) throw new Error(complete.error);
            expect(ArtifactActionOutputSchemasV1['artifact.list'].parse(complete.result).items).toHaveLength(rows.length);
            const structural = await account.workflowArtifacts.list({ limit: 500, includeBody: true });
            expect(structural.items).toHaveLength(500);
            expect(structural.items[0]).toMatchObject({ body: 'retained body' });
            expect(structural.nextCursor).toBeDefined();
            for (const url of urls) {
                expect(url.searchParams.has('search') || url.searchParams.has('kind') || url.searchParams.has('sort')).toBe(false);
            }
        } finally { account.dispose(); }
    });
    it.each(['plain', 'e2ee'] as const)('runs ordinary %s Artifact CRUD through the front door on the captured Home', async mode => {
        const home = await upsertAndActivateServer({ serverUrl: `https://ordinary-artifacts-${mode}.test`, scope: 'tab' });
        await upsertAndActivateServer({ serverUrl: `https://ordinary-focused-${mode}.test`, scope: 'tab' });
        const token = `header.${encodeBase64(new TextEncoder().encode(JSON.stringify({ sub: 'artifact-account' })), 'base64url')}.signature`;
        vi.spyOn(TokenStorage, 'getCredentialsForServerUrl').mockResolvedValue(mode === 'plain' ? { token }
            : { token, secret: encodeBase64(new Uint8Array(32).fill(24), 'base64url') });
        const artifactId = '11111111-1111-4111-8111-111111111111';
        let stored: Artifact | undefined;
        runtimeFetch.mockImplementation(async (url: unknown, init?: RequestInit) => {
            const target = new URL(String(url));
            if (target.pathname === '/health' || target.pathname === '/v1/auth/ping') return json({});
            if (target.pathname === '/v1/features') return json({ features: {}, capabilities: { accountStoredContentCompatibility: {
                v: 1, minimumProtocolVersion: CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION, currentProtocolVersion: CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION,
                declarationTransport: 'http-header-and-socket-auth-v1',
            } } });
            expect(target.origin).toBe(home.serverUrl);
            if (target.pathname === '/v1/account/encryption') return json({ mode, updatedAt: 0 });
            if (target.pathname === '/v2/account/settings') return json({ content: null, version: 0 });
            if (target.pathname === ARTIFACT_UPLOAD_PATH_V1 && init?.method === 'POST') {
                if (!(init.body instanceof ArrayBuffer)) throw new Error('Expected canonical binary upload');
                const frame = new Uint8Array(init.body);
                const metadata = decodeArtifactUploadMetadataV1(frame.subarray(0, frame.indexOf(10)));
                if (metadata.kind !== 'create') throw new Error('Expected publication create');
                stored = { id: metadata.artifactId, header: metadata.header, body: metadata.body, dataEncryptionKey: metadata.dataEncryptionKey,
                    provenance: metadata.provenance, provenanceDataEncryptionKey: metadata.provenanceDataEncryptionKey,
                    ownerAccountId: 'artifact-account', access: 'owner', encryptionMode: mode,
                    seq: 1, headerVersion: 1, bodyVersion: 1, createdAt: 1, updatedAt: 1 };
                return json(stored);
            }
            if (target.pathname === '/v1/artifacts' && init?.method === 'POST') {
                const write = JSON.parse(String(init.body)) as ArtifactCreateRequest;
                stored = { ...write, ownerAccountId: 'artifact-account', access: 'owner', encryptionMode: mode,
                    seq: 1, headerVersion: 1, bodyVersion: 1, createdAt: 1, updatedAt: 1 };
                return json(stored);
            }
            if (target.pathname === '/v1/artifacts') return json(stored ? [stored] : []);
            if (stored && target.pathname.endsWith('/recipients')) return json({ artifactId: stored.id,
                ownerAccountId: stored.ownerAccountId, access: stored.access, encryptionMode: mode, dataEncryptionKey: stored.dataEncryptionKey,
                callerDataEncryptionKey: stored.dataEncryptionKey, provenanceDataEncryptionKey: stored.provenanceDataEncryptionKey,
                callerProvenanceDataEncryptionKey: stored.provenanceDataEncryptionKey, recipients: [] });
            if (stored && target.pathname === `/v1/artifacts/${stored.id}/html-preview`) return json({ url: `https://artifact-isolated.test/a/${stored.id}` });
            if (stored && init?.method === 'DELETE' && target.pathname === `/v1/artifacts/${stored.id}/revision/2/2`) {
                stored = undefined; return new Response(null, { status: 204 });
            }
            if (!stored || (target.pathname !== `/v1/artifacts/${stored.id}` && target.pathname !== `/v1/artifacts/${stored.id}/content/binary`)) return json({ error: 'not_found' }, 404);
            if (init?.method === 'DELETE') { stored = undefined; return new Response(null, { status: 204 }); }
            if (init?.method !== 'POST') return json(stored);
            const write = JSON.parse(String(init.body)) as ArtifactUpdateRequest;
            if (write.expectedHeaderVersion !== stored.headerVersion || write.expectedBodyVersion !== stored.bodyVersion) return json({ success: false, error: 'version-mismatch' });
            stored = { ...stored, ...write, header: write.header!, body: write.body!, headerVersion: 2, bodyVersion: 2 };
            return json({ success: true, headerVersion: 2, bodyVersion: 2 });
        });
        const context = await captureLazyActionAccountContext(home.id);
        try {
            const execute = createFrontDoorActionExecute(createActionExecutor(createActionExecutorBoundaryFixture({ artifactAction: createUiArtifactAction(context) })));
            const caller = { surface: 'ui' as const, authority: 'present_user' as const, actionCaller: { kind: 'host' as const } };
            expect(await execute('artifact.create', { artifactId, header: { title: 'First' }, body: 'initial' }, caller))
                .toEqual({ ok: true, result: { artifactId, revision: { headerVersion: 1, bodyVersion: 1 } } });
            const openedEnvelope = async () => {
                const row = stored!;
                if (mode === 'plain') return decodePlainArtifactStoredContent(row.body!);
                const { createEncryptionFromAuthCredentials } = await import('@/auth/encryption/createEncryptionFromAuthCredentials');
                const encryption = await createEncryptionFromAuthCredentials((await TokenStorage.getCredentialsForServerUrl(home.serverUrl))!);
                const key = await encryption!.decryptEncryptionKey(row.dataEncryptionKey);
                return new ArtifactEncryption(key!).decryptBody(row.body!);
            };
            const openedProvenance = async () => {
                const row = stored!;
                const { createEncryptionFromAuthCredentials } = await import('@/auth/encryption/createEncryptionFromAuthCredentials');
                const encryption = mode === 'e2ee' ? await createEncryptionFromAuthCredentials((await TokenStorage.getCredentialsForServerUrl(home.serverUrl))!) : null;
                const dataKey = row.provenanceDataEncryptionKey ? await encryption!.decryptEncryptionKey(row.provenanceDataEncryptionKey) : null;
                return openArtifactPrivateRevisionMetadata({ mode, artifactId: row.id, bodyVersion: row.bodyVersion!, provenance: row.provenance, dataKey });
            };
            const openedPublicHeader = async () => {
                const row = stored!;
                if (mode === 'plain') return decodePlainArtifactStoredContent(row.header);
                const { createEncryptionFromAuthCredentials } = await import('@/auth/encryption/createEncryptionFromAuthCredentials');
                const encryption = await createEncryptionFromAuthCredentials((await TokenStorage.getCredentialsForServerUrl(home.serverUrl))!);
                const key = await encryption!.decryptEncryptionKey(row.dataEncryptionKey);
                return new ArtifactEncryption(key!).decryptHeaderRaw(row.header);
            };
            expect(await openedEnvelope()).toEqual({ body: 'initial' });
            expect(await openedProvenance()).toEqual({ savedBy: { kind: 'person', accountId: 'artifact-account' } });
            expect(stored?.dataEncryptionKey === ARTIFACT_PLAIN_DATA_KEY_MARKER).toBe(mode === 'plain');
            expect(await execute('artifact.get', { artifactId }, caller)).toMatchObject({ ok: true, result: { artifact: { artifactId, body: 'initial', header: { title: 'First' } } } });
            const listed = await execute('artifact.list', {}, caller);
            expect(listed, JSON.stringify(listed)).toMatchObject({ ok: true, result: { items: [{ artifactId, header: { title: 'First' } }] } });
            expect(await execute('artifact.update', { artifactId, expectedRevision: { headerVersion: 1, bodyVersion: 1 }, header: { title: 'Second' }, body: 'changed' }, caller))
                .toEqual({ ok: true, result: { artifactId, revision: { headerVersion: 2, bodyVersion: 2 } } });
            expect(await openedEnvelope()).toEqual({ body: 'changed' });
            expect(await openedProvenance()).toEqual({ savedBy: { kind: 'person', accountId: 'artifact-account' } });
            expect(await execute('artifact.update', { artifactId, expectedRevision: { headerVersion: 1, bodyVersion: 1 }, header: {}, body: 'stale' }, caller))
                .toMatchObject({ ok: false, errorCode: 'version_mismatch' });
            expect(await execute('artifact.delete', { artifactId, expectedRevision: { headerVersion: 2, bodyVersion: 2 } }, caller))
                .toEqual({ ok: true, result: { artifactId, deleted: true } });
            expect(await execute('artifact.get', { artifactId }, caller)).toEqual({ ok: true, result: { artifact: null } });
            expect(await execute('artifact.publish_from_file', { path: 'result.txt' }, caller))
                .toMatchObject({ ok: false, errorCode: 'artifact_source_unavailable' });
            expect(await execute('artifact.publish_from_file', { path: 'result.txt' }, { ...caller, defaultSessionId: 'publication-session' }))
                .toMatchObject({ ok: false, errorCode: 'artifact_source_unavailable' });
            storage.setState({ sessions: { 'publication-session': createSessionFixture({ id: 'publication-session', serverId: home.id,
                metadata: { ...createSessionFixture().metadata!, path: '/workspace', machineId: 'publication-machine' } }) },
                machineListByServerId: { [home.id]: [createMachineFixture({ id: 'publication-machine' })] } });
            const download = vi.fn(async (request: { signal?: AbortSignal | null; destination: { writeBytes: (bytes: Uint8Array) => Promise<void>; close: () => Promise<void> } }) => {
                await request.destination.writeBytes(new TextEncoder().encode('<h1>Published</h1>'));
                await request.destination.close();
                return { ok: true as const, name: 'result.html', sizeBytes: 18 };
            });
            // This port is the remote workspace byte-transport boundary; Session lookup and publication remain real.
            // Session provenance retains the Agent approval floor. Use the real persisted waiver policy for this admitted source test.
            const publicationSettings = normalizeActionsSettingsV1({ v: 1, approvalWaivedSurfaces: { 'artifact.publish_from_file': ['agent'] } });
            const publication = createFrontDoorActionExecute(createActionExecutor(createActionExecutorBoundaryFixture({ artifactAction: createUiArtifactAction(context, {
                workspaceDownload: download,
            }), isActionApprovalRequired: (actionId, actionContext, input) => isApprovalRequiredByActionsSettings(
                actionId, publicationSettings, actionContext, undefined, undefined, input,
            ) })));
            const publicationCaller = { kind: 'session', sessionId: 'publication-session', starterDepth: 0, turnDepth: 0 } satisfies NonNullable<ActionExecutorContext['actionCaller']>;
            const sessionCaller = { ...caller, serverId: home.id, runtimeAccountId: 'artifact-account',
                defaultSessionId: 'publication-session', actionCaller: publicationCaller };
            expect(await execute('artifact.publish_from_file', { path: 'result.html' }, sessionCaller))
                .toMatchObject({ ok: false, errorCode: 'approvals_not_supported' });
            expect(stored).toBeUndefined();
            expect(download).not.toHaveBeenCalled();
            expect(await publication('artifact.publish_from_file', { path: 'result.html' }, { ...sessionCaller, runtimeAccountId: 'other-account' }))
                .toMatchObject({ ok: false, errorCode: 'artifact_source_unavailable' });
            expect(await publication('artifact.publish_from_file', { path: 'result.html' }, { ...sessionCaller, serverId: 'other-home' }))
                .toMatchObject({ ok: false, errorCode: 'artifact_source_unavailable' });
            expect(download).not.toHaveBeenCalled();
            const publishedResult = await publication('artifact.publish_from_file', { path: 'result.html' }, sessionCaller);
            expect(publishedResult).toEqual({ ok: true, result: { artifactId: expect.any(String), revision: { headerVersion: 1, bodyVersion: 1 } } });
            expect(publishedResult).not.toHaveProperty('result.previewUrl');
            expect(publishedResult).not.toHaveProperty('result.previewError');
            expect(JSON.stringify(publishedResult)).not.toContain('#d=');
            expect(await openedProvenance()).toEqual({ savedBy: { kind: 'agent', accountId: 'artifact-account', sessionId: 'publication-session' }, source: {
                sessionId: 'publication-session', machineId: 'publication-machine', path: 'result.html', sha: expect.any(String),
            } });
            expect(await openedPublicHeader()).not.toHaveProperty('source');
            expect(await openedEnvelope()).toEqual({ body: '<h1>Published</h1>' });
            expect(download).toHaveBeenCalledWith(expect.objectContaining({ serverId: home.id, machineId: 'publication-machine', rootPath: '/workspace', confinedToWorkingDirectory: true }));
            const published = stored;
            const publishedRead = await publication('artifact.get', { artifactId: published!.id }, caller);
            expect(publishedRead).toMatchObject({ ok: true, result: { artifact: { body: '<h1>Published</h1>', header: { kind: 'html' }, provenance: {
                source: { sessionId: 'publication-session', machineId: 'publication-machine', path: 'result.html', sha: expect.any(String) } } } });
            expect(publishedRead).not.toHaveProperty('result.previewUrl');
            const calls = download.mock.calls.length;
            expect(await publication('artifact.publish_from_file', { path: '../private.txt' }, sessionCaller))
                .toMatchObject({ ok: false, errorCode: 'artifact_source_forbidden' });
            expect(download).toHaveBeenCalledTimes(calls);
            const cancellation = new AbortController();
            download.mockImplementationOnce(async (request) => {
                await request.destination.writeBytes(new TextEncoder().encode('<h1>Cancelled</h1>'));
                cancellation.abort();
                expect(request.signal?.aborted).toBe(true);
                return { ok: true, name: 'result.html', sizeBytes: 18 };
            });
            expect(await publication('artifact.publish_from_file', { path: 'result.html' }, { ...sessionCaller, signal: cancellation.signal }))
                .toMatchObject({ ok: false });
            expect(stored).toBe(published);
            download.mockImplementationOnce(async () => {
                const session = storage.getState().sessions['publication-session'];
                storage.setState({ sessions: { 'publication-session': { ...session, metadata: { ...session.metadata!, path: '/different-workspace' } } } });
                return { ok: true, name: 'result.html', sizeBytes: 18 };
            });
            expect(await publication('artifact.publish_from_file', { path: 'result.html' }, sessionCaller))
                .toMatchObject({ ok: false, errorCode: 'artifact_source_unavailable' });
            expect(stored).toBe(published);
            download.mockImplementationOnce(async request => {
                await request.destination.writeBytes(new Uint8Array([0, 255, 128, 42]));
                await request.destination.close();
                return { ok: true, name: 'result.bin', sizeBytes: 4 };
            });
            expect(await publication('artifact.publish_from_file', { path: 'result.bin', mime: 'application/octet-stream' }, sessionCaller))
                .toMatchObject({ ok: true });
            expect(await openedPublicHeader()).not.toHaveProperty('source');
            expect(await openedEnvelope()).toMatchObject({ body: { mime: 'application/octet-stream', sizeBytes: 4 } });
            expect(await openedEnvelope()).not.toHaveProperty('provenance');
            const binarySource = (await openedProvenance())!.source;
            expect(binarySource).toMatchObject({ sessionId: 'publication-session', machineId: 'publication-machine', path: 'result.bin', sha: expect.any(String) });
            expect(await publication('artifact.update', { artifactId: stored!.id, expectedRevision: { headerVersion: 1, bodyVersion: 1 },
                header: { title: 'Rewritten', source: { sessionId: 'forged' } }, body: 'replacement' }, caller)).toMatchObject({ ok: true });
            expect(await openedPublicHeader()).not.toHaveProperty('source');
            expect(await openedEnvelope()).toEqual({ body: 'replacement' });
            expect(await openedProvenance()).toEqual({ savedBy: { kind: 'person', accountId: 'artifact-account' }, source: binarySource });
        } finally { context.dispose(); }
    });
    it('cancels an operation-scoped async Settings transform before its durable write', async () => {
        const home = await upsertAndActivateServer({ serverUrl: 'https://profile-mutation-cancellation.test', scope: 'tab' });
        const token = `header.${encodeBase64(new TextEncoder().encode(JSON.stringify({ sub: 'profile-account' })), 'base64url')}.signature`;
        vi.spyOn(TokenStorage, 'getCredentialsForServerUrl').mockResolvedValue({ token });
        let raw: Record<string, unknown> = { futureSibling: { retained: true } };
        runtimeFetch.mockImplementation(async (url: unknown, init?: RequestInit) => {
            const path = new URL(String(url)).pathname;
            if (path === '/health' || path === '/v1/auth/ping') return json({});
            if (path === '/v1/features') return json({ features: {}, capabilities: { accountStoredContentCompatibility: {
                v: 1, minimumProtocolVersion: CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION,
                currentProtocolVersion: CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION,
                declarationTransport: 'http-header-and-socket-auth-v1',
            } } });
            if (path === '/v1/account/encryption') return json({ mode: 'plain', updatedAt: 0 });
            if (path === '/v2/account/settings') {
                if (init?.method === 'POST') {
                    const write = JSON.parse(String(init.body)) as { content: { v: Record<string, unknown> } };
                    raw = write.content.v;
                    return json({ success: true, version: 5 });
                }
                return json({ content: { t: 'plain', v: raw }, version: 4 });
            }
            return json({ error: 'unexpected' }, 404);
        });
        const context = await captureLazyActionAccountContext(home.id);
        const controller = new AbortController();
        let began!: () => void;
        let release!: () => void;
        const started = new Promise<void>(resolve => { began = resolve; });
        const held = new Promise<void>(resolve => { release = resolve; });
        try {
            const mutation = context.mutateRawSettings(async current => {
                began();
                await held;
                return { ...current, showLineNumbers: false };
            }, { signal: controller.signal });
            const rejected = expect(mutation).rejects.toMatchObject({ name: 'AbortError' });
            await started;
            controller.abort();
            release();
            await rejected;
            expect(raw).toEqual({ futureSibling: { retained: true } });
            expect(await context.readRawSettings()).toEqual(raw);
        } finally { release(); context.dispose(); }
    });

    it.each(['operation', 'invocation', 'account'] as const)('preserves an acknowledged Settings effect after %s retirement without publishing into a replacement Account', async (retirement) => {
        const previous = storage.getState();
        const home = await upsertAndActivateServer({ serverUrl: `https://settings-receipt-${retirement}.test`, scope: 'tab' });
        const token = `header.${encodeBase64(new TextEncoder().encode(JSON.stringify({ sub: 'artifact-account' })), 'base64url')}.signature`;
        vi.spyOn(TokenStorage, 'getCredentialsForServerUrl').mockResolvedValue({ token });
        const invocation = new AbortController();
        const operation = new AbortController();
        const replacementScope = { serverId: home.id, accountId: 'replacement-account' };
        let raw: Record<string, unknown> = { futureSibling: { retained: true } };
        runtimeFetch.mockImplementation(async (url: unknown, init?: RequestInit) => {
            const path = new URL(String(url)).pathname;
            if (path === '/health' || path === '/v1/auth/ping') return json({});
            if (path === '/v1/features') return json({ features: {}, capabilities: { accountStoredContentCompatibility: {
                v: 1, minimumProtocolVersion: CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION,
                currentProtocolVersion: CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION,
                declarationTransport: 'http-header-and-socket-auth-v1',
            } } });
            if (path === '/v1/account/encryption') return json({ mode: 'plain', updatedAt: 0 });
            if (path === '/v2/account/settings') {
                if (init?.method !== 'POST') return json({ content: { t: 'plain', v: raw }, version: 4 });
                const write = JSON.parse(String(init.body)) as { content: { v: Record<string, unknown> } };
                raw = write.content.v;
                // The transport has an actual durable success, but the invoker retires
                // while consuming its receipt. Only content disclosure remains scoped.
                return Object.assign(json({ success: true, version: 5 }), { json: async () => {
                    storage.setState({ settingsScope: replacementScope, settingsVersion: 77 });
                    if (retirement === 'operation') operation.abort();
                    else if (retirement === 'invocation') invocation.abort();
                    else await TokenStorage.setCredentialsForServerUrl(home.serverUrl, { serverId: home.id }, { token: 'replacement-account' });
                    return { success: true, version: 5 };
                } });
            }
            return json({ error: 'unexpected' }, 404);
        });
        const context = await captureLazyActionAccountContext(home.id, invocation.signal);
        try {
            await expect(context.mutateRawSettings(current => ({ ...current, showLineNumbers: false }), { signal: operation.signal }))
                .resolves.toMatchObject({ status: 'applied', settingsVersion: 5 });
            expect(raw).toEqual({ futureSibling: { retained: true }, showLineNumbers: false });
            expect(storage.getState().settingsScope).toEqual(replacementScope);
            expect(storage.getState().settingsVersion).toBe(77);
        } finally { context.dispose(); storage.setState(previous); }
    });

    it('rejects captured-scope retirement before dispatch and after an asynchronous read', async () => {
        const home = await upsertAndActivateServer({ serverUrl: 'https://artifact-retirement.test', scope: 'tab' });
        const token = `header.${encodeBase64(new TextEncoder().encode(JSON.stringify({ sub: 'artifact-account' })), 'base64url')}.signature`;
        vi.spyOn(TokenStorage, 'getCredentialsForServerUrl').mockResolvedValue({ token });
        let releaseRead: (() => void) | undefined;
        let readStarted: (() => void) | undefined;
        const started = new Promise<void>((resolve) => { readStarted = resolve; });
        runtimeFetch.mockImplementation(async (url: unknown) => {
            const target = new URL(String(url));
            if (target.pathname === '/v1/account/encryption') return json({ mode: 'plain', updatedAt: 0 });
            if (target.pathname === '/v1/artifacts/held') {
                readStarted!();
                await new Promise<void>((resolve) => { releaseRead = resolve; });
                return json({ error: 'missing' }, 404);
            }
            return json({});
        });
        const context = await captureLazyActionAccountContext(home.id);
        try {
            const pending = context.workflowArtifacts.read('held');
            const rejected = expect(pending).rejects.toMatchObject({ code: 'action_account_scope_changed' });
            await started;
            expect(await TokenStorage.setCredentialsForServerUrl(home.serverUrl, { serverId: home.id }, { token: 'replacement-account' })).toBe(true);
            releaseRead!();
            await rejected;
            const dispatched = runtimeFetch.mock.calls.length;
            await expect(context.workflowArtifacts.delete('held')).rejects.toMatchObject({ code: 'action_account_scope_changed' });
            expect(runtimeFetch.mock.calls).toHaveLength(dispatched);
        } finally { context.dispose(); }
    });
    it.each(['plain', 'e2ee'] as const)('reads, pages, creates, CAS-updates and deletes %s content on the captured Home', async (mode) => {
        const home = await upsertAndActivateServer({ serverUrl: `https://workflow-artifacts-${mode}.test`, scope: 'tab' });
        await upsertAndActivateServer({ serverUrl: `https://focused-artifacts-${mode}.test`, scope: 'tab' });
        const token = `header.${encodeBase64(new TextEncoder().encode(JSON.stringify({ sub: 'artifact-account' })), 'base64url')}.signature`;
        vi.spyOn(TokenStorage, 'getCredentialsForServerUrl').mockResolvedValue(mode === 'plain'
            ? { token } : { token, secret: encodeBase64(new Uint8Array(32).fill(24), 'base64url') });
        let stored: Artifact | undefined;
        const requests: URL[] = [];
        runtimeFetch.mockImplementation(async (url: unknown, init?: RequestInit) => {
            const target = new URL(String(url));
            if (target.pathname === '/health' || target.pathname === '/v1/auth/ping') return json({});
            if (target.pathname === '/v1/features') return json({ features: {}, capabilities: { accountStoredContentCompatibility: {
                v: 1, minimumProtocolVersion: CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION,
                currentProtocolVersion: CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION,
                declarationTransport: 'http-header-and-socket-auth-v1',
            } } });
            requests.push(target);
            expect(target.origin).toBe(home.serverUrl);
            expect(new Headers(init?.headers).get('Authorization')).toBe(`Bearer ${token}`);
            if (target.pathname === '/v1/account/encryption') return json({ mode, updatedAt: 0 });
            if (target.pathname === '/v1/artifacts' && init?.method === 'POST') {
                const body = JSON.parse(String(init.body)) as ArtifactCreateRequest;
                stored = { ...body, ownerAccountId: 'artifact-account', access: 'owner', encryptionMode: mode, headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 9 };
                return json(stored);
            }
            if (target.pathname === '/v1/artifacts') return json(stored ? [stored] : []);
            if (target.pathname.endsWith('/transport-error')) return json({ error: 'denied' }, 403);
            if (target.pathname.endsWith('/locked')) return json({ ...stored, id: 'locked', encryptionMode: 'e2ee', header: 'broken', dataEncryptionKey: 'unopenable' });
            if (stored && target.pathname.endsWith('/recipients')) return json({ artifactId: stored.id,
                ownerAccountId: stored.ownerAccountId, access: stored.access, encryptionMode: stored.encryptionMode,
                dataEncryptionKey: stored.dataEncryptionKey, callerDataEncryptionKey: stored.dataEncryptionKey,
                provenanceDataEncryptionKey: stored.provenanceDataEncryptionKey,
                callerProvenanceDataEncryptionKey: stored.provenanceDataEncryptionKey, recipients: [] });
            if (!stored || target.pathname !== `/v1/artifacts/${stored.id}`) return json({ error: 'missing' }, 404);
            if (init?.method === 'DELETE') { stored = undefined; return new Response(null, { status: 204 }); }
            if (init?.method !== 'POST') return json(stored);
            const update = JSON.parse(String(init.body)) as ArtifactUpdateRequest;
            if (update.expectedHeaderVersion !== stored.headerVersion || update.expectedBodyVersion !== stored.bodyVersion) return json({ success: false, error: 'version-mismatch' });
            stored = { ...stored, header: update.header!, body: update.body!, provenance: update.provenance,
                ...(update.provenanceDataEncryptionKey === undefined ? {} : { provenanceDataEncryptionKey: update.provenanceDataEncryptionKey }),
                headerVersion: 2, bodyVersion: 2 };
            return json({ success: true, headerVersion: 2, bodyVersion: 2 });
        });
        const context = await captureLazyActionAccountContext(home.id);
        try {
            const workflowBody = (text: string) => JSON.stringify({ kind: 'workflow-definition.v1', definition: { version: 1,
                defaults: { agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.claude', localId: 'claude' } } },
                blocks: [{ kind: 'step', id: 'review', document: { text, references: [], attachments: [] }, input: [], result: { kind: 'text' } }],
            } });
            const body = workflowBody('Review');
            const artifactId = '11111111-1111-4111-8111-111111111111';
            const header = { kind: 'workflow-definition.v1', definitionId: artifactId, revision: { headerVersion: 1, bodyVersion: 1 }, metadata: { title: 'Workflow' } };
            const port = context.workflowArtifacts;
            expect(await port.read(artifactId)).toBeNull();
            await port.create({ artifactId, header, body });
            expect(stored?.id).toBe(artifactId);
            expect(stored?.dataEncryptionKey === ARTIFACT_PLAIN_DATA_KEY_MARKER).toBe(mode === 'plain');
            const encryption = (await context.resolveAccountEncryption()).encryption;
            const key = encryption ? await encryption.decryptEncryptionKey(stored!.dataEncryptionKey) : null;
            const storedHeader = mode === 'plain' ? decodePlainArtifactStoredContent(stored!.header)
                : await new ArtifactEncryption(key!).decryptHeaderRaw(stored!.header);
            const expectedHeader = withArtifactExcerptV1({ ...header, previewSteps: ['Review'] }, body);
            expect(storedHeader).toEqual(expectedHeader);
            expect(await port.read(artifactId)).toEqual({ artifactId, ownerAccountId: 'artifact-account', access: 'owner', publicAudience: 'unknown', header: expectedHeader, body,
                provenance: { savedBy: { kind: 'person', accountId: 'artifact-account' } }, revision: { headerVersion: 1, bodyVersion: 1 } });
            const page = await port.list({ limit: 1, cursor: 'incoming-cursor' });
            expect(page.items[0]).toMatchObject({ artifactId, ownerAccountId: 'artifact-account', access: 'owner', header: expectedHeader, headerVersion: 1, updatedAt: 9 });
            expect(page.nextCursor).toBe(context.encodeArtifactListCursor(page.items[0]!));
            expect(requests.find((url) => url.searchParams.has('cursor'))?.searchParams.get('cursor')).toBe('incoming-cursor');
            expect(requests.find((url) => url.searchParams.has('limit'))?.searchParams.get('limit')).toBe('1');
            const nextHeader = { ...header, revision: { headerVersion: 2, bodyVersion: 2 } };
            expect(await port.update({ artifactId, expectedRevision: header.revision, header: nextHeader, body })).toEqual({ ok: true, revision: nextHeader.revision });
            expect(await port.update({ artifactId, expectedRevision: header.revision, header: nextHeader, body: workflowBody('Overwrite') })).toMatchObject({ ok: false, errorCode: 'version_mismatch' });
            await expect(port.read('transport-error')).rejects.toMatchObject({ status: 403 });
            await expect(port.read('locked')).rejects.toMatchObject({ code: 'content_unavailable' });
            expect(await port.delete(artifactId)).toEqual({ ok: true });
            expect(await port.read(artifactId)).toBeNull();
        } finally { context.dispose(); }
    });
});
