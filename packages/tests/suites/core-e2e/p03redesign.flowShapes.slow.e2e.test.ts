/**
 * p03redesign flow shape tests F1 (Turn), F2 (Session creation) and F4 (settled idle)
 * (PLAN `.project/plans/2026-11-14-p03-redesign/PLAN.md`, unit X0).
 *
 * One composed stack: light server + recording proxy at the server request boundary + real daemon,
 * Session host, holder and Memory worker + fake Claude. Every daemon, host, indexer and driver request
 * goes through the proxy and is attributed to its calling process by loopback source port, so the
 * counts include requests that owner tests cannot see.
 *
 * The stack is driven once in `beforeAll` (a harness failure fails the suite instead of satisfying
 * `it.fails`). Each flow is `it.fails` until its units land; the unit lane that brings a flow to its
 * target flips it to `it`. The census of each flow is printed so the measured counts stay visible.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, readlinkSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { createTestAuth } from '../../src/testkit/auth';
import { seedCliAuthForTestAccount } from '../../src/testkit/cliAuth';
import { daemonControlPostJson } from '../../src/testkit/daemon/controlServerClient';
import { startTestDaemon, type StartedDaemon } from '../../src/testkit/daemon/daemon';
import { fakeClaudeFixturePath } from '../../src/testkit/fakeClaude';
import { startHttpRequestRecordingProxy, type HttpRequestRecordingProxy, type RecordedHttpProxyRequest } from '../../src/testkit/httpRequestRecordingProxy';
import { encryptLegacyBase64 } from '../../src/testkit/messageCrypto';
import { enqueuePendingQueueV2 } from '../../src/testkit/pendingQueueV2';
import { startServerLight, type StartedServer } from '../../src/testkit/process/serverLight';
import { createRunDirs } from '../../src/testkit/runDir';
import { sleep } from '../../src/testkit/timing';

const run = createRunDirs({ runLabel: 'core' });

type Caller = 'driver' | 'daemon' | 'host' | 'holder' | 'indexer' | 'agent' | `other:${string}`;
type CountedRequest = Readonly<{ caller: Caller; method: string; route: string }>;

const TURNS = 3;
const IDLE_WINDOW_MS = 60_000;

/** Route shape with ids collapsed, so counts group by endpoint. */
function routeOf(path: string): string {
    const [pathname] = path.split('?');
    return (pathname ?? '/')
        .replace(/\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/giu, '/:id')
        .replace(/\/(?=[A-Za-z0-9_-]{20,}(?:\/|$))[A-Za-z0-9_-]+/gu, '/:id');
}

function processTable(): Map<number, { ppid: number; command: string }> {
    const out = new Map<number, { ppid: number; command: string }>();
    const text = execFileSync('ps', ['-axo', 'pid=,ppid=,command='], { encoding: 'utf8', maxBuffer: 64 << 20 });
    for (const line of text.split('\n')) {
        const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/u.exec(line);
        if (match) out.set(Number(match[1]), { ppid: Number(match[2]), command: match[3] ?? '' });
    }
    return out;
}

function descendantsOf(root: number, table: Map<number, { ppid: number; command: string }>): Set<number> {
    const out = new Set<number>([root]);
    let grew = true;
    while (grew) {
        grew = false;
        for (const [pid, row] of table) {
            if (!out.has(pid) && out.has(row.ppid)) { out.add(pid); grew = true; }
        }
    }
    return out;
}

/** Linux: map the client port to its socket inode, then find the owning process among `candidates`. */
function ownerPidFromProc(clientPort: number, proxyPort: number, candidates: Iterable<number>): number | null {
    const inodes = new Set<string>();
    for (const table of ['/proc/net/tcp', '/proc/net/tcp6']) {
        if (!existsSync(table)) continue;
        for (const line of readFileSync(table, 'utf8').split('\n').slice(1)) {
            const fields = line.trim().split(/\s+/u);
            const local = fields[1]?.split(':')[1];
            const remote = fields[2]?.split(':')[1];
            if (local && remote && parseInt(local, 16) === clientPort && parseInt(remote, 16) === proxyPort) inodes.add(fields[9] ?? '');
        }
    }
    for (const pid of candidates) {
        let fds: string[];
        try { fds = readdirSync(`/proc/${pid}/fd`); } catch { continue; }
        for (const fd of fds) {
            try {
                const link = readlinkSync(`/proc/${pid}/fd/${fd}`);
                const inode = /^socket:\[(\d+)\]$/u.exec(link)?.[1];
                if (inode && inodes.has(inode)) return pid;
            } catch { /* fd closed while scanning */ }
        }
    }
    return null;
}

/** macOS (no /proc): lsof names the process whose local end is the client port. */
function ownerPidFromLsof(clientPort: number, proxyPort: number): number | null {
    let text: string;
    try { text = execFileSync('lsof', ['-nP', `-iTCP:${clientPort}`, '-Fpn'], { encoding: 'utf8' }); } catch { return null; }
    let pid: number | null = null;
    for (const line of text.split('\n')) {
        if (line.startsWith('p')) pid = Number(line.slice(1));
        if (line.startsWith('n') && line.includes(`:${clientPort}->`) && line.endsWith(`:${proxyPort}`)) return pid;
    }
    return null;
}

function classify(pid: number, daemonPid: number, command: string): Caller {
    if (pid === process.pid) return 'driver';
    if (pid === daemonPid) return 'daemon';
    if (/session-holder/u.test(command)) return 'holder';
    if (/session-host/u.test(command)) return 'host';
    if (/background-service-worker|memory/iu.test(command)) return 'indexer';
    if (/claude-launch|fake-claude/u.test(command)) return 'agent';
    if (/daemon start/u.test(command)) return 'daemon';
    return `other:${command.replace(/\S*\/(?=[^/\s]+)/gu, '').slice(0, 80)}`;
}

function tally(requests: readonly CountedRequest[]): Record<string, number> {
    const out: Record<string, number> = {};
    for (const request of requests) {
        const key = `${request.caller} ${request.method} ${request.route}`;
        out[key] = (out[key] ?? 0) + 1;
    }
    return Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)));
}

const isModeRead = (r: CountedRequest) => r.method === 'GET' && r.route.startsWith('/v1/account/encryption');
const isFeedRead = (r: CountedRequest) => r.method === 'GET' && r.route.startsWith('/v2/changes');
const isSessionSnapshotRead = (r: CountedRequest) => r.method === 'GET' && /^\/v2\/sessions\/:id$/u.test(r.route);

describe('core e2e: p03redesign flow shapes (F1 Turn, F2 Session creation, F4 settled idle)', () => {
    let server: StartedServer | null = null;
    let proxy: HttpRequestRecordingProxy | null = null;
    let daemon: StartedDaemon | null = null;
    const callerByPort = new Map<number, Caller>();
    const unattributed: string[] = [];
    let f2: { requests: CountedRequest[]; launches: string[][]; newProcesses: Caller[] } | null = null;
    const f1Turns: CountedRequest[][] = [];
    let f4: CountedRequest[] | null = null;

    const counted = (entries: readonly RecordedHttpProxyRequest[]): CountedRequest[] => entries.map((entry) => ({
        caller: (entry.clientPort === null ? undefined : callerByPort.get(entry.clientPort)) ?? 'other:unattributed',
        method: entry.method,
        route: entry.upgraded ? `UPGRADE ${routeOf(entry.path)}` : routeOf(entry.path),
    }));

    async function quiesce(quietMs: number, timeoutMs: number): Promise<void> {
        const startedAt = Date.now();
        let last = proxy!.entries().length;
        let quietSince = Date.now();
        while (Date.now() - startedAt < timeoutMs) {
            await sleep(200);
            const next = proxy!.entries().length;
            if (next !== last) { last = next; quietSince = Date.now(); continue; }
            if (Date.now() - quietSince >= quietMs) return;
        }
        throw new Error(`stack did not quiesce within ${timeoutMs} ms: ${JSON.stringify(tally(counted(proxy!.entries().slice(-20))))}`);
    }

    beforeAll(async () => {
        const testDir = run.testDir(`p03redesign-flow-shapes-${randomUUID()}`);
        server = await startServerLight({ testDir, dbProvider: 'sqlite' });
        const auth = await createTestAuth(server.baseUrl);
        let daemonPid = -1;
        let proxyPort = -1;
        proxy = await startHttpRequestRecordingProxy({
            targetBaseUrl: server.baseUrl,
            onRequestStart: (request) => {
                const port = request.clientPort;
                if (port === null || callerByPort.has(port)) return;
                const table = processTable();
                const candidates = new Set([...descendantsOf(process.pid, table), ...descendantsOf(daemonPid, table)]);
                const pid = existsSync('/proc/net/tcp') ? ownerPidFromProc(port, proxyPort, candidates) : ownerPidFromLsof(port, proxyPort);
                if (pid === null) { unattributed.push(`${request.method} ${routeOf(request.path)}`); return; }
                callerByPort.set(port, classify(pid, daemonPid, table.get(pid)?.command ?? ''));
            },
        });
        proxyPort = Number(new URL(proxy.baseUrl).port);

        const daemonHomeDir = resolve(join(testDir, 'daemon-home'));
        await mkdir(daemonHomeDir, { recursive: true });
        await seedCliAuthForTestAccount({ cliHome: daemonHomeDir, serverUrl: proxy.baseUrl, auth, mode: 'legacy' });

        // Counts every Agent CLI process (Turn runtime and probes such as `auth status`/`--help`).
        const launchDir = resolve(join(testDir, 'claude-launch'));
        const launchLog = join(launchDir, 'launches.jsonl');
        await mkdir(launchDir, { recursive: true });
        await writeFile(join(launchDir, 'package.json'), JSON.stringify({ type: 'module' }));
        await writeFile(join(launchDir, 'claude.js'), [
            "import { appendFileSync } from 'node:fs';",
            `appendFileSync(${JSON.stringify(launchLog)}, JSON.stringify({ pid: process.pid, argv: process.argv.slice(2) }) + '\\n');`,
            `await import(${JSON.stringify(pathToFileURL(fakeClaudeFixturePath()).href)});`,
        ].join('\n'));
        const readLaunches = async (): Promise<string[][]> => {
            try {
                return (await readFile(launchLog, 'utf8')).split('\n').filter(Boolean).map((line) => (JSON.parse(line) as { argv: string[] }).argv);
            } catch { return []; }
        };
        const fakeLog = resolve(join(testDir, 'fake-claude.jsonl'));
        const turnResults = async (): Promise<number> => {
            try {
                return (await readFile(fakeLog, 'utf8')).split('\n').filter((line) => line.includes('"messageType":"result"')).length;
            } catch { return 0; }
        };

        const env = {
            ...process.env,
            CI: '1',
            HAPPIER_VARIANT: 'dev',
            HAPPIER_DISABLE_CAFFEINATE: '1',
            HAPPIER_HOME_DIR: daemonHomeDir,
            HAPPIER_SERVER_URL: proxy.baseUrl,
            HAPPIER_WEBAPP_URL: proxy.baseUrl,
            HAPPIER_CLAUDE_PATH: join(launchDir, 'claude.js'),
            HAPPIER_E2E_FAKE_CLAUDE_LOG: fakeLog,
        };
        daemon = await startTestDaemon({ testDir, happyHomeDir: daemonHomeDir, env, cleanupDescendantsOnExit: true });
        daemonPid = daemon.state.pid;
        await quiesce(5_000, 180_000);

        const spawn = async (name: string) => {
            const directory = resolve(join(testDir, name));
            await mkdir(directory, { recursive: true });
            const result = await daemonControlPostJson<{ success: boolean; sessionId?: string }>({
                port: daemon!.state.httpPort,
                path: '/spawn-session',
                controlToken: daemon!.state.controlToken,
                body: { agent: 'claude', directory, terminal: { mode: 'plain' }, environmentVariables: env },
                timeoutMs: 300_000,
            });
            if (result.status !== 200 || result.data.success !== true || !result.data.sessionId) {
                throw new Error(`spawn ${name} failed: ${JSON.stringify(result.data).slice(0, 400)}`);
            }
            return result.data.sessionId;
        };

        // Session 1 starts the host; F2 measures Session 2 on the warm host.
        await spawn('workspace-1');
        await quiesce(5_000, 180_000);
        unattributed.length = 0;
        const launchesBefore = (await readLaunches()).length;
        const before = processTable();
        const beforeTree = descendantsOf(daemonPid, before);
        proxy.clear();
        const sessionId = await spawn('workspace-2');
        await quiesce(5_000, 180_000);
        const after = processTable();
        f2 = {
            requests: counted(proxy.entries()),
            launches: (await readLaunches()).slice(launchesBefore),
            newProcesses: [...descendantsOf(daemonPid, after)].filter((pid) => !beforeTree.has(pid))
                .map((pid) => classify(pid, daemonPid, after.get(pid)?.command ?? '')),
        };

        // F1: steady Turns on Session 2 (the first Turn's birth metadata writes are measured too).
        for (let turn = 0; turn < TURNS; turn += 1) {
            const resultsBefore = await turnResults();
            proxy.clear();
            const localId = randomUUID();
            const ciphertext = encryptLegacyBase64({
                role: 'user', content: { type: 'text', text: `p03redesign-f1-${turn}` }, localId, meta: { source: 'ui', sentFrom: 'e2e' },
            }, auth.accountSigningSeed);
            const enqueued = await enqueuePendingQueueV2({
                baseUrl: proxy.baseUrl, token: auth.token, sessionId, localId, ciphertext, messageRole: 'user',
                requestedAction: { v: 1, kind: 'send_now' },
            });
            if (enqueued.status !== 200) throw new Error(`enqueue failed: ${enqueued.status}`);
            const startedAt = Date.now();
            while (await turnResults() <= resultsBefore) {
                if (Date.now() - startedAt > 120_000) throw new Error(`Turn ${turn} produced no result`);
                await sleep(200);
            }
            await quiesce(5_000, 120_000);
            f1Turns.push(counted(proxy.entries()));
        }

        // F4: settled idle window with one idle Session.
        proxy.clear();
        await sleep(IDLE_WINDOW_MS);
        f4 = counted(proxy.entries());
    }, 900_000);

    afterAll(async () => {
        await daemon?.stop().catch(() => {});
        await proxy?.stop().catch(() => {});
        await server?.stop().catch(() => {});
    }, 120_000);

    it('attributes every request at the server boundary to its calling process', () => {
        const all = [...(f2?.requests ?? []), ...f1Turns.flat(), ...(f4 ?? [])];
        expect(all.length).toBeGreaterThan(0);
        expect({ unattributed, unknownCallers: all.filter((r) => r.caller.startsWith('other:')).map((r) => `${r.caller} ${r.route}`) })
            .toEqual({ unattributed: [], unknownCallers: [] });
    });

    // F2 target (PLAN Gate §1): Start = daemon `1 POST /v1/sessions` (+1 first-input enqueue only with a prompt), 0 mode reads,
    // 0 Session re-reads; host `1 publisher claim + 0 snapshot reads + ≤1 metadata write`, 0 mode reads; processes on a warm
    // host `0 host + 1 holder + 1 Agent`, 0 CLI probes. Kept: ≤1 forced Account-settings read per spawn (ledger);
    // daemon feed reads are the recorded term `a`.
    it.fails('p03redesign.F2: one plain create on a warm host costs the target requests and processes', () => {
        const { requests, launches, newProcesses } = f2!;
        console.info(`[p03redesign.F2] requests=${requests.length} ${JSON.stringify(tally(requests))} launches=${JSON.stringify(launches)} newProcesses=${JSON.stringify(newProcesses)}`);
        const kept = (r: CountedRequest) => (r.caller === 'daemon' && isFeedRead(r))
            || (r.caller === 'daemon' && r.method === 'GET' && r.route === '/v2/account/settings');
        const measured = requests.filter((r) => !kept(r));
        expect({
            daemonSessionCreates: measured.filter((r) => r.caller === 'daemon' && r.method === 'POST' && r.route === '/v1/sessions').length,
            modeReads: measured.filter(isModeRead).length,
            sessionSnapshotReads: measured.filter(isSessionSnapshotRead).length,
            forcedSettingsReadsOverOne: Math.max(0, requests.filter((r) => r.caller === 'daemon' && r.route === '/v2/account/settings').length - 1),
            hostMetadataWritesOverOne: Math.max(0, measured.filter((r) => r.caller === 'host' && r.method !== 'GET' && /metadata/u.test(r.route)).length - 1),
            agentCliProbes: launches.filter((argv) => argv.includes('--help') || (argv[0] === 'auth' && argv[1] === 'status') || argv.includes('--version')).length,
            hostProcesses: newProcesses.filter((c) => c === 'host').length,
        }).toEqual({
            daemonSessionCreates: 1,
            modeReads: 0,
            sessionSnapshotReads: 0,
            forcedSettingsReadsOverOne: 0,
            hostMetadataWritesOverOne: 0,
            agentCliProbes: 0,
            hostProcesses: 0,
        });
    });

    // F1 target (PLAN Gate §1, Design §F1) for a steady Turn with 0 followers and 0 origin runs:
    // HTTP/Turn = E + d + a + r with E = driver enqueue + host claim, d ≤ 1 Turn-status read; a (daemon feed reads) and the
    // named residual r are recorded, not targeted. Every other term is 0: mode reads, host feed reads (h), own transcript
    // catch-up, pending list before claim, usage POST, Memory indexer page reads, daemon Memory Session reads,
    // follow route reads (F), workflow origin pulls (R).
    it.fails('p03redesign.F1: a steady Turn costs only enqueue, claim and the recorded terms', () => {
        console.info(`[p03redesign.F1] perTurn=${JSON.stringify(f1Turns.map((turn) => ({ total: turn.length, ...tally(turn) })))}`);
        const steady = f1Turns.slice(1);
        const perTurn = (predicate: (r: CountedRequest) => boolean) => steady.flat().filter(predicate).length / steady.length;
        expect({
            modeReads: perTurn(isModeRead),
            hostFeedReads: perTurn((r) => r.caller === 'host' && isFeedRead(r)),
            hostTranscriptReads: perTurn((r) => r.caller === 'host' && r.method === 'GET' && /\/messages/u.test(r.route)),
            pendingListReads: perTurn((r) => r.caller !== 'driver' && r.method === 'GET' && /\/pending/u.test(r.route)),
            usageHttp: perTurn((r) => /usage/u.test(r.route) && r.method === 'POST'),
            indexerReads: perTurn((r) => r.caller === 'indexer'),
            daemonNonFeedReads: perTurn((r) => r.caller === 'daemon' && !isFeedRead(r)),
            followRouteReads: perTurn((r) => /follow/u.test(r.route)),
            workflowOriginPulls: perTurn((r) => /workflow|execution-runs|origin/u.test(r.route)),
        }).toEqual({
            modeReads: 0,
            hostFeedReads: 0,
            hostTranscriptReads: 0,
            pendingListReads: 0,
            usageHttp: 0,
            indexerReads: 0,
            daemonNonFeedReads: 0,
            followRouteReads: 0,
            workflowOriginPulls: 0,
        });
    });

    // F4 target (PLAN Gate §1): settled idle `requests/min = 0` from every caller; liveness travels on sockets.
    it.fails('p03redesign.F4: a settled stack with one idle Session sends 0 HTTP requests per minute', () => {
        console.info(`[p03redesign.F4] window=${IDLE_WINDOW_MS}ms requests=${f4!.length} ${JSON.stringify(tally(f4!))}`);
        expect(f4!.length * 60_000 / IDLE_WINDOW_MS).toBe(0);
    });
});
