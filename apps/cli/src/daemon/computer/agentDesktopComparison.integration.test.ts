import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { availableParallelism, cpus, hostname, loadavg } from 'node:os';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import type { ComputerInputOperationV1, ComputerProviderIdV1 } from '@happier-dev/protocol/computer/v1';

import { createComputerDesktop } from './desktop';
import { createManagedComputerDriver, type ComputerDriverCapture, type ManagedComputerDriver } from './driver/managedComputerDriver';
import { openNativeComputerTransport } from './driver/nativeTransport';

// Native GTK controls via the existing runtime, without requiring C headers
// or optional Python GTK typelibs on the comparison host.
const gtkFixture = `
import ctypes
gtk = ctypes.CDLL('libgtk-3.so.0')
atk = ctypes.CDLL('libatk-1.0.so.0')
gobject = ctypes.CDLL('libgobject-2.0.so.0')
pointer = ctypes.c_void_p
def bind(library, name, result, arguments):
    function = getattr(library, name)
    function.restype = result
    function.argtypes = arguments
    return function
bind(gtk, 'gtk_init_check', ctypes.c_int, [pointer, pointer])
bind(gtk, 'gtk_window_new', pointer, [ctypes.c_int])
bind(gtk, 'gtk_window_set_title', None, [pointer, ctypes.c_char_p])
bind(gtk, 'gtk_box_new', pointer, [ctypes.c_int, ctypes.c_int])
bind(gtk, 'gtk_label_new', pointer, [ctypes.c_char_p])
bind(gtk, 'gtk_entry_new', pointer, [])
bind(gtk, 'gtk_widget_get_accessible', pointer, [pointer])
bind(atk, 'atk_object_set_name', None, [pointer, ctypes.c_char_p])
bind(gtk, 'gtk_entry_set_text', None, [pointer, ctypes.c_char_p])
bind(gtk, 'gtk_entry_get_text', ctypes.c_char_p, [pointer])
bind(gtk, 'gtk_button_new_with_label', pointer, [ctypes.c_char_p])
bind(gobject, 'g_signal_connect_data', ctypes.c_ulong, [pointer, ctypes.c_char_p, pointer, pointer, pointer, ctypes.c_int])
bind(gtk, 'gtk_box_pack_start', None, [pointer, pointer, ctypes.c_int, ctypes.c_int, ctypes.c_uint])
bind(gtk, 'gtk_container_add', None, [pointer, pointer])
bind(gtk, 'gtk_widget_show_all', None, [pointer])
bind(gtk, 'gtk_main', None, [])
if not gtk.gtk_init_check(None, None):
    raise RuntimeError('GTK display unavailable')
window = gtk.gtk_window_new(0)
gtk.gtk_window_set_title(window, b'CU Desktop element probe')
box = gtk.gtk_box_new(1, 8)
label = gtk.gtk_label_new(b'Probe readable label')
entry = gtk.gtk_entry_new()
atk.atk_object_set_name(gtk.gtk_widget_get_accessible(entry), b'Probe text')
gtk.gtk_entry_set_text(entry, b'initial')
callback = ctypes.CFUNCTYPE(None, pointer, pointer)
on_change = callback(lambda widget, data: print('value:' + gtk.gtk_entry_get_text(widget).decode(), flush=True))
button = gtk.gtk_button_new_with_label(b'Probe click')
on_click = callback(lambda widget, data: print('clicked', flush=True))
gobject.g_signal_connect_data(entry, b'changed', on_change, None, None, 0)
gobject.g_signal_connect_data(button, b'clicked', on_click, None, None, 0)
for widget in [label, entry, button]:
    gtk.gtk_box_pack_start(box, widget, 0, 0, 0)
gtk.gtk_container_add(window, box)
gtk.gtk_widget_show_all(window)
print('ready', flush=True)
gtk.gtk_main()
`;

// Samples the actual X server, independent of either driver's reported state.
// Before/after samples cannot detect a transient focus or pointer change.
const sampleX11 = `
import ctypes, json
lib = ctypes.CDLL('libX11.so.6')
lib.XOpenDisplay.restype = ctypes.c_void_p
display = lib.XOpenDisplay(None)
if not display:
    raise RuntimeError('X display unavailable')
lib.XDefaultRootWindow.argtypes = [ctypes.c_void_p]
lib.XDefaultRootWindow.restype = ctypes.c_ulong
lib.XGetInputFocus.argtypes = [ctypes.c_void_p, ctypes.POINTER(ctypes.c_ulong), ctypes.POINTER(ctypes.c_int)]
lib.XQueryPointer.argtypes = [ctypes.c_void_p, ctypes.c_ulong, ctypes.POINTER(ctypes.c_ulong), ctypes.POINTER(ctypes.c_ulong), ctypes.POINTER(ctypes.c_int), ctypes.POINTER(ctypes.c_int), ctypes.POINTER(ctypes.c_int), ctypes.POINTER(ctypes.c_int), ctypes.POINTER(ctypes.c_uint)]
lib.XCloseDisplay.argtypes = [ctypes.c_void_p]
focus, revert = ctypes.c_ulong(), ctypes.c_int()
root, child = ctypes.c_ulong(), ctypes.c_ulong()
x, y, wx, wy, mask = ctypes.c_int(), ctypes.c_int(), ctypes.c_int(), ctypes.c_int(), ctypes.c_uint()
lib.XGetInputFocus(display, ctypes.byref(focus), ctypes.byref(revert))
ok = lib.XQueryPointer(display, lib.XDefaultRootWindow(display), ctypes.byref(root), ctypes.byref(child), ctypes.byref(x), ctypes.byref(y), ctypes.byref(wx), ctypes.byref(wy), ctypes.byref(mask))
print(json.dumps({'focusWindow': focus.value, 'pointer': {'x': x.value, 'y': y.value} if ok else None}))
lib.XCloseDisplay(display)
`;
const execute = promisify(execFile);
const inspectX11 = `
import ctypes, json, os, pathlib, shutil, sys, time
lib = ctypes.CDLL('libX11.so.6')
p = ctypes.c_void_p
u = ctypes.c_ulong
lib.XOpenDisplay.restype = p
lib.XDefaultRootWindow.argtypes = [p]
lib.XDefaultRootWindow.restype = u
lib.XInternAtom.argtypes = [p, ctypes.c_char_p, ctypes.c_int]
lib.XInternAtom.restype = u
lib.XGetWindowProperty.argtypes = [p, u, u, ctypes.c_long, ctypes.c_long, ctypes.c_int, u, ctypes.POINTER(u), ctypes.POINTER(ctypes.c_int), ctypes.POINTER(u), ctypes.POINTER(u), ctypes.POINTER(p)]
lib.XGetAtomName.argtypes = [p, u]
lib.XGetAtomName.restype = p
lib.XFree.argtypes = [p]
lib.XCloseDisplay.argtypes = [p]
display = lib.XOpenDisplay(None)
if not display:
    raise RuntimeError('X display unavailable')
def read(window, name):
    atom = lib.XInternAtom(display, name.encode(), 1)
    if not atom:
        return None
    actual, size, count, remaining, data = u(), ctypes.c_int(), u(), u(), p()
    lib.XGetWindowProperty(display, window, atom, 0, 0, 0, 0, ctypes.byref(actual), ctypes.byref(size), ctypes.byref(count), ctypes.byref(remaining), ctypes.byref(data))
    if data: lib.XFree(data)
    if not actual.value:
        return None
    lib.XGetWindowProperty(display, window, atom, 0, (remaining.value + 3) // 4, 0, 0, ctypes.byref(actual), ctypes.byref(size), ctypes.byref(count), ctypes.byref(remaining), ctypes.byref(data))
    values = list(ctypes.cast(data, ctypes.POINTER(u))[:count.value]) if size.value == 32 else []
    if data: lib.XFree(data)
    if name == '_NET_WM_WINDOW_TYPE':
        names = []
        for value in values:
            text = lib.XGetAtomName(display, value)
            names.append(ctypes.string_at(text).decode() if text else None)
            if text: lib.XFree(text)
        return names
    return values
root = lib.XDefaultRootWindow(display)
wait_started = time.monotonic()
if len(sys.argv) > 2 and sys.argv[2] == 'wait-wm':
    lib.XSelectInput.argtypes = [p, u, ctypes.c_long]
    lib.XNextEvent.argtypes = [p, p]
    lib.XSelectInput(display, root, 1 << 22)
initial_wm_check = read(root, '_NET_SUPPORTING_WM_CHECK')
wm_check = initial_wm_check
if len(sys.argv) > 2 and sys.argv[2] == 'wait-wm':
    event = (ctypes.c_long * 24)()
    while not wm_check:
        lib.XNextEvent(display, event)
        wm_check = read(root, '_NET_SUPPORTING_WM_CHECK')
wm_wait_ms = (time.monotonic() - wait_started) * 1000
window = int(sys.argv[1])
runtime = os.environ.get('XDG_RUNTIME_DIR', '')
print(json.dumps({'openboxExecutable': shutil.which('openbox'), 'fluxboxExecutable': shutil.which('fluxbox'), 'privateFluxboxInitExists': pathlib.Path(runtime, '.fluxbox', 'init').is_file(), 'initialRootSupportingWmCheck': initial_wm_check, 'windowManagerReadyWaitMs': wm_wait_ms, 'rootSupportingWmCheck': wm_check, 'rootClientList': read(root, '_NET_CLIENT_LIST'), 'rootClientListStacking': read(root, '_NET_CLIENT_LIST_STACKING'), 'fixtureWindowType': read(window, '_NET_WM_WINDOW_TYPE') if window else None, 'fixtureWindowPid': read(window, '_NET_WM_PID') if window else None}))
lib.XCloseDisplay(display)
`;
type X11Sample = Readonly<{ focusWindow: number; pointer: { x: number; y: number } | null }>;
async function sample(environment: NodeJS.ProcessEnv): Promise<X11Sample> {
    const { stdout } = await execute('python3', ['-c', sampleX11], { env: environment });
    // Test-only native OS boundary: the script above owns this JSON shape.
    return JSON.parse(stdout) as X11Sample;
}

function startFixture(environment: NodeJS.ProcessEnv) {
    const child = spawn('python3', ['-c', gtkFixture], { env: environment, stdio: ['ignore', 'pipe', 'pipe'] });
    const lines: string[] = [];
    const waiters = new Set<Readonly<{ text: string; resolve(): void; reject(error: Error): void }>>();
    let buffered = '';
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    child.stdout.on('data', (chunk: Buffer) => {
        buffered += chunk.toString();
        for (;;) {
            const end = buffered.indexOf('\n');
            if (end < 0) break;
            const text = buffered.slice(0, end);
            buffered = buffered.slice(end + 1);
            lines.push(text);
            for (const waiter of waiters) if (waiter.text === text) { waiters.delete(waiter); waiter.resolve(); }
        }
    });
    const fail = (error: Error) => { for (const waiter of waiters) waiter.reject(error); waiters.clear(); };
    child.on('error', fail);
    child.on('exit', () => fail(new Error(`GTK fixture exited: ${stderr}`)));
    return { child, lines, waitFor(text: string) {
        if (lines.includes(text)) return Promise.resolve();
        return new Promise<void>((resolve, reject) => waiters.add({ text, resolve, reject }));
    } };
}
async function stop(child: ChildProcess): Promise<void> {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = new Promise<void>(resolve => child.once('exit', () => resolve()));
    child.kill('SIGTERM');
    await exited;
}

function observation(capture: ComputerDriverCapture, name: string, latencyMs: number, before: X11Sample, after: X11Sample) {
    const base64 = capture.png.toString('base64');
    const payloadBytes = Buffer.byteLength(JSON.stringify({ captureId: capture.captureId, accessibility: capture.accessibility,
        geometry: capture.geometry, image: { mimeType: 'image/png', data: base64 } }));
    return { name, latencyMs, before, after, focusChanged: before.focusWindow !== after.focusWindow,
        cursorChanged: JSON.stringify(before.pointer) !== JSON.stringify(after.pointer),
        accessibility: capture.accessibility, geometry: capture.geometry,
        pngBytes: capture.png.length, base64PngBytes: Buffer.byteLength(base64),
        accessibilityJsonBytes: Buffer.byteLength(JSON.stringify(capture.accessibility)), payloadJsonBytes: payloadBytes,
        byteQuarterProxy: Math.ceil(payloadBytes / 4) };
}
type Trial = {
    provider: ComputerProviderIdV1;
    fixturePid?: number;
    discovery?: { latencyMs: number; payloadJsonBytes: number | null; before: X11Sample; after?: X11Sample };
    desktopMetadata?: unknown;
    observations: ReturnType<typeof observation>[];
    actions: { name: string; latencyMs: number; result: Awaited<ReturnType<ManagedComputerDriver['input']>>;
        before: X11Sample; after: X11Sample; focusChanged: boolean; cursorChanged: boolean }[];
    tasks: { open: boolean; readInitial: boolean; clickButton: boolean; fillText: boolean; readValue: boolean };
    fixtureOutput: string[];
    nativeCaptureSample?: Readonly<Record<string, unknown>>;
    nativeDiscoverySamples?: readonly Readonly<{ command: string; exitCode: number | string; latencyMs: number; stdoutJsonBytes: number; envelope: unknown }>[];
    permissions?: Awaited<ReturnType<ManagedComputerDriver['checkPermissions']>> | Readonly<{ error: string }>;
    error?: string;
};

function taskMeasurements(trial: Trial) {
    const read = (name: string, actionName?: string, sharedWith?: string) => {
        const observed = trial.observations.find(entry => entry.name === name);
        const action = trial.actions.find(entry => entry.name === actionName);
        if (!observed) return { attempted: false, usage: null, latencyMs: null };
        return { attempted: true, usage: { observation: name, sharedWith: sharedWith ?? null,
            newObserveCount: sharedWith ? 0 : 1, reusedObserveCount: sharedWith ? 1 : 0, actCount: action ? 1 : 0,
            observationPayloadJsonBytes: observed.payloadJsonBytes, attributedPayloadJsonBytes: sharedWith ? 0 : observed.payloadJsonBytes,
            byteQuarterProxy: sharedWith ? 0 : observed.byteQuarterProxy },
        focusChanged: (sharedWith ? false : observed.focusChanged) || (action?.focusChanged ?? false),
        cursorChanged: (sharedWith ? false : observed.cursorChanged) || (action?.cursorChanged ?? false),
        latencyMs: { observe: observed.latencyMs, action: action?.latencyMs ?? null,
            attributedTotal: (sharedWith ? 0 : observed.latencyMs) + (action?.latencyMs ?? 0) } };
    };
    const bytes = trial.observations.reduce((sum, entry) => sum + entry.payloadJsonBytes, 0);
    const byTask = {
        open: trial.discovery ? { attempted: true, usage: { observeCount: 1, actCount: 0,
            outcome: trial.tasks.open ? 'discovered' : 'failed', payloadJsonBytes: trial.discovery.payloadJsonBytes },
            latencyMs: trial.discovery.latencyMs,
            focusChanged: trial.discovery.after ? trial.discovery.before.focusWindow !== trial.discovery.after.focusWindow : null,
            cursorChanged: trial.discovery.after ? JSON.stringify(trial.discovery.before.pointer) !== JSON.stringify(trial.discovery.after.pointer) : null,
        } : { attempted: false, usage: null, latencyMs: null },
        readInitial: read('read initial'), clickButton: read('read initial', 'click named button', 'readInitial'),
        fillText: read('read before fill', 'fill named text'), readValue: read('read filled value'),
    };
    return { byTask: Object.fromEntries(Object.entries(byTask).map(([name, measurement]) => [name, {
        ...measurement, success: trial.tasks[name as keyof Trial['tasks']], taskTrials: 1,
        successRate: trial.tasks[name as keyof Trial['tasks']] ? 1 : 0,
    }])), uniqueSnapshotTotals: trial.observations.length ? { observeCount: trial.observations.length, actCount: trial.actions.length,
        payloadJsonBytes: bytes, sumOfPerObservationCeilByteQuarterProxies: trial.observations.reduce((sum, entry) => sum + entry.byteQuarterProxy, 0),
        ceilOfAggregateByteQuarterProxy: Math.ceil(bytes / 4) } : null };
}

const cuaExecutable = process.env.HAPPIER_TEST_NATIVE_EXECUTABLE;
const agentDesktopExecutable = process.env.HAPPIER_TEST_AGENT_DESKTOP_EXECUTABLE;
// Outside the source replica and executor scratch directory, so a later source
// synchronization cannot remove the observation before the initiating host reads it.
const artifactPath = '/tmp/cu-agentdesktop-comparison.json';

describe.skipIf(process.platform !== 'linux' || !cuaExecutable || !agentDesktopExecutable)('real native computer provider comparison', () => {
    it.skipIf(process.env.HAPPIER_TEST_WINDOW_MANAGER_EXPECTED !== '1')('starts the installed window manager on the managed desktop', async () => {
        const parentHome = process.env.HOME;
        const desktop = createComputerDesktop();
        let fixture: ReturnType<typeof startFixture> | undefined;
        try {
            const connection = await desktop.ensure();
            const environment = { ...process.env, ...connection.environment };
            fixture = startFixture(environment);
            await fixture.waitFor('ready');
            // Test-only native OS boundary; the script owns these executable fields.
            const metadata = JSON.parse((await execute('python3', ['-c', inspectX11, '0', 'wait-wm'], { env: environment })).stdout) as {
                openboxExecutable: string | null; fluxboxExecutable: string | null;
            };
            console.log(`CU_DESKTOP_WINDOW_MANAGER_JSON:${JSON.stringify(metadata)}`);
            expect(metadata).toEqual(expect.objectContaining({ rootSupportingWmCheck: expect.arrayContaining([expect.any(Number)]) }));
            if (!metadata.openboxExecutable && metadata.fluxboxExecutable) {
                expect((await stat(join(connection.environment.XDG_CONFIG_HOME!, '.fluxbox', 'init'))).isFile()).toBe(true);
            }
        } finally {
            if (fixture) await stop(fixture.child);
            await desktop.dispose();
        }
        expect(process.env.HOME).toBe(parentHome);
    });

    it('compares named GTK tasks through both production adapters', async () => {
        const hostAtStart = { hostname: hostname(), availableParallelism: availableParallelism(), loadavg: loadavg(),
            cpuTimes: cpus().map(cpu => cpu.times) };
        const desktop = createComputerDesktop();
        const trials: Trial[] = [];
        let managedDesktopMetadata: unknown;
        try {
            const connection = await desktop.ensure();
            const environment = { ...process.env, ...connection.environment };
            if (process.env.HAPPIER_TEST_WINDOW_MANAGER_EXPECTED === '1') {
                managedDesktopMetadata = JSON.parse((await execute('python3', ['-c', inspectX11, '0', 'wait-wm'], { env: environment })).stdout);
            }
            for (const provider of ['cua', 'agent-desktop'] as const) {
                const trial: Trial = { provider, observations: [], actions: [], fixtureOutput: [],
                    tasks: { open: false, readInitial: false, clickButton: false, fillText: false, readValue: false } };
                trials.push(trial);
                const fixture = startFixture(environment);
                trial.fixturePid = fixture.child.pid;
                let driver: ManagedComputerDriver | undefined;
                try {
                    await fixture.waitFor('ready');
                    driver = await createManagedComputerDriver({ ...connection, provider,
                        executablePath: provider === 'cua' ? cuaExecutable : agentDesktopExecutable });
                    if (provider === 'agent-desktop') {
                        trial.nativeDiscoverySamples = await Promise.all(['list-displays', 'list-windows', 'permissions'].map(command =>
                            new Promise<NonNullable<Trial['nativeDiscoverySamples']>[number]>(resolve => {
                                const began = performance.now();
                                execFile(agentDesktopExecutable!, [command], { env: environment }, (error, stdout) => {
                                    let envelope: unknown;
                                    try { envelope = JSON.parse(stdout); } catch { envelope = { invalidJson: stdout }; }
                                    resolve({ command, exitCode: error?.code ?? 0, latencyMs: performance.now() - began,
                                        stdoutJsonBytes: Buffer.byteLength(stdout), envelope });
                                });
                            })));
                    }
                    try { trial.permissions = await driver.checkPermissions(); }
                    catch (error) { trial.permissions = { error: error instanceof Error ? error.message : String(error) }; }
                    trial.discovery = { latencyMs: 0, payloadJsonBytes: null, before: await sample(environment) };
                    const discoveryBegan = performance.now();
                    let targets: Awaited<ReturnType<ManagedComputerDriver['listTargets']>>;
                    try { targets = await driver.listTargets(); trial.discovery.payloadJsonBytes = Buffer.byteLength(JSON.stringify(targets)); }
                    finally { trial.discovery.latencyMs = performance.now() - discoveryBegan; trial.discovery.after = await sample(environment); }
                    const selected = targets.find(entry => entry.title === 'CU Desktop element probe'
                        && entry.target.kind === 'window' && entry.target.pid === fixture.child.pid);
                    if (!selected) throw new Error('Named GTK window was not discovered');
                    trial.tasks.open = true;
                    const target = selected.target;
                    if (provider === 'agent-desktop' && target.kind === 'window') {
                        // Independent pinned producer sample, with its ref store
                        // confined to this already-owned desktop's private directory.
                        trial.nativeCaptureSample = JSON.parse((await execute(agentDesktopExecutable!, [
                            'snapshot', '--window-id', String(target.windowId), '--include-bounds',
                        ], { env: { ...environment, AGENT_DESKTOP_HOME: join(environment.XDG_RUNTIME_DIR!, 'comparison-native-snapshot') } })).stdout);
                        console.log(`CU_AGENT_DESKTOP_NATIVE_SNAPSHOT_JSON:${JSON.stringify(trial.nativeCaptureSample)}`);
                    }
                    if (provider === 'cua' && target.kind === 'window') {
                        trial.desktopMetadata = JSON.parse((await execute('python3', ['-c', inspectX11, String(target.windowId)], { env: environment })).stdout);
                        // Characterize the pinned producer independently of adapter normalization.
                        // A separate native process owns this diagnostic snapshot's token store.
                        const probe = await openNativeComputerTransport(cuaExecutable!, connection.displayId, { environment: connection.environment });
                        try { trial.nativeCaptureSample = (await probe.call('get_window_state', { pid: target.pid, window_id: target.windowId,
                            full_output: true, include_screenshot: false, include_accessibility_tree: true })).structuredContent; }
                        finally { await probe.close(); }
                    }
                    const observe = async (name: string) => {
                        const before = await sample(environment);
                        const began = performance.now();
                        const capture = await driver!.capture(target);
                        const latencyMs = performance.now() - began;
                        trial.observations.push(observation(capture, name, latencyMs, before, await sample(environment)));
                        return capture;
                    };
                    const act = async (name: string, captureId: string, operation: ComputerInputOperationV1) => {
                        const before = await sample(environment);
                        const began = performance.now();
                        const result = await driver!.input(target, captureId, operation);
                        const latencyMs = performance.now() - began;
                        const after = await sample(environment);
                        trial.actions.push({ name, latencyMs, result, before, after,
                            focusChanged: before.focusWindow !== after.focusWindow,
                            cursorChanged: JSON.stringify(before.pointer) !== JSON.stringify(after.pointer) });
                        return result.status === 'dispatched' || result.status === 'verified';
                    };
                    const initial = await observe('read initial');
                    const field = initial.accessibility.nodes.find(node => node.name === 'Probe text');
                    trial.tasks.readInitial = field?.value === 'initial';
                    const button = initial.accessibility.nodes.find(node => node.name === 'Probe click');
                    if (!button) throw new Error(`Named button absent: ${initial.accessibility.degradedReason ?? 'no accessibility node'}`);
                    if (!await act('click named button', initial.captureId, { kind: 'element', elementId: button.id, action: 'click' }))
                        throw new Error('Named button action refused');
                    await fixture.waitFor('clicked');
                    trial.tasks.clickButton = true;
                    const beforeFill = await observe('read before fill');
                    const input = beforeFill.accessibility.nodes.find(node => node.name === 'Probe text');
                    if (!input) throw new Error('Named text field absent');
                    trial.tasks.fillText = await act('fill named text', beforeFill.captureId,
                        { kind: 'element', elementId: input.id, action: 'set_value', value: 'comparison value' });
                    if (!trial.tasks.fillText) throw new Error('Named text action refused');
                    await fixture.waitFor('value:comparison value');
                    const afterFill = await observe('read filled value');
                    trial.tasks.readValue = afterFill.accessibility.nodes.some(node => node.name === 'Probe text' && node.value === 'comparison value');
                } catch (error) {
                    trial.error = error instanceof Error ? error.message : String(error);
                } finally {
                    trial.fixtureOutput = [...fixture.lines];
                    await driver?.close();
                    await stop(fixture.child);
                }
            }
        } finally {
            try {
            await mkdir(dirname(artifactPath), { recursive: true });
            const report = { observedAt: new Date().toISOString(), platform: process.platform, artifactPath, managedDesktopMetadata,
                hostAtStart, hostAtFinish: { loadavg: loadavg(), cpuTimes: cpus().map(cpu => cpu.times) },
                cleanup: 'Pending at observation write; test terminal result separately verifies teardown',
                nativeVersions: { cua: '0.37.0', 'agent-desktop': '1.0.2' },
                scope: 'One trial per provider, same GTK controls, one daemon-owned managed desktop, real adapters and native binaries',
                measurement: 'Normalized UTF-8 snapshot JSON includes accessibility, geometry, capture id and base64 PNG. byteQuarterProxy = ceil(payloadJsonBytes/4); this is not model tokenization or image-token accounting. Unique snapshot totals exclude discovery/permissions/diagnostic probes/action request-result bytes. Shared readInitial observation is attributed once. Discovery measures normalized target-list JSON separately; native diagnostic stdout bytes include failed envelopes and are not comparable task costs. Unattempted task usage and latency are null. Focus/cursor before/after samples miss transient changes. No outcome, latency or rate gates.',
                trials: trials.map(trial => ({ ...trial, measurements: taskMeasurements(trial), successes: Object.values(trial.tasks).filter(Boolean).length, taskTrials: Object.keys(trial.tasks).length })) };
            await writeFile(artifactPath, `${JSON.stringify(report, null, 2)}\n`);
            // The executor synchronizes authored source in one direction. Keep
            // the same evidence in its captured log for the initiating checkout.
            console.log(`CU_AGENT_DESKTOP_COMPARISON_JSON:${JSON.stringify(report)}`);
            } finally { await desktop.dispose(); console.log('CU_AGENT_DESKTOP_CLEANUP_JSON:{"status":"passed"}'); }
        }
    });
});
