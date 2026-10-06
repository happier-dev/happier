import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, createPlainSessionOwnerMetadataEnvelopeV1, encodePlainArtifactStoredContent, projectLegacySessionAccessCapabilitiesV1, projectSessionSharedMetadataV1, SessionOwnerMetadataV1Schema, type WorkerUpdateV1 } from '@happier-dev/protocol';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { TokenStorage } from '@/auth/storage/tokenStorage';
import { encodeBase64 } from '@/encryption/base64';
import { upsertAndActivateServer } from '@/sync/domains/server/serverRuntime';

import { createMachineFixture, renderScreen, standardCleanup } from '@/dev/testkit';
import { resolveWorkspaceTargetForSessionFromState } from '@/sync/domains/session/resolveWorkspaceTargetForSessionFromState';
import { storage } from '@/sync/domains/state/storage';
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
// Substitute HTTP and machine transport only; the Session, workspace and Artifact readers stay real.
const readerBoundaries = vi.hoisted(() => ({ fetch: vi.fn(), machineRpc: vi.fn() }));
vi.mock('@/utils/system/runtimeFetch', () => ({ runtimeFetch: (...args: unknown[]) => readerBoundaries.fetch(...args) }));
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', async () =>
    (await import('@/dev/testkit/mocks/serverScopedRpc')).createServerScopedMachineRpcBoundaryMock(readerBoundaries.machineRpc));

const initialMachineLists = storage.getState().machineListByServerId;
afterEach(async () => { await standardCleanup(); storage.setState({ machineListByServerId: initialMachineLists }); readerBoundaries.fetch.mockReset(); readerBoundaries.machineRpc.mockReset(); vi.restoreAllMocks(); });

describe('WorkerUpdateCard deliverable readers', () => {
    it.each([{ denied: false, denyMachine: false }, { denied: true, denyMachine: false }, { denied: false, denyMachine: true }])('opens source-scoped files and Artifacts; denied=$denied, machine denied=$denyMachine', async ({ denied, denyMachine }) => {
        const home = await upsertAndActivateServer({ serverUrl: `https://worker-deliverables-${denied}-${denyMachine}.test`, scope: 'tab' });
        await upsertAndActivateServer({ serverUrl: 'https://focused-deliverables.test', scope: 'tab' });
        storage.setState({ machineListByServerId: { ...storage.getState().machineListByServerId, [home.id]: [createMachineFixture({ id: 'worker-machine', active: true })] } });
        const token = `header.${encodeBase64(new TextEncoder().encode(JSON.stringify({ sub: 'viewer' })), 'base64url')}.signature`;
        vi.spyOn(TokenStorage, 'getCredentialsForServerUrl').mockResolvedValue({ token });
        // Exercise credential capture outside the card's deliberately redacted error surface.
        const { captureLazyActionAccountContext } = await import('@/sync/ops/actions/actionAccountContext');
        const captured = await captureLazyActionAccountContext(home.id);
        captured.dispose();
        const reads: string[] = [];
        const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
        readerBoundaries.fetch.mockImplementation(async (url: unknown) => {
            const target = new URL(String(url));
            if (target.pathname === '/health' || target.pathname === '/v1/auth/ping') return json({});
            expect(target.origin).toBe(home.serverUrl);
            if (target.pathname === '/v1/features') return json({ features: {} });
            if (target.pathname === '/v1/account/encryption') return json({ mode: 'plain', updatedAt: 0 });
            if (target.pathname === '/v1/account/encryption/currentness') return json(createPlainAccountEncryptionCurrentnessFixture());
            reads.push(target.pathname);
            if (denied) return json({ error: 'PRIVATE_CONTENT' }, 403);
            if (target.pathname === '/v2/sessions/worker') return json({ session: {
                id: 'worker', seq: 1, createdAt: 1, updatedAt: 1, active: false, activeAt: 1, archivedAt: null,
                encryptionMode: 'plain', dataEncryptionKey: null, metadataLayoutVersion: 1, metadataVersion: 1,
                metadata: JSON.stringify(projectSessionSharedMetadataV1({
                    metadata: { path: '/worker-workspace', machineId: 'worker-machine', host: 'worker-host' },
                    agentState: null,
                })),
                ownerMetadata: createPlainSessionOwnerMetadataEnvelopeV1(SessionOwnerMetadataV1Schema.parse({
                    v: 1, workspace: { path: '/worker-workspace', machineId: 'worker-machine', host: 'worker-host' },
                })),
                effectiveAccess: { v: 1, level: 'owner', sources: [{ kind: 'owner' }], capabilities: projectLegacySessionAccessCapabilitiesV1({ level: 'owner', canApprovePermissions: true }) },
                share: null, responsibleAccountId: null, responsibleAccount: null,
                agentState: null, agentStateVersion: 0, pendingCount: 0, pendingVersion: 0,
            } });
            if (target.pathname === '/v1/artifacts/report') return json({
                id: 'report', ownerAccountId: 'author', access: 'view', encryptionMode: 'plain',
                dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
                header: encodePlainArtifactStoredContent({ title: 'Worker document' }),
                body: encodePlainArtifactStoredContent({ body: 'Artifact preview content' }),
                headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1,
            });
            return json({ error: 'unexpected' }, 404);
        });
        readerBoundaries.machineRpc.mockResolvedValue(denyMachine ? { success: false, error: 'PRIVATE_CONTENT', errorCode: 'permission_denied' } : { success: true, exists: true, kind: 'file', sizeBytes: 10 });
        const push = vi.fn();
        const update: WorkerUpdateV1 = {
            v: 1, workerKind: 'session', workerId: 'worker', ownerState: 'published', wake: 'published',
            headline: 'Worker report', result: 'Ready for review', canInspect: true,
            deliverables: [{ kind: 'workspace_file', sessionId: 'worker', path: 'docs/result.md' }, { kind: 'artifact', artifactId: 'report' }],
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
        expect(screen.getTextContent()).toContain('docs/result.md');
        await act(async () => { await screen.findHostByTestId('worker-deliverable:0')?.props.onPress(); });
        await act(async () => { await vi.waitFor(() => {
            if (denied || denyMachine) expect(screen.findAllHostsByTestId('worker-deliverable-unavailable')).toHaveLength(1);
            else expect(push).toHaveBeenCalled();
        }); });
        await act(async () => { await screen.findHostByTestId('worker-deliverable:1')?.props.onPress(); });
        await act(async () => { await vi.waitFor(() => {
            if (denied) expect(screen.findAllHostsByTestId('worker-deliverable-unavailable')).toHaveLength(2);
            else expect(screen.getTextContent()).toContain('Artifact preview content');
        }); });
        expect(reads).toContain('/v2/sessions/worker');
        expect(reads).toContain('/v1/artifacts/report');
        if (denied) {
            expect(screen.findAllHostsByTestId('worker-deliverable-unavailable')).toHaveLength(2);
            expect(screen.getTextContent()).not.toContain('PRIVATE_CONTENT');
            expect(push).not.toHaveBeenCalled();
            expect(readerBoundaries.machineRpc).not.toHaveBeenCalled();
        } else {
            if (denyMachine) {
                expect(push).not.toHaveBeenCalled();
                expect(screen.findAllHostsByTestId('worker-deliverable-unavailable')).toHaveLength(1);
                expect(screen.getTextContent()).not.toContain('PRIVATE_CONTENT');
            } else {
                expect(push).toHaveBeenCalledWith(buildScopedSessionRouteHref({ sessionId: 'worker', serverId: home.id, suffix: '/file', query: { path: 'docs/result.md' } }));
                // The existing file route must resolve the same fresh workspace as the access check.
                expect(resolveWorkspaceTargetForSessionFromState(storage.getState(), { sessionId: 'worker', serverId: home.id })).toMatchObject({
                    serverId: home.id, machineId: 'worker-machine', rootPath: '/worker-workspace',
                });
            }
            expect(readerBoundaries.machineRpc).toHaveBeenCalledWith(expect.objectContaining({ serverId: home.id, machineId: 'worker-machine', payload: { path: '/worker-workspace/docs/result.md' } }));
            expect(screen.getTextContent()).toContain('Artifact preview content');
            if (!denyMachine) {
                await act(async () => {
                    await TokenStorage.setCredentialsForServerUrl(home.serverUrl, { serverId: home.id }, { token: 'retired-account' });
                });
                expect(screen.getTextContent()).not.toContain('Artifact preview content');
                expect(screen.findAllHostsByTestId('worker-deliverable-unavailable')).toHaveLength(1);
            }
        }
    });
});

describe('WorkerUpdateCard hosted navigation', () => {
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
