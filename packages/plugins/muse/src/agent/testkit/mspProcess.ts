import { readFile } from 'node:fs/promises';
import { watch } from 'node:fs';
import { basename, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { JsonValue } from '@happier-dev/plugin-sdk';
import { MUSE_MSP_DECISION_PLAYBACK } from './mspDecisionPlayback.js';

export type MuseMspPlaybackStep = Readonly<{
    requestRow: number;
    /** Exclusive original-recording row boundary. Only native recv frames are emitted. */
    receiveUntilRow: number;
}>;

export type MuseMspProcessScenario = 'approval-abort' | 'approval-late-child' | 'approval-allow-once' | 'approval-local-persistent' | 'question-single-choice';

export async function createMuseMspProcessFixture(options?: Readonly<{
    schema?: JsonValue;
    startupEvent?: boolean;
    /** Recorded native startup refusal when neither data root nor home is supplied. */
    requireDataDirectory?: boolean;
    /** Schema-derived busy startup; early turn requests retain the native queued disposition. */
    readinessGuard?: boolean;
    /** Muse 1.4.15's documented ephemeral-session profile refusal. */
    permissionProfileRefusal?: boolean;
    /** Schema-derived alternate/unknown outcomes and incoherent result controls. */
    permissionProfileResult?: Readonly<{ applyOutcome?: string; profileId?: string }>;
    /** Schema-derived admission failures, optionally after the captured native turn/started frame. */
    turnFailure?: 'refuse' | 'eof' | 'started-refuse' | 'started-eof';
    recording?: JsonValue;
    /** File input also permits complete gzip recordings above OS environment-string limits. */
    recordingPath?: string;
    /** Exact receive windows, consumed in order per method after the common handshake. */
    playbackSteps?: readonly MuseMspPlaybackStep[];
    /** Harmless fixture bindings checked by the native process, never echoed in errors/audits. */
    expectedMcpServers?: Readonly<Record<string, JsonValue>>;
    scenario?: MuseMspProcessScenario;
    auditPath?: string;
    /** Native-side notifications injected after an observed host boundary. */
    nativeNotificationPath?: string;
    /** Synthetic native policy store; the host never reads or writes it. */
    nativePolicyPath?: string;
    /** Schema-derived ordering gate: captured settlement/effects precede the held native command ACK. */
    decisionAckPath?: string;
    cwd?: string;
}>) {
    const recordingPath = options?.recordingPath ?? (options?.scenario
        ? fileURLToPath(new URL(`./fixtures/${options.scenario === 'approval-allow-once' ? 'lifecycle' : options.scenario === 'approval-late-child' ? 'child-follow' : 'advanced'}.json`, import.meta.url))
        : undefined);
    const recording = recordingPath ? undefined : options?.recording ?? await readMuseLoginRecording();
    return {
        launch: { executable: { kind: 'systemTool' as const, id: 'muse-cli' },
            env: { MUSE_NO_AUTO_UPDATE: '0', MUSE_TEST_SELECTED_HOME: '/selected/native/home' } },
        resolveExecutable: async () => ({ command: process.execPath, args: ['-e', MUSE_MSP_PLAYBACK_SCRIPT, '--'], env: {
            ...(recordingPath ? { MUSE_TEST_RECORDING_PATH: recordingPath } : { MUSE_TEST_RECORDING: JSON.stringify(recording) }),
            ...(options?.playbackSteps ? { MUSE_TEST_PLAYBACK_STEPS: JSON.stringify(options.playbackSteps) } : {}),
            ...(options?.expectedMcpServers ? { MUSE_TEST_EXPECTED_MCP: JSON.stringify(options.expectedMcpServers) } : {}),
            ...(options?.scenario ? { MUSE_TEST_SCENARIO: options.scenario } : {}),
            ...(options?.permissionProfileResult ? { MUSE_TEST_PROFILE_RESULT: JSON.stringify(options.permissionProfileResult) } : {}),
            MUSE_TEST_PROFILE_REFUSAL: options?.permissionProfileRefusal ? '1' : '0',
            MUSE_TEST_SCHEMA: JSON.stringify(options?.schema ?? {}),
            ...(options?.turnFailure ? { MUSE_TEST_TURN_FAILURE: options.turnFailure } : {}),
            ...(options?.readinessGuard ? { MUSE_TEST_READINESS_GUARD: '1' } : {}),
            MUSE_TEST_STARTUP_EVENT: options?.startupEvent ? '1' : '0',
            ...(options?.requireDataDirectory ? { MUSE_TEST_REQUIRE_DATA_DIRECTORY: '1' } : {}),
            ...(options?.auditPath ? { MUSE_TEST_AUDIT_PATH: options.auditPath } : {}),
            ...(options?.nativeNotificationPath ? { MUSE_TEST_NOTIFICATION_PATH: options.nativeNotificationPath } : {}),
            ...(options?.nativePolicyPath ? { MUSE_TEST_POLICY_PATH: options.nativePolicyPath } : {}),
            ...(options?.decisionAckPath ? { MUSE_TEST_DECISION_ACK_PATH: options.decisionAckPath } : {}),
        } }),
        resolvePath: async () => options?.cwd ?? process.cwd(),
    };
}

/** Exact sanitized Muse 1.4.14 capture from
 * .project/research/2026-11-09-muse-code/fixtures/login-smoke.json.
 * Playback performs no model calls or credential reads. */
export async function readMuseLoginRecording(): Promise<JsonValue> {
    return JSON.parse(await readFile(fileURLToPath(new URL('./fixtures/login-smoke.json', import.meta.url)), 'utf8'));
}

/** Exact sanitized MSP capture and companion summary originate at
 * .project/research/2026-11-09-muse-code/fixtures/history{,-summary}.json.
 * Only the wire capture's rows are playback input; retained physical logs and
 * exports mentioned in the summary are never a transcript-reading fallback. */
export async function readMuseHistoryRecording(): Promise<JsonValue> {
    return JSON.parse(await readFile(fileURLToPath(new URL('./fixtures/history.json', import.meta.url)), 'utf8'));
}

export type MuseMspProcessAudit = Readonly<{
    initializeCount: number;
    initializedCount: number;
    methods: readonly string[];
    commandCount: number;
    /** Fixture-only native inputs, never a production diagnostic/log carrier. */
    turnInputs: readonly (readonly JsonValue[])[];
    commandTargets: readonly Readonly<{ method: string; commandId: string; sessionId?: string; providerId?: string;
        modelId?: string; approvalMode?: string; mode?: string; permissionProfile?: string; profileId?: string; reasoningEffort?: string; turnId?: string; expectedTurnId?: string; lastTurnId?: string }>[];
    modelSelections: readonly Readonly<{ providerId?: string | null; modelId?: string }>[];
    modelListSessionIds: readonly (string | null)[];
    viewPages: readonly Readonly<{ sessionId: string | null; cursor: string | null }>[];
    sessionReads: readonly Readonly<{ sessionId: string | null; excludeItems: boolean | null }>[];
    cwd: string;
    args: readonly string[];
    autoUpdate?: string;
    selectedHome?: string;
    receiptCount: number;
    nativeResponseCount: number;
    decisionCount: number;
    released: boolean;
    decisionAckPending: boolean;
    earlyTurnCount: number;
    readinessState: 'busy' | 'ready';
}>;

/** Reads only the playback child's opt-in fixture evidence. */
export async function readMuseMspProcessAudit(path: string): Promise<MuseMspProcessAudit> {
    // This test-only OS boundary is written exclusively by the playback schema below.
    return JSON.parse(await readFile(path, 'utf8')) as MuseMspProcessAudit;
}

/** Observable OS receipt barrier; no timer, polling, or product instrumentation. */
export async function waitForMuseMspProcessAudit(
    path: string,
    accept: (audit: MuseMspProcessAudit) => boolean,
    options?: Readonly<{ signal?: AbortSignal }>,
): Promise<MuseMspProcessAudit> {
    return await new Promise((resolve, reject) => {
        const watcher = watch(dirname(path), (_event, filename) => {
            if (filename === basename(path)) void read();
        });
        const close = () => { watcher.close(); options?.signal?.removeEventListener('abort', abort); };
        const abort = () => { close(); reject(options?.signal?.reason); };
        watcher.on('error', error => { close(); reject(error); });
        async function read() {
            try {
                const audit = await readMuseMspProcessAudit(path);
                if (accept(audit)) { close(); resolve(audit); }
            } catch (error) {
                if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) { close(); reject(error); }
            }
        }
        options?.signal?.addEventListener('abort', abort, { once: true });
        if (options?.signal?.aborted) abort();
        else void read();
    });
}

/** Only the Muse side of the OS boundary. The SDK host owns all RPC transport. */
export const MUSE_MSP_PLAYBACK_SCRIPT = String.raw`
const readline = require('node:readline');
if (process.env.MUSE_TEST_REQUIRE_DATA_DIRECTORY === '1' && !process.env.XDG_DATA_HOME && !process.env.HOME) {
    process.stderr.write('resolve serve paths: no usable data directory from XDG_DATA_HOME or HOME');
    process.exit(1);
}
${MUSE_MSP_DECISION_PLAYBACK}
const recordingPath = process.env.MUSE_TEST_RECORDING_PATH;
const recordingBytes = recordingPath ? require('node:fs').readFileSync(recordingPath) : undefined;
const recording = recordingPath
    ? JSON.parse((recordingPath.endsWith('.gz') ? require('node:zlib').gunzipSync(recordingBytes) : recordingBytes).toString('utf8'))
    : JSON.parse(process.env.MUSE_TEST_RECORDING);
const decisionPlayback = process.env.MUSE_TEST_SCENARIO ? createDecisionPlayback(recording, process.env.MUSE_TEST_SCENARIO) : undefined;
const playbackSteps = process.env.MUSE_TEST_PLAYBACK_STEPS ? JSON.parse(process.env.MUSE_TEST_PLAYBACK_STEPS) : undefined;
const remainingSteps = new Map();
for (const step of playbackSteps || []) {
    const method = recording.rows[step.requestRow].message.method;
    const queue = remainingSteps.get(method) || [];
    queue.push(step);
    remainingSteps.set(method, queue);
}
const rows = recording.rows.filter(row => row.message && typeof row.message === 'object');
const send = value => process.stdout.write(JSON.stringify(value) + '\n');
const notificationPath = process.env.MUSE_TEST_NOTIFICATION_PATH;
let readinessState = process.env.MUSE_TEST_READINESS_GUARD === '1' ? 'busy' : 'ready';
let earlyTurnCount = 0;
const queuedTurns = [];
const notificationWatcher = notificationPath ? require('node:fs').watch(require('node:path').dirname(notificationPath), (_event, filename) => {
    if (filename !== require('node:path').basename(notificationPath)) return;
    try {
        const fs = require('node:fs');
        const notification = JSON.parse(fs.readFileSync(notificationPath, 'utf8'));
        fs.unlinkSync(notificationPath);
        for (const value of Array.isArray(notification) ? notification : [notification]) {
            decisionPlayback?.observe(value);
            if (value.method === 'session/statusChanged') readinessState = value.params.status === 'running' ? 'busy' : 'ready';
            send(remap(value));
            if (value.method === 'session/statusChanged' && value.params.status === 'idle') {
                for (const queuedTurn of queuedTurns.splice(0)) emitTurnNotifications(queuedTurn);
            }
        }
        writeAudit();
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
}) : undefined;
const decisionAckPath = process.env.MUSE_TEST_DECISION_ACK_PATH;
const decisionAckWatcher = decisionAckPath ? require('node:fs').watch(require('node:path').dirname(decisionAckPath), (_event, filename) => {
    if (filename !== require('node:path').basename(decisionAckPath)) return;
    try {
        require('node:fs').unlinkSync(decisionAckPath);
        for (const acknowledgement of decisionPlayback.releaseAcknowledgements()) send(acknowledgement);
        writeAudit();
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
}) : undefined;
let initialized = false;
let initializeCount = 0;
let initializedCount = 0;
const commands = [];
const commandTargets = [];
const turnInputs = [];
const requests = [];
const receipts = [];
const modelSelections = [];
const modelListSessionIds = [];
const viewPages = [];
const sessionReads = [];
let initializeParams;
const commandIds = new Map();
let approvalRequestId;
function writeAudit() {
    if (!process.env.MUSE_TEST_AUDIT_PATH) return;
    const path = process.env.MUSE_TEST_AUDIT_PATH;
    const fs = require('node:fs');
    fs.writeFileSync(path + '.tmp', JSON.stringify({ initializeCount, initializedCount, methods: requests,
        commandCount: commands.length, commandTargets, turnInputs, modelSelections, modelListSessionIds, viewPages, sessionReads, earlyTurnCount, readinessState, cwd: process.cwd(), args: process.argv.slice(1),
        autoUpdate: process.env.MUSE_NO_AUTO_UPDATE, selectedHome: process.env.MUSE_TEST_SELECTED_HOME,
        nativeResponseCount: receipts.length,
        ...(decisionPlayback?.inspect() ?? { receiptCount: receipts.length, decisionCount: 0, released: false, decisionAckPending: false }) }));
    fs.renameSync(path + '.tmp', path);
}
function remap(value) {
    if (typeof value === 'string') return commandIds.get(value) || value;
    if (Array.isArray(value)) return value.map(remap);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, remap(entry)]));
    return value;
}
function resultFor(method) {
    const index = rows.findIndex(row => row.direction === 'send' && row.message.method === method);
    const request = rows[index]?.message;
    const response = rows.slice(index + 1).find(row => row.direction === 'recv' && row.message.id === request?.id);
    return response?.message.result;
}
function emitTurnNotifications(message) {
    const start = rows.findIndex(row => row.direction === 'send' && row.message.method === 'turn/start');
    const commandId = rows[start]?.message.params?.commandId;
    if (commandId) commandIds.set(commandId, message.params.commandId);
    for (const row of rows.slice(start + 1)) {
        if (row.direction === 'recv' && row.message.method && row.message.method !== 'session/closed') send(remap(row.message));
    }
}
readline.createInterface({ input: process.stdin }).on('line', line => {
    const message = JSON.parse(line);
    if (message.method) requests.push(message.method);
    if (message.method === 'initialize') {
        initializeCount++;
        initializeParams = message.params;
        const result = resultFor('initialize');
        result.schema = { ...result.schema, ...JSON.parse(process.env.MUSE_TEST_SCHEMA || '{}') };
        if (process.env.MUSE_TEST_STARTUP_EVENT === '1') {
            send({ jsonrpc: '2.0', method: 'fixture/startup', params: { stage: 'initialize', pid: process.pid } });
        }
        send({ jsonrpc: '2.0', id: message.id, result });
    } else if (message.method === 'initialized') {
        initialized = true;
        initializedCount++;
    } else if (message.method === 'fixture/inspect') {
        send({ jsonrpc: '2.0', id: message.id, result: { initialized, initializeCount, initializedCount, initializeParams,
            commands, commandTargets, turnInputs, requests, receipts, modelSelections, modelListSessionIds, viewPages, sessionReads, ...decisionPlayback?.inspect(),
            args: process.argv.slice(1), autoUpdate: process.env.MUSE_NO_AUTO_UPDATE,
            selectedHome: process.env.MUSE_TEST_SELECTED_HOME } });
    } else if (message.method === 'fixture/approval') {
        approvalRequestId = message.id;
        send({ jsonrpc: '2.0', id: 'native-approval', method: 'approval/request', params: { approvalId: 'approval-1' } });
    } else if (!message.method) {
        receipts.push(message);
        decisionPlayback?.handle(message);
        writeAudit();
        if (message.id === 'native-approval') send({ jsonrpc: '2.0', id: approvalRequestId, result: {} });
    } else if (!initialized) {
        send({ jsonrpc: '2.0', id: message.id, error: { code: -32000, message: 'Not initialized' } });
    } else if (message.method === 'fixture/refuse') {
        send({ jsonrpc: '2.0', id: message.id, error: { code: -32602, message: 'Invalid native input', data: { field: 'input' } } });
    } else if (message.method === 'fixture/park') {
        // Deliberately no reply: cancellation belongs to the existing RPC owner.
    } else {
        if ((message.method === 'turn/start' || message.method === 'turn/steer') && Array.isArray(message.params?.input)) {
            turnInputs.push(message.params.input);
        }
        if (message.method === 'model/list') modelListSessionIds.push(
            typeof message.params?.sessionId === 'string' ? message.params.sessionId : null);
        if (message.method === 'view/page') viewPages.push({
            sessionId: typeof message.params?.sessionId === 'string' ? message.params.sessionId : null,
            cursor: typeof message.params?.cursor === 'string' ? message.params.cursor : null,
        });
        if (message.method === 'session/read') sessionReads.push({
            sessionId: typeof message.params?.sessionId === 'string' ? message.params.sessionId : null,
            excludeItems: typeof message.params?.excludeItems === 'boolean' ? message.params.excludeItems : null,
        });
        if (message.method === 'session/start') modelSelections.push({
            providerId: message.params?.providerId, modelId: message.params?.modelId,
        });
        if ((message.method === 'session/start' || message.method === 'session/resume') && process.env.MUSE_TEST_EXPECTED_MCP) {
            const expected = JSON.parse(process.env.MUSE_TEST_EXPECTED_MCP);
            const received = message.params?.config?.mcpServers;
            if (!Object.entries(expected).every(([name, value]) => require('node:util').isDeepStrictEqual(received?.[name], value))) {
                send({ jsonrpc: '2.0', id: message.id, error: { code: -32602,
                    message: 'Native MCP fixture binding did not match', data: { kind: 'invalidParams', fixtureSchemaDerived: true } } });
                writeAudit();
                return;
            }
        }
        const step = playbackSteps ? remainingSteps.get(message.method)?.shift() : undefined;
        const recordedRequest = step ? recording.rows[step.requestRow].message
            : !playbackSteps ? rows.find(row => row.direction === 'send' && row.message.method === message.method)?.message : undefined;
        if (recordedRequest?.params?.commandId && message.params?.commandId) {
            commandIds.set(recordedRequest.params.commandId, message.params.commandId);
        }
        // Schema-derived response matching the isolated Muse 1.4.14 no-turn control probe.
        const result = message.method === 'session/setApprovalMode' ? {
            commandId: message.params.commandId, status: 'accepted', applyOutcome: 'completed',
            effectiveMode: { mode: message.params.mode, source: 'approvalReconfigure', lastCommandId: message.params.commandId },
        } : resultFor(message.method);
        if (message.params?.commandId) {
            commands.push(message.params.commandId);
            const target = { method: message.method, commandId: message.params.commandId };
            for (const key of ['sessionId', 'providerId', 'modelId', 'approvalMode', 'mode', 'permissionProfile', 'profileId', 'reasoningEffort', 'turnId', 'expectedTurnId']) {
                if (typeof message.params[key] === 'string') target[key] = message.params[key];
            }
            if (typeof message.params.model?.modelId === 'string') target.modelId = message.params.model.modelId;
            if (typeof message.params.model?.providerId === 'string') target.providerId = message.params.model.providerId;
            if (typeof message.params.cutPoint?.lastTurnId === 'string') target.lastTurnId = message.params.cutPoint.lastTurnId;
            commandTargets.push(target);
        }
        // Muse 1.4.15 SessionSetPermissionProfileParams/Result; schema-derived
        // boundary variation, not a captured successful native transaction.
        if (message.method === 'session/setPermissionProfile') {
            if (process.env.MUSE_TEST_PROFILE_REFUSAL === '1') {
                send({ jsonrpc: '2.0', id: message.id, error: { code: -32030, message: 'Permission profile is fixed for ephemeral Sessions',
                    data: { kind: 'commandRejected', commandId: message.params.commandId,
                        reason: 'permission_profile_ephemeral_fixed', retryable: false } } });
            } else {
                const profileResult = process.env.MUSE_TEST_PROFILE_RESULT ? JSON.parse(process.env.MUSE_TEST_PROFILE_RESULT) : { applyOutcome: 'completed' };
                send({ jsonrpc: '2.0', id: message.id, result: { status: 'accepted',
                    commandId: message.params.commandId, applyOutcome: profileResult.applyOutcome, permissionState: {
                        profileId: profileResult.profileId ?? message.params.profileId, reviewerAuthority: 'human', reviewerAttached: true,
                    } } });
            }
            writeAudit();
            return;
        }
        if (message.method === 'turn/start' && process.env.MUSE_TEST_READINESS_GUARD === '1' && readinessState === 'busy') {
            // Schema-derived ordering of the native documented queue disposition;
            // no claim that this startup interleaving was captured from Muse.
            earlyTurnCount++;
            queuedTurns.push(message);
            send({ jsonrpc: '2.0', id: message.id, result: {
                ...remap(result), disposition: 'queued', startedNewTurn: false,
            } });
            writeAudit();
            return;
        }
        const turnFailure = process.env.MUSE_TEST_TURN_FAILURE;
        if (message.method === 'turn/start' && turnFailure) {
            if (turnFailure.startsWith('started-')) {
                send(remap(rows.find(row => row.direction === 'recv' && row.message.method === 'turn/started').message));
            }
            if (turnFailure.endsWith('refuse')) {
                // Failure grammar is native; this chosen admission interleaving
                // is schema-derived, not a claim of vendor-observed refusal.
                send({ jsonrpc: '2.0', id: message.id, error: { code: -32030, message: 'Synthetic native admission refusal',
                    data: { kind: 'commandRejected', commandId: message.params.commandId, reason: 'fixtureForcedRefusal',
                        retryable: false, details: { fixtureSchemaDerived: true } } } });
            }
            writeAudit();
            if (turnFailure.endsWith('eof')) process.stdout.write('', () => process.exit(0));
            return;
        }
        if (playbackSteps && message.method !== 'session/setApprovalMode') {
            if (!step) {
                send({ jsonrpc: '2.0', id: message.id, error: { code: -32603,
                    message: 'Playback has no remaining recorded receive window for this method',
                    data: { kind: 'internal', fixtureUnsupportedVector: true } } });
            } else {
                for (const row of recording.rows.slice(step.requestRow + 1, step.receiveUntilRow)) {
                    if (row.direction !== 'recv' || !row.message || typeof row.message !== 'object') continue;
                    const value = remap(row.message);
                    send(!value.method && value.id === recordedRequest.id ? { ...value, id: message.id } : value);
                }
            }
            writeAudit();
            return;
        }
        const scenarioMessages = decisionPlayback?.handle(message);
        if (scenarioMessages !== undefined) {
            for (const value of scenarioMessages) send(value);
            writeAudit();
            return;
        }
        if (result !== undefined) {
            if (message.method === 'session/start') {
                const started = remap(rows.find(row => row.message.method === 'session/started').message);
                if (process.env.MUSE_TEST_READINESS_GUARD === '1') {
                    started.params.session.status = 'running';
                    result.session.status = 'running';
                }
                send(started);
            }
            if (message.method === 'turn/start') emitTurnNotifications(message);
            send({ jsonrpc: '2.0', id: message.id, result: remap(result) });
            writeAudit();
        } else send({ jsonrpc: '2.0', id: message.id, result: {} });
    }
}).on('close', () => {
    notificationWatcher?.close();
    decisionAckWatcher?.close();
    writeAudit();
    const closed = rows.find(row => row.message.method === 'session/closed');
    if (closed) send(closed.message);
});
`;
