import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { installBrowserClipboardBoundary } from '@/dev/testkit';
import { act } from 'react-test-renderer';
import { Terminal } from '@xterm/xterm';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { createXtermWriteQueue } from '@/components/terminal/xterm/writeQueue';
import { buildXtermWriteCompleteEvent } from '@/components/terminal/xterm/bytes';
import { TERMINAL_OUTPUT_GAP_MARKER } from '@/sync/domains/terminal/stream/runtime';
import { createPf56NativeTerminalPeer } from './pf56NativeTerminalPeer.testkit';
import type { WorkspaceRefV1 } from '@happier-dev/protocol/workspaces/workspaceRefV1';
import type { SessionTerminalMemberV1 } from '@happier-dev/protocol/terminal/workspace';

import { createDeferred, createMachineFixture, flushHookEffects, registerStandardCleanupTarget, renderHook, renderScreen, standardCleanup } from '@/dev/testkit';
import { installTimerCensus } from '@/dev/testkit/performance/timerCensus';
import { ActionOperationSnapshotV1Schema } from '@happier-dev/protocol/actions/operations/v1';
import { TerminalStreamReadResponseSchema, TERMINAL_STREAM_MAX_READ_BYTES, TERMINAL_STREAM_MAX_FRAME_DECODED_BYTES } from '@happier-dev/protocol/terminal/stream';
import { createRpcCallError } from '@happier-dev/protocol/rpcErrors';
import { RPC_ERROR_CODES } from '@happier-dev/protocol/rpc';
import { isRecoverableTerminalRpcError, resolveTerminalAutoRetryDelayMs, TERMINAL_AUTO_RETRY_MAX_ATTEMPTS } from '@/components/sessions/terminal/terminalRpcRecovery';
import { serveActionHomes } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { getServerFeaturesSnapshot } from '@/sync/api/capabilities/serverFeaturesClient';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { publishAppliedActiveServerSnapshot } from '@/sync/runtime/orchestration/appliedActiveServerRuntime';

// Recipient-envelope HTTP is outside this controller journey and must remain unused.
vi.mock('@/sync/api/session/sessionDataKeyEnvelopesApi', () => {
    const unused = () => { throw new Error('Terminal controller unexpectedly reached the recipient-envelope API'); };
    return {
        createSessionDataKeyEnvelopeClient: unused,
        readSessionDataKeyEnvelopeCollectionPage: unused,
        prepareSessionDataKeyEnvelopesForScope: unused,
        prepareSessionDataKeyEnvelopesDetached: unused,
    };
});
import type { DaemonTerminalEnsureResponse } from '@happier-dev/protocol/daemon/terminal';
import type {
    EmbeddedTerminalRendererHandle,
    EmbeddedTerminalRendererResource,
    EmbeddedTerminalWriteBytesResult,
    EmbeddedTerminalWriteCompleteEvent,
} from '@/components/terminal/embedded/embeddedTerminalRendererHandle';
import {
    createEmptyTerminalSurfaceState,
    readTerminalSurfaceState,
    replaceTerminalSurfaceState,
} from '@/components/sessions/terminal/terminalSurfaceStateCache';
import { createMachineReadBatchResponseFixture, createPlainMachineRowFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { observeMachinePresenceForTest, publishMachineInventoryForTest } from '@/dev/testkit/harness/machinePresence';
import { createPlainProjectAccountRowListFixture } from '@/dev/testkit/fixtures/projectAccountRows';
import { createEmptyAccountBootstrapHttpResponse } from '@/dev/testkit/fixtures/accountBootstrapHttpBoundary';
import { ManagedMachineActionOutputSchemasV1 } from '@happier-dev/protocol/machines/managed/actionsV1';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// Response fixtures belong to the external encrypted daemon RPC boundary. The real
// Action admission, policy, machineTerminal codecs and stream carrier all stay live.
const terminalOps = vi.hoisted(() => ({
    ensure: vi.fn(),
    restart: vi.fn(),
    streamRead: vi.fn(),
    streamReadBytes: vi.fn(),
    streamCreditRead: vi.fn(),
    streamAcknowledge: vi.fn(),
    streamSendInput: vi.fn(),
    close: vi.fn(),
    operationGet: vi.fn(),
    operationCancel: vi.fn(),
    input: vi.fn(),
    resize: vi.fn(),
}));

const streamReadSignals = vi.hoisted(() => [] as (AbortSignal | undefined)[]);

let servedHomes: Awaited<ReturnType<typeof serveActionHomes>>;
let homeIds: Readonly<{ primary: string; cancel: string; attach: string }>;
let byteStreamEnabled = true;
let workerWorkspaceRefs: readonly WorkspaceRefV1[] = [];
const queuedWriteResult = { status: 'queued' } satisfies EmbeddedTerminalWriteBytesResult;
const clipboardState = vi.hoisted(() => ({
    setClipboardStringSafe: vi.fn(async (_text: string) => true),
}));
const rendererBoundaryState = vi.hoisted(() => ({ parsed: false }));

// Xterm is the platform rendering boundary; the mounted Project pane, terminal
// controller, Action front door, codecs and transport selection remain real.
vi.mock('@/components/terminal/xterm/XtermTerminalView.web', async () => {
    const React = await import('react');
    const { Terminal } = await import('@xterm/xterm');
    class ParsedRendererResource {
        readonly kind = 'xterm-web';
        readonly terminal = new Terminal({ cols: 100, rows: 24, scrollback: 5000 });
        attached = true;
        retained = false;
        writes = new Set<Promise<void>>();
        whenSettled = async () => { await Promise.all(this.writes); };
        dispose = () => { this.retained = false; if (!this.attached) this.terminal.dispose(); };
        detach = () => { this.attached = false; if (!this.retained) this.terminal.dispose(); };
    }
    return { XtermTerminalView: React.forwardRef<EmbeddedTerminalRendererHandle,
        { retainedResource?: EmbeddedTerminalRendererResource; onReady: (cols: number, rows: number) => void; onInput: (data: string) => void; readOnly?: boolean; onWriteComplete?: (event: EmbeddedTerminalWriteCompleteEvent) => void; testID?: string }>((props, ref) => {
        const [output, setOutput] = React.useState('');
        const resource = React.useRef<ParsedRendererResource | null>(null);
        const currentProps = React.useRef(props);
        currentProps.current = props;
        if (rendererBoundaryState.parsed && !resource.current) {
            // Match real xterm's first-layout adoption, before the controller's passive initialization.
            const retained = props.retainedResource;
            resource.current = retained instanceof ParsedRendererResource && !retained.attached ? retained : new ParsedRendererResource();
            resource.current.attached = true;
        }
        React.useImperativeHandle(ref, () => ({
            write: text => { if (resource.current) resource.current.terminal.write(text);
                else setOutput(previous => previous + text); return true; },
            writeBytes: input => {
                const target = resource.current;
                if (!target) { setOutput(previous => previous + new TextDecoder().decode(input.bytes)); return true; }
                const notify = currentProps.current.onWriteComplete;
                const write = new Promise<void>(resolve => target.terminal.write(input.bytes, () => {
                    notify?.(buildXtermWriteCompleteEvent(input)); resolve();
                }));
                target.writes.add(write);
                void write.then(() => target.writes.delete(write));
                return queuedWriteResult;
            },
            clear: () => { resource.current?.terminal.reset(); setOutput(''); },
            hasSelection: () => false,
            getSelectionText: () => '',
            ...(rendererBoundaryState.parsed ? {
                captureResource: () => { const target = resource.current!; target.retained = true; return target; },
                restoreResource: candidate => {
                    if (resource.current === candidate) return true;
                    if (!(candidate instanceof ParsedRendererResource) || candidate.attached) return false;
                    resource.current?.detach(); resource.current = candidate; candidate.attached = true; return true;
                },
                hasRetainedOutput: () => resource.current?.retained === true,
            } satisfies Partial<EmbeddedTerminalRendererHandle> : {}),
        }), []);
        React.useEffect(() => () => resource.current?.detach(), []);
        React.useEffect(() => props.onReady(80, 24), [props.onReady]);
        return React.createElement('TerminalRenderer', { testID: props.testID, readOnly: props.readOnly, onInput: props.onInput }, output);
    }) };
});
type EmbeddedTerminalWriteBytesInput = Parameters<NonNullable<EmbeddedTerminalRendererHandle['writeBytes']>>[0];

function rendererWriteComplete(input: EmbeddedTerminalWriteCompleteEvent & Readonly<{
    writeGeneration: number;
}>): EmbeddedTerminalWriteCompleteEvent {
    return input;
}

function readWriteGeneration(value: unknown): number | null {
    if (!value || typeof value !== 'object') {
        return null;
    }
    const writeGeneration = (value as Readonly<{ writeGeneration?: unknown }>).writeGeneration;
    return typeof writeGeneration === 'number' && Number.isFinite(writeGeneration)
        ? writeGeneration
        : null;
}

vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', async () => {
    const { RPC_METHODS } = await import('@happier-dev/protocol/rpc');
    const { ACTION_OPERATION_RPC_METHODS_V1, ACTION_OPERATION_RPC_METHODS_V2 } = await import('@happier-dev/protocol/actions/operations/v1');
    const { TerminalStreamReadRequestSchema } = await import('@happier-dev/protocol/terminal/stream');
    const responses = new Map<string, typeof terminalOps.ensure>([
        [ACTION_OPERATION_RPC_METHODS_V2.get, terminalOps.operationGet],
        [ACTION_OPERATION_RPC_METHODS_V1.cancel, terminalOps.operationCancel],
        [RPC_METHODS.DAEMON_TERMINAL_ENSURE, terminalOps.ensure],
        [RPC_METHODS.DAEMON_TERMINAL_RESTART, terminalOps.restart],
        [RPC_METHODS.DAEMON_TERMINAL_STREAM_READ, terminalOps.streamRead],
        [RPC_METHODS.DAEMON_TERMINAL_STREAM_READ_BYTES, terminalOps.streamReadBytes],
        [RPC_METHODS.DAEMON_TERMINAL_STREAM_ACK, terminalOps.streamAcknowledge],
        [RPC_METHODS.DAEMON_TERMINAL_STREAM_INPUT, terminalOps.streamSendInput],
        [RPC_METHODS.DAEMON_TERMINAL_CLOSE, terminalOps.close],
        [RPC_METHODS.DAEMON_TERMINAL_INPUT, terminalOps.input],
        [RPC_METHODS.DAEMON_TERMINAL_RESIZE, terminalOps.resize],
    ]);
    return {
        machineRpcWithServerScope: (request: Readonly<{ method: string; machineId: string; serverId?: string | null; accountId?: string | null; payload: unknown; signal?: AbortSignal }>) => {
            if (request.method === RPC_METHODS.DAEMON_TERMINAL_STREAM_READ_BYTES) {
                const payload = TerminalStreamReadRequestSchema.parse(request.payload);
                // This current peer accepts controlCursor on output polls;
                // Account-bound credit-only reads omit it. Do not consume the
                // next scripted output response when only returning credit.
                if (payload.controlCursor !== undefined) streamReadSignals.push(request.signal);
                if (payload.controlCursor === undefined) {
                    return terminalOps.streamCreditRead(request.machineId, payload, {
                        serverId: request.serverId, ...(request.accountId ? { accountId: request.accountId } : {}),
                    });
                }
            }
            const response = responses.get(request.method);
            if (!response) throw new Error(`Unexpected terminal RPC: ${request.method}`);
            return response(request.machineId, request.payload, {
                serverId: request.serverId, ...(request.accountId ? { accountId: request.accountId } : {}),
                ...(request.method === RPC_METHODS.DAEMON_TERMINAL_STREAM_READ_BYTES && request.signal ? { signal: request.signal } : {}),
            });
        },
    };
});

// The OS clipboard is external; keep the app's safe-write adapter and selection policy real.
vi.mock('expo-clipboard', () => ({
    setStringAsync: clipboardState.setClipboardStringSafe,
}));

// This native rendering package is unavailable in the source runner and never
// renders in the terminal-controller harness. Keep the actual controller real.
vi.mock('react-native-enriched-markdown/lib/module/web/streamingReveal.js', () => ({
    splitStreamingRevealTextParts: () => { throw new Error('Unexpected native Markdown render in terminal controller test'); },
}));

// Resolve the real controller during collection: cold source transforms must
// not consume the lifecycle test's fake-clock phase.
await import('./useMachineTerminalSession');

describe('terminal RPC recovery policy', () => {
    it('recognizes a no-handler refusal returned by terminal Action admission', () => {
        expect(isRecoverableTerminalRpcError({ ok: false, errorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE,
            error: 'RPC method not available' })).toBe(true);
    });

    it('retains the same policy for thrown RPC errors', () => {
        expect(isRecoverableTerminalRpcError(createRpcCallError({ error: 'RPC method not available',
            errorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE }))).toBe(true);
    });

    it('recovers from typed transport loss before terminal delivery', () => {
        for (const errorCode of [RPC_ERROR_CODES.CLIENT_NOT_AVAILABLE, 'MACHINE_RPC_TIMEOUT']) {
            expect(isRecoverableTerminalRpcError(createRpcCallError({ error: 'Transport unavailable', errorCode }), 'stream')).toBe(true);
        }
    });

    it('does not treat ambiguous, denied, cancelled or arbitrary admission failures as a no-handler refusal', () => {
        for (const errorCode of [RPC_ERROR_CODES.OUTCOME_UNKNOWN, 'outcome_unknown', 'MACHINE_RPC_TIMEOUT',
            RPC_ERROR_CODES.FORBIDDEN, 'cancelled', 'action_failed']) {
            expect(isRecoverableTerminalRpcError({ ok: false, errorCode, error: 'operation has timed out' })).toBe(false);
        }
    });
});

async function refreshTerminalFeatures(): Promise<void> {
    for (const serverId of Object.values(homeIds)) {
        await getServerFeaturesSnapshot({ serverId, force: true });
    }
}

describe('useMachineTerminalSession', () => {
    beforeEach(async () => {
        rendererBoundaryState.parsed = false;
        byteStreamEnabled = true;
        workerWorkspaceRefs = [];
        const settings = {
            featureToggles: { 'terminal.embeddedPty': true },
            actionsSettingsV1: { v: 1, actions: {}, approvalWaivedSurfaces: {
                'machines.terminal.open': ['ui'], 'machines.terminal.restart': ['ui'],
                'action.operations.cancel': ['ui'],
            } },
        };
        servedHomes = await serveActionHomes({
            homes: [
                { key: 'cancel', serverUrl: 'https://terminal-cancel.test', serverIdentityId: 'srv_terminal_cancel', accountId: 'terminal-account', currentAccount: true, settings },
                { key: 'attach', serverUrl: 'https://terminal-attach.test', serverIdentityId: 'srv_terminal_attach', accountId: 'terminal-account', currentAccount: true, settings },
                { key: 'primary', serverUrl: 'https://terminal-primary.test', serverIdentityId: 'srv_terminal_primary', accountId: 'terminal-account', currentAccount: true, settings },
            ],
            route: request => request.path === '/v1/machines'
                ? Response.json(['machine', 'machine-cancel', 'machine-1'].map(id =>
                    createPlainMachineRowFixture({ id, accountId: 'terminal-account' })))
                // Account Machine Actions resolve their target through the batched Machine row read.
                : request.path === '/v1/machines/read-batch' && request.method === 'POST'
                ? createMachineReadBatchResponseFixture(request.body, id => ['machine', 'machine-cancel', 'machine-1'].includes(id)
                    ? createPlainMachineRowFixture({ id, accountId: 'terminal-account' }) : null)
                : request.path === '/v1/machines/managed/actions/list'
                ? Response.json(ManagedMachineActionOutputSchemasV1['machines.managed.list'].parse({ machines: [] }))
                : request.path === '/v1/account/project-rows/list'
                ? Response.json(createPlainProjectAccountRowListFixture({ workspaceRefs: workerWorkspaceRefs }))
                : request.path === '/v1/features' || request.path === '/v1/features/authenticated'
                ? Response.json(createRootLayoutFeaturesResponse({ features: { terminal: {
                    embeddedPty: { enabled: true }, transport: { byteStream: { enabled: byteStreamEnabled } },
                } } })) : createEmptyAccountBootstrapHttpResponse(request.path, { method: request.method }) ?? undefined,
        });
        homeIds = { primary: servedHomes.homes.primary!.id, cancel: servedHomes.homes.cancel!.id, attach: servedHomes.homes.attach!.id };
        publishAppliedActiveServerSnapshot(getActiveServerSnapshot());
        await refreshTerminalFeatures();
        terminalOps.ensure.mockReset();
        terminalOps.restart.mockReset();
        terminalOps.streamRead.mockReset();
        terminalOps.streamReadBytes.mockReset();
        terminalOps.streamCreditRead.mockReset();
        terminalOps.streamAcknowledge.mockReset();
        terminalOps.streamSendInput.mockReset();
        terminalOps.close.mockReset();
        terminalOps.operationGet.mockReset();
        terminalOps.operationCancel.mockReset();
        terminalOps.input.mockReset();
        terminalOps.resize.mockReset();
        terminalOps.streamAcknowledge.mockResolvedValue({ ok: true });
        terminalOps.streamCreditRead.mockImplementation((_machineId: string, request: { terminalId: string; byteOffset: number }) =>
            TerminalStreamReadResponseSchema.parse({ ok: true, terminalId: request.terminalId, frames: [],
                nextByteOffset: request.byteOffset, availableByteOffset: request.byteOffset, droppedBeforeByteOffset: 0, done: false }));
        streamReadSignals.length = 0;
        terminalOps.streamSendInput.mockResolvedValue({ ok: true });
        terminalOps.close.mockResolvedValue({ ok: true });
        terminalOps.input.mockResolvedValue({ ok: true });
        terminalOps.resize.mockResolvedValue({ ok: true });
        clipboardState.setClipboardStringSafe.mockReset();
        installBrowserClipboardBoundary(async text => { await clipboardState.setClipboardStringSafe(text); });
        vi.useFakeTimers();
    });

    afterEach(async () => {
        await standardCleanup();
        vi.useRealTimers();
        await servedHomes.dispose();
    });

    it.skipIf(process.platform === 'win32')('holds pre-prompt keys in order through the pane, hook, carrier and native PTY until attachment', async () => {
        vi.useRealTimers();
        const nativePeer = createPf56NativeTerminalPeer(homeIds.primary);
        onTestFinished(async () => { await (await nativePeer).dispose(); });
        const [peer, React, { AppPaneProvider }, { WorkspaceEmbeddedTerminalPane }, { EmbeddedTerminalPane }] = await Promise.all([
            nativePeer,
            import('react'),
            import('@/components/appShell/panes/AppPaneProvider'),
            import('@/components/projects/panes/details/views/WorkspaceEmbeddedTerminalPane'),
            import('@/components/terminal/embedded/EmbeddedTerminalPane'),
        ]);
        const receipt = createDeferred<DaemonTerminalEnsureResponse>();
        onTestFinished(() => receipt.resolve({ ok: false, error: 'fixture_disposed', errorCode: 'terminal_not_found' }));
        terminalOps.ensure.mockImplementation(() => receipt.promise);
        terminalOps.streamReadBytes.mockImplementation((_machineId, request) => peer.request(RPC_METHODS.DAEMON_TERMINAL_STREAM_READ_BYTES, request));
        terminalOps.streamCreditRead.mockImplementation((_machineId, request) => peer.request(RPC_METHODS.DAEMON_TERMINAL_STREAM_READ_BYTES, request));
        terminalOps.streamSendInput.mockImplementation((_machineId, request) => peer.request(RPC_METHODS.DAEMON_TERMINAL_STREAM_INPUT, request));
        await publishMachineInventoryForTest({ serverId: homeIds.primary, accountId: 'terminal-account' }, [
            createMachineFixture({ id: 'machine', activeAt: Date.now() }),
        ]);
        const screen = await renderScreen(React.createElement(AppPaneProvider, null,
            React.createElement(WorkspaceEmbeddedTerminalPane, { scopeId: 'project-pre-prompt', machineId: 'machine',
                serverId: homeIds.primary, rootPath: '/repo', terminalKey: 'pf56-pre-prompt' })));
        await vi.waitFor(() => expect(screen.findAllByType('TerminalRenderer')).toHaveLength(1));
        await act(async () => screen.findByType(EmbeddedTerminalPane).props.controller.retryConnect());
        await vi.waitFor(() => expect(terminalOps.ensure).toHaveBeenCalledTimes(1));
        await act(async () => { await new Promise(resolve => setTimeout(resolve, 300)); });
        const renderer = screen.findByType('TerminalRenderer');
        expect(renderer.props.readOnly).toBe(false);
        const parts = ["printf 'PF56_PRE%s\\n' ", "'PROMPT_IN_ORDER'", '\r'];
        await act(async () => { for (const part of parts) renderer.props.onInput(part); });
        expect(terminalOps.streamSendInput).not.toHaveBeenCalled();
        await act(async () => { receipt.resolve({ ok: true, terminalId: peer.terminalId, reused: false }); });
        await vi.waitFor(() => expect(screen.findByType('TerminalRenderer').children.join('')).toContain('PF56_PREPROMPT_IN_ORDER'));
        const sent = terminalOps.streamSendInput.mock.calls.map(([, request]) => request.event.text ?? '').join('');
        expect(sent).toBe(parts.join(''));
        expect(screen.findByType(EmbeddedTerminalPane).props.controller.inputRecoveryAvailable).toBe(false);
        await screen.unmount();
    }, 60_000);

    it.each(['phone', 'desktop'] as const)('keeps four Shell connections and parsed renderers alive across %s tab activation', async device => {
        vi.useRealTimers();
        rendererBoundaryState.parsed = true;
        const React = await import('react');
        const { AppPaneProvider } = await import('@/components/appShell/panes/AppPaneProvider');
        const { WorkspaceEmbeddedTerminalPane } = await import('@/components/projects/panes/details/views/WorkspaceEmbeddedTerminalPane');
        const { EmbeddedTerminalPane } = await import('@/components/terminal/embedded/EmbeddedTerminalPane');
        const { SessionTerminalPageView } = await import('@/components/sessions/panes/terminal/SessionTerminalPage');
        const { SessionTerminalWorkspaceView } = await import('@/components/sessions/terminal/strip/SessionTerminalWorkspaceView');
        await publishMachineInventoryForTest({ serverId: homeIds.primary, accountId: 'terminal-account' }, [
            createMachineFixture({ id: 'machine', activeAt: Date.now() }),
        ]);
        const members = Array.from({ length: 4 }, (_, index) => ({ id: `d5-${device}-${index}`, target: { kind: 'workspace_shell' as const } }));
        const tabs = members.map(member => ({ id: member.id, focusedTerminalId: member.id, terminals: [member], root: { kind: 'leaf' as const, terminalId: member.id } }));
        const descriptors = members.map(member => ({ tabId: member.id, title: member.id, mark: { kind: 'shell' as const }, status: null,
            members: [{ terminalId: member.id, title: member.id, mark: { kind: 'shell' as const }, status: null, detail: null, place: null, url: null, borrowed: false }] }));
        const context = { agentId: null, agentName: null, agentAsking: false, agentTerminalHost: null,
            sessionMachineId: null, sessionMachineName: null, machineName: () => null };
        terminalOps.ensure.mockImplementation(async (_machineId: string, request: { terminalKey: string }) => ({ ok: true, terminalId: request.terminalKey, reused: true }));
        const held = createDeferred<ReturnType<typeof TerminalStreamReadResponseSchema.parse>>();
        terminalOps.streamReadBytes.mockImplementation(async (_machineId: string, request: { terminalId: string; byteOffset: number }) => {
            const output = Buffer.from(`${request.terminalId} prompt$ `);
            if (request.byteOffset === output.length) return held.promise;
            return TerminalStreamReadResponseSchema.parse({ ok: true, terminalId: request.terminalId, frames: [{ t: 'bytes', terminalId: request.terminalId,
                seq: 0, byteOffset: 0, byteLength: output.length, encoding: 'base64', data: output.toString('base64') }],
                nextByteOffset: output.length, availableByteOffset: output.length, droppedBeforeByteOffset: 0, done: false, holdForOutput: true });
        });
        const leaf = (member: SessionTerminalMemberV1, focused: boolean) => <WorkspaceEmbeddedTerminalPane
            key={member.id} scopeId={`d5-${device}`} machineId="machine" serverId={homeIds.primary}
            rootPath="/repo" terminalKey={member.id} title={member.id} focused={focused} />;
        const render = (activeTabId: string) => <AppPaneProvider>{device === 'phone'
            ? <SessionTerminalPageView workspace={{ v: 1, tabs, activeTabId, showList: false }} tabs={descriptors} context={context}
                onAction={() => {}} renderTerminal={(member, _descriptor, focused = true) => leaf(member, focused)} />
            : <SessionTerminalWorkspaceView scopeId={`d5-${device}`} workspace={{ v: 1, tabs, activeTabId, showList: false }} tabs={descriptors}
                renderLeaf={(member, state) => leaf(member, state.focused)} minimumTerminalWidthPx={320} onFocusTerminal={() => {}} onResize={() => {}}
                onActivateTab={() => {}} onCloseTab={() => {}} onNewShell={() => {}} newMenuOpen={false} onNewMenuOpenChange={() => {}}
                newMenuItems={[]} onNewMenuSelect={() => {}} canSplit={false} onSplit={() => {}} tabMenuItems={() => []} onTabMenuSelect={() => {}}
                paneMenuItems={[]} onPaneMenuSelect={() => {}} onHide={() => {}} onOpenUrl={() => {}} />}</AppPaneProvider>;
        const screen = await renderScreen(render(members[0]!.id));
        for (const member of members) {
            await screen.update(render(member.id));
            await vi.waitFor(() => expect(screen.findAllByType(EmbeddedTerminalPane).some(pane => pane.props.title === member.id)).toBe(true));
            await act(async () => screen.findAllByType(EmbeddedTerminalPane).find(pane => pane.props.title === member.id)!.props.controller.retryConnect());
            await vi.waitFor(() => expect(readTerminalSurfaceState(member.id)?.cursor).toBe(Buffer.byteLength(`${member.id} prompt$ `)));
        }
        const resources = members.map(member => readTerminalSurfaceState(member.id)!.rendererResource);
        const starts = terminalOps.ensure.mock.calls.length;
        const reads = terminalOps.streamReadBytes.mock.calls.length;
        // Explicit fixture Open may have replaced its initial read; measure the settled live reads.
        const signals = streamReadSignals.filter(signal => !signal?.aborted);
        expect(signals.length).toBeGreaterThanOrEqual(members.length);
        for (const member of [...members, ...members].reverse()) await screen.update(render(member.id));
        expect(terminalOps.ensure.mock.calls.length - starts).toBe(0);
        expect(terminalOps.streamReadBytes.mock.calls.length - reads).toBe(0);
        expect(signals.some(signal => signal?.aborted)).toBe(false);
        expect(screen.findAllByType('TerminalRenderer')).toHaveLength(4);
        expect(members.map(member => readTerminalSurfaceState(member.id)!.rendererResource)).toEqual(resources);
        for (const [index, resource] of resources.entries()) {
            const parser = (resource as EmbeddedTerminalRendererResource & { terminal: Terminal }).terminal;
            expect(parser.buffer.active.getLine(0)?.translateToString(true)).toBe(`${members[index]!.id} prompt$ `);
        }
        await screen.unmount();
        for (const member of members) replaceTerminalSurfaceState(member.id, createEmptyTerminalSurfaceState());
    });

    it.skipIf(process.platform === 'win32')('replays the complete native Shell history into a fresh page after output resumes beyond the age window', async () => {
        vi.useRealTimers();
        rendererBoundaryState.parsed = true;
        const peer = await createPf56NativeTerminalPeer(homeIds.primary);
        onTestFinished(() => peer.dispose());
        const React = await import('react');
        const { AppPaneProvider } = await import('@/components/appShell/panes/AppPaneProvider');
        const { WorkspaceEmbeddedTerminalPane } = await import('@/components/projects/panes/details/views/WorkspaceEmbeddedTerminalPane');
        const { EmbeddedTerminalPane } = await import('@/components/terminal/embedded/EmbeddedTerminalPane');
        await publishMachineInventoryForTest({ serverId: homeIds.primary, accountId: 'terminal-account' }, [
            createMachineFixture({ id: 'machine', activeAt: Date.now() }),
        ]);
        terminalOps.ensure.mockResolvedValue({ ok: true, terminalId: peer.terminalId, reused: true });
        terminalOps.streamReadBytes.mockImplementation((_machineId, request) => peer.request(RPC_METHODS.DAEMON_TERMINAL_STREAM_READ_BYTES, request));
        terminalOps.streamCreditRead.mockImplementation((_machineId, request) => peer.request(RPC_METHODS.DAEMON_TERMINAL_STREAM_READ_BYTES, request));
        const terminalKey = 'pf56-native-reload-history';
        const render = () => React.createElement(AppPaneProvider, null, React.createElement(WorkspaceEmbeddedTerminalPane, {
            scopeId: 'project-native-reload-history', machineId: 'machine', serverId: homeIds.primary,
            rootPath: '/repo', terminalKey,
        }));
        let screen = await renderScreen(render());
        const open = async () => {
            await vi.waitFor(() => expect(screen.findAllByType('TerminalRenderer')).toHaveLength(1));
            await act(async () => screen.findByType(EmbeddedTerminalPane).props.controller.retryConnect());
            await vi.waitFor(() => expect(readTerminalSurfaceState(terminalKey)?.rendererResource).toBeDefined());
        };
        const read = () => {
            const resource = readTerminalSurfaceState(terminalKey)!.rendererResource!;
            const parser = (resource as typeof resource & { terminal: Terminal }).terminal;
            return Array.from({ length: parser.buffer.active.length }, (_, index) => parser.buffer.active.getLine(index)?.translateToString(true) ?? '').join('\n').trimEnd();
        };
        await open();
        await peer.request(RPC_METHODS.DAEMON_TERMINAL_STREAM_INPUT, { terminalId: peer.terminalId, event: { t: 'text',
            text: `for ((i=0;i<1600;i++)); do printf 'PF56_REPLAY_%04d complete retained terminal history beyond preview\\n' "$i"; done\r` } });
        await vi.waitFor(() => expect(read()).toContain('PF56_REPLAY_1599 complete retained terminal history beyond preview'));
        // The rejected live run had over forty minutes between successful commands in this Shell.
        await peer.advanceClock(40 * 60_000);
        await peer.request(RPC_METHODS.DAEMON_TERMINAL_STREAM_INPUT, { terminalId: peer.terminalId,
            event: { t: 'text', text: "printf 'PF56_AFTER_IDLE\\n'\r" } });
        await vi.waitFor(() => expect(read().split('\n')).toContain('PF56_AFTER_IDLE'));
        const beforeReload = read();
        const beforeCursor = readTerminalSurfaceState(terminalKey)!.cursor;
        expect(beforeReload.length).toBeGreaterThan(64_000);
        await screen.unmount();
        replaceTerminalSurfaceState(terminalKey, createEmptyTerminalSurfaceState());
        screen = await renderScreen(render());
        await open();
        await vi.waitFor(() => expect(readTerminalSurfaceState(terminalKey)?.cursor).toBe(beforeCursor));
        expect(read().length).toBe(beforeReload.length);
        expect(read()).toBe(beforeReload);
        expect(readTerminalSurfaceState(terminalKey)?.outputRetention?.retainedFromCursor).toBe(0);
        await screen.unmount();
        replaceTerminalSurfaceState(terminalKey, createEmptyTerminalSurfaceState());
    }, 60_000);

    it('retains owned Project Shell parsed history when switching A to B and back after ring expiry', async () => {
        vi.useRealTimers();
        rendererBoundaryState.parsed = true;
        const React = await import('react');
        const { AppPaneProvider } = await import('@/components/appShell/panes/AppPaneProvider');
        const { WorkspaceEmbeddedTerminalPane } = await import('@/components/projects/panes/details/views/WorkspaceEmbeddedTerminalPane');
        const { EmbeddedTerminalPane } = await import('@/components/terminal/embedded/EmbeddedTerminalPane');
        await publishMachineInventoryForTest({ serverId: homeIds.primary, accountId: 'terminal-account' }, [
            createMachineFixture({ id: 'machine', activeAt: Date.now() }),
        ]);
        const history = Array.from({ length: 1600 }, (_, i) => `shell A marker ${i} retained history beyond the preview limit\r\n`).join('');
        const outputs = new Map([['switch-history-A', Buffer.from(history)], ['switch-history-B', Buffer.from('shell B prompt$ ')]]);
        terminalOps.ensure.mockImplementation(async (_machineId: string, request: { terminalKey: string }) => ({
            ok: true, terminalId: request.terminalKey, reused: true,
        }));
        let expired = false;
        const held = createDeferred<ReturnType<typeof TerminalStreamReadResponseSchema.parse>>();
        terminalOps.streamReadBytes.mockImplementation(async (_machineId: string, request: { terminalId: string; byteOffset: number; maxBytes?: number }) => {
            const output = outputs.get(request.terminalId)!;
            if (request.byteOffset === output.length) return held.promise;
            const retainedFrom = expired && request.terminalId === 'switch-history-A' ? output.length - 64 : 0;
            const start = Math.max(retainedFrom, request.byteOffset);
            const end = Math.min(output.length, start + (request.maxBytes ?? TERMINAL_STREAM_MAX_READ_BYTES));
            const frames: Record<string, unknown>[] = request.byteOffset < retainedFrom
                ? [{ t: 'gap', terminalId: request.terminalId, droppedBeforeByteOffset: retainedFrom,
                    nextAvailableByteOffset: retainedFrom, reason: 'ring_overflow' }] : [];
            for (let offset = start; offset < end; offset += TERMINAL_STREAM_MAX_FRAME_DECODED_BYTES) {
                const bytes = output.subarray(offset, Math.min(end, offset + TERMINAL_STREAM_MAX_FRAME_DECODED_BYTES));
                frames.push({ t: 'bytes', terminalId: request.terminalId, seq: offset, byteOffset: offset,
                    byteLength: bytes.length, encoding: 'base64', data: bytes.toString('base64') });
            }
            return TerminalStreamReadResponseSchema.parse({ ok: true, terminalId: request.terminalId, frames,
                nextByteOffset: end, availableByteOffset: output.length, droppedBeforeByteOffset: retainedFrom, done: false, holdForOutput: true });
        });
        const render = (terminalId: string) => React.createElement(AppPaneProvider, null,
            React.createElement(WorkspaceEmbeddedTerminalPane, { scopeId: 'project-switch-history', machineId: 'machine',
                serverId: homeIds.primary, rootPath: '/repo', terminalKey: terminalId }));
        let screen = await renderScreen(render('switch-history-A'));
        const open = async () => {
            await vi.waitFor(() => expect(screen.findAllByType('TerminalRenderer')).toHaveLength(1));
            await act(async () => screen.findByType(EmbeddedTerminalPane).props.controller.retryConnect());
        };
        await open();
        await vi.waitFor(() => expect(readTerminalSurfaceState('switch-history-A')?.cursor,
            JSON.stringify(screen.findByType(EmbeddedTerminalPane).props.controller)).toBe(Buffer.byteLength(history)));
        const first = readTerminalSurfaceState('switch-history-A')!.rendererResource!;
        expect(first, JSON.stringify({ parsed: rendererBoundaryState.parsed,
            handle: Object.keys(screen.findByType(EmbeddedTerminalPane).props.terminalRef.current ?? {}) })).toBeDefined();
        const read = (resource = first) => {
            // The SDK boundary owns a real xterm parser; the pane/controller/cache stay real.
            const parser = (resource as typeof resource & { terminal: Terminal }).terminal;
            return Array.from({ length: parser.buffer.active.length }, (_, i) => parser.buffer.active.getLine(i)?.translateToString(true) ?? '').join('\n').trimEnd();
        };
        expect(read()).toBe(history.replaceAll('\r\n', '\n').trimEnd());
        expect(history.length).toBeGreaterThan(64_000);
        expired = true;
        await screen.update(render('switch-history-B'));
        await open();
        await vi.waitFor(() => expect(readTerminalSurfaceState('switch-history-B')?.cursor).toBe(outputs.get('switch-history-B')!.length));
        await screen.update(render('switch-history-A'));
        await open();
        await vi.waitFor(() => expect(screen.findByType(EmbeddedTerminalPane).props.controller.status).toBe('connected'));
        expect(read()).toBe(history.replaceAll('\r\n', '\n').trimEnd());
        expect(readTerminalSurfaceState('switch-history-A')?.rendererResource).toBe(first);
        await screen.unmount();
        for (const key of outputs.keys()) replaceTerminalSurfaceState(key, createEmptyTerminalSurfaceState());
        // A browser reload has no parsed resource or preview; replay starts from the daemon buffer.
        expired = false;
        screen = await renderScreen(render('switch-history-A'));
        await open();
        await vi.waitFor(() => expect(readTerminalSurfaceState('switch-history-A')?.cursor).toBe(Buffer.byteLength(history)));
        const reloaded = readTerminalSurfaceState('switch-history-A')!.rendererResource!;
        expect(reloaded).not.toBe(first);
        expect(read(reloaded)).toBe(history.replaceAll('\r\n', '\n').trimEnd());
        await screen.unmount();
        for (const key of outputs.keys()) replaceTerminalSurfaceState(key, createEmptyTerminalSurfaceState());
    });

    it.each([
        { exitCode: 0, signal: null, outcome: 'Exit code: 0' },
        { exitCode: 17, signal: null, outcome: 'Exit code: 17' },
        { exitCode: 0, signal: 0, outcome: 'Exit code: 0' },
        { exitCode: 0, signal: 15, outcome: 'Stopped' },
        { exitCode: null, signal: 15, outcome: 'Stopped' },
        { exitCode: null, signal: null, outcome: null },
        { exitCode: 0, signal: 0, outcome: 'Stopped', cancelled: true },
        { exitCode: 0, signal: 0, outcome: 'Stopping', stopping: true },
        { exitCode: 0, signal: 0, outcome: 'Stopped', remoteSettlement: 'cancelled' as const },
        { exitCode: 0, signal: 0, outcome: 'Exit code: 0', remoteSettlement: 'succeeded' as const },
        { exitCode: 0, signal: 0, outcome: 'Stopped', stopping: true, remoteSettlement: 'cancelled' as const, phone: true },
        { exitCode: 0, signal: 0, outcome: 'Completed', stopping: true, remoteSettlement: 'succeeded' as const, phone: true },
    ])('renders a finished worker Script with native outcome $exitCode / $signal / $cancelled / $stopping / $remoteSettlement / phone $phone through the real output pane', async ({ exitCode, signal, outcome, cancelled, stopping, remoteSettlement, phone }) => {
        vi.useRealTimers();
        const terminalId = `finished-worker-${exitCode}-${signal}-${cancelled ?? false}-${stopping ?? false}-${remoteSettlement ?? false}`;
        const { storage } = await import('@/sync/domains/state/storage');
        storage.getState().applyMachines([createMachineFixture({ id: 'machine', activeAt: Date.now() })]);
        await publishMachineInventoryForTest({ serverId: homeIds.primary, accountId: 'terminal-account' }, [
            createMachineFixture({ id: 'machine', activeAt: Date.now() }),
        ]);
        workerWorkspaceRefs = [
            { id: 'source-checkout', serverId: homeIds.primary, machineId: 'source-machine', rootPath: '/source/repo', createdAtMs: 1, projectKey: 'project' },
            { id: 'worker-checkout', serverId: homeIds.primary, machineId: 'machine', rootPath: '/worker/repo', createdAtMs: 1, projectKey: 'project' },
        ];
        // Keep real Sync admission and its asynchronous bootstrap in the path;
        // a fabricated store projection can be withdrawn by the next failed census.
        const { sync } = await import('@/sync/sync');
        await sync.refreshProjectAccountRows();
        const snapshot = ActionOperationSnapshotV1Schema.parse({
            version: 1, operationId: `worker-output-${terminalId}`, revision: 2, actionId: 'projects.script.run',
            state: stopping || remoteSettlement ? 'running' : cancelled ? 'cancelled' : exitCode === 0 ? 'succeeded' : 'failed',
            scope: { accountId: 'terminal-account', machineId: remoteSettlement ? 'source-machine' : 'machine' },
            title: 'Script', createdAt: 1, startedAt: 2, ...(stopping || remoteSettlement ? {} : { settledAt: 3 }), cancellation: 'supported',
            ...(exitCode === 0 ? {} : { error: { errorCode: 'project_command_step_failed', error: 'project_command_step_failed' } }),
            domainRef: { kind: 'projectCommand', purpose: 'script', serverId: homeIds.primary,
                machineId: 'machine', workspaceRefId: 'worker-checkout', cwd: '/worker/repo', terminalId,
                sourceWorkspace: { serverId: homeIds.primary, machineId: 'source-machine', workspaceId: 'source-checkout', rootPath: '/source/repo' },
                script: { name: 'fail', source: { kind: 'command', command: 'printf QA_FAIL' } },
                ...(exitCode === null ? {} : { exitCode }) },
        });
        const { actionOperationStore } = await import('@/sync/domains/actionOperations/actionOperationStore');
        actionOperationStore.mergeSnapshots({ serverId: homeIds.primary, snapshots: [snapshot] });
        const settlement = createDeferred<unknown>();
        terminalOps.operationGet.mockImplementation(() => settlement.promise);
        terminalOps.streamReadBytes.mockResolvedValue(TerminalStreamReadResponseSchema.parse({ ok: true, terminalId, frames: [
            { t: 'bytes', terminalId, seq: 1, byteOffset: 0, byteLength: 9, encoding: 'base64', data: 'UUFfRkFJTA0K' },
            { t: 'exit', terminalId, byteOffset: 9, exitCode, signal },
        ], nextByteOffset: 9, availableByteOffset: 9, droppedBeforeByteOffset: 0, done: true }));
        const { ProjectCommandOutputPane } = await import('@/components/inbox/actionOperations/ProjectCommandOutputPane');
        const { WorkspaceEmbeddedTerminalPane } = await import('@/components/projects/panes/details/views/WorkspaceEmbeddedTerminalPane');
        const { ProjectScriptRow } = await import('@/components/projects/projectSetup/ProjectScriptRow');
        const { ProjectCommandOutputPage } = await import('@/components/inbox/actionOperations/ProjectCommandOutputPage');
        const { AppPaneProvider } = await import('@/components/appShell/panes/AppPaneProvider');
        const React = await import('react');
        const outputProps = {
            operation: { serverId: homeIds.primary, observation: 'available', isUnavailableProjection: false, snapshot }, title: 'Script',
        } satisfies React.ComponentProps<typeof ProjectCommandOutputPane>;
        const renderOutput = async () => {
            const rendered = await renderScreen(React.createElement(AppPaneProvider, null, phone
            ? React.createElement(ProjectCommandOutputPage, { serverId: homeIds.primary, operationId: snapshot.operationId,
                name: 'Script', command: 'printf QA_FAIL', onClose: () => {} })
            : stopping
            ? React.createElement(ProjectScriptRow, { testID: 'script', workspace: {
                serverId: homeIds.primary, machineId: 'machine', workspaceId: 'worker-checkout', rootPath: '/worker/repo',
            }, name: 'Script', badge: null, command: 'printf QA_FAIL', portable: false, operation: outputProps.operation,
            idleText: '', pending: false, failureCode: null, compact: false, onRun: () => {} })
            // A borrowed output states its own native outcome unless its owner (a Script row, the output page)
            // already does; those owners are the stop and phone cases above and ProjectCommandOutputPane's own test.
            : React.createElement(WorkspaceEmbeddedTerminalPane, { scopeId: `project-command:${homeIds.primary}:${snapshot.operationId}`,
                workspaceRefId: 'worker-checkout', machineId: 'machine', serverId: homeIds.primary, rootPath: '/worker/repo',
                attachedTerminalId: terminalId, workspace: { serverId: homeIds.primary, workspaceId: 'worker-checkout',
                    machineId: 'machine', rootPath: '/worker/repo' },
                terminalKey: `project-command:${terminalId}`, title: 'Script', closeOnUnmount: false })));
            if (phone) await act(async () => {
                // Native layout is the external boundary that mounts the page's output body.
                const layout = rendered.findAll(node => typeof node.type === 'string' && typeof node.props.onLayout === 'function')[0];
                if (!layout) throw new Error('Phone output layout is missing');
                layout.props.onLayout({ nativeEvent: { layout: { x: 0, y: 0, width: 390, height: 600 } } });
            });
            return rendered;
        };
        const screen = await renderOutput();
        // Sync can withdraw retained presence while finishing its connection.
        // Supply fresh ingress to the mounted borrowed viewer after that edge.
        await act(async () => {
            observeMachinePresenceForTest({ serverId: homeIds.primary, accountId: 'terminal-account' }, ['machine']);
        });
        const cancellation = createDeferred<unknown>();
        if (stopping) {
            if (!phone) await screen.pressByTestIdAsync('script');
            terminalOps.operationCancel.mockImplementation(() => cancellation.promise);
            await screen.pressByTestIdAsync(phone ? 'project-command-output-page.stop' : 'script.run');
            // Pending RPC and accepted Stop both retain Stopping, before the
            // independent settlement observation arrives.
            // The row (or the page) owns the status; the terminal under it leaves its own exit line out.
            await vi.waitFor(() => expect(screen.getTextContent()).toContain('Stopping'));
            expect(screen.findByTestId('workspace-embedded-terminal-state-line')).toBeNull();
            if (!phone) await act(async () => cancellation.resolve({ kind: 'requested' }));
        }
        await vi.waitFor(async () => {
            await flushHookEffects();
            expect(screen.getTextContent()).toContain('QA_FAIL');
        });
        if (remoteSettlement) {
            await vi.waitFor(() => expect(terminalOps.operationGet).toHaveBeenCalledWith('source-machine',
                { operationId: snapshot.operationId, waitForTerminal: true }, expect.objectContaining({ serverId: homeIds.primary, accountId: 'terminal-account' })));
            const otherViewer = await renderOutput();
            await vi.waitFor(() => expect(otherViewer.getTextContent()).toContain('QA_FAIL'));
            expect(screen.findByType(WorkspaceEmbeddedTerminalPane).props.workspace).toMatchObject({
                serverId: homeIds.primary, machineId: 'machine', workspaceId: 'worker-checkout', rootPath: '/worker/repo',
            });
            expect(otherViewer.getTextContent()).not.toContain('Exit code:');
            expect(screen.getTextContent()).not.toContain('Exit code:');
            expect(terminalOps.operationGet).toHaveBeenCalledTimes(1);
            await act(async () => settlement.resolve({ kind: 'found', operation: ActionOperationSnapshotV1Schema.parse({
                ...snapshot, revision: 3, state: remoteSettlement, settledAt: 3,
            }) }));
            await vi.waitFor(() => expect(otherViewer.getTextContent()).toContain(outcome));
            // The canonical read settles both viewers even while the initiating
            // phone's cancel RPC has not acknowledged. Native exit alone did not settle it.
            if (phone) {
                await vi.waitFor(() => expect(screen.getTextContent()).toContain(outcome));
                expect(screen.getTextContent()).not.toContain('Stopping');
                await act(async () => cancellation.resolve({ kind: 'requested' }));
                expect(screen.getTextContent()).toContain(outcome);
            }
            await otherViewer.unmount();
        }
        expect(screen.findByTestId('workspace-embedded-terminal-state-card')).toBeNull();
        if (outcome) await vi.waitFor(() => expect(screen.getTextContent()).toContain(outcome));
        if (exitCode === null || signal || cancelled || stopping || remoteSettlement === 'cancelled') expect(screen.getTextContent()).not.toContain('Exit code:');
        if (remoteSettlement) {
            expect([...actionOperationStore.getSnapshot().operationsByKey.values()].find(value => value.snapshot.operationId === snapshot.operationId)?.snapshot.state).toBe(remoteSettlement);
        }
        expect(terminalOps.streamReadBytes).toHaveBeenCalledWith('machine', expect.objectContaining({ terminalId }), expect.objectContaining({ serverId: homeIds.primary }));
        if (stopping) {
            if (phone) {
                await screen.unmount();
                return;
            }
            await act(async () => settlement.resolve({ kind: 'found', operation: ActionOperationSnapshotV1Schema.parse({
                ...snapshot, revision: 3, state: 'cancelled', settledAt: 3,
            }) }));
            // The canonical read lands in the operation store (the row's own source of status); the terminal under
            // the row adds no outcome line of its own.
            await vi.waitFor(() => expect([...actionOperationStore.getSnapshot().operationsByKey.values()]
                .find(value => value.snapshot.operationId === snapshot.operationId)?.snapshot.state).toBe('cancelled'));
            expect(screen.getTextContent()).not.toContain('Exit code:');
            await screen.unmount();
            return;
        }
        await screen.unmount();
        // Returning from phone width remounts the inline pane. Its retained bytes
        // and native outcome must be visible before the daemon answers the new read.
        const replay = createDeferred<ReturnType<typeof TerminalStreamReadResponseSchema.parse>>();
        terminalOps.streamReadBytes.mockImplementation(() => replay.promise);
        const returned = await renderOutput();
        const { EmbeddedTerminalPane } = await import('@/components/terminal/embedded/EmbeddedTerminalPane');
        expect(returned.findByType(EmbeddedTerminalPane).props.controller).toMatchObject({
            status: 'exited', exitCode, exitSignal: signal,
        });
        expect(returned.getTextContent()).toContain('QA_FAIL');
        expect(returned.findByTestId('workspace-embedded-terminal-state-card')).toBeNull();
        if (outcome) expect(returned.getTextContent()).toContain(outcome);
        await act(async () => replay.resolve(TerminalStreamReadResponseSchema.parse({ ok: true, terminalId, frames: [
            { t: 'exit', terminalId, byteOffset: 9, exitCode, signal },
        ], nextByteOffset: 9, availableByteOffset: 9, droppedBeforeByteOffset: 0, done: true })));
        expect(returned.getTextContent().match(/QA_FAIL/g)).toHaveLength(1);
        await returned.unmount();
        expect(terminalOps.ensure).not.toHaveBeenCalled();
        expect(terminalOps.restart).not.toHaveBeenCalled();
        expect(terminalOps.close).not.toHaveBeenCalled();
    });

    it('drains a retained flood through its tail using the admitted read budget', async () => {
        const terminalId = 'retained-flood';
        const terminalKey = 'retained-flood-budget';
        const output = Buffer.from(Array.from({ length: 24_000 }, (_, i) => `trace ${i + 1}: ${'output '.repeat(16)}\r\n`).join('') + 'flood done\r\n');
        const retainedFrom = output.length - TERMINAL_STREAM_MAX_READ_BYTES;
        terminalOps.streamReadBytes.mockImplementation((_machineId: string, request: { byteOffset: number; maxBytes?: number }) => {
            const start = Math.max(retainedFrom, request.byteOffset);
            const end = Math.min(output.length, start + (request.maxBytes ?? 16_384));
            const frames = [];
            if (request.byteOffset < retainedFrom) frames.push({ t: 'gap', terminalId,
                droppedBeforeByteOffset: retainedFrom, nextAvailableByteOffset: retainedFrom, reason: 'ring_overflow' });
            for (let offset = start; offset < end; offset += TERMINAL_STREAM_MAX_FRAME_DECODED_BYTES) {
                const bytes = output.subarray(offset, Math.min(end, offset + TERMINAL_STREAM_MAX_FRAME_DECODED_BYTES));
                frames.push({ t: 'bytes', terminalId, seq: offset, byteOffset: offset, byteLength: bytes.length,
                    encoding: 'base64', data: bytes.toString('base64') });
            }
            if (end === output.length) frames.push({ t: 'exit', terminalId, byteOffset: end, exitCode: 0, signal: null });
            return TerminalStreamReadResponseSchema.parse({ ok: true, terminalId, frames, nextByteOffset: end,
                availableByteOffset: output.length, droppedBeforeByteOffset: retainedFrom, done: end === output.length });
        });
        let rendered = '';
        const terminalRef = { current: { write: (text: string) => { rendered += text; },
            writeBytes: (input: EmbeddedTerminalWriteBytesInput) => { rendered += new TextDecoder().decode(input.bytes); return true; },
            clear: () => { rendered = ''; } } };
        const { useMachineTerminalSession } = await import('./useMachineTerminalSession');
        const hook = await renderHook(() => useMachineTerminalSession({ machineId: 'machine', serverId: homeIds.primary,
            cwd: '/repo', terminalKey, terminalRef, attachedTerminalId: terminalId, readOnly: true }));
        await flushHookEffects({ cycles: 4, turns: 2, runOnlyPendingTimers: true });
        expect(rendered.endsWith('flood done\r\n')).toBe(true);
        expect(readTerminalSurfaceState(terminalKey)).toMatchObject({ cursor: output.length,
            output: expect.stringMatching(/flood done\r\n$/) });
        expect(hook.getCurrent()).toMatchObject({ status: 'exited', outputRetention: { truncated: true } });
        expect(readTerminalSurfaceState(terminalKey)?.outputRetention).toMatchObject({
            retainedFromCursor: retainedFrom, availableCursor: output.length, truncated: true });
        // One admitted window, one physical output read; renderer-credit reads are separate.
        expect(terminalOps.streamReadBytes).toHaveBeenCalledTimes(1);
        await hook.unmount();
        // Pausing byte credit must still admit a control-only read through the
        // real Action and strict request schema (maxBytes itself cannot be zero).
        const { createMachineRpcTerminalStreamCarrier } = await import('@/sync/domains/terminal/stream/carrier');
        const carrier = createMachineRpcTerminalStreamCarrier({ machineId: 'machine', serverId: homeIds.primary,
            accountId: 'terminal-account' });
        await expect(carrier.read({ terminalId, cursor: { mode: 'byte-offset', value: output.length }, creditBytes: 0 }))
            .resolves.toMatchObject({ ok: true, nextCursor: output.length, done: true });
    });

    it('finishes retained replay only after the current renderer acknowledges its final bytes', async () => {
        const terminalId = 'retained-replay-pty';
        const terminalKey = 'retained-replay-ack';
        replaceTerminalSurfaceState(terminalKey, { terminalId, cursor: 3, output: 'retained preview', detectedUrl: null,
            exit: { exitCode: 0, signal: null, scope: { serverId: homeIds.primary, accountId: 'terminal-account' } } });
        const read = createDeferred<unknown>();
        terminalOps.streamReadBytes.mockImplementation(() => read.promise);
        const writeBytes = vi.fn((_input: EmbeddedTerminalWriteBytesInput) => queuedWriteResult);
        const terminalRef = { current: { write: vi.fn(), writeBytes, clear: vi.fn() } };
        const { useMachineTerminalSession } = await import('./useMachineTerminalSession');
        const hook = await renderHook(() => useMachineTerminalSession({ machineId: 'machine', serverId: homeIds.primary,
            cwd: '/repo', terminalKey, terminalRef, attachedTerminalId: terminalId, readOnly: true }));
        await flushHookEffects({ cycles: 4, turns: 2, runOnlyPendingTimers: true });
        expect(hook.getCurrent()).toMatchObject({ status: 'exited' });
        await act(async () => read.resolve(TerminalStreamReadResponseSchema.parse({ ok: true, terminalId, frames: [
            { t: 'gap', terminalId, droppedBeforeByteOffset: 100, nextAvailableByteOffset: 100, reason: 'ring_overflow' },
            { t: 'bytes', terminalId, seq: 5, byteOffset: 100, byteLength: 3, encoding: 'base64', data: 'QUJD' },
            { t: 'exit', terminalId, byteOffset: 103, exitCode: 0, signal: null },
        ], nextByteOffset: 103, availableByteOffset: 103, droppedBeforeByteOffset: 100, done: true })));
        await flushHookEffects({ cycles: 4, turns: 2, runOnlyPendingTimers: true });
        expect(readTerminalSurfaceState(terminalKey)?.cursor).toBe(0);
        expect(hook.getCurrent()).toMatchObject({ outputRetention: { truncated: true } });
        expect(readTerminalSurfaceState(terminalKey)?.outputRetention).toEqual({
            mode: 'byte-offset', retainedFromCursor: 100, availableCursor: 103, truncated: true });
        const generation = readWriteGeneration(writeBytes.mock.calls[0]?.[0]);
        if (generation === null) throw new Error('Renderer did not receive the retained bytes');
        await act(async () => hook.getCurrent().onWriteComplete(rendererWriteComplete({ terminalId, seq: 5,
            byteOffset: 100, byteLength: 3, ackedByteOffset: 103, writeGeneration: generation })));
        await flushHookEffects({ cycles: 4, turns: 2, runOnlyPendingTimers: true });
        expect(hook.getCurrent()).toMatchObject({ status: 'exited' });
        expect(readTerminalSurfaceState(terminalKey)).toMatchObject({ cursor: 103, output: expect.stringMatching(/ABC$/) });
        expect(terminalOps.streamReadBytes).toHaveBeenCalledTimes(1);
        expect(terminalOps.ensure).not.toHaveBeenCalled();
        expect(terminalOps.close).not.toHaveBeenCalled();
        await hook.unmount();
    });

    it('does not restore a finished borrowed surface before its Account scope is proven', async () => {
        const terminalKey = 'borrowed-other-account';
        replaceTerminalSurfaceState(terminalKey, {
            terminalId: 'borrowed-other-account-pty', cursor: 7, output: 'private', detectedUrl: null,
            exit: { exitCode: 17, signal: null, scope: { serverId: homeIds.primary, accountId: 'another-account' } },
            outputRetention: { mode: 'byte-offset', retainedFromCursor: 10, availableCursor: 100, truncated: true },
        });
        const read = createDeferred<unknown>();
        terminalOps.streamReadBytes.mockImplementation(() => read.promise);
        const terminalRef = { current: { write: vi.fn(), clear: vi.fn() } };
        const { useMachineTerminalSession } = await import('./useMachineTerminalSession');
        const firstStates: Array<Readonly<{ status: string; exitCode: number | null; retention: unknown }>> = [];
        const hook = await renderHook(() => {
            const controller = useMachineTerminalSession({ machineId: 'machine', serverId: homeIds.primary, cwd: '/repo',
                terminalKey, terminalRef, attachedTerminalId: 'borrowed-other-account-pty', readOnly: true });
            firstStates.push({ status: controller.status, exitCode: controller.exitCode, retention: controller.outputRetention });
            return controller;
        }, { flushOptions: { cycles: 1, turns: 1 } });
        expect(firstStates[0]).toEqual({ status: 'connecting', exitCode: null, retention: null });
        expect(terminalRef.current.write).not.toHaveBeenCalledWith('private', expect.anything());
        await hook.unmount();
    });

    it('reads borrowed output with independent credit identities while refusing all process mutations', async () => {
        terminalOps.streamAcknowledge.mockResolvedValue({ ok: true });
        terminalOps.streamSendInput.mockResolvedValue({ ok: true });
        terminalOps.streamReadBytes.mockResolvedValue({ ok: true, terminalId: 'borrowed', frames: [{
            t: 'bytes', terminalId: 'borrowed', seq: 1, byteOffset: 0, byteLength: 3, encoding: 'base64', data: 'b3V0',
        }], nextByteOffset: 3, availableByteOffset: 3, droppedBeforeByteOffset: 0, done: true });
        const renderer = { write: vi.fn(), writeBytes: vi.fn(() => true), clear: vi.fn() } satisfies EmbeddedTerminalRendererHandle;
        const { useMachineTerminalSession } = await import('./useMachineTerminalSession');
        const createView = (terminalKey: string) => {
            const terminalRef = { current: renderer };
            return renderHook(() => useMachineTerminalSession({
                machineId: 'machine', serverId: homeIds.primary, cwd: '/repo', terminalKey,
                terminalRef, attachedTerminalId: 'borrowed', readOnly: true, closeOnUnmount: true,
            }), { flushOptions: { cycles: 1, turns: 1 } });
        };
        const first = await createView('borrowed-view-one');
        const second = await createView('borrowed-view-two');
        expect(first.getCurrent().readOnly).toBe(true);
        expect(second.getCurrent().readOnly).toBe(true);
        await act(async () => {
            first.getCurrent().onReady(80, 24);
            first.getCurrent().onInput('echo forbidden\r');
            expect(await first.getCurrent().onPaste('echo mutable')).toMatchObject({ kind: 'ignore' });
            first.getCurrent().onResize(120, 40);
            first.getCurrent().requestRestart();
        });
        await flushHookEffects({ cycles: 4, turns: 2, runOnlyPendingTimers: true });
        expect(renderer.writeBytes).toHaveBeenCalledWith(expect.objectContaining({ terminalId: 'borrowed', byteOffset: 0 }));
        expect(terminalOps.streamReadBytes).toHaveBeenCalledWith('machine', expect.objectContaining({ terminalId: 'borrowed' }), expect.objectContaining({ serverId: homeIds.primary }));
        const rendererIds = new Set(terminalOps.streamReadBytes.mock.calls.map((call) => (call[1] as { rendererId?: string }).rendererId));
        expect(rendererIds.size).toBe(2);
        expect(rendererIds.has('embedded-terminal')).toBe(false);
        await first.unmount();
        await second.unmount();
        expect(terminalOps.ensure).not.toHaveBeenCalled();
        expect(terminalOps.restart).not.toHaveBeenCalled();
        expect(terminalOps.streamSendInput).not.toHaveBeenCalled();
        expect(terminalOps.input).not.toHaveBeenCalled();
        expect(terminalOps.resize).not.toHaveBeenCalled();
        expect(terminalOps.close).not.toHaveBeenCalled();
    });

    it.each([undefined, 'observed'])('waits without an error or terminal RPCs for observed Machine presence, then attaches (existing terminal: %s)', async (attachedTerminalId) => {
        terminalOps.ensure.mockResolvedValue({ ok: true, terminalId: 'observed', reused: false });
        terminalOps.streamReadBytes.mockResolvedValue({ ok: true, terminalId: 'observed', frames: [], nextByteOffset: 0, availableByteOffset: 0, droppedBeforeByteOffset: 0, done: true });
        const { useMachineTerminalSession } = await import('./useMachineTerminalSession');
        const terminalRef = { current: { write: vi.fn(), clear: vi.fn() } satisfies EmbeddedTerminalRendererHandle };
        let reachable: boolean | null = null;
        const hook = await renderHook(() => useMachineTerminalSession({
            machineId: 'machine', serverId: homeIds.primary, cwd: '/repo', terminalKey: 'unobserved-machine',
            terminalRef, machineReachable: reachable, machineRpcTargetAvailable: true,
            attachedTerminalId,
        }));
        await act(async () => hook.getCurrent().onReady(80, 24));
        await flushHookEffects({ cycles: 4, turns: 2, runOnlyPendingTimers: true });
        for (const rpc of Object.values(terminalOps)) expect(rpc).not.toHaveBeenCalled();
        expect(hook.getCurrent().status).toBe(attachedTerminalId ? 'connecting' : 'not-open');
        expect(hook.getCurrent().error).toBeNull();
        reachable = true;
        await hook.rerender();
        await flushHookEffects({ cycles: 4, turns: 2, runOnlyPendingTimers: true });
        expect(terminalOps.ensure).toHaveBeenCalledTimes(attachedTerminalId ? 0 : 1);
        expect(terminalOps.streamReadBytes).toHaveBeenCalledWith('machine', expect.objectContaining({ terminalId: 'observed' }), expect.any(Object));
        expect(hook.getCurrent().terminalId).toBe('observed');
        expect(hook.getCurrent().error).toBeNull();
        await hook.unmount();
    });

    it('keeps a workspace terminal waiting while its retained Machine presence is unknown, then opens on observation', async () => {
        const React = await import('react');
        const { storage } = await import('@/sync/domains/state/storage');
        const { observeMachinePresenceForTest } = await import('@/dev/testkit/harness/machinePresence');
        const { withdrawMachinePresenceForScope } = await import('@/sync/domains/machines/reachability/machineReachability');
        const { AppPaneProvider } = await import('@/components/appShell/panes/AppPaneProvider');
        const { WorkspaceEmbeddedTerminalPane } = await import('@/components/projects/panes/details/views/WorkspaceEmbeddedTerminalPane');
        const { EmbeddedTerminalPane } = await import('@/components/terminal/embedded/EmbeddedTerminalPane');
        storage.getState().applyMachines([createMachineFixture({ id: 'machine', activeAt: Date.now() })]);
        // Model the real transport-withdrawal edge: the row remains, its presence needs fresh observation.
        withdrawMachinePresenceForScope({ serverId: homeIds.primary, accountId: 'terminal-account' });
        terminalOps.ensure.mockResolvedValue({ ok: true, terminalId: 'workspace-observed', reused: false });
        terminalOps.streamReadBytes.mockResolvedValue({ ok: true, terminalId: 'workspace-observed', frames: [],
            nextByteOffset: 0, availableByteOffset: 0, droppedBeforeByteOffset: 0, done: true });
        const screen = await renderScreen(React.createElement(AppPaneProvider, null,
            React.createElement(WorkspaceEmbeddedTerminalPane, {
                scopeId: 'workspace-presence', machineId: 'machine', rootPath: '/repo',
                serverId: homeIds.primary, terminalKey: 'workspace-presence',
            })));
        expect(screen.findByType(EmbeddedTerminalPane).props.controller).toMatchObject({ status: 'not-open', error: null });
        for (const rpc of Object.values(terminalOps)) expect(rpc).not.toHaveBeenCalled();
        await act(async () => { observeMachinePresenceForTest({ serverId: homeIds.primary, accountId: 'terminal-account' }, ['machine']); });
        await vi.waitFor(() => expect(terminalOps.streamReadBytes).toHaveBeenCalledWith('machine',
            expect.objectContaining({ terminalId: 'workspace-observed' }), expect.any(Object)));
        expect(screen.findByType(EmbeddedTerminalPane).props.controller.error).toBeNull();
        await screen.unmount();
    });

    it.each(['session_attach', 'shell'] as const)('reopens an exited %s pane according to its process ownership', async kind => {
        const terminalKey = `native-session-resume-${kind}`;
        terminalOps.ensure.mockResolvedValueOnce({ ok: true, terminalId: 'old-native-attachment', reused: false })
            .mockResolvedValue({ ok: true, terminalId: 'resumed-native-attachment', reused: false });
        const resumedRead = createDeferred<ReturnType<typeof TerminalStreamReadResponseSchema.parse>>();
        terminalOps.streamReadBytes.mockImplementation((_machineId: string, request: { terminalId: string; byteOffset: number }) =>
            request.terminalId === 'old-native-attachment' ? ({
                ok: true, terminalId: request.terminalId,
                frames: [{ t: 'exit', terminalId: request.terminalId, byteOffset: 0, exitCode: 1, signal: null }],
                nextByteOffset: 0, availableByteOffset: 0, droppedBeforeByteOffset: 0, done: true,
            }) : request.byteOffset === 0 ? ({
                ok: true, terminalId: request.terminalId,
                frames: [{ t: 'bytes', terminalId: request.terminalId, seq: 1, byteOffset: 0, byteLength: 1,
                    encoding: 'base64', data: 'Qg==' }],
                nextByteOffset: 1, availableByteOffset: 1, droppedBeforeByteOffset: 0, done: false,
            }) : resumedRead.promise);
        const { useMachineTerminalSession } = await import('./useMachineTerminalSession');
        const launch = kind === 'session_attach' ? { kind: 'session_attach' as const, sessionId: 'native-session' } : null;
        const renderer = { write: vi.fn(), writeBytes: vi.fn(() => true), clear: vi.fn() } satisfies EmbeddedTerminalRendererHandle;
        let terminalRef = { current: renderer };
        const mount = () => renderHook(() => useMachineTerminalSession({
            machineId: 'machine', serverId: homeIds.primary, sessionId: 'native-session', cwd: kind === 'shell' ? '/repo' : null, terminalKey,
            launch, terminalRef,
        }));
        const first = await mount();
        await act(async () => first.getCurrent().onReady(80, 24));
        await flushHookEffects({ cycles: 4, turns: 2 });
        expect(first.getCurrent().error).toBeNull();
        expect(first.getCurrent()).toMatchObject({ status: 'exited', exitCode: 1 });
        terminalRef = { current: terminalRef.current };
        await first.rerender();
        await flushHookEffects({ cycles: 4, turns: 2 });
        expect(first.getCurrent().status).toBe('exited');
        expect(terminalOps.ensure).toHaveBeenCalledTimes(1);
        await first.unmount();

        const reopened = await mount();
        await act(async () => reopened.getCurrent().onReady(80, 24));
        await flushHookEffects({ cycles: 4, turns: 2 });
        expect(reopened.getCurrent()).toMatchObject(kind === 'session_attach'
            ? { status: 'connected', terminalId: 'resumed-native-attachment', exitCode: null }
            : { status: 'exited', terminalId: 'old-native-attachment', exitCode: 1 });
        expect(terminalOps.ensure).toHaveBeenCalledTimes(kind === 'session_attach' ? 2 : 1);
        expect(terminalOps.restart).not.toHaveBeenCalled();
        if (kind === 'session_attach') {
            expect(renderer.writeBytes).toHaveBeenCalledWith(expect.objectContaining({
                terminalId: 'resumed-native-attachment', bytes: new Uint8Array([66]),
            }));
        } else {
            expect(renderer.writeBytes).not.toHaveBeenCalled();
        }
        await reopened.unmount();
    });

    it.each([
        { intent: 'reopen', removed: false }, { intent: 'open', removed: false },
        { intent: 'reopen', removed: true }, { intent: 'open', removed: true },
    ] as const)('retains an observed close through mounted lifecycle changes until explicit $intent (removed: $removed)', async ({ intent, removed }) => {
        const terminalKey = `guard-closed-${intent}-${removed}`;
        terminalOps.ensure.mockResolvedValue({ ok: true, terminalId: 'guard-original', reused: false });
        terminalOps.restart.mockResolvedValue({ ok: true, terminalId: 'person-reopened', reused: false });
        terminalOps.streamReadBytes.mockImplementation((_machineId: string, request: { terminalId: string }) => removed && request.terminalId === 'guard-original'
            // closeGuardIdle removes the exact PTY from the daemon census; the
            // next read observes absence, rather than receiving an exit frame.
            ? { ok: false, code: 'terminal_not_found', message: 'terminal_not_found' } : ({
            ok: true, terminalId: request.terminalId,
            frames: [{ t: 'exit', terminalId: request.terminalId, byteOffset: 0, exitCode: null, signal: 15 }],
            nextByteOffset: 0, availableByteOffset: 0, droppedBeforeByteOffset: 0, done: true,
        }));
        const { useMachineTerminalSession } = await import('./useMachineTerminalSession');
        let terminalRef = { current: { write: vi.fn(), clear: vi.fn() } satisfies EmbeddedTerminalRendererHandle };
        let reachable = true;
        const hook = await renderHook(() => useMachineTerminalSession({
            machineId: 'machine', serverId: homeIds.primary, cwd: '/repo', terminalKey, terminalRef,
            machineReachable: reachable, machineRpcTargetAvailable: true,
        }));
        await act(async () => hook.getCurrent().onReady(80, 24));
        await flushHookEffects({ cycles: 4, turns: 2 });
        expect(hook.getCurrent()).toMatchObject({ status: 'exited', terminalId: 'guard-original' });
        expect(terminalOps.ensure).toHaveBeenCalledTimes(1);
        const readsAtExit = terminalOps.streamReadBytes.mock.calls.length;
        // The bounded preview cache may forget this key while the controller
        // stays mounted. Losing preview bytes cannot authorize a new shell.
        replaceTerminalSurfaceState(terminalKey, createEmptyTerminalSurfaceState());
        // The mounted sheet can observe transport/presence and renderer changes
        // after Guard closes the PTY. None of these is a new open intent.
        reachable = false;
        await hook.rerender();
        reachable = true;
        await hook.rerender();
        await act(async () => hook.getCurrent().onReady(100, 30));
        await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
        await flushHookEffects({ cycles: 4, turns: 2 });
        expect(hook.getCurrent()).toMatchObject({ status: 'exited', terminalId: 'guard-original', error: null });
        expect(terminalOps.ensure).toHaveBeenCalledTimes(1);
        expect(terminalOps.restart).not.toHaveBeenCalled();
        expect(terminalOps.streamReadBytes).toHaveBeenCalledTimes(readsAtExit);
        terminalOps.ensure.mockResolvedValue({ ok: true, terminalId: 'person-reopened', reused: false });
        await act(async () => intent === 'reopen' ? hook.getCurrent().requestRestart() : hook.getCurrent().retryConnect());
        await flushHookEffects({ cycles: 4, turns: 2 });
        expect(hook.getCurrent().terminalId).toBe('person-reopened');
        expect(terminalOps.restart).toHaveBeenCalledTimes(intent === 'reopen' ? 1 : 0);
        expect(terminalOps.ensure).toHaveBeenCalledTimes(intent === 'open' ? 2 : 1);
        // An explicit Open is consumed once. Its eventual exit must not leave
        // later renderer changes carrying the previous person's open intent.
        terminalRef = { current: terminalRef.current };
        await hook.rerender();
        await flushHookEffects({ cycles: 4, turns: 2 });
        expect(hook.getCurrent().status).toBe('exited');
        expect(terminalOps.restart).toHaveBeenCalledTimes(intent === 'reopen' ? 1 : 0);
        expect(terminalOps.ensure).toHaveBeenCalledTimes(intent === 'open' ? 2 : 1);
        await hook.unmount();
    });

    it('supersedes a stalled read on Retry and releases hidden output without closing its process', async () => {
        const terminalId = 'retained-reader';
        const terminalKey = 'retained-reader-lifecycle';
        const reads = [createDeferred<unknown>(), createDeferred<unknown>(), createDeferred<unknown>()];
        terminalOps.ensure.mockResolvedValue({ ok: true, terminalId, reused: true });
        terminalOps.streamReadBytes.mockImplementationOnce(() => reads[0].promise)
            .mockImplementationOnce(() => reads[1].promise).mockImplementation(() => reads[2].promise);
        const write = vi.fn();
        const terminalRef = { current: { write, clear: vi.fn() } satisfies EmbeddedTerminalRendererHandle };
        const { useMachineTerminalSession } = await import('./useMachineTerminalSession');
        const mount = async () => {
            const hook = await renderHook(() => useMachineTerminalSession({
                machineId: 'machine', serverId: homeIds.primary, cwd: '/repo', terminalKey, terminalRef,
            }));
            await act(async () => hook.getCurrent().onReady(80, 24));
            await flushHookEffects({ cycles: 4, turns: 2 });
            return hook;
        };
        const first = await mount();
        expect(streamReadSignals).toHaveLength(1);
        expect(streamReadSignals[0]?.aborted).toBe(false);
        await act(async () => first.getCurrent().retryConnect());
        await flushHookEffects({ cycles: 4, turns: 2 });
        expect(streamReadSignals).toHaveLength(2);
        expect(streamReadSignals[0]?.aborted).toBe(true);
        expect(streamReadSignals[1]?.aborted).toBe(false);
        await act(async () => reads[0].resolve({ ok: true, terminalId, frames: [{ t: 'bytes', terminalId,
            seq: 0, byteOffset: 0, byteLength: 4, encoding: 'base64', data: 'bGF0ZQ==' }],
            nextByteOffset: 4, availableByteOffset: 4, droppedBeforeByteOffset: 0, done: false }));
        await flushHookEffects({ cycles: 4, turns: 2 });
        expect(write).not.toHaveBeenCalledWith('late');
        await first.unmount();
        expect(streamReadSignals[1]?.aborted).toBe(true);
        await flushHookEffects({ cycles: 4, turns: 2 });
        expect(streamReadSignals).toHaveLength(2);
        const reopened = await mount();
        expect(reopened.getCurrent()).toMatchObject({ status: 'connected', terminalId });
        expect(streamReadSignals).toHaveLength(3);
        expect(terminalOps.restart).not.toHaveBeenCalled();
        expect(terminalOps.close).not.toHaveBeenCalled();
        await reopened.unmount();
        expect(streamReadSignals[2]?.aborted).toBe(true);
    });

    it('offers connection recovery only after a failed attempt and resets it for an explicit restart', async () => {
        const initial = createDeferred<DaemonTerminalEnsureResponse>();
        const retried = createDeferred<DaemonTerminalEnsureResponse>();
        const restarted = createDeferred<DaemonTerminalEnsureResponse>();
        terminalOps.ensure.mockImplementationOnce(() => initial.promise).mockImplementationOnce(() => retried.promise);
        terminalOps.restart.mockReturnValue(restarted.promise);
        terminalOps.streamReadBytes.mockImplementation((_machineId: string, request: { terminalId: string; byteOffset: number }) =>
            TerminalStreamReadResponseSchema.parse({ ok: true, terminalId: request.terminalId, frames: [],
                nextByteOffset: request.byteOffset, availableByteOffset: request.byteOffset, droppedBeforeByteOffset: 0, done: false }));
        const { useMachineTerminalSession } = await import('./useMachineTerminalSession');
        const terminalRef = { current: { write: vi.fn(), clear: vi.fn() } satisfies EmbeddedTerminalRendererHandle };
        const hook = await renderHook(() => useMachineTerminalSession({
            machineId: 'machine', serverId: homeIds.primary, cwd: '/repo', terminalKey: 'connection-recovery-state', terminalRef,
        }));
        await act(async () => hook.getCurrent().onReady(80, 24));
        await flushHookEffects();
        expect(hook.getCurrent()).toMatchObject({ status: 'connecting', connectionRetryAvailable: false });

        await act(async () => initial.resolve({ ok: false, errorCode: 'terminal_spawn_failed', error: 'terminal_spawn_failed' }));
        await flushHookEffects();
        expect(hook.getCurrent().status).toBe('error');
        await act(async () => hook.getCurrent().retryConnect());
        await flushHookEffects();
        expect(hook.getCurrent()).toMatchObject({ status: 'connecting', connectionRetryAvailable: true });

        await act(async () => retried.resolve({ ok: true, terminalId: 'recovered-terminal', reused: false }));
        await flushHookEffects();
        expect(hook.getCurrent().status).toBe('connected');
        await act(async () => hook.getCurrent().requestRestart());
        await flushHookEffects();
        expect(hook.getCurrent()).toMatchObject({ status: 'connecting', connectionRetryAvailable: false });
        expect(terminalOps.restart).toHaveBeenCalledOnce();
        await hook.unmount();
    });

    it('issues an explicit Retry while the machine is unreachable', async () => {
        const ensured = createDeferred<DaemonTerminalEnsureResponse>();
        terminalOps.ensure.mockReturnValue(ensured.promise);
        terminalOps.streamReadBytes.mockResolvedValue({ ok: true, terminalId: 'retried', frames: [], nextByteOffset: 0, availableByteOffset: 0, droppedBeforeByteOffset: 0, done: true });
        const { useMachineTerminalSession } = await import('./useMachineTerminalSession');
        const terminalRef = { current: { write: vi.fn(), clear: vi.fn() } satisfies EmbeddedTerminalRendererHandle };
        let reachable = false;
        const hook = await renderHook(() => useMachineTerminalSession({
            machineId: 'machine', serverId: homeIds.primary, cwd: '/repo', terminalKey: 'unreachable-retry',
            terminalRef, machineReachable: reachable, machineRpcTargetAvailable: reachable,
        }));
        await act(async () => hook.getCurrent().onReady(80, 24));
        expect(terminalOps.ensure).not.toHaveBeenCalled();
        await act(async () => hook.getCurrent().retryConnect());
        await flushHookEffects({ cycles: 4, turns: 2, runOnlyPendingTimers: true });
        expect(terminalOps.ensure).toHaveBeenCalledWith('machine', expect.objectContaining({ cwd: '/repo' }), expect.any(Object));
        reachable = true;
        await hook.rerender();
        expect(terminalOps.ensure).toHaveBeenCalledTimes(1);
        await act(async () => ensured.resolve({ ok: true, terminalId: 'retried', reused: false }));
        await flushHookEffects({ cycles: 4, turns: 2, runOnlyPendingTimers: true });
        expect(terminalOps.streamReadBytes).toHaveBeenCalledWith('machine', expect.objectContaining({ terminalId: 'retried' }), expect.any(Object));
        expect(hook.getCurrent().error).toBeNull();
        await hook.unmount();
    });

    it('reports an offline Machine when a bound target is unavailable over RPC', async () => {
        const { useMachineTerminalSession } = await import('./useMachineTerminalSession');
        const terminalRef = { current: { write: vi.fn(), clear: vi.fn() } satisfies EmbeddedTerminalRendererHandle };
        const hook = await renderHook(() => useMachineTerminalSession({
            machineId: 'machine', serverId: homeIds.primary, cwd: '/repo', terminalKey: 'offline-typed-state', terminalRef,
            machineReachable: false, machineRpcTargetAvailable: false,
        }));
        await act(async () => hook.getCurrent().onReady(80, 24));
        await flushHookEffects({ cycles: 4, turns: 2, runOnlyPendingTimers: true });
        expect(hook.getCurrent()).toMatchObject({ status: 'error', error: 'terminal_machine_unreachable' });
        expect(terminalOps.ensure).not.toHaveBeenCalled();
        await hook.unmount();
    });

    it('settles terminal disposal when its close RPC loses transport', async () => {
        vi.useRealTimers();
        terminalOps.ensure.mockResolvedValue({ ok: true, terminalId: 'closing', reused: false });
        terminalOps.streamReadBytes.mockResolvedValue({ ok: true, terminalId: 'closing', frames: [], nextByteOffset: 0,
            availableByteOffset: 0, droppedBeforeByteOffset: 0, done: true });
        const closing = createDeferred<{ ok: true }>();
        terminalOps.close.mockReturnValue(closing.promise);
        const unhandled: unknown[] = [];
        const onUnhandled = (error: unknown) => { unhandled.push(error); };
        process.on('unhandledRejection', onUnhandled);
        try {
            const { useMachineTerminalSession } = await import('./useMachineTerminalSession');
            const terminalRef = { current: { write: vi.fn(), clear: vi.fn() } satisfies EmbeddedTerminalRendererHandle };
            const hook = await renderHook(() => useMachineTerminalSession({
                machineId: 'machine', serverId: homeIds.primary, cwd: '/repo', terminalKey: 'close-transport',
                terminalRef, closeOnUnmount: true,
            }));
            await act(async () => hook.getCurrent().onReady(80, 24));
            await vi.waitFor(() => expect(hook.getCurrent().status).toBe('exited'));
            await hook.unmount();
            expect(terminalOps.close).toHaveBeenCalled();
            closing.reject(createRpcCallError({ error: 'RPC target unavailable', errorCode: RPC_ERROR_CODES.CLIENT_NOT_AVAILABLE }));
            await new Promise(resolve => setImmediate(resolve));
            await new Promise(resolve => setImmediate(resolve));
            expect(unhandled).toEqual([]);
        } finally { process.off('unhandledRejection', onUnhandled); }
    });

    it.each([RPC_ERROR_CODES.METHOD_NOT_AVAILABLE, RPC_ERROR_CODES.CLIENT_NOT_AVAILABLE, 'MACHINE_RPC_TIMEOUT'])(
        'uses the existing finite recovery budget for a stream %s failure', async errorCode => {
            terminalOps.ensure.mockResolvedValue({ ok: true, terminalId: 'recover-stream', reused: true });
            terminalOps.streamReadBytes.mockRejectedValue(createRpcCallError({ error: 'Stream unavailable', errorCode }));
            terminalOps.streamRead.mockRejectedValue(createRpcCallError({ error: 'Stream unavailable', errorCode }));
            const { useMachineTerminalSession } = await import('./useMachineTerminalSession');
            const terminalRef = { current: { write: vi.fn(), clear: vi.fn() } satisfies EmbeddedTerminalRendererHandle };
            const hook = await renderHook(() => useMachineTerminalSession({
                machineId: 'machine', serverId: homeIds.primary, cwd: '/repo', terminalKey: `stream-recovery:${errorCode}`, terminalRef,
            }));
            await act(async () => hook.getCurrent().onReady(80, 24));
            await flushHookEffects({ cycles: 4, turns: 2 });
            expect(hook.getCurrent().status).toBe('connecting');
            for (let attempt = 1; attempt <= TERMINAL_AUTO_RETRY_MAX_ATTEMPTS; attempt++) {
                await act(async () => { await vi.advanceTimersByTimeAsync(resolveTerminalAutoRetryDelayMs(attempt)); });
                await flushHookEffects({ cycles: 4, turns: 2 });
            }
            expect(hook.getCurrent().status).toBe('error');
            expect(hook.getCurrent().error).toBe('terminal_rpc_target_unavailable');
            const settledReads = terminalOps.streamReadBytes.mock.calls.length;
            await act(async () => { await vi.advanceTimersByTimeAsync(resolveTerminalAutoRetryDelayMs(TERMINAL_AUTO_RETRY_MAX_ATTEMPTS)); });
            await flushHookEffects({ cycles: 4, turns: 2 });
            expect(terminalOps.streamReadBytes).toHaveBeenCalledTimes(settledReads);
            await hook.unmount();
        });

    it('attributes an owned terminal ensure to its Session', async () => {
        terminalOps.ensure.mockResolvedValue({ ok: true, terminalId: 'attributed', reused: false });
        terminalOps.streamReadBytes.mockResolvedValue({ ok: true, terminalId: 'attributed', frames: [], nextByteOffset: 0, availableByteOffset: 0, droppedBeforeByteOffset: 0, done: true });
        const { useMachineTerminalSession } = await import('./useMachineTerminalSession');
        const terminalRef = { current: { write: vi.fn(), clear: vi.fn() } satisfies EmbeddedTerminalRendererHandle };
        const hook = await renderHook(() => useMachineTerminalSession({ machineId: 'machine', cwd: '/repo', terminalKey: 'attribution', terminalRef, sessionId: 'own-session' }));
        await act(async () => hook.getCurrent().onReady(80, 24));
        await flushHookEffects({ cycles: 4, turns: 2, runOnlyPendingTimers: true });
        expect(terminalOps.ensure).toHaveBeenCalledWith('machine', expect.objectContaining({ sessionId: 'own-session' }), expect.any(Object));
        await hook.unmount();
    });

    it('closes a late ensure after unmount when terminal cleanup is requested', async () => {
        const ensured = createDeferred<DaemonTerminalEnsureResponse>();
        terminalOps.ensure.mockReturnValue(ensured.promise);
        terminalOps.close.mockResolvedValue({ ok: true });
        const terminalRef = { current: { write: vi.fn(), clear: vi.fn() } satisfies EmbeddedTerminalRendererHandle };
        const launch = { kind: 'agent_login', agentId: 'codex' } as const;
        const { useMachineTerminalSession } = await import('./useMachineTerminalSession');
        const hook = await renderHook(() => useMachineTerminalSession({
            machineId: 'machine-cancel', serverId: homeIds.cancel, cwd: null, launch,
            terminalKey: 'provider-login:machine-cancel:codex', terminalRef, closeOnUnmount: true,
        }));
        await act(async () => { hook.getCurrent().onReady(80, 24); });
        await vi.waitFor(() => expect({ error: hook.getCurrent().error, ensures: terminalOps.ensure.mock.calls.length })
            .toEqual({ error: null, ensures: 1 }));
        expect(terminalOps.ensure).toHaveBeenCalled();
        await hook.unmount();
        await act(async () => {
            ensured.resolve({ ok: true, terminalId: 'late-cancel-terminal', reused: false });
        });
        await vi.waitFor(() => expect(terminalOps.close).toHaveBeenCalledWith('machine-cancel', { terminalId: 'late-cancel-terminal' },
            { serverId: homeIds.cancel, accountId: 'terminal-account' }));
        expect(terminalOps.streamReadBytes).not.toHaveBeenCalled();
        expect(readTerminalSurfaceState('provider-login:machine-cancel:codex')?.terminalId ?? null).toBeNull();
    });

    it('keeps the stable terminal key and Home on a typed session-attach request', async () => {
        terminalOps.ensure.mockResolvedValue({ ok: true, terminalId: 'term-attach', reused: false });
        terminalOps.streamReadBytes.mockResolvedValue({
            ok: true,
            terminalId: 'term-attach',
            frames: [],
            nextByteOffset: 0,
            availableByteOffset: 0,
            droppedBeforeByteOffset: 0,
            done: false,
        });

        const terminalRef = {
            current: {
                write: vi.fn(),
                writeBytes: vi.fn(),
                clear: vi.fn(),
            } satisfies EmbeddedTerminalRendererHandle,
        };
        const launch = { kind: 'session_attach', sessionId: 'session-1' } as const;

        const { useMachineTerminalSession } = await import('./useMachineTerminalSession');
        const hook = await renderHook(
            () => useMachineTerminalSession({
                machineId: 'machine-1',
                serverId: homeIds.attach,
                sessionId: 'session-1',
                closeOnUnmount: true,
                cwd: null,
                launch,
                terminalKey: 'session:session-1:attached',
                terminalRef,
            }),
            { flushOptions: { cycles: 1, turns: 1 } },
        );

        await act(async () => {
            hook.getCurrent().onReady(80, 24);
        });
        await flushHookEffects({ cycles: 4, turns: 2, runOnlyPendingTimers: true });

        await vi.waitFor(() => expect({ error: hook.getCurrent().error, ensures: terminalOps.ensure.mock.calls.length })
            .toEqual({ error: null, ensures: 1 }));
        expect(terminalOps.ensure).toHaveBeenCalledWith('machine-1', expect.objectContaining({
            terminalKey: 'session:session-1:attached',
            launch: { kind: 'session_attach', sessionId: 'session-1' },
        }), { serverId: homeIds.attach, accountId: 'terminal-account' });
        await vi.waitFor(() => expect(terminalOps.streamReadBytes).toHaveBeenCalledWith('machine-1', expect.any(Object), expect.objectContaining({ serverId: homeIds.attach })));

        terminalOps.streamSendInput.mockResolvedValue({ ok: true });
        await act(async () => {
            hook.getCurrent().onInput('pwd\r');
        });
        await flushHookEffects({ cycles: 2, turns: 2, runOnlyPendingTimers: true });
        await vi.waitFor(() => expect(terminalOps.streamSendInput).toHaveBeenCalledWith(
            'machine-1',
            { terminalId: 'term-attach', event: { t: 'text', text: 'pwd\r' } },
            expect.objectContaining({ serverId: homeIds.attach }),
        ));

        terminalOps.restart.mockResolvedValue({ ok: true, terminalId: 'term-restarted', reused: false });
        terminalOps.streamReadBytes.mockResolvedValue({
            ok: true, terminalId: 'term-restarted', frames: [], nextByteOffset: 0,
            availableByteOffset: 0, droppedBeforeByteOffset: 0, done: true,
        });
        await act(async () => hook.getCurrent().requestRestart());
        await flushHookEffects({ cycles: 4, turns: 2, runOnlyPendingTimers: true });
        await vi.waitFor(() => expect(terminalOps.restart).toHaveBeenCalledWith('machine-1', expect.objectContaining({ sessionId: 'session-1' }), { serverId: homeIds.attach, accountId: 'terminal-account' }));
        await vi.waitFor(() => expect(hook.getCurrent().terminalId).toBe('term-restarted'));

        await hook.unmount();
        expect(terminalOps.close).toHaveBeenCalledWith('machine-1', { terminalId: 'term-restarted' }, { serverId: homeIds.attach, accountId: 'terminal-account' });
    });

    it('owns bounded title, bell, and user-selection copy policy at the session controller', async () => {
        const { Platform } = await import('react-native');
        const previousPlatform = Platform.OS;
        Platform.OS = 'web';
        onTestFinished(() => { Platform.OS = previousPlatform; });
        const renderer: EmbeddedTerminalRendererHandle = {
            write: vi.fn(),
            clear: vi.fn(),
            hasSelection: () => true,
            getSelectionText: () => 'selected terminal output',
        };
        const terminalRef = { current: renderer };
        const { useMachineTerminalSession } = await import('./useMachineTerminalSession');
        const hook = await renderHook(
            () => useMachineTerminalSession({
                machineId: null,
                cwd: null,
                terminalKey: 'session:terminal-presentation-policy',
                terminalRef,
            }),
            { flushOptions: { cycles: 1, turns: 1 } },
        );
        const controller = hook.getCurrent() as typeof hook extends { getCurrent: () => infer T } ? T & Readonly<{
            terminalTitle?: string | null;
            terminalBell?: string | null;
            copySelection?: (request?: Readonly<{ source: 'user-selection' | 'remote-osc52'; text: string }>) => void;
        }> : never;

        await act(async () => {
            controller.onTitle?.(`status\u001b[31m${'x'.repeat(160)}`);
            controller.onBell?.('ding\u0007\u001b[31m');
            controller.copySelection?.();
            controller.copySelection?.({ source: 'remote-osc52', text: 'remote clipboard payload' });
        });

        const updatedController = hook.getCurrent() as typeof controller;
        expect(updatedController.terminalTitle).toHaveLength(120);
        expect(updatedController.terminalTitle).toContain('status[31m');
        expect(updatedController.terminalTitle).not.toContain('\u001b');
        expect(updatedController.terminalBell).toBe('ding[31m');
        expect(clipboardState.setClipboardStringSafe).toHaveBeenCalledWith('selected terminal output');
        expect(clipboardState.setClipboardStringSafe).not.toHaveBeenCalledWith('remote clipboard payload');

        await hook.unmount();
    });

    it('preserves control replay when the daemon boundary refuses only held reads', async () => {
        // Prior development 83dcfa7462 has a closed request with controlCursor but no holdForOutput.
        terminalOps.streamReadBytes.mockImplementation(async (_machineId, request) => {
            if (request.holdForOutput !== undefined) return { ok: false, code: 'terminal_invalid_request', message: 'terminal_invalid_request' };
            return { ok: true, terminalId: 'term-1', frames: request.controlCursor === 0 ? [{
                t: 'url', terminalId: 'term-1', byteOffset: 0, url: 'https://example.test', kind: 'auth',
            }] : [], nextByteOffset: 0, availableByteOffset: 0, droppedBeforeByteOffset: 0,
                nextControlCursor: 1, done: false };
        });
        const { createMachineRpcTerminalStreamCarrier } = await import('@/sync/domains/terminal/stream/carrier');
        const carrier = createMachineRpcTerminalStreamCarrier({ machineId: 'machine', serverId: homeIds.primary });
        const request = { terminalId: 'term-1', cursor: { mode: 'byte-offset' as const, value: 0 } };
        expect(await carrier.read(request)).toMatchObject({ ok: true, frames: [{ t: 'url' }] });
        expect(await carrier.read(request)).toMatchObject({ ok: true, frames: [] });
        expect(terminalOps.streamReadBytes).toHaveBeenCalledTimes(3);
    });

    it('carries the daemon held-read fact and returns ACK credit without holding', async () => {
        terminalOps.streamReadBytes.mockResolvedValue({ ok: true, terminalId: 'term-1', frames: [],
            nextByteOffset: 0, availableByteOffset: 0, droppedBeforeByteOffset: 0,
            nextControlCursor: 0, holdForOutput: true, done: false });
        const { createMachineRpcTerminalStreamCarrier } = await import('@/sync/domains/terminal/stream/carrier');
        const carrier = createMachineRpcTerminalStreamCarrier({ machineId: 'machine', serverId: homeIds.primary, accountId: 'terminal-account' });
        expect(await carrier.read({ terminalId: 'term-1', cursor: { mode: 'byte-offset', value: 0 } }))
            .toMatchObject({ ok: true, holdForOutput: true });
        await carrier.acknowledge({ terminalId: 'term-1', rendererId: 'renderer-1', surfaceEpoch: 0, ackedByteOffset: 0, creditBytes: 64 });
        expect(terminalOps.streamCreditRead).toHaveBeenCalledWith('machine', {
            byteOffset: 0,
            terminalId: 'term-1', rendererId: 'renderer-1', surfaceEpoch: 0, ackedByteOffset: 0, creditBytes: 64,
        }, expect.any(Object));
        expect(terminalOps.streamAcknowledge).not.toHaveBeenCalled();
    });

    it('credits synchronously accepted byte writes without accepting an unsolicited renderer completion', async () => {
        terminalOps.ensure.mockResolvedValue({ ok: true, terminalId: 'term-1', reused: false });
        terminalOps.streamReadBytes.mockResolvedValueOnce({
            ok: true,
            terminalId: 'term-1',
            frames: [{
                t: 'bytes',
                terminalId: 'term-1',
                seq: 1,
                byteOffset: 0,
                byteLength: 3,
                encoding: 'base64',
                data: 'QUJD',
            }],
            nextByteOffset: 3,
            availableByteOffset: 3,
            droppedBeforeByteOffset: 0,
            done: true,
        });

        const renderer: EmbeddedTerminalRendererHandle = {
            write: vi.fn(),
            writeBytes: vi.fn(),
            clear: vi.fn(),
        };
        const terminalRef = { current: renderer };
        const { useMachineTerminalSession } = await import('./useMachineTerminalSession');
        const hook = await renderHook(
            () => useMachineTerminalSession({
                machineId: 'machine-1',
                cwd: '/repo',
                terminalKey: 'session:s1:terminal',
                terminalRef,
            }),
            { flushOptions: { cycles: 1, turns: 1 } },
        );

        await act(async () => {
            hook.getCurrent().onReady(80, 24);
        });
        await flushHookEffects({ cycles: 4, turns: 2, runOnlyPendingTimers: true });

        expect(renderer.writeBytes).toHaveBeenCalledWith(expect.objectContaining({
            terminalId: 'term-1',
            byteOffset: 0,
            bytes: new Uint8Array([65, 66, 67]),
        }));
        expect(terminalOps.streamReadBytes).toHaveBeenCalledWith(
            'machine-1',
            expect.objectContaining({ terminalId: 'term-1', byteOffset: 0 }),
            expect.any(Object),
        );
        expect(terminalOps.streamRead).not.toHaveBeenCalled();
        expect(hook.getCurrent()).toMatchObject({ status: 'exited', outputRetention: { truncated: false } });
        expect(renderer.write).not.toHaveBeenCalledWith('ABC');

        expect(terminalOps.streamAcknowledge).not.toHaveBeenCalled();
        expect(terminalOps.streamCreditRead).toHaveBeenCalledWith(
            'machine-1',
            expect.objectContaining({
                terminalId: 'term-1',
                byteOffset: 3,
                ackedByteOffset: 3,
                rendererId: 'embedded-terminal',
            }),
            expect.objectContaining({ serverId: homeIds.primary, accountId: 'terminal-account' }),
        );

        const acknowledgementsBeforeUnsolicitedCompletion = terminalOps.streamCreditRead.mock.calls.length;
        await act(async () => {
            hook.getCurrent().onWriteComplete(rendererWriteComplete({
                terminalId: 'term-1',
                seq: 1,
                byteOffset: 0,
                byteLength: 3,
                ackedByteOffset: 3,
                writeGeneration: 0,
            }));
        });

        expect(terminalOps.streamCreditRead).toHaveBeenCalledTimes(acknowledgementsBeforeUnsolicitedCompletion);

        await hook.unmount();
    });

    it('does not advance the byte replay cursor when the renderer rejects a byte write', async () => {
        terminalOps.ensure.mockResolvedValue({ ok: true, terminalId: 'term-retry', reused: false });
        terminalOps.streamReadBytes
            .mockResolvedValueOnce({
                ok: true,
                terminalId: 'term-retry',
                frames: [{
                    t: 'bytes',
                    terminalId: 'term-retry',
                    seq: 1,
                    byteOffset: 0,
                    byteLength: 3,
                    encoding: 'base64',
                    data: 'QUJD',
                }],
                nextByteOffset: 3,
                availableByteOffset: 3,
                droppedBeforeByteOffset: 0,
                done: false,
            })
            .mockResolvedValue({
                ok: true,
                terminalId: 'term-retry',
                frames: [],
                nextByteOffset: 0,
                availableByteOffset: 3,
                droppedBeforeByteOffset: 0,
                done: false,
            });

        const renderer: EmbeddedTerminalRendererHandle = {
            write: vi.fn(),
            writeBytes: vi.fn(() => false),
            clear: vi.fn(),
        };
        const terminalRef = { current: renderer };
        const { useMachineTerminalSession } = await import('./useMachineTerminalSession');
        const hook = await renderHook(
            () => useMachineTerminalSession({
                machineId: 'machine-1',
                cwd: '/repo',
                terminalKey: 'session:s-retry:terminal',
                terminalRef,
            }),
            { flushOptions: { cycles: 1, turns: 1 } },
        );

        await act(async () => {
            hook.getCurrent().onReady(80, 24);
        });
        await flushHookEffects({ cycles: 5, turns: 2, runOnlyPendingTimers: true });

        expect(renderer.writeBytes).toHaveBeenCalledTimes(1);
        expect(terminalOps.streamReadBytes).toHaveBeenNthCalledWith(
            1,
            'machine-1',
            expect.objectContaining({ terminalId: 'term-retry', byteOffset: 0 }),
            expect.any(Object),
        );
        expect(terminalOps.streamReadBytes).toHaveBeenNthCalledWith(
            2,
            'machine-1',
            expect.objectContaining({ terminalId: 'term-retry', byteOffset: 0 }),
            expect.any(Object),
        );

        await hook.unmount();
    });

    it('keeps predecessor snapshot reads paced and delivers output when held reads are unavailable', async () => {
        const terminalId = 'simpl15-pf56-idle';
        let outputReady = false;
        terminalOps.ensure.mockResolvedValue({ ok: true, terminalId, reused: false });
        terminalOps.streamReadBytes.mockImplementation(() => TerminalStreamReadResponseSchema.parse({
            ok: true, terminalId,
            frames: outputReady ? [{ t: 'bytes', terminalId, seq: 0, byteOffset: 0, byteLength: 3,
                encoding: 'base64', data: 'QUJD' }] : [],
            nextByteOffset: outputReady ? 3 : 0,
            availableByteOffset: outputReady ? 3 : 0,
            droppedBeforeByteOffset: 0, done: outputReady,
        }));
        const write = vi.fn();
        const terminalRef = { current: { write, clear: vi.fn() } satisfies EmbeddedTerminalRendererHandle };
        const { useMachineTerminalSession } = await import('./useMachineTerminalSession');
        const hook = await renderHook(() => useMachineTerminalSession({
            machineId: 'machine', serverId: homeIds.primary, cwd: '/repo', terminalKey: 'simpl15-pf56-idle', terminalRef,
            attachedTerminalId: terminalId, readOnly: true,
        }), { flushOptions: { cycles: 1, turns: 1 } });
        await act(async () => { hook.getCurrent().onReady(80, 24); });
        await flushHookEffects({ cycles: 4, turns: 2, runOnlyPendingTimers: true });
        expect(hook.getCurrent().error).toBeNull();
        await vi.waitFor(() => expect(terminalOps.streamReadBytes).toHaveBeenCalled());
        const initialReads = terminalOps.streamReadBytes.mock.calls.length;
        await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
        const idleReads = terminalOps.streamReadBytes.mock.calls.length - initialReads;
        outputReady = true;
        await act(async () => { await vi.advanceTimersByTimeAsync(250); });
        expect(write).toHaveBeenCalledWith('ABC');
        await hook.unmount();
        expect(idleReads).toBeGreaterThan(0);
    });

    it('PF56 replays retained history beyond the preview when a Shell moves and reopens', async () => {
        const { appPaneReduce, createAppPaneState } = await import('@/components/appShell/panes/model/appPaneReducer');
        const { useMachineTerminalSession } = await import('./useMachineTerminalSession');
        const scopeId = 'project:pf56-renderer-replay';
        const terminalId = 'pf56-renderer-replay';
        const terminalKey = 'pf56-renderer-replay';
        let panes = appPaneReduce(createAppPaneState({ maxScopesInMemory: 3 }), {
            type: 'terminalWorkspace', scopeId, command: { type: 'open', terminal: {
                id: terminalId, target: { kind: 'terminal_view', machineId: 'machine', terminalId, terminalKey, cwd: '/repo' },
            } },
        });
        let output = 'earlier retained output\r\n' + 'history\r\n'.repeat(8_000);
        const held = createDeferred<ReturnType<typeof TerminalStreamReadResponseSchema.parse>>();
        terminalOps.streamReadBytes.mockImplementation((_machineId: string, request: { byteOffset: number; maxBytes?: number }) => {
            const bytes = Buffer.from(output);
            if (request.byteOffset === bytes.length) return held.promise;
            const end = Math.min(bytes.length, request.byteOffset + (request.maxBytes ?? 16_384));
            const frames = [];
            for (let offset = request.byteOffset; offset < end; offset += TERMINAL_STREAM_MAX_FRAME_DECODED_BYTES) {
                const chunk = bytes.subarray(offset, Math.min(end, offset + TERMINAL_STREAM_MAX_FRAME_DECODED_BYTES));
                frames.push({ t: 'bytes', terminalId, seq: offset, byteOffset: offset, byteLength: chunk.length,
                    encoding: 'base64', data: chunk.toString('base64') });
            }
            return TerminalStreamReadResponseSchema.parse({ ok: true, terminalId, frames, nextByteOffset: end,
                availableByteOffset: bytes.length, droppedBeforeByteOffset: 0, done: false, holdForOutput: true });
        });
        const mountView = async (pane: 'bottom' | 'right') => {
            expect(panes.scopes[scopeId][pane].isOpen).toBe(true);
            let rendered = '';
            const terminalRef = { current: {
                write: (text: string) => { rendered += text; return true; },
                clear: () => { rendered = ''; },
            } satisfies EmbeddedTerminalRendererHandle };
            const hook = await renderHook(() => useMachineTerminalSession({
                machineId: 'machine', serverId: homeIds.primary, cwd: '/repo', terminalKey, terminalRef,
                attachedTerminalId: terminalId, readOnly: true,
            }));
            await flushHookEffects({ cycles: 8, turns: 2 });
            expect(hook.getCurrent().error).toBeNull();
            return { hook, read: () => rendered };
        };
        const first = await mountView('bottom');
        expect(first.read()).toBe(output);
        expect(readTerminalSurfaceState(terminalKey)?.output.length).toBeLessThan(output.length);
        await first.hook.unmount();
        panes = appPaneReduce(panes, { type: 'openRight', scopeId, tabId: 'terminal' });
        expect(panes.scopes[scopeId].bottom.isOpen).toBe(false);
        output += 'sidebar prompt$ ';
        const moved = await mountView('right');
        expect(moved.read()).toBe(output);
        await moved.hook.unmount();
        panes = appPaneReduce(panes, { type: 'closeRight', scopeId });
        panes = appPaneReduce(panes, { type: 'openRight', scopeId, tabId: 'terminal' });
        output += 'reopened prompt$ ';
        const reopened = await mountView('right');
        expect(reopened.read()).toBe(output);
        await reopened.hook.unmount();
    });

    it.each([
        { beyondPreview: false, pending: false, lostWhileHidden: false },
        { beyondPreview: true, pending: false, lostWhileHidden: false },
        { beyondPreview: false, pending: true, lostWhileHidden: false },
        { beyondPreview: false, pending: false, lostWhileHidden: true },
    ])('preserves already displayed history after daemon retention expires on a move (%j)', async ({ beyondPreview, pending, lostWhileHidden }) => {
        vi.useRealTimers();
        const { useMachineTerminalSession } = await import('./useMachineTerminalSession');
        const terminalId = `expired-history-${beyondPreview}-${pending}-${lostWhileHidden}`;
        const terminalKey = terminalId;
        const history = Array.from({ length: 30 }, (_, i) => `marker ${i} café 🦀\r\n`).join('')
            + (beyondPreview ? 'retained history\r\n'.repeat(4500) : '');
        const splitCharacter = Buffer.from('🦀');
        let output = pending ? Buffer.concat([Buffer.from(history), splitCharacter.subarray(0, 2)]) : Buffer.from(history);
        let retainedFrom = 0;
        const held = createDeferred<ReturnType<typeof TerminalStreamReadResponseSchema.parse>>();
        let transportReady = createDeferred<void>();
        terminalOps.streamReadBytes.mockImplementation(async (_machineId: string, request: { byteOffset: number; maxBytes?: number }) => {
            await transportReady.promise;
            if (request.byteOffset === output.length) return held.promise;
            const start = Math.max(retainedFrom, request.byteOffset);
            const end = Math.min(output.length, start + (request.maxBytes ?? TERMINAL_STREAM_MAX_READ_BYTES));
            const frames: Record<string, unknown>[] = request.byteOffset < retainedFrom
                ? [{ t: 'gap', terminalId, droppedBeforeByteOffset: retainedFrom,
                    nextAvailableByteOffset: retainedFrom, reason: 'ring_overflow' }] : [];
            for (let offset = start; offset < end; offset += TERMINAL_STREAM_MAX_FRAME_DECODED_BYTES) {
                const chunk = output.subarray(offset, Math.min(end, offset + TERMINAL_STREAM_MAX_FRAME_DECODED_BYTES));
                frames.push({ t: 'bytes', terminalId, seq: offset, byteOffset: offset, byteLength: chunk.length,
                    encoding: 'base64', data: chunk.toString('base64') });
            }
            return TerminalStreamReadResponseSchema.parse({ ok: true, terminalId, frames, nextByteOffset: end,
                availableByteOffset: output.length, droppedBeforeByteOffset: retainedFrom, done: false, holdForOutput: true });
        });
        const retainedTerminal = new Terminal({ cols: 80, rows: 24, scrollback: 5000 });
        const writes = new Set<Promise<void>>();
        let finishDetachedWrite: (() => void) | undefined;
        let disposed = false;
        let resourceAttached = false;
        const resource = { kind: 'xterm-web' as const,
            get attached() { return resourceAttached; },
            whenSettled: async () => { await Promise.all(writes); },
            dispose: () => { if (!disposed) retainedTerminal.dispose(); disposed = true; resourceAttached = false; } };
        onTestFinished(resource.dispose);
        const read = () => Array.from({ length: retainedTerminal.buffer.active.length }, (_, index) =>
            retainedTerminal.buffer.active.getLine(index)?.translateToString(true) ?? '').join('\n').trimEnd();
        let mounts = 0;
        const mount = async (expected: string, afterMount?: () => Promise<void>) => {
            transportReady = createDeferred<void>();
            let restored = false;
            let activeTerminal = mounts++ === 0 ? retainedTerminal : new Terminal({ cols: 80, rows: 24, scrollback: 5000 });
            if (activeTerminal !== retainedTerminal) {
                const temporaryTerminal = activeTerminal;
                onTestFinished(() => temporaryTerminal.dispose());
            }
            let complete = (_event: EmbeddedTerminalWriteCompleteEvent) => {};
            const terminalRef = { current: {
                write: (text: string) => { activeTerminal.write(text); return true; },
                clear: () => { activeTerminal.reset(); },
                writeBytes: (input) => {
                    const notify = complete;
                    const write = new Promise<void>(resolve => activeTerminal.write(input.bytes, () => {
                        const finish = () => { notify(buildXtermWriteCompleteEvent(input)); resolve(); };
                        if (pending && mounts === 1) finishDetachedWrite = finish;
                        else finish();
                    }));
                    writes.add(write);
                    void write.then(() => writes.delete(write));
                    return queuedWriteResult;
                },
                captureResource: () => { resourceAttached = true; return resource; },
                restoreResource: (candidate) => { restored = candidate === resource;
                    if (restored) { activeTerminal = retainedTerminal; resourceAttached = true; }
                    return restored; },
                hasRetainedOutput: () => restored,
            } satisfies EmbeddedTerminalRendererHandle };
            const hook = await renderHook(() => useMachineTerminalSession({
                machineId: 'machine', serverId: homeIds.primary, cwd: '/repo', terminalKey, terminalRef,
                attachedTerminalId: terminalId, readOnly: true,
            }));
            complete = event => hook.getCurrent().onWriteComplete(event);
            transportReady.resolve();
            await afterMount?.();
            await vi.waitFor(() => expect(read()).toBe(expected.replaceAll('\r\n', '\n').trimEnd()));
            expect(hook.getCurrent().error).toBeNull();
            if (!pending || mounts > 1) await resource.whenSettled();
            return { hook, read };
        };
        const first = await mount(history);
        expect(first.read()).toBe(history.replaceAll('\r\n', '\n').trimEnd());
        expect(readTerminalSurfaceState(terminalKey)).toMatchObject({ cursor: pending ? 0 : output.length,
            rendererResource: resource });
        await first.hook.unmount();
        resourceAttached = false;
        retainedFrom = output.length - Buffer.byteLength('retained history\r\n'.repeat(8));
        if (!beyondPreview) retainedFrom = Buffer.byteLength(history.split('\r\n').slice(0, 22).join('\r\n') + '\r\n');
        if (lostWhileHidden) {
            output = Buffer.concat([output, Buffer.from('unobserved output\r\n')]);
            retainedFrom = output.length;
        }
        output = Buffer.concat([output, ...(pending ? [splitCharacter.subarray(2)] : []), Buffer.from('new prompt$ ')]);
        const expected = history + (pending ? '🦀' : '')
            + (lostWhileHidden ? TERMINAL_OUTPUT_GAP_MARKER : '') + 'new prompt$ ';
        const previousReads = terminalOps.streamReadBytes.mock.calls.length;
        const moved = await mount(expected, pending ? async () => {
            expect(finishDetachedWrite).toBeDefined();
            await flushHookEffects({ cycles: 2, turns: 2 });
            expect(terminalOps.streamReadBytes).toHaveBeenCalledTimes(previousReads);
            await act(async () => { finishDetachedWrite?.(); });
        } : undefined);
        expect(moved.read()).toBe(expected.replaceAll('\r\n', '\n').trimEnd());
        expect(readTerminalSurfaceState(terminalKey)?.output.endsWith((pending ? '🦀' : '') + 'new prompt$ ')).toBe(true);
        expect(moved.read().includes(TERMINAL_OUTPUT_GAP_MARKER.trim())).toBe(lostWhileHidden);
        if (!beyondPreview && !pending && !lostWhileHidden) {
            await act(async () => { await servedHomes.switchAccount('primary', 'replacement-account'); });
            expect(disposed).toBe(true);
            expect(readTerminalSurfaceState(terminalKey)?.rendererResource).toBeUndefined();
            expect(moved.read()).toBe('');
        }
        await moved.hook.unmount();
        resourceAttached = false;
    });

    // This native peer uses the CLI's POSIX Python relay; renderer ordering is covered separately on every platform.
    it.skipIf(process.platform === 'win32')('PF56 drains a fast user-input burst through the real hook, carrier, CLI RPC and native PTY, then holds idle', async () => {
        vi.useRealTimers();
        const peer = await createPf56NativeTerminalPeer(homeIds.primary);
        onTestFinished(() => peer.dispose());
        const terminalId = peer.terminalId;
        terminalOps.streamReadBytes.mockImplementation((_machineId, request) => peer.request(RPC_METHODS.DAEMON_TERMINAL_STREAM_READ_BYTES, request));
        terminalOps.streamCreditRead.mockImplementation((_machineId, request) => peer.request(RPC_METHODS.DAEMON_TERMINAL_STREAM_READ_BYTES, request));
        terminalOps.streamSendInput.mockImplementation((_machineId, request) => peer.request(RPC_METHODS.DAEMON_TERMINAL_STREAM_INPUT, request));
        const terminal = new Terminal({ cols: 80, rows: 24 });
        onTestFinished(() => terminal.dispose());
        let complete = (_event: EmbeddedTerminalWriteCompleteEvent) => {};
        const queue = createXtermWriteQueue({ write: (data, callback) => terminal.write(data, callback),
            schedule: () => {}, maxPendingBytes: TERMINAL_STREAM_MAX_READ_BYTES });
        let parsed = '';
        const generations: number[] = [];
        const renderer: EmbeddedTerminalRendererHandle = {
            write: data => { terminal.write(data); return true; },
            clear: () => { queue.clear(); terminal.clear(); },
            writeBytes: input => {
                const event = buildXtermWriteCompleteEvent(input);
                generations.push(input.writeGeneration);
                queue.enqueue({ data: input.bytes, byteLength: input.bytes.length, onComplete: () => {
                    parsed += new TextDecoder().decode(input.bytes);
                    complete(event);
                } });
                queue.flush();
                return queuedWriteResult;
            },
        };
        const terminalRef = { current: renderer };
        const { useMachineTerminalSession } = await import('./useMachineTerminalSession');
        const hook = await renderHook(() => useMachineTerminalSession({ machineId: 'machine', serverId: homeIds.primary,
            cwd: '/repo', terminalKey: 'pf56-native-burst', terminalRef, attachedTerminalId: terminalId }));
        complete = event => hook.getCurrent().onWriteComplete(event);
        terminal.onData(data => hook.getCurrent().onInput(data));
        await vi.waitFor(() => expect(terminalOps.streamReadBytes).toHaveBeenCalled());
        expect(hook.getCurrent().error).toBeNull();
        const burst = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ12345678';
        const started = Date.now();
        await act(async () => { for (const character of burst) terminal.input(character); });
        const inputElapsedMs = Date.now() - started;
        expect(inputElapsedMs).toBeLessThan(1000);
        await vi.waitFor(() => expect(parsed).toContain(burst));
        const echoElapsedMs = Date.now() - started;
        const sent = terminalOps.streamSendInput.mock.calls.map(([, request]) => request.event.text ?? '').join('');
        expect(sent).toBe(burst);
        await vi.waitFor(() => expect(terminalOps.streamReadBytes.mock.calls.at(-1)?.[1]).toMatchObject({
            byteOffset: expect.any(Number), ackedByteOffset: expect.any(Number), surfaceEpoch: generations.at(-1),
        }));
        const reads = terminalOps.streamReadBytes.mock.calls.length;
        const finalRead = terminalOps.streamReadBytes.mock.calls.at(-1)?.[1];
        expect(finalRead.ackedByteOffset).toBe(finalRead.byteOffset);
        vi.useFakeTimers();
        await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
        expect(terminalOps.streamReadBytes).toHaveBeenCalledTimes(reads);
        vi.useRealTimers();
        await act(async () => terminal.input('\u0003'));
        await vi.waitFor(() => expect(terminalOps.streamReadBytes.mock.calls.length).toBeGreaterThan(reads));
        expect(hook.getCurrent().inputRecoveryAvailable).toBe(false);
        console.info('PF56_BURST_EVIDENCE', JSON.stringify({
            platform: process.platform, inputCharacters: burst.length, sentCharacters: sent.length,
            inputElapsedMs, echoElapsedMs, outputReadsBeforeIdle: reads, additionalReadsDuringIdle: 0,
            idleUiClockMs: 60_000, outputReadsAfterRearm: terminalOps.streamReadBytes.mock.calls.length,
            byteOffset: finalRead.byteOffset, ackedByteOffset: finalRead.ackedByteOffset,
            surfaceEpoch: finalRead.surfaceEpoch, parserGeneration: generations.at(-1),
            inputRecoveryAvailable: hook.getCurrent().inputRecoveryAvailable,
        }));
        await hook.unmount();
    }, 60_000);

    it('PF56 holds one read per idle minute and renews a deadline without consumer pacing or lost output', async () => {
        const terminalId = 'pf56-held';
        const first = createDeferred<ReturnType<typeof TerminalStreamReadResponseSchema.parse>>();
        const next = createDeferred<ReturnType<typeof TerminalStreamReadResponseSchema.parse>>();
        const empty = TerminalStreamReadResponseSchema.parse({ ok: true, terminalId, frames: [],
            nextByteOffset: 0, availableByteOffset: 0, droppedBeforeByteOffset: 0, done: false, holdForOutput: true });
        terminalOps.streamReadBytes.mockImplementationOnce(() => first.promise).mockImplementation(() => next.promise);
        const write = vi.fn();
        const terminalRef = { current: { write, clear: vi.fn() } satisfies EmbeddedTerminalRendererHandle };
        const { useMachineTerminalSession } = await import('./useMachineTerminalSession');
        const hook = await renderHook(() => useMachineTerminalSession({
            machineId: 'machine', serverId: homeIds.primary, cwd: '/repo', terminalKey: 'pf56-held', terminalRef,
            attachedTerminalId: terminalId, readOnly: true,
        }));
        await flushHookEffects({ cycles: 4, turns: 2, runOnlyPendingTimers: true });
        expect(terminalOps.streamReadBytes).toHaveBeenCalledTimes(1);
        await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
        expect(terminalOps.streamReadBytes).toHaveBeenCalledTimes(1);
        await act(async () => first.resolve(empty));
        await flushHookEffects({ cycles: 4, turns: 2 });
        expect(terminalOps.streamReadBytes).toHaveBeenCalledTimes(2);
        await act(async () => next.resolve(TerminalStreamReadResponseSchema.parse({ ...empty,
            frames: [{ t: 'bytes', terminalId, seq: 0, byteOffset: 0, byteLength: 3, encoding: 'base64', data: 'QUJD' },
                { t: 'exit', terminalId, byteOffset: 3, exitCode: 0, signal: null }],
            nextByteOffset: 3, availableByteOffset: 3, done: true,
        })));
        await flushHookEffects({ cycles: 4, turns: 2 });
        expect(write).toHaveBeenCalledWith('ABC');
        expect(hook.getCurrent()).toMatchObject({ status: 'exited', exitCode: 0 });
        expect(terminalOps.streamReadBytes).toHaveBeenCalledTimes(2);
        await hook.unmount();
    });

    it('waits for queued native write ACK before advancing the byte replay cursor', async () => {
        let terminalWaitTimers = 0;
        const timers = installTimerCensus((stack) => {
            if (!stack.includes('useMachineTerminalSession.ts')) return null;
            terminalWaitTimers++;
            return 'terminal-renderer';
        });
        registerStandardCleanupTarget({ unmount: timers.stop });
        terminalOps.ensure.mockResolvedValue({ ok: true, terminalId: 'term-native-queue', reused: false });
        terminalOps.streamReadBytes
            .mockResolvedValueOnce({
                ok: true,
                terminalId: 'term-native-queue',
                frames: [{
                    t: 'bytes',
                    terminalId: 'term-native-queue',
                    seq: 5,
                    byteOffset: 0,
                    byteLength: 3,
                    encoding: 'base64',
                    data: 'QUJD',
                }],
                nextByteOffset: 3,
                availableByteOffset: 3,
                droppedBeforeByteOffset: 0,
                done: false,
            })
            .mockResolvedValue({
                ok: true,
                terminalId: 'term-native-queue',
                frames: [],
                nextByteOffset: 3,
                availableByteOffset: 3,
                droppedBeforeByteOffset: 0,
                done: false,
            });

        const writeBytes = vi.fn((_input: EmbeddedTerminalWriteBytesInput) => queuedWriteResult);
        const renderer: EmbeddedTerminalRendererHandle = {
            write: vi.fn(),
            writeBytes,
            clear: vi.fn(),
        };
        const terminalRef = { current: renderer };
        const { useMachineTerminalSession } = await import('./useMachineTerminalSession');
        const hook = await renderHook(
            () => useMachineTerminalSession({
                machineId: 'machine-1',
                cwd: '/repo',
                terminalKey: 'session:s-native-queue:terminal',
                terminalRef,
            }),
            { flushOptions: { cycles: 1, turns: 1 } },
        );

        await act(async () => {
            hook.getCurrent().onReady(80, 24);
        });
        await flushHookEffects({ cycles: 4, turns: 2, runOnlyPendingTimers: true });

        expect(renderer.writeBytes).toHaveBeenCalledTimes(1);
        expect(terminalOps.streamReadBytes).toHaveBeenCalledTimes(1);

        const terminalWaitTimersBeforeWait = terminalWaitTimers;
        await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
        expect(terminalWaitTimers - terminalWaitTimersBeforeWait).toBe(0);
        expect(timers.read().filter(timer => timer.consumer === 'terminal-renderer')).toHaveLength(0);

        await act(async () => {
            hook.getCurrent().onWriteComplete(rendererWriteComplete({
                terminalId: 'term-native-queue',
                seq: 5,
                byteOffset: 0,
                byteLength: 3,
                ackedByteOffset: 99,
                writeGeneration: 0,
            }));
        });
        await flushHookEffects({ cycles: 2, turns: 1, runOnlyPendingTimers: true });

        expect(terminalOps.streamReadBytes).toHaveBeenCalledTimes(1);
        expect(terminalOps.streamCreditRead).not.toHaveBeenCalled();

        await act(async () => {
            hook.getCurrent().onWriteComplete(rendererWriteComplete({
                terminalId: 'term-native-queue',
                seq: 5,
                byteOffset: 0,
                byteLength: 2,
                ackedByteOffset: 3,
                writeGeneration: 0,
            }));
        });
        await flushHookEffects({ cycles: 2, turns: 1, runOnlyPendingTimers: true });

        expect(terminalOps.streamReadBytes).toHaveBeenCalledTimes(1);
        expect(terminalOps.streamCreditRead).not.toHaveBeenCalled();

        await act(async () => {
            hook.getCurrent().onWriteComplete(rendererWriteComplete({
                terminalId: 'term-native-queue',
                seq: 5,
                byteOffset: 0,
                byteLength: 3,
                ackedByteOffset: 3,
                writeGeneration: 1,
            }));
        });
        await flushHookEffects({ cycles: 2, turns: 1, runOnlyPendingTimers: true });

        expect(terminalOps.streamReadBytes).toHaveBeenCalledTimes(1);
        expect(terminalOps.streamCreditRead).not.toHaveBeenCalled();

        await act(async () => {
            hook.getCurrent().onWriteComplete(rendererWriteComplete({
                terminalId: 'term-native-queue',
                seq: 5,
                byteOffset: 0,
                byteLength: 3,
                ackedByteOffset: 3,
                writeGeneration: 0,
            }));
        });
        await flushHookEffects({ cycles: 4, turns: 2, runOnlyPendingTimers: true });

        expect(terminalOps.streamReadBytes).toHaveBeenNthCalledWith(
            2,
            'machine-1',
            expect.objectContaining({ terminalId: 'term-native-queue', byteOffset: 3 }),
            expect.any(Object),
        );
        expect(terminalOps.streamCreditRead).toHaveBeenCalledWith(
            'machine-1',
            expect.objectContaining({
                terminalId: 'term-native-queue',
                byteOffset: 3,
                ackedByteOffset: 3,
                rendererId: 'embedded-terminal',
            }),
            expect.objectContaining({ serverId: homeIds.primary, accountId: 'terminal-account' }),
        );

        const acknowledgedBeforeClear = terminalOps.streamCreditRead.mock.calls.length;
        await act(async () => {
            hook.getCurrent().clearTerminal();
            hook.getCurrent().onWriteComplete(rendererWriteComplete({
                terminalId: 'term-native-queue',
                seq: 5,
                byteOffset: 0,
                byteLength: 3,
                ackedByteOffset: 3,
                writeGeneration: 0,
            }));
        });
        await flushHookEffects({ cycles: 2, turns: 1, runOnlyPendingTimers: true });

        expect(terminalOps.streamCreditRead).toHaveBeenCalledTimes(acknowledgedBeforeClear);

        await hook.unmount();
        timers.stop();
    });

    it('keeps the first output after Clear while the viewer waits in a held read', async () => {
        terminalOps.ensure.mockResolvedValue({ ok: true, terminalId: 'term-held-clear', reused: false });
        const output = { ok: true, terminalId: 'term-held-clear', nextByteOffset: 3, availableByteOffset: 3, droppedBeforeByteOffset: 0, done: false,
            frames: [{ t: 'bytes' as const, terminalId: 'term-held-clear', seq: 1, byteOffset: 0, byteLength: 3, encoding: 'base64' as const, data: 'QUJD' }] };
        let deliverHeldOutput: () => void = () => {};
        let heldReadSignal: AbortSignal | undefined;
        let heldReadAborted = false;
        terminalOps.streamReadBytes
            .mockImplementationOnce(async (_machineId: string, _request: unknown, options?: Readonly<{ signal?: AbortSignal }>) => await new Promise((resolve, reject) => {
                heldReadSignal = options?.signal;
                deliverHeldOutput = () => resolve(output);
                heldReadSignal?.addEventListener('abort', () => {
                    heldReadAborted = true;
                    reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
                }, { once: true });
            }))
            // A daemon answers by cursor: a read past the output has nothing to replay.
            .mockImplementation(async (_machineId: string, request: Readonly<{ byteOffset: number }>) => request.byteOffset === 0 ? output
                : { ...output, frames: [], nextByteOffset: 3, done: true });
        const writeBytes = vi.fn((_input: EmbeddedTerminalWriteBytesInput) => queuedWriteResult);
        const terminalRef = { current: { write: vi.fn(), writeBytes, clear: vi.fn() } satisfies EmbeddedTerminalRendererHandle };
        const { useMachineTerminalSession } = await import('./useMachineTerminalSession');
        const hook = await renderHook(() => useMachineTerminalSession({ machineId: 'machine-1', cwd: '/repo',
            terminalKey: 'session:s-held-clear:terminal', terminalRef }), { flushOptions: { cycles: 1, turns: 1 } });
        try {
            await act(async () => { hook.getCurrent().onReady(80, 24); });
            await flushHookEffects({ cycles: 4, turns: 2, runOnlyPendingTimers: true });
            expect(terminalOps.streamReadBytes).toHaveBeenCalledTimes(1);
            expect(heldReadSignal?.aborted).toBe(false);
            await act(async () => { hook.getCurrent().clearTerminal(); });
            expect(heldReadAborted).toBe(true);
            expect(heldReadSignal?.aborted).toBe(true);
            deliverHeldOutput();
            await flushHookEffects({ cycles: 4, turns: 2, runOnlyPendingTimers: true });
            expect(terminalOps.streamReadBytes.mock.calls[1]?.[1]).toMatchObject({ byteOffset: 0 });
            expect(writeBytes).toHaveBeenCalledWith(expect.objectContaining({
                terminalId: 'term-held-clear', byteOffset: 0, bytes: new Uint8Array([65, 66, 67]),
            }));
        } finally {
            deliverHeldOutput();
            await hook.unmount();
        }
    });

    it('releases a rejected queued native write and retries its original bytes without ACK credit', async () => {
        terminalOps.ensure.mockResolvedValue({ ok: true, terminalId: 'term-native-reject', reused: false });
        const byteFrame = {
            t: 'bytes' as const,
            terminalId: 'term-native-reject',
            seq: 5,
            byteOffset: 0,
            byteLength: 3,
            encoding: 'base64' as const,
            data: 'QUJD',
        };
        terminalOps.streamReadBytes
            .mockResolvedValueOnce({
                ok: true,
                terminalId: 'term-native-reject',
                frames: [byteFrame],
                nextByteOffset: 3,
                availableByteOffset: 3,
                droppedBeforeByteOffset: 0,
                done: false,
            })
            .mockResolvedValueOnce({
                ok: true,
                terminalId: 'term-native-reject',
                frames: [byteFrame],
                nextByteOffset: 3,
                availableByteOffset: 3,
                droppedBeforeByteOffset: 0,
                done: false,
            });

        const writeBytes = vi.fn((_input: EmbeddedTerminalWriteBytesInput) => queuedWriteResult);
        const renderer: EmbeddedTerminalRendererHandle = {
            write: vi.fn(),
            writeBytes,
            clear: vi.fn(),
        };
        const terminalRef = { current: renderer };
        const { useMachineTerminalSession } = await import('./useMachineTerminalSession');
        const hook = await renderHook(
            () => useMachineTerminalSession({
                machineId: 'machine-1',
                cwd: '/repo',
                terminalKey: 'session:s-native-reject:terminal',
                terminalRef,
            }),
            { flushOptions: { cycles: 1, turns: 1 } },
        );

        await act(async () => {
            hook.getCurrent().onReady(80, 24);
        });
        await flushHookEffects({ cycles: 4, turns: 2, runOnlyPendingTimers: true });

        const firstWrite = writeBytes.mock.calls[0]?.[0];
        const writeGeneration = readWriteGeneration(firstWrite);
        expect(firstWrite).toEqual(expect.objectContaining({
            terminalId: 'term-native-reject',
            seq: 5,
            byteOffset: 0,
            bytes: new Uint8Array([65, 66, 67]),
        }));
        expect(writeGeneration).not.toBeNull();

        await act(async () => {
            hook.getCurrent().onWriteComplete(rendererWriteComplete({
                terminalId: 'term-native-reject',
                seq: 5,
                byteOffset: 0,
                byteLength: 3,
                ackedByteOffset: 0,
                writeGeneration: writeGeneration!,
            }));
        });
        await flushHookEffects({ cycles: 4, turns: 2, runOnlyPendingTimers: true });

        expect(terminalOps.streamReadBytes).toHaveBeenNthCalledWith(
            2,
            'machine-1',
            expect.objectContaining({ terminalId: 'term-native-reject', byteOffset: 0 }),
            expect.any(Object),
        );
        expect(writeBytes).toHaveBeenCalledTimes(2);
        expect(writeBytes.mock.calls[1]?.[0]).toEqual(expect.objectContaining({
            terminalId: 'term-native-reject',
            seq: 5,
            byteOffset: 0,
            bytes: new Uint8Array([65, 66, 67]),
        }));
        expect(terminalOps.streamCreditRead).not.toHaveBeenCalled();

        await hook.unmount();
    });

    it('delivers control frames after a matching queued write completion without rereading them', async () => {
        terminalOps.ensure.mockResolvedValue({ ok: true, terminalId: 'term-queued-url', reused: false });
        terminalOps.streamReadBytes.mockResolvedValueOnce({
            ok: true,
            terminalId: 'term-queued-url',
            frames: [
                {
                    t: 'bytes',
                    terminalId: 'term-queued-url',
                    seq: 5,
                    byteOffset: 0,
                    byteLength: 3,
                    encoding: 'base64',
                    data: 'QUJD',
                },
                {
                    t: 'url',
                    terminalId: 'term-queued-url',
                    byteOffset: 3,
                    url: 'https://example.com/login',
                    kind: 'auth',
                },
            ],
            nextByteOffset: 3,
            availableByteOffset: 3,
            droppedBeforeByteOffset: 0,
            done: true,
        });

        const writeBytes = vi.fn((_input: EmbeddedTerminalWriteBytesInput) => queuedWriteResult);
        const renderer: EmbeddedTerminalRendererHandle = {
            write: vi.fn(),
            writeBytes,
            clear: vi.fn(),
        };
        const terminalRef = { current: renderer };
        const { useMachineTerminalSession } = await import('./useMachineTerminalSession');
        const hook = await renderHook(
            () => useMachineTerminalSession({
                machineId: 'machine-1',
                cwd: '/repo',
                terminalKey: 'session:s-queued-url:terminal',
                terminalRef,
            }),
            { flushOptions: { cycles: 1, turns: 1 } },
        );

        await act(async () => {
            hook.getCurrent().onReady(80, 24);
        });
        await flushHookEffects({ cycles: 4, turns: 2, runOnlyPendingTimers: true });

        const writeGeneration = readWriteGeneration(writeBytes.mock.calls[0]?.[0]);
        expect(writeGeneration).not.toBeNull();
        expect(hook.getCurrent().detectedUrl).toBeNull();

        await act(async () => {
            hook.getCurrent().onWriteComplete(rendererWriteComplete({
                terminalId: 'term-queued-url',
                seq: 5,
                byteOffset: 0,
                byteLength: 3,
                ackedByteOffset: 3,
                writeGeneration: writeGeneration!,
            }));
        });
        await flushHookEffects({ cycles: 4, turns: 2, runOnlyPendingTimers: true });

        expect(hook.getCurrent().detectedUrl).toEqual({
            t: 'url',
            url: 'https://example.com/login',
            kind: 'auth',
            suggestOpen: undefined,
        });
        expect(terminalOps.streamCreditRead).toHaveBeenCalledWith(
            'machine-1',
            expect.objectContaining({
                terminalId: 'term-queued-url',
                byteOffset: 3,
                ackedByteOffset: 3,
                surfaceEpoch: writeGeneration,
            }),
            expect.objectContaining({ serverId: homeIds.primary, accountId: 'terminal-account' }),
        );
        expect(terminalOps.streamReadBytes).toHaveBeenCalledTimes(1);

        await act(async () => {
            hook.getCurrent().onWriteComplete(rendererWriteComplete({
                terminalId: 'term-queued-url',
                seq: 5,
                byteOffset: 0,
                byteLength: 3,
                ackedByteOffset: 3,
                writeGeneration: writeGeneration!,
            }));
        });
        await flushHookEffects({ cycles: 2, turns: 1, runOnlyPendingTimers: true });

        expect(terminalOps.streamReadBytes).toHaveBeenCalledTimes(1);

        await hook.unmount();
    });

    it('rejects a same-identity parser completion from before terminal restart', async () => {
        terminalOps.ensure.mockResolvedValue({ ok: true, terminalId: 'term-restart-generation', reused: false });
        terminalOps.restart.mockResolvedValue({ ok: true, terminalId: 'term-restart-generation', reused: false });
        terminalOps.streamReadBytes
            .mockResolvedValueOnce({
                ok: true,
                terminalId: 'term-restart-generation',
                frames: [{
                    t: 'bytes',
                    terminalId: 'term-restart-generation',
                    seq: 5,
                    byteOffset: 0,
                    byteLength: 3,
                    encoding: 'base64',
                    data: 'QUJD',
                }],
                nextByteOffset: 3,
                availableByteOffset: 3,
                droppedBeforeByteOffset: 0,
                done: false,
            })
            .mockResolvedValueOnce({
                ok: true,
                terminalId: 'term-restart-generation',
                frames: [{
                    t: 'bytes',
                    terminalId: 'term-restart-generation',
                    seq: 5,
                    byteOffset: 0,
                    byteLength: 3,
                    encoding: 'base64',
                    data: 'QUJD',
                }],
                nextByteOffset: 3,
                availableByteOffset: 3,
                droppedBeforeByteOffset: 0,
                done: false,
            })
            .mockResolvedValue({
                ok: true,
                terminalId: 'term-restart-generation',
                frames: [],
                nextByteOffset: 3,
                availableByteOffset: 3,
                droppedBeforeByteOffset: 0,
                done: false,
            });

        const writeBytes = vi.fn((_input: EmbeddedTerminalWriteBytesInput) => queuedWriteResult);
        const renderer: EmbeddedTerminalRendererHandle = {
            write: vi.fn(),
            writeBytes,
            clear: vi.fn(),
        };
        const terminalRef = { current: renderer };
        const { useMachineTerminalSession } = await import('./useMachineTerminalSession');
        const hook = await renderHook(
            () => useMachineTerminalSession({
                machineId: 'machine-1',
                cwd: '/repo',
                terminalKey: 'session:s-restart-generation:terminal',
                terminalRef,
            }),
            { flushOptions: { cycles: 1, turns: 1 } },
        );

        await act(async () => {
            hook.getCurrent().onReady(80, 24);
        });
        await flushHookEffects({ cycles: 4, turns: 2, runOnlyPendingTimers: true });

        const initialGeneration = readWriteGeneration(writeBytes.mock.calls[0]?.[0]);
        expect(initialGeneration).not.toBeNull();

        await act(async () => {
            hook.getCurrent().requestRestart();
        });
        await flushHookEffects({ cycles: 5, turns: 2, runOnlyPendingTimers: true });

        expect(terminalOps.restart).toHaveBeenCalledTimes(1);
        expect(writeBytes).toHaveBeenCalledTimes(2);
        const restartedGeneration = readWriteGeneration(writeBytes.mock.calls[1]?.[0]);
        expect(restartedGeneration).not.toBeNull();
        expect(restartedGeneration).not.toBe(initialGeneration);

        await act(async () => {
            hook.getCurrent().onWriteComplete(rendererWriteComplete({
                terminalId: 'term-restart-generation',
                seq: 5,
                byteOffset: 0,
                byteLength: 3,
                ackedByteOffset: 3,
                writeGeneration: initialGeneration!,
            }));
        });
        await flushHookEffects({ cycles: 2, turns: 1, runOnlyPendingTimers: true });

        expect(terminalOps.streamCreditRead).not.toHaveBeenCalled();
        expect(terminalOps.streamReadBytes).toHaveBeenCalledTimes(2);

        await hook.unmount();
    });

    it('keeps the legacy event cursor and suppresses byte ACKs after a queued compatibility write', async () => {
        terminalOps.ensure.mockResolvedValue({ ok: true, terminalId: 'term-legacy-queue', reused: false });
        terminalOps.streamReadBytes.mockResolvedValueOnce({
            ok: false,
            code: 'terminal_byte_stream_unavailable',
            message: 'older daemon',
        });
        terminalOps.streamRead
            .mockResolvedValueOnce({
                ok: true,
                terminalId: 'term-legacy-queue',
                events: [{ t: 'data', data: 'legacy' }],
                nextCursor: 1,
                done: false,
            })
            .mockResolvedValueOnce({
                ok: true,
                terminalId: 'term-legacy-queue',
                events: [],
                nextCursor: 1,
                done: true,
            });

        const renderer: EmbeddedTerminalRendererHandle = {
            write: vi.fn(),
            writeBytes: vi.fn((_input: EmbeddedTerminalWriteBytesInput) => queuedWriteResult),
            clear: vi.fn(),
        };
        const terminalRef = { current: renderer };
        const { useMachineTerminalSession } = await import('./useMachineTerminalSession');
        const hook = await renderHook(
            () => useMachineTerminalSession({
                machineId: 'machine-1',
                cwd: '/repo',
                terminalKey: 'session:s-legacy-queue:terminal',
                terminalRef,
            }),
            { flushOptions: { cycles: 1, turns: 1 } },
        );

        await act(async () => {
            hook.getCurrent().onReady(80, 24);
        });
        await flushHookEffects({ cycles: 4, turns: 2, runOnlyPendingTimers: true });

        expect(terminalOps.streamRead).toHaveBeenNthCalledWith(
            1,
            'machine-1',
            { terminalId: 'term-legacy-queue', cursor: 0, maxBytes: undefined, maxEvents: undefined },
            expect.any(Object),
        );

        await act(async () => {
            hook.getCurrent().onWriteComplete(rendererWriteComplete({
                terminalId: 'term-legacy-queue',
                seq: 0,
                byteOffset: 0,
                byteLength: 6,
                ackedByteOffset: 6,
                writeGeneration: 0,
            }));
        });
        await flushHookEffects({ cycles: 4, turns: 2, runOnlyPendingTimers: true });

        expect(terminalOps.streamRead).toHaveBeenNthCalledWith(
            2,
            'machine-1',
            { terminalId: 'term-legacy-queue', cursor: 1, maxBytes: undefined, maxEvents: undefined },
            expect.any(Object),
        );
        expect(terminalOps.streamCreditRead).not.toHaveBeenCalled();

        await hook.unmount();
    });

    it('clears cached preview output when it cannot be tied to the ensured terminal id', async () => {
        const terminalKey = 'session:s-stale:terminal';
        replaceTerminalSurfaceState(terminalKey, {
            terminalId: null,
            cursor: 42,
            output: 'stale cached terminal output',
            detectedUrl: null,
        });
        terminalOps.ensure.mockResolvedValue({ ok: true, terminalId: 'term-fresh', reused: true });
        terminalOps.streamReadBytes.mockResolvedValueOnce({
            ok: true,
            terminalId: 'term-fresh',
            frames: [],
            nextByteOffset: 0,
            availableByteOffset: 0,
            droppedBeforeByteOffset: 0,
            done: true,
        });

        const renderer: EmbeddedTerminalRendererHandle = {
            write: vi.fn(),
            writeBytes: vi.fn(),
            clear: vi.fn(),
        };
        const terminalRef = { current: renderer };
        const { useMachineTerminalSession } = await import('./useMachineTerminalSession');
        const hook = await renderHook(
            () => useMachineTerminalSession({
                machineId: 'machine-1',
                cwd: '/repo',
                terminalKey,
                terminalRef,
            }),
            { flushOptions: { cycles: 1, turns: 1 } },
        );

        await act(async () => {
            hook.getCurrent().onReady(80, 24);
        });
        await flushHookEffects({ cycles: 4, turns: 2, runOnlyPendingTimers: true });

        expect(renderer.clear).toHaveBeenCalled();
        expect(renderer.write).not.toHaveBeenCalledWith('stale cached terminal output');
        expect(terminalOps.streamReadBytes).toHaveBeenCalledWith(
            'machine-1',
            expect.objectContaining({ terminalId: 'term-fresh', byteOffset: 0 }),
            expect.any(Object),
        );

        await hook.unmount();
    });

    it('resets a cached byte cursor when disabled terminal streaming selects legacy replay', async () => {
        const terminalKey = 'session:s-legacy-cursor-mismatch:terminal';
        byteStreamEnabled = false;
        await refreshTerminalFeatures();
        replaceTerminalSurfaceState(terminalKey, {
            terminalId: 'term-legacy-cursor-mismatch',
            cursor: 42,
            cursorMode: 'byte-offset',
            output: 'cached byte preview',
            detectedUrl: null,
        });
        terminalOps.ensure.mockResolvedValue({ ok: true, terminalId: 'term-legacy-cursor-mismatch', reused: true });
        terminalOps.streamRead.mockResolvedValueOnce({
            ok: true,
            terminalId: 'term-legacy-cursor-mismatch',
            events: [],
            nextCursor: 0,
            done: true,
        });

        const renderer: EmbeddedTerminalRendererHandle = {
            write: vi.fn(),
            writeBytes: vi.fn(),
            clear: vi.fn(),
        };
        const terminalRef = { current: renderer };
        const { useMachineTerminalSession } = await import('./useMachineTerminalSession');
        const hook = await renderHook(
            () => useMachineTerminalSession({
                machineId: 'machine-1',
                cwd: '/repo',
                terminalKey,
                terminalRef,
            }),
            { flushOptions: { cycles: 1, turns: 1 } },
        );

        await act(async () => {
            hook.getCurrent().onReady(80, 24);
        });
        await flushHookEffects({ cycles: 4, turns: 2, runOnlyPendingTimers: true });

        expect(terminalOps.streamRead).toHaveBeenCalledWith(
            'machine-1',
            expect.objectContaining({ terminalId: 'term-legacy-cursor-mismatch', cursor: 0 }),
            expect.any(Object),
        );
        expect(terminalOps.streamReadBytes).not.toHaveBeenCalled();

        await hook.unmount();
    });

    it('records a legacy cursor mode when carrier fallback keeps the numeric cursor at zero', async () => {
        const terminalKey = 'session:s-legacy-mode-transition:terminal';
        terminalOps.ensure.mockResolvedValue({ ok: true, terminalId: 'term-legacy-mode-transition', reused: false });
        terminalOps.streamReadBytes.mockResolvedValueOnce({
            ok: false,
            code: 'terminal_byte_stream_unavailable',
            message: 'older daemon',
        });
        terminalOps.streamRead.mockResolvedValueOnce({
            ok: true,
            terminalId: 'term-legacy-mode-transition',
            events: [],
            nextCursor: 0,
            done: true,
        });

        const renderer: EmbeddedTerminalRendererHandle = {
            write: vi.fn(),
            writeBytes: vi.fn(),
            clear: vi.fn(),
        };
        const terminalRef = { current: renderer };
        const { useMachineTerminalSession } = await import('./useMachineTerminalSession');
        const hook = await renderHook(
            () => useMachineTerminalSession({
                machineId: 'machine-1',
                cwd: '/repo',
                terminalKey,
                terminalRef,
            }),
            { flushOptions: { cycles: 1, turns: 1 } },
        );

        await act(async () => {
            hook.getCurrent().onReady(80, 24);
        });
        await flushHookEffects({ cycles: 4, turns: 2, runOnlyPendingTimers: true });

        expect(readTerminalSurfaceState(terminalKey)).toEqual(expect.objectContaining({
            terminalId: 'term-legacy-mode-transition',
            cursor: 0,
            cursorMode: 'legacy-event-cursor',
        }));

        await hook.unmount();
    });

    it('aborts a partial OSC at a stream gap so the marker and next prompt remain visible', async () => {
        byteStreamEnabled = false;
        await refreshTerminalFeatures();
        terminalOps.ensure.mockResolvedValue({ ok: true, terminalId: 'term-osc-gap', reused: false });
        terminalOps.streamRead.mockResolvedValueOnce({
            ok: true,
            terminalId: 'term-osc-gap',
            events: [
                { t: 'data', data: '\u001b]0;unfinished title' },
                { t: 'gap', droppedBefore: 2 },
                { t: 'data', data: 'next prompt$ ' },
            ],
            nextCursor: 3,
            done: true,
        });
        const terminal = new Terminal({ cols: 80, rows: 24 });
        const terminalRef = { current: {
            write: (data: string) => terminal.write(data),
            clear: () => terminal.clear(),
        } satisfies EmbeddedTerminalRendererHandle };
        const { useMachineTerminalSession } = await import('./useMachineTerminalSession');
        const hook = await renderHook(() => useMachineTerminalSession({
            machineId: 'machine-1',
            cwd: '/repo',
            terminalKey: 'session:osc-gap:terminal',
            terminalRef,
        }), { flushOptions: { cycles: 1, turns: 1 } });
        try {
            await act(async () => hook.getCurrent().onReady(80, 24));
            await flushHookEffects({ cycles: 4, turns: 2, runOnlyPendingTimers: true });
            const text = Array.from({ length: terminal.buffer.active.length }, (_, index) => (
                terminal.buffer.active.getLine(index)?.translateToString(true) ?? ''
            )).join('\n');
            expect(text).toContain('[Output truncated]');
            expect(text).toContain('next prompt$');
        } finally {
            await hook.unmount();
            terminal.dispose();
        }
    });

    it.each(['terminal-account', 'another-account'])('PF56 paints only the current Account preview while presence is pending (%s)', async (accountId) => {
        const terminalKey = 'pf56-preview-pending-admission';
        const foreignResource = { kind: 'xterm-web' as const, attached: false, whenSettled: async () => {}, dispose: vi.fn() };
        const cached = {
            ...createEmptyTerminalSurfaceState(), terminalId: 'pf56-preview-pending',
            cursor: 8, output: 'prompt$ ', scope: { serverId: homeIds.primary, accountId },
            ...(accountId === 'another-account' ? { rendererResource: foreignResource } : {}),
        };
        replaceTerminalSurfaceState(terminalKey, cached);
        let rendered = '';
        const restoreResource = vi.fn(() => true);
        const renderer = {
            write: (text: string) => { rendered += text; return true; },
            clear: () => { rendered = ''; },
            restoreResource,
        } satisfies EmbeddedTerminalRendererHandle;
        const terminalRef: { current: EmbeddedTerminalRendererHandle | null } = { current: null };
        const { useMachineTerminalSession } = await import('./useMachineTerminalSession');
        const hook = await renderHook(() => useMachineTerminalSession({
            machineId: 'machine', serverId: homeIds.primary, cwd: '/repo', terminalKey, terminalRef,
            attachedTerminalId: 'pf56-preview-pending', readOnly: true, machineReachable: null,
            workspace: { serverId: homeIds.primary, machineId: 'machine', workspaceId: 'repo', rootPath: '/repo' },
        }));
        await act(async () => {
            terminalRef.current = renderer;
            hook.getCurrent().onReady(80, 24);
        });
        await flushHookEffects({ cycles: 8, turns: 2 });
        expect({ status: hook.getCurrent().status, error: hook.getCurrent().error }).toEqual({ status: 'connecting', error: null });
        expect(hook.getCurrent().status).toBe('connecting');
        expect(rendered).toBe(accountId === 'terminal-account' ? 'prompt$ ' : '');
        expect(terminalOps.ensure).not.toHaveBeenCalled();
        expect(terminalOps.streamReadBytes).not.toHaveBeenCalled();
        expect(restoreResource).not.toHaveBeenCalled();
        await hook.unmount();
    });

    it('replaces same-mode cached preview text when daemon replay begins', async () => {
        const terminalKey = 'session:s-preview-replacement:terminal';
        replaceTerminalSurfaceState(terminalKey, {
            terminalId: 'term-preview-replacement',
            cursor: 3,
            cursorMode: 'byte-offset',
            output: 'cached preview',
            detectedUrl: null,
        });
        terminalOps.ensure.mockResolvedValue({ ok: true, terminalId: 'term-preview-replacement', reused: true });
        terminalOps.streamReadBytes.mockResolvedValueOnce({
            ok: true,
            terminalId: 'term-preview-replacement',
            frames: [{
                t: 'bytes',
                terminalId: 'term-preview-replacement',
                seq: 2,
                byteOffset: 0,
                byteLength: 5,
                encoding: 'base64',
                data: 'RlJFU0g=',
            }],
            nextByteOffset: 5,
            availableByteOffset: 5,
            droppedBeforeByteOffset: 0,
            done: true,
        });

        const callOrder: string[] = [];
        const renderer: EmbeddedTerminalRendererHandle = {
            write: vi.fn((data: string) => {
                callOrder.push(`write:${data}`);
            }),
            writeBytes: vi.fn((input) => {
                callOrder.push(`bytes:${new TextDecoder().decode(input.bytes)}`);
            }),
            clear: vi.fn(() => {
                callOrder.push('clear');
            }),
        };
        const terminalRef = { current: renderer };
        const { useMachineTerminalSession } = await import('./useMachineTerminalSession');
        const hook = await renderHook(
            () => useMachineTerminalSession({
                machineId: 'machine-1',
                attachedTerminalId: 'term-preview-replacement', readOnly: true,
                cwd: '/repo',
                terminalKey,
                terminalRef,
            }),
            { flushOptions: { cycles: 1, turns: 1 } },
        );

        await flushHookEffects({ cycles: 4, turns: 2, runOnlyPendingTimers: true });

        expect(terminalOps.streamReadBytes).toHaveBeenCalledWith(
            'machine-1',
            expect.objectContaining({ terminalId: 'term-preview-replacement', byteOffset: 0 }),
            expect.any(Object),
        );
        const previewIndex = callOrder.indexOf('write:cached preview');
        const replayClearIndex = callOrder.lastIndexOf('clear');
        const replayBytesIndex = callOrder.indexOf('bytes:FRESH');
        expect(previewIndex).toBeGreaterThanOrEqual(0);
        expect(replayClearIndex).toBeGreaterThan(previewIndex);
        expect(replayClearIndex).toBeLessThan(replayBytesIndex);
        expect(readTerminalSurfaceState(terminalKey)).toEqual(expect.objectContaining({
            terminalId: 'term-preview-replacement',
            cursor: 5,
            cursorMode: 'byte-offset',
            output: 'FRESH',
        }));

        await hook.unmount();
    });

    it('hydrates a replacement renderer when its ready event follows a child-local fallback', async () => {
        const terminalKey = 'session:s-renderer-fallback:terminal';
        replaceTerminalSurfaceState(terminalKey, {
            terminalId: 'term-renderer-fallback',
            cursor: 14,
            cursorMode: 'byte-offset',
            output: 'cached output',
            detectedUrl: null,
        });
        terminalOps.ensure.mockResolvedValue({
            ok: true,
            terminalId: 'term-renderer-fallback',
            reused: true,
        });
        terminalOps.streamReadBytes.mockImplementation(() => new Promise(() => {}));
        const firstRenderer: EmbeddedTerminalRendererHandle = {
            write: vi.fn(() => true),
            writeBytes: vi.fn(() => true),
            clear: vi.fn(),
        };
        const fallbackRenderer: EmbeddedTerminalRendererHandle = {
            write: vi.fn(() => true),
            writeBytes: vi.fn(() => true),
            clear: vi.fn(),
        };
        const terminalRef = {
            current: firstRenderer as EmbeddedTerminalRendererHandle | null,
        };
        const { useMachineTerminalSession } = await import('./useMachineTerminalSession');
        const hook = await renderHook(
            () => useMachineTerminalSession({
                machineId: 'machine-1',
                cwd: '/repo',
                terminalKey,
                terminalRef,
            }),
            { flushOptions: { cycles: 1, turns: 1 } },
        );

        await act(async () => {
            hook.getCurrent().onReady(80, 24);
        });
        expect(firstRenderer.write).toHaveBeenCalledWith('cached output', { intent: 'replay' });

        terminalRef.current = fallbackRenderer;
        await act(async () => {
            hook.getCurrent().onReady(80, 24);
        });

        expect(fallbackRenderer.clear).toHaveBeenCalledTimes(1);
        expect(fallbackRenderer.write).toHaveBeenCalledWith('cached output', { intent: 'replay' });
        await hook.unmount();
    });

    it('holds reattach input while the retired renderer settles, then sends it once in order', async () => {
        const settled = createDeferred<void>();
        let settling = false;
        // Renderer/parser settlement is the platform boundary; admission and transport stay real.
        const resource = { kind: 'xterm-web' as const, attached: true, dispose: () => {}, whenSettled: () => settling ? settled.promise : Promise.resolve() };
        const renderer: EmbeddedTerminalRendererHandle = {
            write: vi.fn(), writeBytes: vi.fn(), clear: vi.fn(),
            captureResource: () => resource,
            restoreResource: () => true,
        };
        terminalOps.ensure.mockResolvedValue({ ok: true, terminalId: 'reattach-input', reused: true });
        terminalOps.streamReadBytes.mockImplementation((_machineId: string, request: { terminalId: string; byteOffset: number }) =>
            TerminalStreamReadResponseSchema.parse({ ok: true, terminalId: request.terminalId, frames: [],
                nextByteOffset: request.byteOffset, availableByteOffset: request.byteOffset, droppedBeforeByteOffset: 0, done: false }));
        const terminalRef = { current: renderer };
        const { useMachineTerminalSession } = await import('./useMachineTerminalSession');
        const hook = await renderHook(() => useMachineTerminalSession({ machineId: 'machine-1', serverId: homeIds.primary, cwd: '/repo',
            terminalKey: 'session:reattach-input:terminal', terminalRef }));
        await act(async () => hook.getCurrent().onReady(80, 24));
        await act(async () => hook.getCurrent().retryConnect());
        await flushHookEffects({ cycles: 3, turns: 2, runOnlyPendingTimers: true });
        expect(hook.getCurrent().status, hook.getCurrent().error ?? '').toBe('connected');
        settling = true;
        await act(async () => hook.getCurrent().retryConnect());
        await act(async () => { hook.getCurrent().onInput('echo '); hook.getCurrent().onInput('X=$$'); });
        await flushHookEffects({ cycles: 1, turns: 1, runOnlyPendingTimers: true });
        expect(terminalOps.streamSendInput).not.toHaveBeenCalled();
        await act(async () => { hook.getCurrent().onInput('\r'); settled.resolve(); });
        await flushHookEffects({ cycles: 4, turns: 2, runOnlyPendingTimers: true });
        expect(terminalOps.streamSendInput.mock.calls.map(([, request]) => request.event.text ?? '').join('')).toBe('echo X=$$\r');
        expect(hook.getCurrent().inputRecoveryAvailable).toBe(false);
        await hook.unmount();
    });

    it('routes user input through the stream carrier after connection', async () => {
        terminalOps.ensure.mockResolvedValue({ ok: true, terminalId: 'term-input', reused: false });
        terminalOps.streamReadBytes.mockResolvedValue({
            ok: true,
            terminalId: 'term-input',
            frames: [],
            nextByteOffset: 0,
            availableByteOffset: 0,
            droppedBeforeByteOffset: 0,
            done: false,
        });
        terminalOps.streamSendInput.mockResolvedValue({ ok: true });

        const renderer: EmbeddedTerminalRendererHandle = {
            write: vi.fn(),
            writeBytes: vi.fn(),
            clear: vi.fn(),
        };
        const terminalRef = { current: renderer };
        const { useMachineTerminalSession } = await import('./useMachineTerminalSession');
        const hook = await renderHook(
            () => useMachineTerminalSession({
                machineId: 'machine-1',
                cwd: '/repo',
                terminalKey: 'session:s-input:terminal',
                terminalRef,
            }),
            { flushOptions: { cycles: 1, turns: 1 } },
        );

        await act(async () => {
            hook.getCurrent().onReady(80, 24);
        });
        await flushHookEffects({ cycles: 2, turns: 1, runOnlyPendingTimers: true });

        hook.getCurrent().onInput('ls\r');
        await flushHookEffects({ cycles: 1, turns: 0, runOnlyPendingTimers: true });

        expect(terminalOps.streamSendInput).toHaveBeenCalledWith(
            'machine-1',
            {
                terminalId: 'term-input',
                event: { t: 'text', text: 'ls\r' },
            },
            expect.any(Object),
        );
        expect(terminalOps.input).not.toHaveBeenCalled();

        await hook.unmount();
    });

    it('stops routing user input after the stream read loop fails', async () => {
        terminalOps.ensure.mockResolvedValue({ ok: true, terminalId: 'term-input-error', reused: false });
        terminalOps.streamReadBytes.mockResolvedValueOnce({
            ok: false,
            code: 'terminal_rpc_target_unavailable',
            message: 'terminal RPC target unavailable',
        });
        terminalOps.streamSendInput.mockResolvedValue({ ok: true });

        const renderer: EmbeddedTerminalRendererHandle = {
            write: vi.fn(),
            writeBytes: vi.fn(),
            clear: vi.fn(),
        };
        const terminalRef = { current: renderer };
        const { useMachineTerminalSession } = await import('./useMachineTerminalSession');
        const hook = await renderHook(
            () => useMachineTerminalSession({
                machineId: 'machine-1',
                cwd: '/repo',
                terminalKey: 'session:s-input-error:terminal',
                terminalRef,
            }),
            { flushOptions: { cycles: 1, turns: 1 } },
        );

        await act(async () => {
            hook.getCurrent().onReady(80, 24);
        });
        await flushHookEffects({ cycles: 4, turns: 2, runOnlyPendingTimers: true });

        expect(hook.getCurrent().status).toBe('error');

        hook.getCurrent().onInput('echo hidden\r');
        await flushHookEffects({ cycles: 1, turns: 0, runOnlyPendingTimers: true });

        expect(terminalOps.streamSendInput).not.toHaveBeenCalled();

        await hook.unmount();
    });

    it.each([true, false])('classifies first-read failure from an owned Shell without page cache (reused=%s)', async reused => {
        const terminalKey = `owned-first-read-failed-${reused}`;
        const terminalId = `native-first-read-failed-${reused}`;
        expect(readTerminalSurfaceState(terminalKey)?.terminalId ?? null).toBeNull();
        terminalOps.ensure.mockResolvedValue({ ok: true, terminalId, reused });
        terminalOps.streamReadBytes.mockResolvedValue({
            ok: false, code: 'terminal_invalid_request', message: 'terminal_invalid_request',
        });
        terminalOps.streamCreditRead.mockResolvedValue({
            ok: false, code: 'terminal_invalid_request', message: 'terminal_invalid_request',
        });
        const { useMachineTerminalSession } = await import('./useMachineTerminalSession');
        const { projectTerminalSurfaceFailure } = await import('@/components/sessions/terminal/terminalSurfaceSummary');
        const terminalRef = { current: { write: vi.fn(), clear: vi.fn() } satisfies EmbeddedTerminalRendererHandle };
        const hook = await renderHook(() => useMachineTerminalSession({
            machineId: 'machine', serverId: homeIds.primary, cwd: '/repo', terminalKey, terminalRef,
        }));
        await act(async () => hook.getCurrent().onReady(80, 24));
        await flushHookEffects({ cycles: 4, turns: 2, runOnlyPendingTimers: true });
        await vi.waitFor(() => expect(hook.getCurrent().status).toBe('error'));
        expect(hook.getCurrent()).toMatchObject({
            status: 'error', error: 'terminal_invalid_request', terminalId, connectionLost: reused,
        });
        expect(projectTerminalSurfaceFailure(hook.getCurrent())).toBe(reused ? 'connection-lost' : 'failed');
        if (reused) {
            terminalOps.ensure.mockResolvedValue({ ok: true, terminalId: 'fresh-replacement', reused: false });
            await act(async () => hook.getCurrent().retryConnect());
            await flushHookEffects({ cycles: 4, turns: 2, runOnlyPendingTimers: true });
            await vi.waitFor(() => expect(hook.getCurrent().terminalId).toBe('fresh-replacement'));
            await vi.waitFor(() => expect(hook.getCurrent().status).toBe('error'));
            expect(hook.getCurrent()).toMatchObject({
                status: 'error', terminalId: 'fresh-replacement', connectionLost: false,
            });
            expect(projectTerminalSurfaceFailure(hook.getCurrent())).toBe('failed');
        }
        await hook.unmount();
    });

    it('classifies borrowed attachment read failures as connection loss before and after its first successful read', async () => {
        const renderer: EmbeddedTerminalRendererHandle = { write: vi.fn(), writeBytes: vi.fn(), clear: vi.fn() };
        const terminalRef = { current: renderer };
        const { useMachineTerminalSession } = await import('./useMachineTerminalSession');
        const runUntilError = async (terminalKey: string) => {
            const hook = await renderHook(
                () => useMachineTerminalSession({ machineId: 'machine', serverId: homeIds.primary,
                    cwd: '/repo', terminalKey, terminalRef, readOnly: true, attachedTerminalId: 'term-dropped' }),
                { flushOptions: { cycles: 1, turns: 1 } },
            );
            await act(async () => {
                hook.getCurrent().onReady(80, 24);
            });
            await flushHookEffects({ cycles: 4, turns: 2, runOnlyPendingTimers: true });
            return hook;
        };

        terminalOps.ensure.mockResolvedValue({ ok: true, terminalId: 'term-dropped', reused: false });
        terminalOps.streamCreditRead.mockResolvedValue({
            ok: false, code: 'terminal_invalid_request', message: 'terminal_invalid_request',
        });
        terminalOps.streamReadBytes.mockResolvedValueOnce({
            ok: true, terminalId: 'term-dropped', frames: [], nextByteOffset: 0,
            availableByteOffset: 0, droppedBeforeByteOffset: 0, nextControlCursor: 0, done: false,
        });
        terminalOps.streamReadBytes.mockResolvedValueOnce({
            ok: false,
            code: 'terminal_invalid_request',
            message: 'terminal_invalid_request',
        });
        const dropped = await runUntilError('borrowed-dropped');
        expect(dropped.getCurrent().status).toBe('error');
        expect(dropped.getCurrent().connectionLost).toBe(true);
        await dropped.unmount();

        terminalOps.streamReadBytes.mockResolvedValue({
            ok: false, code: 'terminal_invalid_request', message: 'terminal_invalid_request',
        });
        const firstReadFailed = await runUntilError('borrowed-first-read-failed');
        expect(firstReadFailed.getCurrent().status).toBe('error');
        expect(firstReadFailed.getCurrent().error).toBe('terminal_invalid_request');
        expect(firstReadFailed.getCurrent().connectionLost).toBe(true);
        const settledReads = terminalOps.streamReadBytes.mock.calls.length;
        await flushHookEffects({ cycles: 4, turns: 2, runOnlyPendingTimers: true });
        expect(terminalOps.streamReadBytes.mock.calls.length).toBe(settledReads);
        await firstReadFailed.unmount();

        terminalOps.streamReadBytes.mockResolvedValue({
            ok: false, code: 'terminal_access_denied', message: 'terminal_access_denied',
        });
        const withdrawn = await runUntilError('borrowed-withdrawn-before-first-read');
        expect(withdrawn.getCurrent()).toMatchObject({
            status: 'error', error: 'terminal_access_denied', terminalId: null, connectionLost: false,
        });
        await withdrawn.unmount();

    });

    it('keeps two Account-bound renderers readable when a predecessor refuses holdForOutput', async () => {
        const terminalId = 'term-predecessor-viewers';
        // Network peer vector: HEAD 323e6f98's closed byte-read request has no
        // holdForOutput field. Keep the real Action/codec/carrier below this boundary.
        terminalOps.streamReadBytes.mockImplementation((_machineId: string, request: { holdForOutput?: boolean }) => {
            expect(request.holdForOutput).toBe(true);
            return { ok: false, code: 'terminal_invalid_request', message: 'terminal_invalid_request' };
        });
        terminalOps.streamCreditRead.mockResolvedValue({ ok: true, terminalId, frames: [], nextByteOffset: 0,
            availableByteOffset: 0, droppedBeforeByteOffset: 0, done: true });
        const { useMachineTerminalSession } = await import('./useMachineTerminalSession');
        const createViewer = (index: number) => {
            const terminalRef = { current: null };
            return renderHook(() => useMachineTerminalSession({
                machineId: 'machine', serverId: homeIds.primary, cwd: '/repo', terminalKey: `predecessor-viewer-${index}`,
                terminalRef, readOnly: true, attachedTerminalId: terminalId,
            }), { flushOptions: { cycles: 1, turns: 1 } });
        };
        const viewers = [await createViewer(0), await createViewer(1)];
        await act(async () => { for (const viewer of viewers) viewer.getCurrent().onReady(80, 24); });
        await flushHookEffects({ cycles: 4, turns: 2, runOnlyPendingTimers: true });
        for (const viewer of viewers) {
            expect(viewer.getCurrent().error).toBeNull();
            expect(viewer.getCurrent().status).toBe('exited');
        }
        // One accepted fallback per compatibility probe, including attempts
        // superseded by initial renderer sizing; settled streams do not poll.
        expect(terminalOps.streamCreditRead.mock.calls.length).toBe(terminalOps.streamReadBytes.mock.calls.length);
        const settledReads = terminalOps.streamReadBytes.mock.calls.length;
        await flushHookEffects({ cycles: 4, turns: 2, runOnlyPendingTimers: true });
        expect(terminalOps.streamReadBytes.mock.calls.length).toBe(settledReads);
        for (const viewer of viewers) await viewer.unmount();
    });

    it.each([RPC_ERROR_CODES.OUTCOME_UNKNOWN, 'MACHINE_RPC_TIMEOUT'])('does not repeat terminal creation after an ambiguous %s admission failure', async (errorCode) => {
        terminalOps.ensure.mockRejectedValue(createRpcCallError({ error: 'The terminal creation result was not observed', errorCode }));
        const renderer: EmbeddedTerminalRendererHandle = { write: vi.fn(), clear: vi.fn() };
        const terminalRef = { current: renderer };
        const { useMachineTerminalSession } = await import('./useMachineTerminalSession');
        const hook = await renderHook(() => useMachineTerminalSession({
            machineId: 'machine-1', cwd: '/repo', terminalKey: `session:no-repeat:${errorCode}`, terminalRef,
        }), { flushOptions: { cycles: 1, turns: 1 } });
        await act(async () => { hook.getCurrent().onReady(80, 24); });
        await flushHookEffects({ cycles: 4, turns: 2, runOnlyPendingTimers: true });
        expect(hook.getCurrent().status).toBe('error');
        expect(hook.getCurrent().error).toBe(errorCode);
        expect(terminalOps.ensure).toHaveBeenCalledTimes(1);
        await act(async () => { await vi.advanceTimersByTimeAsync(resolveTerminalAutoRetryDelayMs(1)); });
        expect(terminalOps.ensure).toHaveBeenCalledTimes(1);
        await hook.unmount();
    });

    it('waits for explicit Open after stream input reports a missing terminal', async () => {
        terminalOps.ensure
            .mockResolvedValueOnce({ ok: true, terminalId: 'term-input-stale', reused: false })
            .mockResolvedValueOnce({ ok: true, terminalId: 'term-input-fresh', reused: false });
        terminalOps.streamReadBytes.mockResolvedValue({
            ok: true,
            terminalId: 'term-input-stale',
            frames: [],
            nextByteOffset: 0,
            availableByteOffset: 0,
            droppedBeforeByteOffset: 0,
            done: false,
        });
        terminalOps.streamSendInput
            .mockResolvedValueOnce({
                ok: false,
                code: 'terminal_not_found',
                message: 'terminal_not_found',
            })
            .mockResolvedValue({ ok: true });

        const renderer: EmbeddedTerminalRendererHandle = {
            write: vi.fn(),
            writeBytes: vi.fn(),
            clear: vi.fn(),
        };
        const terminalRef = { current: renderer };
        const { useMachineTerminalSession } = await import('./useMachineTerminalSession');
        const hook = await renderHook(
            () => useMachineTerminalSession({
                machineId: 'machine-1',
                cwd: '/repo',
                terminalKey: 'session:s-input-recovery:terminal',
                terminalRef,
            }),
            { flushOptions: { cycles: 1, turns: 1 } },
        );

        await act(async () => {
            hook.getCurrent().onReady(80, 24);
        });
        await flushHookEffects({ cycles: 2, turns: 1, runOnlyPendingTimers: true });

        hook.getCurrent().onInput('echo stale\r');
        await flushHookEffects({ cycles: 2, turns: 1, runOnlyPendingTimers: true });

        await flushHookEffects({ cycles: 3, turns: 2, runOnlyPendingTimers: true });

        expect(hook.getCurrent()).toEqual(expect.objectContaining({
            status: 'exited',
            error: null,
        }));
        expect(terminalOps.ensure).toHaveBeenCalledTimes(1);
        expect(terminalOps.streamSendInput).toHaveBeenCalledTimes(1);
        expect(terminalOps.streamSendInput).toHaveBeenNthCalledWith(
            1,
            'machine-1',
            {
                terminalId: 'term-input-stale',
                event: { t: 'text', text: 'echo stale\r' },
            },
            expect.any(Object),
        );

        await act(async () => hook.getCurrent().retryConnect());
        await flushHookEffects({ cycles: 3, turns: 2, runOnlyPendingTimers: true });
        expect(terminalOps.ensure).toHaveBeenCalledTimes(2);
        hook.getCurrent().onInput('echo fresh\r');
        await flushHookEffects({ cycles: 2, turns: 1, runOnlyPendingTimers: true });

        expect(terminalOps.streamSendInput).toHaveBeenLastCalledWith(
            'machine-1',
            {
                terminalId: 'term-input-fresh',
                event: { t: 'text', text: 'echo fresh\r' },
            },
            expect.any(Object),
        );

        await hook.unmount();
    });

    it('waits for explicit Open after a scoped stream input RPC rejects a missing terminal', async () => {
        terminalOps.ensure
            .mockResolvedValueOnce({ ok: true, terminalId: 'term-rpc-stale', reused: false })
            .mockResolvedValueOnce({ ok: true, terminalId: 'term-rpc-fresh', reused: false });
        terminalOps.streamReadBytes.mockResolvedValue({
            ok: true,
            terminalId: 'term-rpc-stale',
            frames: [],
            nextByteOffset: 0,
            availableByteOffset: 0,
            droppedBeforeByteOffset: 0,
            done: false,
        });
        terminalOps.streamSendInput
            .mockRejectedValueOnce(createRpcCallError({ error: 'terminal_not_found', errorCode: 'terminal_not_found' }))
            .mockResolvedValue({ ok: true });

        const renderer: EmbeddedTerminalRendererHandle = {
            write: vi.fn(),
            writeBytes: vi.fn(),
            clear: vi.fn(),
        };
        const terminalRef = { current: renderer };
        const { useMachineTerminalSession } = await import('./useMachineTerminalSession');
        const hook = await renderHook(
            () => useMachineTerminalSession({
                machineId: 'machine-1',
                cwd: '/repo',
                terminalKey: 'session:s-input-rpc-recovery:terminal',
                terminalRef,
            }),
            { flushOptions: { cycles: 1, turns: 1 } },
        );

        await act(async () => {
            hook.getCurrent().onReady(80, 24);
        });
        await flushHookEffects({ cycles: 2, turns: 1, runOnlyPendingTimers: true });

        hook.getCurrent().onInput('echo stale rpc\r');
        await flushHookEffects({ cycles: 2, turns: 1, runOnlyPendingTimers: true });
        await flushHookEffects({ cycles: 3, turns: 2, runOnlyPendingTimers: true });

        expect(hook.getCurrent()).toEqual(expect.objectContaining({
            status: 'exited',
            error: null,
        }));
        expect(terminalOps.ensure).toHaveBeenCalledTimes(1);

        await act(async () => hook.getCurrent().retryConnect());
        await flushHookEffects({ cycles: 3, turns: 2, runOnlyPendingTimers: true });
        expect(terminalOps.ensure).toHaveBeenCalledTimes(2);
        hook.getCurrent().onInput('echo fresh rpc\r');
        await flushHookEffects({ cycles: 2, turns: 1, runOnlyPendingTimers: true });

        expect(terminalOps.streamSendInput).toHaveBeenLastCalledWith(
            'machine-1',
            {
                terminalId: 'term-rpc-fresh',
                event: { t: 'text', text: 'echo fresh rpc\r' },
            },
            expect.any(Object),
        );

        await hook.unmount();
    });

    it('keeps the live terminal connected after unsupported resizes and accepts subsequent input', async () => {
        const { useMachineTerminalSession } = await import('./useMachineTerminalSession');
        terminalOps.ensure.mockResolvedValue({ ok: true, terminalId: 'term-fixed-size', reused: false });
        terminalOps.streamReadBytes.mockResolvedValue({
            ok: true,
            terminalId: 'term-fixed-size',
            frames: [],
            nextByteOffset: 0,
            availableByteOffset: 0,
            droppedBeforeByteOffset: 0,
            done: false,
        });
        terminalOps.streamSendInput
            .mockResolvedValueOnce({ ok: false, code: 'terminal_resize_unavailable', message: 'Resize unavailable' })
            .mockResolvedValue({ ok: true });

        const renderer: EmbeddedTerminalRendererHandle = { write: vi.fn(), writeBytes: vi.fn(), clear: vi.fn() };
        const terminalRef = { current: renderer };
        const hook = await renderHook(() => useMachineTerminalSession({
            machineId: 'machine-1', cwd: '/repo', terminalKey: 'session:fixed-size:terminal', terminalRef,
        }), { flushOptions: { cycles: 1, turns: 1 } });
        await act(async () => { hook.getCurrent().onReady(80, 24); });
        await flushHookEffects({ cycles: 2, turns: 1, runOnlyPendingTimers: true });

        await act(async () => { hook.getCurrent().onResize(120, 40); });
        await flushHookEffects({ cycles: 2, turns: 1, runOnlyPendingTimers: true });
        expect(hook.getCurrent()).toMatchObject({ status: 'connected', error: null });

        hook.getCurrent().onInput('echo still connected\r');
        await flushHookEffects({ cycles: 2, turns: 1, runOnlyPendingTimers: true });
        expect(terminalOps.streamSendInput).toHaveBeenLastCalledWith('machine-1', {
            terminalId: 'term-fixed-size', event: { t: 'text', text: 'echo still connected\r' },
        }, expect.any(Object));
        expect(hook.getCurrent()).toMatchObject({ status: 'connected', error: null });
        await hook.unmount();
    });

    it.each(['text', 'resize'] as const)('reports non-recoverable %s failures instead of silently staying connected', async (event) => {
        terminalOps.ensure.mockResolvedValue({ ok: true, terminalId: 'term-input-failure', reused: false });
        terminalOps.streamReadBytes.mockResolvedValue({
            ok: true,
            terminalId: 'term-input-failure',
            frames: [],
            nextByteOffset: 0,
            availableByteOffset: 0,
            droppedBeforeByteOffset: 0,
            done: false,
        });
        terminalOps.streamSendInput.mockResolvedValueOnce({
            ok: false,
            code: 'terminal_rpc_target_unavailable',
            message: 'terminal RPC target unavailable',
        });

        const renderer: EmbeddedTerminalRendererHandle = {
            write: vi.fn(),
            writeBytes: vi.fn(),
            clear: vi.fn(),
        };
        const terminalRef = { current: renderer };
        const { useMachineTerminalSession } = await import('./useMachineTerminalSession');
        const hook = await renderHook(
            () => useMachineTerminalSession({
                machineId: 'machine-1',
                cwd: '/repo',
                terminalKey: 'session:s-input-failure:terminal',
                terminalRef,
            }),
            { flushOptions: { cycles: 1, turns: 1 } },
        );

        await act(async () => {
            hook.getCurrent().onReady(80, 24);
        });
        await flushHookEffects({ cycles: 2, turns: 1, runOnlyPendingTimers: true });

        await act(async () => {
            if (event === 'resize') hook.getCurrent().onResize(120, 40);
            else hook.getCurrent().onInput('echo hidden\r');
        });
        await flushHookEffects({ cycles: 2, turns: 1, runOnlyPendingTimers: true });

        expect(hook.getCurrent()).toEqual(expect.objectContaining({
            status: 'error',
            error: 'terminal RPC target unavailable',
        }));

        await hook.unmount();
    });

    it('uses legacy event-cursor reads when terminal.transport.byteStream is disabled', async () => {
        byteStreamEnabled = false;
        await refreshTerminalFeatures();
        terminalOps.ensure.mockResolvedValue({ ok: true, terminalId: 'term-legacy-feature', reused: false });
        terminalOps.streamRead.mockResolvedValueOnce({
            ok: true,
            terminalId: 'term-legacy-feature',
            events: [{ t: 'data', data: 'legacy output' }],
            nextCursor: 1,
            done: true,
        });

        const renderer: EmbeddedTerminalRendererHandle = {
            write: vi.fn(),
            writeBytes: vi.fn(),
            clear: vi.fn(),
        };
        const terminalRef = { current: renderer };
        const { useMachineTerminalSession } = await import('./useMachineTerminalSession');
        const hook = await renderHook(
            () => useMachineTerminalSession({
                machineId: 'machine-1',
                cwd: '/repo',
                terminalKey: 'session:s-legacy-feature:terminal',
                terminalRef,
            }),
            { flushOptions: { cycles: 1, turns: 1 } },
        );

        await act(async () => {
            hook.getCurrent().onReady(80, 24);
        });
        await flushHookEffects({ cycles: 4, turns: 2, runOnlyPendingTimers: true });

        expect(terminalOps.streamReadBytes).not.toHaveBeenCalled();
        expect(terminalOps.streamRead).toHaveBeenCalledWith(
            'machine-1',
            {
                terminalId: 'term-legacy-feature',
                cursor: 0,
                maxBytes: undefined,
                maxEvents: undefined,
            },
            expect.any(Object),
        );
        expect(renderer.writeBytes).toHaveBeenCalledWith(expect.objectContaining({
            terminalId: 'term-legacy-feature',
            byteOffset: 0,
            bytes: new TextEncoder().encode('legacy output'),
        }));

        await hook.unmount();
    });
});
