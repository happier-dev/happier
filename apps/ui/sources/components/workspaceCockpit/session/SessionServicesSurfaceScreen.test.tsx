import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { tryWriteServerEnabledBitInPlace } from '@happier-dev/protocol/features/serverEnabledBit';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { DaemonLocalServiceLauncherStartResponseV1Schema } from '@happier-dev/protocol/local/services/launcher/v1';
import { DaemonLocalServicePublicPreviewCreateResponseV1Schema, LocalServicePublicPreviewSnapshotV1Schema } from '@happier-dev/protocol/local/services/public/v1';

import { buildLocalServiceInventoryState, createPlainMachineRowFixture, createSessionFixture, renderScreen } from '@/dev/testkit';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { createHydratedPlainMachineFixture, createMachineReadBatchResponseFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { installSessionPaneRuntimeTestHarness } from '@/components/sessions/panes/sessionPaneRuntimeTestHarness';
import { primeServerFeaturesSnapshot } from '@/sync/api/capabilities/serverFeaturesClient';
import { storage } from '@/sync/domains/state/storageStore';
import { buildSessionListRenderableFromSession } from '@/sync/domains/session/listing/sessionListRenderable';
import { resolveMachineTargetForSessionFromState } from '@/sync/domains/session/resolveMachineTargetForSessionFromState';
import { applyLocalServiceLauncherSnapshot, createLocalServiceLauncherState } from '@/sync/domains/local/services/launch';
import { applyLocalServicePublicPreviewSnapshot, createLocalServicePublicPreviewState } from '@/sync/domains/local/services/publicPreview/store';

const modalShow = vi.hoisted(() => vi.fn((config: unknown) => {
    const props = (config as { props?: {
        modeChoices: readonly { mode: string }[];
        ttlChoices: readonly { ttlMs: number }[];
        onResolve: (decision: { mode: string; ttlMs: number } | null) => void;
    } }).props;
    const mode = props?.modeChoices[0];
    const ttl = props?.ttlChoices[0];
    props?.onResolve(mode && ttl ? { mode: mode.mode, ttlMs: ttl.ttlMs } : null);
    return 'modal-id';
}));
vi.mock('@/modal', async () =>
    (await import('@/dev/testkit/mocks/modal')).createModalModuleMock({ confirmResult: true, spies: { show: modalShow as never } }).module);
vi.mock('socket.io-client', async importOriginal =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));

let publicPreviewEnabled = true;
let machineIdsForHome = ['machine-a'];
function features() {
    const response = createRootLayoutFeaturesResponse();
    for (const feature of ['localServices', 'localServices.preview', 'localServices.publicPreview'] as const) {
        if (!tryWriteServerEnabledBitInPlace(response, feature, feature === 'localServices.publicPreview' ? publicPreviewEnabled : true)) {
            throw new Error('Expected the registered Local Services feature');
        }
    }
    return response;
}
const calls: { method: string; input: unknown; machineId: string }[] = [];
const responses = new Map<string, unknown>();
// Only Home HTTP/Socket transport and native consequence presentation are replaced.
const runtime = installSessionPaneRuntimeTestHarness({
    sessionId: 'session-a', features,
    request: async (url, init) => {
        const path = new URL(String(url)).pathname;
        const machines = machineIdsForHome.map(id => createPlainMachineRowFixture({ id, accountId: 'account-a' }));
        if (path === '/v1/machines/read-batch' && init?.method === 'POST') return createMachineReadBatchResponseFixture(init.body,
            id => machines.find(machine => machine.id === id) ?? null);
        const machine = machines.find(machine => path === `/v1/machines/${machine.id}`);
        return path === '/v1/machines' ? Response.json(machines) : machine ? Response.json({ machine }) : null;
    },
    rpc: async (method, input, machineId) => {
        calls.push({ method, input, machineId });
        return responses.get(method) ?? { success: false, errorCode: 'FEATURE_UNSUPPORTED' };
    },
});
const { SessionServicesSurfaceScreen } = await import('./SessionServicesSurfaceScreen');
const callsFor = (method: string) => calls.filter(call => call.method === method);

function buildLauncherState() {
    return applyLocalServiceLauncherSnapshot(createLocalServiceLauncherState(), {
        v: 1,
        machineId: 'machine-a',
        sessionId: 'session-a',
        updatedAt: 3_000,
        targets: [{
            id: 'managed:mobile-feed',
            source: 'managed_service',
            sourceClass: { kind: 'managed_service', managedServiceId: 'mobile-feed' },
            machineId: 'machine-a',
            sessionId: 'session-a',
            title: 'Mobile feed service',
            subtitle: 'localhost:4173',
            confidence: 'medium',
            state: 'available',
            actions: ['start'],
        }],
    });
}

function buildPublicPreviewLauncherState() {
    return applyLocalServiceLauncherSnapshot(createLocalServiceLauncherState(), {
        v: 1,
        machineId: 'machine-a',
        sessionId: 'session-a',
        updatedAt: 3_000,
        targets: [{
            // A row reads running only from observed liveness; preview access rides an observed Service.
            id: 'inventory:mobile-feed',
            source: 'inventory_entry',
            sourceClass: { kind: 'inventory_entry', inventoryEntryId: 'mobile-feed' },
            machineId: 'machine-a',
            sessionId: 'session-a',
            title: 'Mobile feed preview',
            subtitle: 'localhost:4173',
            confidence: 'high',
            state: 'available',
            actions: [],
            browserTarget: {
                kind: 'localServicePreview',
                targetId: 'preview-mobile',
                sessionId: 'session-a',
                machineId: 'machine-a',
            },
        }],
    });
}

function buildPublicPreviewSnapshot() {
    return LocalServicePublicPreviewSnapshotV1Schema.parse({
        v: 1,
        machineId: 'machine-a',
        sessionId: 'session-a',
        generatedAt: 4_000,
        refreshState: 'idle',
        policy: {
            enabled: true,
            allowedModes: ['secret_link'],
            maxTtlMs: 600_000,
            maxConcurrentExposures: 2,
            dnsTlsRequired: true,
            auditRequired: true,
            rateLimitProfileIds: ['default'],
        },
        exposures: [],
        diagnostics: [],
    });
}

function buildPublicPreviewState() {
    return applyLocalServicePublicPreviewSnapshot(createLocalServicePublicPreviewState(), buildPublicPreviewSnapshot());
}


describe('SessionServicesSurfaceScreen', () => {
    beforeEach(() => {
        publicPreviewEnabled = true;
        machineIdsForHome = ['machine-a'];
        modalShow.mockClear();
        calls.length = 0;
        responses.clear();
        primeServerFeaturesSnapshot({ serverId: runtime.serverId, snapshot: { status: 'ready', features: features() } });
        storage.getState().applyMachines([createHydratedPlainMachineFixture({ id: 'machine-a', accountId: 'account-a', machine: { activeAt: Date.now() } })], true,
            { sourceServerId: runtime.serverId, sourceAccountId: 'account-a' });
        storage.getState().markMachineListSettled(runtime.serverId);
        storage.getState().applySessions([createSessionFixture({ id: 'session-a', serverId: runtime.serverId,
            metadata: { machineId: 'machine-a', path: '/repo', host: 'tester' } })]);
    });
    afterEach(() => { publicPreviewEnabled = true; });

    it.each(['ambient', 'explicit-other-Home'] as const)('requests mobile Services from the Session Machine for %s', async target => {
        const machineId = target === 'ambient' ? 'machine-a' : 'machine-b';
        const machineA = createHydratedPlainMachineFixture({ id: 'machine-a', accountId: 'account-a', machine: { activeAt: Date.now() } });
        const machineB = createHydratedPlainMachineFixture({ id: 'machine-b', accountId: 'account-a', machine: { activeAt: Date.now() } });
        storage.setState({ machines: { [machineA.id]: machineA }, machineListByServerId: { [runtime.serverId]: [machineA] } });
        if (target === 'explicit-other-Home') {
            machineIdsForHome = ['machine-a', 'machine-b'];
            const ambient = createSessionFixture({ id: 'session-a', serverId: 'ambient-home', active: true,
                metadata: { machineId: machineA.id, path: '/ambient', host: 'ambient-host' } });
            const scoped = createSessionFixture({ id: 'session-a', serverId: runtime.serverId, active: true,
                metadata: { machineId: machineB.id, path: '/target', host: 'target-host' } });
            storage.setState({ sessions: { 'session-a': ambient }, machines: { [machineA.id]: machineA, [machineB.id]: machineB },
                machineListByServerId: { 'ambient-home': [machineA], [runtime.serverId]: [machineA, machineB] },
                sessionListRowsByServerId: { [runtime.serverId]: { 'session-a': buildSessionListRenderableFromSession(scoped) } } });
        }
        expect(resolveMachineTargetForSessionFromState(storage.getState(), 'session-a')?.machineId).toBe('machine-a');
        expect(resolveMachineTargetForSessionFromState(storage.getState(), { serverId: runtime.serverId, sessionId: 'session-a' })?.machineId).toBe(machineId);
        responses.set(RPC_METHODS.DAEMON_LOCAL_SERVICES_LAUNCHER_SNAPSHOT, {
            protocolVersion: 1, snapshot: { v: 1, machineId, sessionId: 'session-a', updatedAt: 4_000, targets: [] },
        });
        await renderScreen(<SessionServicesSurfaceScreen sessionId="session-a"
            serverId={target === 'explicit-other-Home' ? runtime.serverId : undefined}
            inventoryState={buildLocalServiceInventoryState({ rows: [] })}
            publicPreviewState={buildPublicPreviewState()} />, { wrapper: runtime.Wrapper });
        await vi.waitFor(() => expect(callsFor(RPC_METHODS.DAEMON_LOCAL_SERVICES_LAUNCHER_SNAPSHOT)).toEqual([
            expect.objectContaining({ machineId, input: expect.objectContaining({ machineId, sessionId: 'session-a' }) }),
        ]));
    });

    it('does not poll public preview status when public previews are disabled', async () => {
        publicPreviewEnabled = false;
        primeServerFeaturesSnapshot({ serverId: runtime.serverId, snapshot: { status: 'ready', features: features() } });
        const publicPreviewStatusClient = vi.fn(async () => ({ ok: false as const, reason: 'unavailable' as const }));
        await renderScreen(<SessionServicesSurfaceScreen sessionId="session-a" serverId={runtime.serverId} machineId="machine-a"
            inventoryState={buildLocalServiceInventoryState({ rows: [] })} launcherState={buildLauncherState()}
            publicPreviewStatusClient={publicPreviewStatusClient} />, { wrapper: runtime.Wrapper });
        expect(publicPreviewStatusClient).not.toHaveBeenCalled();
    });

    it('starts the exact mobile Services target through real Action admission and Machine transport', async () => {
        responses.set(RPC_METHODS.DAEMON_LOCAL_SERVICES_LAUNCHER_START, DaemonLocalServiceLauncherStartResponseV1Schema.parse({
            protocolVersion: 1, machineId: 'machine-a', targetId: 'managed:mobile-feed', status: 'succeeded',
            snapshot: { v: 1, machineId: 'machine-a', sessionId: 'session-a', updatedAt: 4_000, targets: [] },
        }));
        const screen = await renderScreen(<SessionServicesSurfaceScreen sessionId="session-a" serverId={runtime.serverId} machineId="machine-a"
            inventoryState={buildLocalServiceInventoryState({ rows: [] })} launcherState={buildLauncherState()} />,
        { wrapper: runtime.Wrapper });
        await screen.pressByTestIdAsync('session-mobile-services-row:managed:mobile-feed-start');
        await vi.waitFor(() => expect(callsFor(RPC_METHODS.DAEMON_LOCAL_SERVICES_LAUNCHER_START), screen.getTextContent()).toEqual([{
            method: RPC_METHODS.DAEMON_LOCAL_SERVICES_LAUNCHER_START, machineId: 'machine-a',
            input: { machineId: 'machine-a', targetId: 'managed:mobile-feed', sessionId: 'session-a' },
        }]));
    });

    it('creates the confirmed public preview through real mobile Services Action admission', async () => {
        const exposure = { exposureId: 'public-preview-1', previewId: 'preview-mobile', sessionId: 'session-a',
            machineId: 'machine-a', mode: 'secret_link', state: 'active', publicUrl: 'https://preview.example.test/public-preview-1',
            issuedAt: 4_000, expiresAt: 604_000, auditEventIds: ['audit-1'], rateLimitProfileId: 'default' };
        responses.set(RPC_METHODS.DAEMON_LOCAL_SERVICES_PUBLIC_PREVIEW_CREATE, DaemonLocalServicePublicPreviewCreateResponseV1Schema.parse({
            protocolVersion: 1, exposure,
            snapshot: { ...buildPublicPreviewSnapshot(), exposures: [exposure] },
        }));
        const screen = await renderScreen(<SessionServicesSurfaceScreen sessionId="session-a" serverId={runtime.serverId} machineId="machine-a"
            inventoryState={buildLocalServiceInventoryState({ rows: [] })} launcherState={buildPublicPreviewLauncherState()}
            publicPreviewState={buildPublicPreviewState()} />, { wrapper: runtime.Wrapper });
        await screen.pressByTestIdAsync('session-mobile-services-row:inventory:mobile-feed-item');
        await screen.pressByTestIdAsync('session-mobile-services-row:inventory:mobile-feed-share');
        await vi.waitFor(() => expect(callsFor(RPC_METHODS.DAEMON_LOCAL_SERVICES_PUBLIC_PREVIEW_CREATE)).toEqual([{
            method: RPC_METHODS.DAEMON_LOCAL_SERVICES_PUBLIC_PREVIEW_CREATE, machineId: 'machine-a',
            input: { machineId: 'machine-a', sessionId: 'session-a', previewId: 'preview-mobile',
                mode: 'secret_link', ttlMs: 600_000, confirmation: { acknowledged: true } },
        }]));
        expect(modalShow).toHaveBeenCalledOnce();
    });
});
