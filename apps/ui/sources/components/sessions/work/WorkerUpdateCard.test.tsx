import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, encodePlainArtifactStoredContent, type AccountEncryptionCurrentnessResponse, type AccountEncryptionModeResponse, type WorkerUpdateV1 } from '@happier-dev/protocol';
import { TokenStorage } from '@/auth/storage/tokenStorage';
import { encodeBase64 } from '@/encryption/base64';
import { upsertAndActivateServer } from '@/sync/domains/server/serverRuntime';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { DestinationInstanceHost } from '@/components/appShell/workspace/DestinationInstanceHost';
import { Text } from '@/components/ui/text/Text';
import { buildScopedSessionRouteHref } from '@/hooks/session/sessionRouteServerScope';
import { WorkerUpdateCard } from './WorkerUpdateCard';
import { AppSessionTranscriptSourceProvider } from '@/components/sessions/transcript/source/appSessionTranscriptSource';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock());
vi.mock('expo-router', async () => {
    const module = (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module;
    return { ...module, useRouter: () => { throw new Error('Worker card has no Expo navigator'); } };
});
// Substitute HTTP and machine transport only; inline Artifact reads stay real.
const readerBoundaries = vi.hoisted(() => ({ fetch: vi.fn(), machineRpc: vi.fn() }));
vi.mock('@/utils/system/runtimeFetch', () => ({ runtimeFetch: (...args: unknown[]) => readerBoundaries.fetch(...args) }));
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', async () =>
    (await import('@/dev/testkit/mocks/serverScopedRpc')).createServerScopedMachineRpcBoundaryMock(readerBoundaries.machineRpc));

afterEach(async () => { await standardCleanup(); readerBoundaries.fetch.mockReset(); readerBoundaries.machineRpc.mockReset(); vi.restoreAllMocks(); });

describe('WorkerUpdateCard deliverable readers', () => {
    it.each([false, true])('opens source-scoped inline Artifacts; denied=%s', async (denied) => {
        const home = await upsertAndActivateServer({ serverUrl: `https://worker-deliverables-${denied}.test`, scope: 'tab' });
        await upsertAndActivateServer({ serverUrl: 'https://focused-deliverables.test', scope: 'tab' });
        const token = `header.${encodeBase64(new TextEncoder().encode(JSON.stringify({ sub: 'viewer' })), 'base64url')}.signature`;
        vi.spyOn(TokenStorage, 'getCredentialsForServerUrl').mockResolvedValue({ token });
        const reads: string[] = [];
        const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
        readerBoundaries.fetch.mockImplementation(async (url: unknown) => {
            const target = new URL(String(url));
            if (target.pathname === '/health' || target.pathname === '/v1/auth/ping') return json({});
            expect(target.origin).toBe(home.serverUrl);
            if (target.pathname === '/v1/features') return json({ features: {} });
            if (target.pathname === '/v1/account/encryption') return json({ mode: 'plain', updatedAt: 0 } satisfies AccountEncryptionModeResponse);
            if (target.pathname === '/v1/account/encryption/currentness') return json({ mode: 'plain', updatedAt: 0, version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null } satisfies AccountEncryptionCurrentnessResponse);
            reads.push(target.pathname);
            if (denied) return json({ error: 'PRIVATE_CONTENT' }, 403);
            if (target.pathname === '/v1/artifacts/report') return json({
                id: 'report', ownerAccountId: 'author', access: 'view', encryptionMode: 'plain',
                dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
                header: encodePlainArtifactStoredContent({ title: 'Worker document' }),
                body: encodePlainArtifactStoredContent({ body: 'Artifact preview content' }),
                headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1,
            });
            return json({ error: 'unexpected' }, 404);
        });
        const push = vi.fn();
        const update: WorkerUpdateV1 = {
            v: 1, workerKind: 'session', workerId: 'worker', ownerState: 'published', wake: 'published',
            headline: 'Worker report', result: 'Ready for review', canInspect: true,
            deliverables: [{ kind: 'artifact', artifactId: 'report' }],
        };
        const screen = await renderScreen(
            <DestinationInstanceHost tabId="deliverables" ref={{ kind: 'session', params: { id: 'lead' } }}
                pathname="/session/lead" focused visible navigation={{ push, replace: () => {}, back: () => {} }}>
                <AppSessionTranscriptSourceProvider sessionId="lead" serverId={home.id}>
                    <WorkerUpdateCard update={update} serverId={home.id} />
                </AppSessionTranscriptSourceProvider>
            </DestinationInstanceHost>,
        );
        expect(reads).toEqual([]);
        await act(async () => { await screen.findHostByTestId('worker-deliverable:0')?.props.onPress(); });
        await act(async () => { await vi.waitFor(() => {
            if (denied) expect(screen.findAllHostsByTestId('worker-deliverable-unavailable')).toHaveLength(1);
            else expect(screen.getTextContent()).toContain('Artifact preview content');
        }); });
        expect(reads).toContain('/v1/artifacts/report');
        expect(push).not.toHaveBeenCalled();
        expect(readerBoundaries.machineRpc).not.toHaveBeenCalled();
        if (denied) {
            expect(screen.findAllHostsByTestId('worker-deliverable-unavailable')).toHaveLength(1);
            expect(screen.getTextContent()).not.toContain('PRIVATE_CONTENT');
        } else {
            expect(screen.getTextContent()).toContain('Artifact preview content');
            await act(async () => {
                await TokenStorage.setCredentialsForServerUrl(home.serverUrl, { serverId: home.id }, { token: 'retired-account' });
            });
            expect(screen.getTextContent()).not.toContain('Artifact preview content');
            expect(screen.findAllHostsByTestId('worker-deliverable-unavailable')).toHaveLength(1);
        }
    });
});

describe('WorkerUpdateCard hosted navigation', () => {
    it('opens a workspace reference through the source Home file route without a separate card read', async () => {
        const push = vi.fn();
        const update: WorkerUpdateV1 = {
            v: 1, workerKind: 'session', workerId: 'worker', ownerState: 'published',
            wake: 'published', headline: 'Worker report', canInspect: false,
            deliverables: [{ kind: 'workspace_file', sessionId: 'worker', path: 'docs/result.md' }],
        };
        const screen = await renderScreen(
            <DestinationInstanceHost tabId="file-reference" ref={{ kind: 'session', params: { id: 'lead' } }}
                pathname="/session/lead" focused visible navigation={{ push, replace: () => {}, back: () => {} }}>
                <AppSessionTranscriptSourceProvider sessionId="lead" serverId="source-home">
                    <WorkerUpdateCard update={update} serverId="source-home" />
                </AppSessionTranscriptSourceProvider>
            </DestinationInstanceHost>,
        );

        await act(async () => { await screen.findHostByTestId('worker-deliverable:0')?.props.onPress(); });

        expect(push).toHaveBeenCalledWith(buildScopedSessionRouteHref({
            sessionId: 'worker', serverId: 'source-home', suffix: '/file', query: { path: 'docs/result.md' },
        }));
        expect(readerBoundaries.fetch).not.toHaveBeenCalled();
        expect(readerBoundaries.machineRpc).not.toHaveBeenCalled();
    });

    it('replaces only the default result with supplied findings while retaining the card and inspection', async () => {
        const update: WorkerUpdateV1 = {
            v: 1, workerKind: 'session', workerId: 'review-worker', ownerState: 'settled',
            wake: 'finished', headline: 'Finished', result: 'Default summary', canInspect: true,
            transcriptPointer: { kind: 'session', sessionId: 'review-worker' },
        };
        const card = (children?: React.ReactNode) => (
            <DestinationInstanceHost tabId="review-tab" ref={{ kind: 'session', params: { id: 'parent' } }}
                pathname="/session/parent" focused visible
                navigation={{ push: () => {}, replace: () => {}, back: () => {} }}>
                <AppSessionTranscriptSourceProvider sessionId="parent" serverId="server">
                    <WorkerUpdateCard update={update} serverId="server">{children}</WorkerUpdateCard>
                </AppSessionTranscriptSourceProvider>
            </DestinationInstanceHost>
        );
        const screen = await renderScreen(card());
        expect(screen.findHostByTestId('worker-update-result')?.props.children).toBe('Default summary');

        await act(async () => { screen.update(card(<Text testID="review-findings">Finding details</Text>)); });

        expect(screen.findHostByTestId('review-findings')?.props.children).toBe('Finding details');
        expect(screen.findAllHostsByTestId('worker-update-result')).toHaveLength(0);
        expect(screen.findAllHostsByTestId('worker-update:review-worker')).toHaveLength(1);
        expect(screen.findAllHostsByTestId('worker-update-inspect')).toHaveLength(1);
    });

    it('heads the card with the worker, its state word, kind and age, and never shows raw ids', async () => {
        const update: WorkerUpdateV1 = {
            v: 1, workerKind: 'session', workerId: 'sess_raw_worker_7f3', ownerState: 'settled',
            wake: 'finished', engine: { agentId: 'claude', modelId: 'opus-5.5' },
            headline: 'Support runbook for retries', result: 'Runbook drafted and published.', canInspect: true,
            transcriptPointer: { kind: 'session', sessionId: 'sess_raw_worker_7f3', seq: 4127 },
        };
        const screen = await renderScreen(
            <DestinationInstanceHost tabId="tab" ref={{ kind: 'session', params: { id: 'lead' } }}
                pathname="/session/lead" focused visible
                navigation={{ push: () => {}, replace: () => {}, back: () => {} }}>
                <AppSessionTranscriptSourceProvider sessionId="lead" serverId="server">
                    <WorkerUpdateCard update={update} serverId="server" at={Date.now() - 12 * 60_000}
                        facts={<Text testID="worker-fact">#2490</Text>} />
                </AppSessionTranscriptSourceProvider>
            </DestinationInstanceHost>,
        );

        expect(screen.findHostByTestId('worker-update-title')?.props.children).toBe('Support runbook for retries');
        expect(screen.findHostByTestId('worker-update-state')?.props.children).toBe('sessionWork.workerUpdate.settled');
        expect(screen.findHostByTestId('worker-update-kind')?.props.children).toBe('sessionWork.kinds.session · 12m');
        expect(screen.findHostByTestId('worker-update-result')?.props.children).toBe('Runbook drafted and published.');
        expect(screen.findHostByTestId('worker-update-footer')).toBeTruthy();
        expect(screen.findAllHostsByTestId('worker-fact')).toHaveLength(1);
        expect(screen.findAllHostsByTestId('worker-update-inspect')).toHaveLength(1);
        expect(screen.findAllHostsByTestId('worker-update-pointer')).toHaveLength(0);
        expect(screen.getTextContent()).not.toContain('sess_raw_worker_7f3');
        expect(screen.getTextContent()).not.toContain('4127');
    });

    it.each([
        { workerKind: 'execution_run', ownerState: 'succeeded', kind: 'sessionWork.kinds.backgroundRun' },
        { workerKind: 'workflow_run', ownerState: 'succeeded', kind: 'sessionWork.kinds.workflowRun' },
    ] as const)('names a $workerKind by its kind, not its id', async ({ workerKind, ownerState, kind }) => {
        const update = {
            v: 1, workerKind, workerId: 'run_raw_91c', ownerState, wake: 'finished',
            headline: 'Second opinion', result: 'Agrees.', canInspect: false,
            transcriptPointer: workerKind === 'workflow_run'
                ? { kind: 'workflow_run', runId: 'run_raw_91c' }
                : { kind: 'execution_run', sessionId: 'lead', runId: 'run_raw_91c' },
        } as WorkerUpdateV1;
        const screen = await renderScreen(
            <DestinationInstanceHost tabId="kind-tab" ref={{ kind: 'session', params: { id: 'lead' } }}
                pathname="/session/lead" focused visible navigation={{ push: () => {}, replace: () => {}, back: () => {} }}>
                <AppSessionTranscriptSourceProvider sessionId="lead" serverId="server">
                    <WorkerUpdateCard update={update} serverId="server" />
                </AppSessionTranscriptSourceProvider>
            </DestinationInstanceHost>,
        );

        expect(screen.findHostByTestId('worker-update-kind')?.props.children).toBe(kind);
        expect(screen.findHostByTestId('worker-update-title')?.props.children).toBe('Second opinion');
        expect(screen.getTextContent()).not.toContain('run_raw_91c');
    });

    it('opens each worker pointer through its containing destination rather than another tab', async () => {
        const pushes = [vi.fn(), vi.fn()];
        const screen = await renderScreen(<>
            {pushes.map((push, index) => {
                const update: WorkerUpdateV1 = {
                    v: 1, workerKind: 'session', workerId: `child-${index}`, ownerState: 'settled',
                    wake: 'finished', headline: 'Finished', result: 'Result', canInspect: true,
                    transcriptPointer: { kind: 'session', sessionId: `child-${index}` },
                };
                return <DestinationInstanceHost key={index} tabId={`tab-${index}`}
                    ref={{ kind: 'session', params: { id: `parent-${index}` } }}
                    pathname={`/session/parent-${index}`} focused={index === 0} visible
                    navigation={{ push, replace: () => {}, back: () => {} }}>
                    <AppSessionTranscriptSourceProvider sessionId={`parent-${index}`} serverId={`server-${index}`}>
                        <WorkerUpdateCard update={update} serverId={`server-${index}`} />
                    </AppSessionTranscriptSourceProvider>
                </DestinationInstanceHost>;
            })}
        </>);
        const actions = screen.findAllHostsByTestId('worker-update-inspect');
        expect(actions).toHaveLength(2);
        await act(async () => { actions.forEach((node) => node.props.onPress()); });
        pushes.forEach((push, index) => expect(push).toHaveBeenCalledWith(buildScopedSessionRouteHref({
            sessionId: `child-${index}`, serverId: `server-${index}`,
        })));
    });
});
