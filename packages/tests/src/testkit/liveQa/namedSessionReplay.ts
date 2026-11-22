import { spawn } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { mkdir, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import { chromium, expect, type Page } from '@playwright/test';

import { createTestAuth } from '../auth';
import { seedCliAuthForTestAccount } from '../cliAuth';
import { fakeClaudeEchoResponseText, fakeClaudeFixturePath } from '../fakeClaude';
import { fetchMachineIdentities } from '../machineIdentity';
import { repoRootDir } from '../paths';
import { visibleNewSessionComposer } from '../uiE2e/createSessionFromNewSessionComposer';
import { selectNewSessionAgent } from '../uiE2e/selectNewSessionAgent';
import { canonicalizeServerUrlForUiWeb } from '../uiE2e/uiWebStorageContract';
import { captureNamedSessionComposerState, openNamedSessionComposer } from './openNamedSessionComposer';

const runtimeRoles = ['server', 'daemon'] as const;
const root = repoRootDir();

type Report = (data: object) => void;

type NamedSessionReplayOptions = Readonly<{
    mode: 'check' | 'runtime-check' | 'live';
    stack: string;
    uiOrigin: string;
    identityPrefix: string;
    cut: string;
    productionAsset: string;
    runtimeIdentities: Readonly<Record<typeof runtimeRoles[number], string>>;
    cutoffUtcMs: number;
    report: Report;
}>;

function checkedOrigin(input: unknown): URL {
    if (typeof input !== 'string') throw new Error('Missing URL');
    const url = new URL(input);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
        throw new Error('Invalid QA route');
    }
    return url;
}

async function readCreatePhases(cliHome: string, sessionId: string) {
    const logDirectory = join(cliHome, 'logs');
    const entries = await readdir(logDirectory, { withFileTypes: true });
    const rows: Array<{
        owner: string; phase: string; clock: string; durationMs: number; elapsedMs?: number;
        operationId?: string; turnId?: string; localId?: string;
    }> = [];
    const safeId = (value: unknown) => typeof value === 'string' && /^[\w-]{1,100}$/u.test(value) ? value : undefined;
    for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith('.log')) continue;
        const lines = createInterface({ input: createReadStream(join(logDirectory, entry.name)), crlfDelay: Infinity });
        for await (const line of lines) {
            const match = /^\[(\d\d:\d\d:\d\d\.\d{3})\] (?:\[INFO\] )?(\[DAEMON RUN\] Spawn preparation phase|\[NativeAgentSession\] (?:Open|Turn) phase) (\{.*?\})(?: \[.*\])?$/u.exec(line);
            if (!match || !match[3].includes(sessionId)) continue;
            const [, clock, owner, payload] = match;
            try {
                const record = JSON.parse(payload);
                if (record.sessionId !== sessionId || !safeId(record.phase) || !Number.isFinite(record.durationMs)) continue;
                rows.push({
                    owner, phase: record.phase, clock, durationMs: record.durationMs,
                    elapsedMs: Number.isFinite(record.elapsedMs) ? record.elapsedMs : undefined,
                    operationId: safeId(record.operationId), turnId: safeId(record.turnId), localId: safeId(record.localId),
                });
            } catch { /* partial or different log record */ }
        }
    }
    rows.sort((left, right) => left.clock.localeCompare(right.clock));
    const send = rows.find(row => row.phase === 'send_entered');
    const firstText = rows.find(row => row.phase === 'first_assistant_text' && row.localId === send?.localId && row.turnId === send?.turnId);
    return { sessionId, firstTextJoinedToNativeSend: Boolean(send?.localId && firstText), rows };
}

type StackCommandResult = {
    ok?: boolean;
    retired?: boolean;
    authenticated?: boolean;
    accountId?: string;
    machineId?: string;
    machineRegistered?: boolean;
    daemonRunning?: boolean;
    baseDir?: string;
    urls?: { canonicalServerUrl?: string; internalServerUrl?: string };
    runtime?: { sourceRuntimeIdentities?: Record<string, { selected?: string; loaded?: string }> };
    session?: { id?: string; active?: boolean };
};

export function readNamedFixtureMachineId(status: StackCommandResult, accountId: string): string {
    const machineId = status.machineId;
    if (status.accountId !== accountId || status.authenticated !== true || status.daemonRunning !== true
        || status.machineRegistered !== true || !machineId || !/^[\w-]+$/u.test(machineId)) {
        throw new Error('The named terminal did not attest a registered Machine for the disposable Account');
    }
    return machineId;
}

async function stackCommand(args: string[], overrides?: Readonly<Record<string, string>>, signal?: AbortSignal) {
    signal?.throwIfAborted();
    return await new Promise<StackCommandResult>((resolveResult, reject) => {
        const child = spawn(process.execPath, [join(root, 'apps/stack/scripts/repo_local.mjs'), 'stack', ...args], {
            cwd: root, stdio: ['ignore', 'pipe', 'ignore'], signal,
            ...(overrides ? { env: { ...process.env, ...overrides } } : {}),
        });
        let output = '';
        child.stdout.setEncoding('utf8').on('data', chunk => { output += chunk; });
        child.on('error', reject);
        child.on('close', code => {
            let parsed: (StackCommandResult & { data?: StackCommandResult }) | undefined;
            for (const [index, char] of output.split('').entries()) {
                if (char !== '{' || (index !== 0 && output[index - 1] !== '\n')) continue;
                try { parsed = JSON.parse(output.slice(index)); break; } catch { /* command prelude */ }
            }
            const result = parsed?.data ?? parsed;
            if (code !== 0 || !result || result.ok === false) {
                reject(new Error('Stack command did not succeed'));
            } else resolveResult(result);
        });
    });
}

type RequestRow = {
    method: string;
    path: string;
    start: number;
    status?: number;
    bytes?: number;
    durationMs?: number;
};

async function recordRequests(page: Page, server: URL, ui: string, report: Report) {
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Network.enable');
    let measured: { start: number; wall: number; rows: RequestRow[]; socket: SocketRow[]; marks: Record<string, number> } | undefined;
    const active = new Map<string, RequestRow>();
    const sockets = new Set<string>();
    type SocketRow = { direction: 'in' | 'out'; event: string; start: number };
    await page.exposeBinding('namedSessionReplayPointer', (_source, name: string, wall: number) => {
        if (!measured || !['createSend', 'confirmation', 'steer', 'resumeSend'].includes(name)) return;
        measured.marks[name] ??= Math.round(wall - measured.wall);
    });
    await page.addInitScript(() => {
        document.addEventListener('pointerdown', event => {
            if (!(event.target instanceof Element) || event.button !== 0) return;
            const element = event.target.closest('button, [role="button"]');
            const testId = event.target.closest('[data-testid="new-session-composer-send"], [data-testid="agent-input-send-option-open"], [data-testid="agent-input-send-option-agent_queue"], [data-testid="session-composer-send"]')?.getAttribute('data-testid');
            const label = element?.textContent?.trim().toLowerCase();
            const name = testId === 'new-session-composer-send' || testId === 'agent-input-send-option-open' ? 'createSend'
                : testId === 'agent-input-send-option-agent_queue' ? 'steer'
                : testId === 'session-composer-send' ? 'resumeSend'
                : label === 'create session' ? 'confirmation' : null;
            if (name) void (window as unknown as { namedSessionReplayPointer: (name: string, wall: number) => Promise<void> })
                .namedSessionReplayPointer(name, performance.timeOrigin + performance.now());
        }, { capture: true });
    });
    cdp.on('Network.webSocketCreated', ({ requestId, url }) => {
        const origin = new URL(url).origin.replace(/^ws/u, 'http');
        if (origin === server.origin || origin === ui) sockets.add(requestId);
    });
    cdp.on('Network.webSocketClosed', ({ requestId }) => { sockets.delete(requestId); });
    const captureFrame = (direction: SocketRow['direction']) => ({
        requestId, response,
    }: { requestId: string; response: { opcode: number; payloadData: string } }) => {
        if (!measured || !sockets.has(requestId)) return;
        const label = response.opcode === 1 ? /^42(?:\/[^,]*,)?\d*\["(rpc-call|rpc-request|rpc-response|update|ephemeral)"/u.exec(response.payloadData)?.[1] : undefined;
        const event = label ?? (response.opcode === 1 && /^43/u.test(response.payloadData) ? 'ack' : 'other');
        measured.socket.push({ direction, event, start: Math.round(performance.now() - measured.start) });
    };
    cdp.on('Network.webSocketFrameSent', captureFrame('out'));
    cdp.on('Network.webSocketFrameReceived', captureFrame('in'));
    cdp.on('Network.requestWillBeSent', ({ requestId, request }) => {
        if (!measured) return;
        const url = new URL(request.url);
        if (![server.origin, ui].includes(url.origin) || !/^\/v\d+\//u.test(url.pathname)
            || /^\/v\d+\/auth(?:\/|$)/u.test(url.pathname)) return;
        const path = url.pathname.split('/').map(part => /^[0-9a-z_-]{22,}$/iu.test(part) && !part.includes('-') ? ':id' : part).join('/');
        const row = { method: request.method, path, start: Math.round(performance.now() - measured.start) };
        measured.rows.push(row);
        active.set(requestId, row);
    });
    cdp.on('Network.responseReceived', ({ requestId, response }) => {
        const row = active.get(requestId);
        if (row) row.status = response.status;
    });
    cdp.on('Network.loadingFinished', ({ requestId, encodedDataLength }) => {
        const row = active.get(requestId);
        if (measured && row) {
            row.bytes = encodedDataLength;
            row.durationMs = Math.round(performance.now() - measured.start) - row.start;
        }
        active.delete(requestId);
    });
    cdp.on('Network.loadingFailed', ({ requestId }) => { active.delete(requestId); });
    return {
        async sample(name: string, operation: (mark: (name: string) => void) => Promise<void>) {
            const start = performance.now();
            const startedAtUtcMs = Date.now();
            const rows: RequestRow[] = [];
            const socket: SocketRow[] = [];
            const marks: Record<string, number> = {};
            measured = { start, wall: startedAtUtcMs, rows, socket, marks };
            let completed = false;
            try {
                await operation(mark => { marks[mark] = Math.round(performance.now() - start); });
                completed = true;
            } finally {
                measured = undefined;
                active.clear();
                const group = (keys: readonly string[]) => {
                    const counts: Record<string, number> = {};
                    for (const key of keys) counts[key] = (counts[key] ?? 0) + 1;
                    return counts;
                };
                const countFrom = (from: number) => ({
                    requests: rows.filter(row => row.start >= from).length,
                    http: group(rows.filter(row => row.start >= from).map(row => row.method + ' ' + row.path)),
                    socket: group(socket.filter(row => row.start >= from).map(row => row.direction + ' ' + row.event)),
                });
                report({
                    name, completed, startedAtUtcMs, marks,
                    fullSample: countFrom(0),
                    ...(marks.createSend === undefined ? {} : { fromSend: countFrom(marks.createSend) }),
                    ...(marks.confirmation === undefined ? {} : { fromConfirmation: countFrom(marks.confirmation) }),
                    ...(marks.steer === undefined ? {} : { fromSteer: countFrom(marks.steer) }),
                    ...(name !== 'stopped-resume' || marks.resumeSend === undefined ? {} : { fromResumeSend: countFrom(marks.resumeSend) }),
                });
            }
        },
    };
}

function classifyBrowserFailure(error: unknown): string {
    if (!(error instanceof Error)) return 'unknown';
    if (error.name === 'TimeoutError') return 'timeout';
    if (/target .* has been closed|page closed/iu.test(error.message)) return 'target-closed';
    if (/execution context was destroyed|interrupted by another navigation/iu.test(error.message)) return 'navigation-interrupted';
    const networkCode = /net::(ERR_[A-Z_]+)/u.exec(error.message)?.[1];
    return networkCode ?? 'fixture-step';
}

const visible = (page: Page, testId: string) => page.getByTestId(testId).filter({ visible: true }).first();

export async function runNamedSessionReplay(options: NamedSessionReplayOptions): Promise<void> {
    const { mode, stack, cut, productionAsset } = options;
    const executable = fakeClaudeFixturePath();
    let phase = 'testkit';
    const report: Report = data => options.report({ phase, ...data });
    if (mode === 'check') {
        report({ passed: true, fakeClaudeFound: true });
        return;
    }

    phase = 'runtime-adopted-export';
    const ui = checkedOrigin(options.uiOrigin).origin;
    if (!/^[0-9a-f]{40}$/u.test(cut) || !/^index-[0-9a-f]{32}\.js$/u.test(productionAsset)
        || runtimeRoles.some(role => !options.runtimeIdentities[role])) {
        throw new Error('The QA owner must supply the loaded cut, production asset and runtime identities');
    }
    if (!/^[a-z0-9][a-z0-9_-]{0,47}$/iu.test(options.identityPrefix)) throw new Error('Invalid fixture identity prefix');
    const remainingMs = options.cutoffUtcMs - Date.now();
    if (!Number.isSafeInteger(options.cutoffUtcMs) || remainingMs <= 0) {
        throw new Error('The named replay requires an unexpired workload cutoff');
    }

    // These Stack development scripts are JavaScript. Keep the consumed fields local.
    const [
        { resolveCliHomeDirForIdentity },
        { readSelectedSourceRuntimeRecord },
    ]: [
        { resolveCliHomeDirForIdentity: (input: { cliHomeDir: string; identity: string }) => string },
        { readSelectedSourceRuntimeRecord: (input: {
            stackBaseDir: string; component: typeof runtimeRoles[number];
        }) => Promise<{ identity: string; sourceCapture?: { revision?: string } }> },
    ] = await Promise.all([
        import(join(root, 'apps/stack/scripts/utils/stack/cli_identities.mjs')),
        import(join(root, 'apps/stack/scripts/runtime/shared/source_bundle_record.mjs')),
    ]);
    const workSignal = AbortSignal.timeout(remainingMs);
    phase = 'runtime-identity';
    const info = await stackCommand(['info', stack, '--json'], undefined, workSignal);
    phase = 'runtime-canonical-route';
    const serverUrl = checkedOrigin(info.urls?.canonicalServerUrl);
    phase = 'runtime-internal-route';
    const internalServerUrl = checkedOrigin(info.urls?.internalServerUrl);
    phase = 'runtime-loaded-roles';
    if (!info.baseDir) throw new Error('Stack base directory unavailable');
    const stackBaseDir = info.baseDir;
    const identities = info.runtime?.sourceRuntimeIdentities;
    const selectedRoles = Object.fromEntries(await Promise.all(runtimeRoles.map(async role => {
        const loaded = identities?.[role];
        const selected = await readSelectedSourceRuntimeRecord({ stackBaseDir, component: role });
        if (!loaded?.loaded || loaded.loaded !== loaded.selected || selected.identity !== loaded.loaded
            || selected.sourceCapture?.revision !== cut || loaded.loaded !== options.runtimeIdentities[role]) {
            throw new Error('Selected and loaded runtime must match the named cut');
        }
        return [role, selected.identity] as const;
    })));
    phase = 'runtime-production-http';
    const fetchOptions = { redirect: 'error', signal: workSignal } as const;
    const [html, health] = await Promise.all([fetch(ui, fetchOptions), fetch(new URL('/health', serverUrl), fetchOptions)]);
    if (!health.ok || !html.ok || !(await html.text()).includes(productionAsset)) throw new Error('Production bundle mismatch');
    report({ cut, productionAsset, selectedRoles, sourceRevision: cut });
    if (mode === 'runtime-check') return;

    // The runner executes on the selected daemon host. Configure the fixture only
    // on this named daemon invocation and confine its config to the named home.
    const identity = `${options.identityPrefix}-${randomUUID().slice(0, 8)}`;
    const cliHome = resolveCliHomeDirForIdentity({ cliHomeDir: join(info.baseDir, 'cli'), identity });
    const fakeClaudeConfig = join(cliHome, 'fake-claude');
    const identityArg = '--identity=' + identity;
    const cli = (args: string[], signal = workSignal) => stackCommand(
        ['happier', stack, identityArg, '--runtime=source', '--', ...args, '--json'], undefined, signal,
    );
    let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
    let browserClosure: Promise<boolean> | undefined;
    const closeBrowser = () => browserClosure ??= browser?.close().then(() => true, () => false);
    const stopWork = () => {
        report({ workloadCutoff: true });
        void closeBrowser();
    };
    workSignal.addEventListener('abort', stopWork, { once: true });
    let page: Page | undefined;
    let daemonStarted = false;
    let sessionId: string | undefined;
    let submittedCreate = false;
    const readSessionId = (page: Page) => {
        const url = new URL(page.url());
        return url.origin === ui ? /^\/session\/([\w-]+)$/u.exec(url.pathname)?.[1] : undefined;
    };

    try {
        // Prove Chromium can load the exact Site and its supported recovery form
        // before spending the one replacement Account. Use the actual product
        // sign-in rather than assuming the export's credential storage scope.
        phase = 'browser-launch';
        workSignal.throwIfAborted();
        browser = await chromium.launch({ headless: true });
        workSignal.throwIfAborted();
        const sessionPage = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
        page = sessionPage;
        const restoreUrl = new URL('/restore/manual', ui);
        const profileOrigins = new Set([
            serverUrl.origin, ui, new URL(canonicalizeServerUrlForUiWeb(serverUrl.origin)).origin,
        ]);
        const isProfile = (response: { url(): string }) => {
            const url = new URL(response.url());
            return profileOrigins.has(url.origin) && url.pathname === '/v1/account/profile';
        };
        const isAuth = (url: URL) => /^\/v1\/auth(?:\/|$)/u.test(url.pathname);
        let authRouteRejected = false;
        const outsideFixtureAuth = (url: URL) => isAuth(url) && !profileOrigins.has(url.origin);
        await sessionPage.route(outsideFixtureAuth, async route => {
            authRouteRejected = true;
            await route.abort();
        });
        const restoreInput = visible(sessionPage, 'restore-manual-secret-input');
        const restoreSubmit = visible(sessionPage, 'restore-manual-submit');
        phase = 'browser-restore-route';
        const restoreStartedAt = performance.now();
        const restoreDocument = await sessionPage.goto(restoreUrl.href, { waitUntil: 'domcontentloaded' });
        if (!restoreDocument?.ok() || !(await restoreDocument.text()).includes(productionAsset)
            || new URL(sessionPage.url()).origin !== ui) {
            throw new Error('Browser did not load the approved cut');
        }
        phase = 'browser-restore-form';
        await restoreInput.waitFor({ state: 'visible', timeout: 60_000 });
        report({ restoreFormMs: Math.round(performance.now() - restoreStartedAt) });

        phase = 'fresh-account';
        workSignal.throwIfAborted();
        const auth = await createTestAuth(serverUrl.origin);
        phase = 'fresh-account-profile';
        const profile = await fetch(new URL('/v1/account/profile', serverUrl), {
            ...fetchOptions, headers: { Authorization: 'Bearer ' + auth.token },
        });
        if (!profile.ok) throw new Error('Profile unavailable');
        const { id: accountId } = await profile.json();
        if (typeof accountId !== 'string' || !/^[a-z0-9-]{8,}$/iu.test(accountId)) throw new Error('Invalid Account');
        report({ accountPrefix: accountId.slice(0, 8), identity });

        const profileStatuses: number[] = [];
        const authStatuses: number[] = [];
        const onResponse = (response: { url(): string; status(): number }) => {
            if (isProfile(response)) profileStatuses.push(response.status());
            const url = new URL(response.url());
            if (profileOrigins.has(url.origin) && isAuth(url)) authStatuses.push(response.status());
        };
        sessionPage.on('response', onResponse);
        try {
            phase = 'browser-key-sign-in';
            await restoreInput.fill(Buffer.from(auth.accountSigningSeed).toString('base64url'));
            const [browserProfile] = await Promise.all([
                sessionPage.waitForResponse(response => isProfile(response) && response.ok(), { timeout: 60_000 }),
                restoreSubmit.click(),
            ]);
            phase = 'browser-account-match';
            if ((await browserProfile.json()).id !== accountId) throw new Error('Browser Account mismatch');
            await sessionPage.waitForURL(url => url.origin === ui && url.pathname !== restoreUrl.pathname,
                { timeout: 60_000 });
        } finally {
            sessionPage.off('response', onResponse);
            await sessionPage.unroute(outsideFixtureAuth);
            report({ observedProfileStatuses: profileStatuses, observedAuthStatuses: authStatuses, authRouteRejected });
        }
        const skip = visible(sessionPage, 'onboarding-showcase-story-skip');
        if (await skip.isVisible()) await skip.click();
        const recorder = await recordRequests(sessionPage, serverUrl, ui, report);
        phase = 'empty-reload';
        await recorder.sample('empty-reload', async mark => {
            await sessionPage.reload({ waitUntil: 'domcontentloaded' });
            await visible(sessionPage, 'sessions-empty-state-first-run').waitFor();
            mark('visibleEmptySessions');
        });

        phase = 'terminal-key-exchange';
        workSignal.throwIfAborted();
        await mkdir(cliHome, { mode: 0o700 });
        await mkdir(fakeClaudeConfig, { mode: 0o700 });
        const { machineId: seededMachineId } = await seedCliAuthForTestAccount({
            auth, cliHome, serverUrl: internalServerUrl.href.replace(/\/$/u, ''), mode: 'dataKey',
        });
        phase = 'named-daemon';
        workSignal.throwIfAborted();
        daemonStarted = true;
        await stackCommand(['daemon', stack, 'start', identityArg, '--json'], {
            HAPPIER_CLAUDE_PATH: executable,
            CLAUDE_CONFIG_DIR: fakeClaudeConfig,
        }, workSignal);
        report({ identity, seededMachineId });

        phase = 'named-auth-status';
        const namedAuth = await cli(['auth', 'status']);
        report({
            fixtureAccountMatches: namedAuth.accountId === accountId,
            authenticated: namedAuth.authenticated === true,
            daemonRunning: namedAuth.daemonRunning === true,
            machineRegistered: namedAuth.machineRegistered === true,
            seedMatchesRegisteredMachine: namedAuth.machineId === seededMachineId,
        });
        const machineId = readNamedFixtureMachineId(namedAuth, accountId);

        phase = 'named-machine-active';
        let machineInventory = { seen: false, active: false, additionalActive: 0 };
        try {
            await expect.poll(async () => {
                workSignal.throwIfAborted();
                const machines = await fetchMachineIdentities({ baseUrl: serverUrl.origin, token: auth.token });
                const machine = machines.find(row => row.id === machineId);
                machineInventory = {
                    seen: machine !== undefined,
                    active: machine?.active === true,
                    additionalActive: machines.filter(row => row.id !== machineId && row.active === true).length,
                };
                return machineInventory.active;
            }, { timeout: 90_000 }).toBe(true);
            if (machineInventory.additionalActive !== 0) throw new Error('Disposable fixture has an unexpected active Machine');
        } finally {
            report({ machineId, ...machineInventory });
        }

        const composer = visibleNewSessionComposer(sessionPage);
        const providerChip = visible(sessionPage, 'agent-input-agent-chip');
        const send = visible(sessionPage, 'new-session-composer-send');
        const confirmation = sessionPage.getByRole('button', { name: 'Create session', exact: true }).filter({ visible: true }).first();
        const install = sessionPage.getByRole('button', { name: 'Add agent', exact: true }).filter({ visible: true }).first();
        const prompt = 'lsl 1 2 20';

        let lastComposerState: Awaited<ReturnType<typeof captureNamedSessionComposerState>> = null;
        try {
            phase = 'create-open-exact-machine';
            lastComposerState = await captureNamedSessionComposerState(sessionPage);
            await openNamedSessionComposer(sessionPage, machineId, 60_000);
            if (new URL(sessionPage.url()).origin !== ui) throw new Error('New Session left the attested UI');
            lastComposerState = await captureNamedSessionComposerState(sessionPage);
            report({ reached: true, screen: lastComposerState });

            phase = 'create-wait-provider-chip';
            await providerChip.waitFor({ state: 'visible', timeout: 60_000 });
            report({ visible: true });

            phase = 'create-select-claude';
            await selectNewSessionAgent({ page: sessionPage, agentId: 'claude', label: 'Claude' });
            report({ selected: true });

            phase = 'create-fill-composer';
            await composer.fill(prompt);
            phase = 'create-wait-visible-send';
            await expect(send).toBeVisible({ timeout: 60_000 });
            phase = 'create-wait-enabled-send';
            await expect(send).toBeEnabled({ timeout: 60_000 });
            report({ visible: true, enabled: true });

            // The docked composer defaults to leaving the new Session in the
            // background. Use its explicit Open action for the first-text sample.
            phase = 'create-resolve-send-action';
            await send.click({ button: 'right' });
            const sendAndOpen = visible(sessionPage, 'agent-input-send-option-open');
            const alreadyOpens = visible(sessionPage, 'agent-input-send-option-startAnother');
            await expect(sendAndOpen.or(alreadyOpens)).toBeVisible({ timeout: 60_000 });
            let sendAction = send;
            if (await sendAndOpen.isVisible()) {
                sendAction = sendAndOpen;
            } else {
                await sessionPage.keyboard.press('Escape');
                await expect(alreadyOpens).toBeHidden();
            }

            phase = 'create-send';
            await recorder.sample('create', async mark => {
                submittedCreate = true;
                await sendAction.click();
                phase = 'create-wait-confirmation-or-session';
                let next: 'confirmation' | 'install' | 'session' | undefined;
                await expect.poll(async () => {
                    if (readSessionId(sessionPage)) next = 'session';
                    else if (await install.isVisible()) next = 'install';
                    else if (await confirmation.isVisible()) next = 'confirmation';
                    return next !== undefined;
                }, { timeout: 95_000 }).toBe(true);
                if (next === 'install') throw new Error('The named fake-Claude provider is not ready');
                if (next === 'confirmation') {
                    phase = 'create-confirm';
                    await confirmation.click();
                }

                phase = 'create-wait-session-route';
                await sessionPage.waitForURL(url => url.origin === ui && /^\/session\/[\w-]+$/u.test(url.pathname), { timeout: 120_000 });
                sessionId = readSessionId(sessionPage);
                if (!sessionId) throw new Error('Missing exact Session');
                mark('sessionRoute');

                phase = 'create-wait-first-text';
                await sessionPage.getByText('item 0.0', { exact: false }).filter({ visible: true }).first().waitFor({ timeout: 100_000 });
                await sessionPage.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
                mark('firstVisibleProviderText');
                report({ sessionId });
            });
        } catch (error) {
            const screen = await captureNamedSessionComposerState(sessionPage);
            report({
                failedCreateCheckpoint: phase,
                screen,
                lastComposerState,
                errorKind: classifyBrowserFailure(error),
                sendVisible: await send.isVisible().catch(() => false),
                sendEnabled: await send.isEnabled({ timeout: 1_000 }).catch(() => false),
                createConfirmationVisible: await confirmation.isVisible().catch(() => false),
                addAgentVisible: await install.isVisible().catch(() => false),
            });
            throw error;
        }
        phase = 'create-phase-attribution';
        if (!sessionId) throw new Error('Missing exact Session');
        try {
            report(await readCreatePhases(cliHome, sessionId));
        } catch {
            report({ sessionId, phaseEvidenceAvailable: false });
        }

        phase = 'steer';
        const steerInput = 'QA Session Steer ' + identity;
        await recorder.sample('steer', async mark => {
            await visible(sessionPage, 'session-composer-input').fill('lsl 1 20 900');
            await visible(sessionPage, 'session-composer-send').click();
            await sessionPage.getByText('item 0.2', { exact: false }).filter({ visible: true }).first().waitFor();
            mark('priorTurnFirstText');
            await visible(sessionPage, 'session-composer-input').fill(steerInput);
            await visible(sessionPage, 'session-composer-send').click({ delay: 700 });
            await visible(sessionPage, 'agent-input-send-option-agent_queue').click();
            await sessionPage.getByText(fakeClaudeEchoResponseText(steerInput), { exact: false }).filter({ visible: true }).first().waitFor();
            mark('steerReply');
        });

        phase = 'stop';
        if (!sessionId) throw new Error('Missing exact Session');
        await cli(['session', 'stop', sessionId]);
        const stopped = await cli(['session', 'status', sessionId, '--live']);
        if (stopped.session?.id !== sessionId || stopped.session.active !== false) throw new Error('Session inactivity unverified');
        report({ sessionId, active: false });
        phase = 'stopped-resume';
        const resumeInput = 'QA Stopped Resume ' + identity;
        await recorder.sample('stopped-resume', async mark => {
            await visible(sessionPage, 'session-composer-input').fill(resumeInput);
            await visible(sessionPage, 'session-composer-send').click();
            await sessionPage.getByText(fakeClaudeEchoResponseText(resumeInput), { exact: false }).filter({ visible: true }).first().waitFor();
            mark('firstVisibleProviderText');
        });
        const resumed = await cli(['session', 'status', sessionId, '--live']);
        if (resumed.session?.id !== sessionId || resumed.session.active !== true) throw new Error('Resume activation unverified');
        report({ sessionId, active: true });
    } finally {
        workSignal.removeEventListener('abort', stopWork);
        if (!sessionId && submittedCreate && page) sessionId = readSessionId(page);
        const browserClosed = await closeBrowser();
        if (browser) report({ cleanup: 'browser', closed: browserClosed === true });
        let cleanupVerified = !browser || browserClosed === true;
        if (sessionId) {
            const stopped = await cli(['session', 'stop', sessionId], AbortSignal.timeout(60_000)).then(() => true, () => false);
            const archived = await cli(['session', 'archive', sessionId], AbortSignal.timeout(60_000)).then(() => true, () => false);
            report({ cleanup: 'session', stopped, archived });
            cleanupVerified &&= stopped && archived;
        }
        if (daemonStarted) {
            const retired = await stackCommand(
                ['daemon', stack, 'stop', identityArg, '--retire', '--json'], undefined, AbortSignal.timeout(120_000),
            ).then(result => result.retired === true, () => false);
            report({ cleanup: 'daemon', identity, retired });
            cleanupVerified &&= retired;
        }
        if (!cleanupVerified) throw new Error('Named replay cleanup was not confirmed');
    }
}
