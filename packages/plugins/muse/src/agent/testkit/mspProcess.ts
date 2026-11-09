import { readFile } from 'node:fs/promises';
import { watch } from 'node:fs';
import { basename, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { JsonValue } from '@happier-dev/plugin-sdk';
import { MUSE_MSP_DECISION_PLAYBACK } from './mspDecisionPlayback.js';

export type MuseMspProcessScenario = 'approval-abort' | 'approval-allow-once' | 'approval-local-persistent' | 'question-single-choice';

export async function createMuseMspProcessFixture(options?: Readonly<{
    schema?: JsonValue;
    startupEvent?: boolean;
    recording?: JsonValue;
    /** File input also permits complete gzip recordings above OS environment-string limits. */
    recordingPath?: string;
    scenario?: MuseMspProcessScenario;
    auditPath?: string;
    /** Native-side notifications injected after an observed host boundary. */
    nativeNotificationPath?: string;
    /** Synthetic native policy store; the host never reads or writes it. */
    nativePolicyPath?: string;
    cwd?: string;
}>) {
    const recordingPath = options?.recordingPath ?? (options?.scenario
        ? fileURLToPath(new URL(`./fixtures/${options.scenario === 'approval-allow-once' ? 'lifecycle' : 'advanced'}.json`, import.meta.url))
        : undefined);
    const recording = recordingPath ? undefined : options?.recording ?? await readMuseLoginRecording();
    return {
        launch: { executable: { kind: 'systemTool' as const, id: 'muse-cli' },
            env: { MUSE_NO_AUTO_UPDATE: '0', MUSE_TEST_SELECTED_HOME: '/selected/native/home' } },
        resolveExecutable: async () => ({ command: process.execPath, args: ['-e', MUSE_MSP_PLAYBACK_SCRIPT, '--'], env: {
            ...(recordingPath ? { MUSE_TEST_RECORDING_PATH: recordingPath } : { MUSE_TEST_RECORDING: JSON.stringify(recording) }),
            ...(options?.scenario ? { MUSE_TEST_SCENARIO: options.scenario } : {}),
            MUSE_TEST_SCHEMA: JSON.stringify(options?.schema ?? {}),
            MUSE_TEST_STARTUP_EVENT: options?.startupEvent ? '1' : '0',
            ...(options?.auditPath ? { MUSE_TEST_AUDIT_PATH: options.auditPath } : {}),
            ...(options?.nativeNotificationPath ? { MUSE_TEST_NOTIFICATION_PATH: options.nativeNotificationPath } : {}),
            ...(options?.nativePolicyPath ? { MUSE_TEST_POLICY_PATH: options.nativePolicyPath } : {}),
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
    modelSelections: readonly Readonly<{ providerId?: string | null; modelId?: string }>[];
    modelListSessionIds: readonly (string | null)[];
    cwd: string;
    autoUpdate?: string;
    selectedHome?: string;
    receiptCount: number;
    nativeResponseCount: number;
    decisionCount: number;
    released: boolean;
}>;

/** Reads only the playback child's opt-in, content-free shutdown evidence. */
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
${MUSE_MSP_DECISION_PLAYBACK}
const recordingPath = process.env.MUSE_TEST_RECORDING_PATH;
const recordingBytes = recordingPath ? require('node:fs').readFileSync(recordingPath) : undefined;
const recording = recordingPath
    ? JSON.parse((recordingPath.endsWith('.gz') ? require('node:zlib').gunzipSync(recordingBytes) : recordingBytes).toString('utf8'))
    : JSON.parse(process.env.MUSE_TEST_RECORDING);
const decisionPlayback = process.env.MUSE_TEST_SCENARIO ? createDecisionPlayback(recording, process.env.MUSE_TEST_SCENARIO) : undefined;
const rows = recording.rows.filter(row => row.message && typeof row.message === 'object');
const send = value => process.stdout.write(JSON.stringify(value) + '\n');
const notificationPath = process.env.MUSE_TEST_NOTIFICATION_PATH;
const notificationWatcher = notificationPath ? require('node:fs').watch(require('node:path').dirname(notificationPath), (_event, filename) => {
    if (filename !== require('node:path').basename(notificationPath)) return;
    try {
        const fs = require('node:fs');
        const notification = JSON.parse(fs.readFileSync(notificationPath, 'utf8'));
        fs.unlinkSync(notificationPath);
        decisionPlayback?.observe(notification);
        send(notification);
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
}) : undefined;
let initialized = false;
let initializeCount = 0;
let initializedCount = 0;
const commands = [];
const requests = [];
const receipts = [];
const modelSelections = [];
const modelListSessionIds = [];
let initializeParams;
const commandIds = new Map();
let approvalRequestId;
function writeAudit() {
    if (!process.env.MUSE_TEST_AUDIT_PATH) return;
    const path = process.env.MUSE_TEST_AUDIT_PATH;
    const fs = require('node:fs');
    fs.writeFileSync(path + '.tmp', JSON.stringify({ initializeCount, initializedCount, methods: requests,
        commandCount: commands.length, modelSelections, modelListSessionIds, cwd: process.cwd(),
        autoUpdate: process.env.MUSE_NO_AUTO_UPDATE, selectedHome: process.env.MUSE_TEST_SELECTED_HOME,
        nativeResponseCount: receipts.length,
        ...(decisionPlayback?.inspect() ?? { receiptCount: receipts.length, decisionCount: 0, released: false }) }));
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
            commands, requests, receipts, modelSelections, modelListSessionIds, ...decisionPlayback?.inspect(),
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
        if (message.method === 'model/list') modelListSessionIds.push(
            typeof message.params?.sessionId === 'string' ? message.params.sessionId : null);
        if (message.method === 'session/start') modelSelections.push({
            providerId: message.params?.providerId, modelId: message.params?.modelId,
        });
        if (message.params?.commandId) {
            const original = rows.find(row => row.direction === 'send' && row.message.method === message.method)?.message.params?.commandId;
            if (original) commandIds.set(original, message.params.commandId);
        }
        const result = resultFor(message.method);
        if (message.params?.commandId) commands.push(message.params.commandId);
        const scenarioMessages = decisionPlayback?.handle(message);
        if (scenarioMessages !== undefined) {
            for (const value of scenarioMessages) send(value);
            writeAudit();
            return;
        }
        if (result !== undefined) {
            if (message.method === 'session/start') {
                send(remap(rows.find(row => row.message.method === 'session/started').message));
            }
            if (message.method === 'turn/start') {
                const start = rows.findIndex(row => row.direction === 'send' && row.message.method === 'turn/start');
                for (const row of rows.slice(start + 1)) {
                    if (row.direction === 'recv' && row.message.method && row.message.method !== 'session/closed') send(remap(row.message));
                }
            }
            send({ jsonrpc: '2.0', id: message.id, result: remap(result) });
        } else send({ jsonrpc: '2.0', id: message.id, result: {} });
    }
}).on('close', () => {
    notificationWatcher?.close();
    writeAudit();
    const closed = rows.find(row => row.message.method === 'session/closed');
    if (closed) send(closed.message);
});
`;
