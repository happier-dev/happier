import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { accountSettingsParse, buildTrustedHostSessionInputAdmissionV1 } from '@happier-dev/protocol';
import { emptyPromptLibraryRecordV1 } from '@happier-dev/protocol/prompts/library/promptLibraryCatalogV1';
import { PromptLibraryCatalogKeyV1Schema } from '@happier-dev/protocol/prompts/library/promptLibraryRowsV1';

import { ApiClient } from '@/api/api';
import { createProtectedFirstInputHomeHarness } from '@/testkit/backends/protectedFirstInputHome.composed.testkit';
import { createDeferred } from '@/testkit/async/deferred';
import { createNativeAgentRuntimeSessionPlan } from '@/agent/runtime/registry/engineRegistry/nativeAgentSession';
import { createExternalContributionFixtures, createLease, createSessionHostServiceOwners } from '@/agent/runtime/registry/engineRegistry/nativeAgentSession.composed.testkit';
import { buildPluginSessionBindingInput } from '@/plugins/runtime/runtimeCore/plugin/sessionLaunch';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import { resetActiveAccountSettingsSnapshotForTests, setActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { runHostSessionRuntime } from './runHostSessionRuntime';
import { createPendingFirstInputCommitter, HAPPIER_DAEMON_PENDING_FIRST_INPUT_ENV_KEY, serializePendingFirstInputForEnv } from '@/daemon/spawn/pendingFirstInput';
import { db } from '../../../../../../server/sources/storage/db';

let home: Awaited<ReturnType<typeof createProtectedFirstInputHomeHarness>>;
beforeAll(async () => { home = await createProtectedFirstInputHomeHarness(); }, 120_000);
afterAll(async () => { await home?.close(); });
afterEach(() => { resetActiveAccountSettingsSnapshotForTests(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it.each([
    { attached: false, retained: false, blank: false },
    { attached: true, retained: false, blank: false },
    { attached: false, retained: true, blank: false },
    { attached: true, retained: true, blank: false },
    { attached: false, retained: false, blank: true },
    { attached: true, retained: false, blank: true },
])('preserves custody after native-open failure (attached=$attached, retained=$retained, blank=$blank)', async ({ attached, retained, blank }) => {
    const text = 'Retain the original first request\nincluding SECOND LINE';
    const fixture = await home.createSession(text, { enqueueImmediately: false, metadata: {
        mcpSelectionV1: { v: 1, managedServersEnabled: false, forceIncludeServerIds: [], forceExcludeServerIds: [] },
    } });
    const credentials = { token: fixture.token, encryption: null };
    const retainedEnv = retained ? { [HAPPIER_DAEMON_PENDING_FIRST_INPUT_ENV_KEY]: serializePendingFirstInputForEnv({
        text, localId: fixture.localId, inputAdmission: buildTrustedHostSessionInputAdmissionV1('ui'),
    }) } : {};
    const committer = createPendingFirstInputCommitter({ env: retainedEnv });
    const failureTranscriptMessage = expect.objectContaining({ content: expect.objectContaining({ t: 'plain',
        v: expect.objectContaining({ meta: expect.objectContaining({ runtimeIssueCode: 'agent_startup_rpc_rejected' }) }) }) });
    const snapshot = { source: 'network' as const, settings: accountSettingsParse({}), rawSettings: {},
        scopeKey: resolveAccountSettingsScopeKey(credentials), settingsVersion: 1, loadedAtMs: 1, settingsSecretsReadKeys: [],
        promptLibraryCatalog: { status: 'ready' as const, rows: PromptLibraryCatalogKeyV1Schema.options.map(key => ({ revision: 1,
            record: emptyPromptLibraryRecordV1(key) })), tombstones: [], diagnostics: [] } };
    setActiveAccountSettingsSnapshot(snapshot);
    const openFailed = createDeferred<void>();
    const failure = Object.assign(new Error('The native Agent could not start'), { diagnostic: {
        code: 'agent_startup_rpc_rejected', severity: 'error', message: 'The native Agent could not start',
    } });
    const agentId = 'acme-startup-original';
    const plan = await createNativeAgentRuntimeSessionPlan({
        ...createExternalContributionFixtures(agentId), lease: createLease(agentId), createSessionHostServiceOwners,
        sessionInput: buildPluginSessionBindingInput({ credentials, directory: fixture.metadata.path }),
        runtime: { sessions: { open: async () => { openFailed.resolve(); throw failure; } } },
    });
    const api = await ApiClient.create(credentials);
    let stop: (() => Promise<void>) | undefined;
    const running = runHostSessionRuntime({ credentials, directory: fixture.metadata.path,
        startedBy: 'daemon', ...(attached ? { existingSessionId: fixture.sessionId } : {}),
        accountSettingsContext: { ...snapshot, whenRefreshed: null } }, {
        ...plan.config, flavor: 'qwen', policyAgentId: 'qwen', backendDisplayName: 'Test Agent',
        providerName: 'Test Agent', uiLogPrefix: '[startup first input]', waitingForCommandLabel: 'Test Agent', agentMessageType: 'qwen',
        runtimeActivityApplicability: 'not_applicable', processLifecycleOwnership: 'caller',
        machineMetadata: { host: 'test', platform: process.platform, happyCliVersion: 'test', homeDir: fixture.metadata.path,
            happyHomeDir: fixture.metadata.path, happyLibDir: fixture.metadata.path },
        loadTerminalDisplay: async () => () => null, shouldRenderTerminalDisplay: () => false,
        formatPromptErrorMessage: String, onRuntimeStopReady: value => { stop = value; },
    }, {
        initializeBackendApiContextFn: async () => ({ api, machineId: fixture.machineId }),
        initializeBackendRunSessionFn: async () => ({ session: fixture.client, reconnectionHandle: null,
            reportedSessionId: fixture.sessionId, attachedToExistingSession: attached,
            ...(retained ? { commitPendingFirstInputAfterRuntimeReady: () => committer.commit(fixture.client) } : {}) }),
    });
    let finished = false;
    let runtimeError: unknown;
    const outcome = running.then(() => { finished = true; return null; }, error => { finished = true; runtimeError = error; return error; });
    try {
        await Promise.race([openFailed.promise, outcome.then(error => { throw error ?? new Error('Host ended before native open'); })]);
        if (!retained) {
            // Reproduce the caller that offers its original only after native
            // startup has already failed, rather than racing the open boundary.
            await vi.waitFor(async () => expect(await db.session.findUniqueOrThrow({ where: { id: fixture.sessionId } }))
                .toMatchObject({ latestTurnStatus: 'failed' }));
        }
        if (blank) {
            expect(finished).toBe(false);
            const transcript = await fixture.readTranscript();
            expect(transcript).not.toEqual(expect.arrayContaining([failureTranscriptMessage]));
            expect(transcript).not.toEqual(expect.arrayContaining([expect.objectContaining({ messageRole: 'user' })]));
            expect(await fixture.readPending()).toEqual([]);
            expect(stop).toBeTypeOf('function');
            await stop!();
            expect(await outcome).toBeNull();
            return;
        }
        if (!retained) await fixture.enqueueFirstInput();
        await vi.waitFor(async () => {
            const transcript = await fixture.readTranscript();
            const inputIndex = transcript.findIndex(row => row.localId === fixture.localId);
            const diagnostic = JSON.stringify({ finished, error: runtimeError instanceof Error ? runtimeError.message : runtimeError,
                pending: (await fixture.readPending()).map(row => ({ localId: row.localId, deliveryState: row.deliveryState,
                    deliveryBlockedReason: row.deliveryBlockedReason })), events: fixture.packets.slice(-5).map(packet => packet.event) });
            expect(inputIndex, diagnostic).toBeGreaterThanOrEqual(0);
            expect(transcript[inputIndex]).toMatchObject({ localId: fixture.localId, messageRole: 'user',
                content: { t: 'plain', v: { content: { type: 'text', text } } } });
            expect(transcript.slice(0, inputIndex)).not.toEqual(expect.arrayContaining([failureTranscriptMessage]));
            expect(transcript.slice(inputIndex + 1), diagnostic).toEqual(expect.arrayContaining([failureTranscriptMessage]));
            expect(await fixture.readPending()).toMatchObject([{ localId: fixture.localId, deliveryState: 'blocked',
                deliveryBlockedReason: 'provider_unavailable_before_acceptance',
                content: { t: 'plain', v: { content: { type: 'text', text } } } }]);
        }, { timeout: 10_000 });
        expect(await outcome).toMatchObject({ diagnostic: { code: 'agent_startup_rpc_rejected', severity: 'error' } });
        if (retained) expect(committer.hasPendingInput).toBe(false);
        await fixture.retryFirstInput();
        expect(await fixture.readPending()).toMatchObject([{ localId: fixture.localId, status: 'queued',
            requestedAction: { v: 1, kind: 'enqueue' }, deliveryState: null, deliveryBlockedReason: null,
            content: { t: 'plain', v: { content: { type: 'text', text } } } }]);
    } finally {
        if (!finished) await stop?.();
        await outcome;
        await fixture.close();
    }
});
