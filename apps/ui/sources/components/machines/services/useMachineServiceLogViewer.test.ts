import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MachineServiceRowV1, ManagedServiceNativeLogResultV1 } from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { ExternalActionExecutionAuthorizationRequestV1Schema, ExternalActionRequestEnvelopeV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { computeExternalActionRequestEnvelopeDigestV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import type { LogViewerControlsV1 } from '@happier-dev/forge-ci/ui';
import { renderHook, flushHookEffects, standardCleanup } from '@/dev/testkit';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries, type HomeDomainAnswer } from '@/dev/testkit/harness/homeGovernanceHarness';
import { createMachineReadBatchResponseFixture, createPlainMachineRowFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { initializeRealAppRuntimeForTests } from '@/dev/testkit/harness/realAppRuntimeHarness';

// Only the Home HTTP/credential boundary is substituted. The viewer, first Action,
// Resource store, continuation transport and Forge index/Find model remain real.
const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
const { useMachineServiceLogViewer } = await import('./useMachineServiceLogViewer');
let serverId: string;
let restoreScope: () => void | Promise<void> = () => {};
beforeEach(async () => {
    await homes.reset();
    const { storage } = await import('@/sync/domains/state/storage');
    const runtime = await import('@/sync/runtime/orchestration/appliedActiveServerRuntime');
    const priorStorage = storage.getState();
    const priorSnapshot = runtime.getAppliedActiveServerSnapshot();
    const priorAvailable = runtime.isAppliedActiveServerRuntimeAvailable();
    await initializeRealAppRuntimeForTests();
    installHomeGovernanceBoundaries(homes);
    serverId = await homes.addHome({ name: 'Log viewer currentness', serverUrl: 'https://log-viewer-current.test',
        serverIdentityId: 'srv_log_viewer_current', accountId: 'account', currentAccount: true, active: false });
    const { TokenStorage } = await import('@/auth/storage/tokenStorage');
    const { setActiveServerId } = await import('@/sync/domains/server/serverProfiles');
    const { restoreConnectionToActiveServer, disconnectActiveServerConnection } = await import('@/sync/runtime/orchestration/connectionManager');
    await setActiveServerId(serverId, { scope: 'device' });
    const credentials = await TokenStorage.getCredentialsForServerUrl('https://log-viewer-current.test', { serverId });
    if (!credentials) throw new Error('Expected stored log viewer credentials');
    await restoreConnectionToActiveServer(credentials);
    restoreScope = async () => {
        await disconnectActiveServerConnection();
        storage.setState(priorStorage, true);
        runtime.publishAppliedActiveServerSnapshot(priorSnapshot, priorAvailable);
    };
});
afterEach(async () => { standardCleanup(); await restoreScope(); await homes.reset(); });

describe('native log viewer authority withdrawal', () => {
    it.each(['expired_resource', 'action_forbidden', 'action_home_signed_out'] as const)(
        'preserves bounded logs through unavailable and hidden demand, then retires and readmits on %s', async reason => {
            const actionId = 'machines.services.logs.read';
            const actionPath = `/v1/actions/${actionId}`;
            const page: ManagedServiceNativeLogResultV1 = { kind: 'page', page: {
                sourceRevision: 'native-source', text: 'bounded redacted log sentinel', nextCursor: null, truncated: false,
            } };
            let current: ManagedServiceNativeLogResultV1 = page;
            let terminal = false;
            let transportUnavailable = false;
            let freshAdmission = false;
            let firstReads = 0;
            let pendingReplacementReads = 0;
            let pendingReplacementOpens = 0;
            const acquisitions: string[] = [];
            let watchCloses = 0;
            let captureWithdrawnRenders = false;
            const withdrawnRenders: string[] = [];
            let finishFreshFirst: (() => void) | undefined;
            let deliver: (() => void) | undefined;
            const content = () => {
                const bytes = Buffer.from(JSON.stringify(current));
                return { contentType: 'application/json' as const, bytesBase64: bytes.toString('base64'),
                    digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}` };
            };
            const row = { ...createPlainMachineRowFixture({ id: 'machine', accountId: 'account' }), installationId: 'installation' };
            homes.answer(serverId, '/v1/machines/machine', { body: { machine: row } });
            homes.answer(serverId, 'POST /v1/machines/read-batch', { select: async body => ({
                body: await createMachineReadBatchResponseFixture(body, () => row).json(),
            }) });
            homes.answer(serverId, `${actionPath}/execution-authorization`, { select: body => {
                const envelope = ExternalActionRequestEnvelopeV1Schema.parse((body as { envelope: unknown }).envelope);
                return { body: { v: 1, token: 'home-log-currentness-proof', binding: {
                    serverIdentityId: 'srv_log_viewer_current', accountId: 'account', authentication: { kind: 'account', tokenEpoch: 0 },
                    actionId, requestId: envelope.requestId, target: { kind: 'machine', machineId: 'machine' },
                    machineId: 'machine', installationId: 'installation', custodianAccountId: 'account', accountEncryptionMode: 'plain',
                    requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope),
                } } };
            } });
            homes.answer(serverId, actionPath, { select: (body, request) => {
                const authorized = ExternalActionExecutionAuthorizationRequestV1Schema.safeParse(body);
                const envelope = ExternalActionRequestEnvelopeV1Schema.parse(authorized.success ? authorized.data.envelope : body);
                const reply = (result: unknown): HomeDomainAnswer => ({ body: {
                    v: 1, actionId, requestId: envelope.requestId, execution: { ok: true, result },
                } });
                const continuation = envelope.resourceContinuation;
                // READ/OPEN/NEXT acquire work; CLOSE releases an admitted watch
                // and is expected when follow pauses or the surface hides.
                if (continuation?.method === RPC_METHODS.DAEMON_PLUGIN_UI_RESOURCE_WATCH_CLOSE) watchCloses++;
                else acquisitions.push(continuation?.method ?? 'first-action');
                if (!continuation) {
                    firstReads++;
                    if (!terminal) return reply(page);
                    return new Promise<HomeDomainAnswer>(resolve => {
                        const aborted = () => resolve(reply({ kind: 'unavailable', reason: 'cancelled' }));
                        finishFreshFirst = () => {
                            freshAdmission = true;
                            current = { kind: 'page', page: { ...page.page, text: 'freshly admitted replacement' } };
                            request.signal?.removeEventListener('abort', aborted);
                            resolve(reply({ kind: 'page', page: { ...page.page, text: 'freshly admitted replacement' } }));
                        };
                        request.signal?.addEventListener('abort', aborted, { once: true });
                        if (request.signal?.aborted) aborted();
                    });
                }
                const reference = continuation.params.resource;
                if (continuation.method === RPC_METHODS.DAEMON_PLUGIN_UI_RESOURCE_READ) {
                    if (transportUnavailable) return { status: 503, body: { error: 'home_unreachable' } };
                    if (terminal && !freshAdmission) {
                        pendingReplacementReads++;
                        return new Promise<HomeDomainAnswer>(resolve => {
                            const aborted = () => resolve(reply({ ok: false, code: 'service_unavailable', reason: 'unavailable' }));
                            request.signal?.addEventListener('abort', aborted, { once: true });
                            if (request.signal?.aborted) aborted();
                        });
                    }
                    return reply({ ok: true, resource: reference, ...content() });
                }
                if (continuation.method === RPC_METHODS.DAEMON_PLUGIN_UI_RESOURCE_WATCH_OPEN) {
                    if (!terminal || freshAdmission) return reply({ ok: true, subscriptionId: continuation.params.subscriptionId, digest: content().digest });
                    pendingReplacementOpens++;
                    // A genuinely expired observation cannot restore bytes from
                    // a replacement until that replacement has been admitted.
                    return new Promise<HomeDomainAnswer>(resolve => {
                        const aborted = () => resolve(reply({ ok: false, code: 'service_unavailable', reason: 'unavailable' }));
                        request.signal?.addEventListener('abort', aborted, { once: true });
                        if (request.signal?.aborted) aborted();
                    });
                }
                if (continuation.method === RPC_METHODS.DAEMON_PLUGIN_UI_RESOURCE_WATCH_CLOSE)
                    return reply({ ok: true, closed: true });
                expect(continuation.method).toBe(RPC_METHODS.DAEMON_PLUGIN_UI_RESOURCE_WATCH_NEXT);
                return new Promise<HomeDomainAnswer>(resolve => {
                    const finish = (value: unknown) => {
                        if (deliver === notify) deliver = undefined;
                        request.signal?.removeEventListener('abort', abort);
                        resolve(reply(value));
                    };
                    const notify = () => {
                        finish({ ok: true, status: 'event', event: terminal && !freshAdmission
                            ? { version: 1, kind: 'error', code: reason === 'expired_resource' ? 'expired_resource' : 'unavailable',
                                subscriptionId: continuation.params.subscriptionId, diagnostics: [reason] }
                            : { version: 1, kind: 'invalidated',
                                subscriptionId: continuation.params.subscriptionId, digest: content().digest } });
                    };
                    const abort = () => finish({ ok: true, status: 'idle' });
                    deliver = notify;
                    request.signal?.addEventListener('abort', abort, { once: true });
                    if (request.signal?.aborted) abort();
                });
            } });
            const service: MachineServiceRowV1 = { serviceId: 'service', name: 'Worker', authority: 'machine',
                lifecyclePurpose: 'deployment', generation: 'generation-a', state: 'running', watchId: 'watch', watchRevision: 'watch-revision',
                capabilities: { start: false, stop: true, restart: false, logs: true, accounting: false } };
            // Controlled presentation state belongs to this native host. No view or Find owner is mocked.
            const view: LogViewerControlsV1['view'] = {
                getSnapshot: () => state, subscribe: () => () => {}, invoke() {},
            };
            const state: NonNullable<ReturnType<typeof view.getSnapshot>> = {
                selection: { kind: 'all' }, groupExpanded: {}, revealedLine: null, timestampsVisible: true,
            };
            const hook = await renderHook((props: { active: boolean }) => {
                const value = useMachineServiceLogViewer({ serverId, machineId: 'machine', service,
                    active: props.active, view, surfaceId: 'native-currentness', containsFocus: () => true, isInputFocused: () => false });
                if (captureWithdrawnRenders) withdrawnRenders.push(JSON.stringify({
                    first: value.first, index: value.index?.plainText,
                    viewer: value.viewer?.lines.map(line => line.plainText),
                }));
                return value;
            }, { initialProps: { active: false } });
            expect(firstReads).toBe(0);
            await hook.rerender({ active: true });
            await flushHookEffects();
            await vi.waitFor(() => expect(hook.getCurrent().index?.plainText).toBe('bounded redacted log sentinel'));
            await vi.waitFor(() => expect(deliver).toBeTypeOf('function'));
            const beforePauseCloses = watchCloses;
            await hook.getCurrent().setFollow(false);
            await vi.waitFor(() => expect(watchCloses).toBe(beforePauseCloses + 1));
            await flushHookEffects();
            // Switching to the existing static subscription may read through
            // once. Once settled, paused demand must not keep acquiring work.
            const pausedAcquisitions = acquisitions.length;
            await flushHookEffects();
            expect(acquisitions).toHaveLength(pausedAcquisitions);
            await hook.getCurrent().setFollow(true);
            await vi.waitFor(() => expect(deliver).toBeTypeOf('function'));
            const beforeHide = { acquisitions: acquisitions.length, closes: watchCloses };
            await hook.rerender({ active: false });
            await vi.waitFor(() => expect(watchCloses).toBe(beforeHide.closes + 1));
            await flushHookEffects();
            expect(acquisitions).toHaveLength(beforeHide.acquisitions);
            expect(hook.getCurrent().index?.plainText).toBe('bounded redacted log sentinel');
            await hook.rerender({ active: true });
            await vi.waitFor(() => expect(deliver).toBeTypeOf('function'));
            current = { kind: 'source-changed', sourceRevision: 'replacement-source' };
            deliver!();
            await vi.waitFor(() => expect(hook.getCurrent().projection?.kind).toBe('sourceChanged'));
            expect(hook.getCurrent().index?.plainText).toBe('bounded redacted log sentinel');
            expect(hook.getCurrent().followed?.lastGoodPage).toBeUndefined();
            current = page;
            await hook.getCurrent().followed?.refresh();
            await vi.waitFor(() => expect(hook.getCurrent().projection?.kind).toBe('index'));
            await vi.waitFor(() => expect(deliver).toBeTypeOf('function'));
            transportUnavailable = true;
            deliver!();
            await vi.waitFor(() => expect(hook.getCurrent().followed?.error).toBeDefined());
            expect(hook.getCurrent().index?.plainText).toBe('bounded redacted log sentinel');
            transportUnavailable = false;
            await hook.getCurrent().followed?.refresh();
            await vi.waitFor(() => expect(deliver).toBeTypeOf('function'));
            current = { kind: 'unavailable', reason: 'unavailable' };
            deliver!();
            await vi.waitFor(() => expect(hook.getCurrent().followUnavailable).toBe('unavailable'));
            expect(hook.getCurrent().index?.plainText).toBe('bounded redacted log sentinel');
            expect(hook.getCurrent().viewer?.lines.map(line => line.plainText)).toEqual(['bounded redacted log sentinel']);
            await vi.waitFor(() => expect(deliver).toBeTypeOf('function'));
            current = { kind: 'unavailable', reason: 'admission_unavailable' };
            deliver!();
            await vi.waitFor(() => expect(hook.getCurrent().followUnavailable).toBe('admission_unavailable'));
            expect(hook.getCurrent().index?.plainText).toBe('bounded redacted log sentinel');
            await vi.waitFor(() => expect(deliver).toBeTypeOf('function'));
            terminal = true; captureWithdrawnRenders = true;
            deliver!();
            await vi.waitFor(() => expect(hook.getCurrent().projection).toEqual({ kind: 'unavailable',
                reason: 'admission_unavailable' }));
            captureWithdrawnRenders = true;
            expect(hook.getCurrent().index).toBeNull();
            expect(hook.getCurrent().viewer).toBeNull();
            expect(JSON.stringify(hook.getCurrent().first)).not.toContain('bounded redacted log sentinel');
            expect(hook.getCurrent().followed?.lastGoodPage).toBeUndefined();
            expect(await hook.getCurrent().copyLoaded()).toBe(false);
            expect(await hook.getCurrent().exportLoaded()).toBe('canceled');
            {
                // Expiry synchronously replaces the Resource watch/read. Keep
                // BOTH replacement admissions pending: an error-free pending
                // snapshot must never resurrect the separate first page.
                if (reason === 'expired_resource') {
                    await vi.waitFor(() => expect(pendingReplacementReads).toBeGreaterThan(0));
                    await vi.waitFor(() => expect(pendingReplacementOpens).toBeGreaterThan(0));
                }
                await hook.rerender({ active: false });
                await hook.rerender({ active: true });
                await hook.getCurrent().setFollow(false);
                await flushHookEffects();
                await hook.getCurrent().setFollow(true);
                await flushHookEffects();
                expect(firstReads).toBe(1);
                expect(hook.getCurrent().index).toBeNull();
                expect(hook.getCurrent().viewer).toBeNull();
                expect(withdrawnRenders.every(render => !render.includes('bounded redacted log sentinel'))).toBe(true);
                // Only the next deliberate first Action can admit new bytes.
                const freshRead = hook.getCurrent().readAgain();
                await vi.waitFor(() => expect(finishFreshFirst).toBeTypeOf('function'));
                expect(hook.getCurrent().index).toBeNull();
                finishFreshFirst!();
                await freshRead;
                await hook.getCurrent().followed?.refresh();
                await vi.waitFor(() => expect(hook.getCurrent().index?.plainText).toBe('freshly admitted replacement'));
                expect(firstReads).toBe(2);
            }
            await hook.unmount();
        },
    );
});
