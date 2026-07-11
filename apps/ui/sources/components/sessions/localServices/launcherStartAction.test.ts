import { describe, expect, it, vi } from 'vitest';

import type {
    LocalServiceLauncherSnapshotV1,
    RuntimeActionExecute,
} from '@happier-dev/protocol';
import { renderHook } from '@/dev/testkit';
import type { LocalServiceLaunchTarget } from '@/sync/domains/local/services/launch';

const startedSnapshot = {
    v: 1,
    machineId: 'machine-a',
    sessionId: 'session-a',
    updatedAt: 2_000,
    targets: [{
        id: 'managed:preview',
        source: 'managed_service',
        sourceClass: { kind: 'managed_service', managedServiceId: 'preview' },
        machineId: 'machine-a',
        sessionId: 'session-a',
        title: 'Preview',
        confidence: 'medium',
        state: 'starting',
        actions: [],
    }],
} satisfies LocalServiceLauncherSnapshotV1;

const startableTarget = {
    id: 'managed:preview',
    source: 'managed_service',
    sourceClass: { kind: 'managed_service', managedServiceId: 'preview' },
    machineId: 'machine-a',
    sessionId: 'session-a',
    workspaceId: 'workspace-a',
    title: 'Preview',
    confidence: 'medium',
    state: 'available',
    actions: ['start'],
} satisfies LocalServiceLaunchTarget;

type StartActionContextWithSnapshotApply = Readonly<{
    runtimeActionExecute?: RuntimeActionExecute | null;
    machineId?: string | null;
    sessionId?: string | null;
    workspaceId?: string | null;
    serverId?: string | null;
    applyLauncherSnapshot?: (snapshot: LocalServiceLauncherSnapshotV1) => void;
}>;

describe('launcher start action helpers', () => {
    it('builds the canonical launcher start runtime-action input', async () => {
        const mod = await import('./launcherStartAction').catch(() => null);

        expect(mod?.buildLocalServiceLauncherStartRequest).toBeTypeOf('function');
        if (!mod?.buildLocalServiceLauncherStartRequest) return;

        expect(mod.buildLocalServiceLauncherStartRequest({
            target: startableTarget,
            machineId: 'machine-a',
            sessionId: 'session-a',
            workspaceId: 'workspace-a',
        })).toEqual({
            machineId: 'machine-a',
            targetId: 'managed:preview',
            sessionId: 'session-a',
            workspaceId: 'workspace-a',
        });
    });

    it('executes launcher start through RuntimeActionExecute with the UI surface', async () => {
        const mod = await import('./launcherStartAction').catch(() => null);

        expect(mod?.useLocalServiceLauncherStartAction).toBeTypeOf('function');
        if (!mod?.useLocalServiceLauncherStartAction) return;

        const runtimeActionExecute = vi.fn(async () => ({
            protocolVersion: 1,
            machineId: 'machine-a',
            targetId: 'managed:preview',
            status: 'succeeded',
            snapshot: startedSnapshot,
        })) satisfies RuntimeActionExecute;
        const hook = await renderHook(() => mod.useLocalServiceLauncherStartAction({
            runtimeActionExecute,
            machineId: 'machine-a',
            serverId: 'server-a',
            sessionId: 'session-a',
            workspaceId: 'workspace-a',
        }));
        const start = hook.getCurrent();

        expect(start).toBeTypeOf('function');
        await start?.(startableTarget);

        expect(runtimeActionExecute).toHaveBeenCalledExactlyOnceWith({
            actionId: 'localServices.launcher.start',
            input: {
                machineId: 'machine-a',
                targetId: 'managed:preview',
                sessionId: 'session-a',
                workspaceId: 'workspace-a',
            },
            context: {
                defaultSessionId: 'session-a',
                serverId: 'server-a',
                surface: 'ui',
            },
        });
    });

    it('applies successful launcher start response snapshots after RuntimeActionExecute returns', async () => {
        const mod = await import('./launcherStartAction').catch(() => null);

        expect(mod?.useLocalServiceLauncherStartAction).toBeTypeOf('function');
        if (!mod?.useLocalServiceLauncherStartAction) return;

        const runtimeActionExecute = vi.fn(async () => ({
            protocolVersion: 1,
            machineId: 'machine-a',
            targetId: 'managed:preview',
            status: 'succeeded',
            snapshot: startedSnapshot,
        })) satisfies RuntimeActionExecute;
        const applyLauncherSnapshot = vi.fn();
        const useStartAction = mod.useLocalServiceLauncherStartAction as (
            context: StartActionContextWithSnapshotApply
        ) => ((target: LocalServiceLaunchTarget) => Promise<unknown>) | undefined;
        const hook = await renderHook(() => useStartAction({
            runtimeActionExecute,
            applyLauncherSnapshot,
            machineId: 'machine-a',
            serverId: 'server-a',
            sessionId: 'session-a',
            workspaceId: 'workspace-a',
        }));
        const start = hook.getCurrent();

        expect(start).toBeTypeOf('function');
        await start?.(startableTarget);

        expect(applyLauncherSnapshot).toHaveBeenCalledExactlyOnceWith(startedSnapshot);
    });

    it('ignores denied, failed, disabled, malformed, and mismatched launcher start results for state refresh', async () => {
        const mod = await import('./launcherStartAction').catch(() => null);

        expect(mod?.readSuccessfulLocalServiceLauncherStartSnapshot).toBeTypeOf('function');
        if (!mod?.readSuccessfulLocalServiceLauncherStartSnapshot) return;

        const request = mod.buildLocalServiceLauncherStartRequest({
            target: startableTarget,
            machineId: 'machine-a',
            sessionId: 'session-a',
            workspaceId: 'workspace-a',
        });
        const denied = {
            protocolVersion: 1,
            machineId: 'machine-a',
            targetId: 'managed:preview',
            status: 'denied',
            reasonCode: 'not_owned',
            snapshot: startedSnapshot,
        };
        const failed = {
            protocolVersion: 1,
            machineId: 'machine-a',
            targetId: 'managed:preview',
            status: 'failed',
            reasonCode: 'launch_failed',
            snapshot: startedSnapshot,
        };
        const disabled = {
            ok: false,
            errorCode: 'runtime_action_disabled',
            error: 'runtime_action_disabled:localServices:local_services_launcher_unavailable',
        };
        const mismatchedSession = {
            protocolVersion: 1,
            machineId: 'machine-a',
            targetId: 'managed:preview',
            status: 'succeeded',
            snapshot: {
                ...startedSnapshot,
                sessionId: 'session-b',
            },
        };

        expect(mod.readSuccessfulLocalServiceLauncherStartSnapshot(denied, request)).toBeNull();
        expect(mod.readSuccessfulLocalServiceLauncherStartSnapshot(failed, request)).toBeNull();
        expect(mod.readSuccessfulLocalServiceLauncherStartSnapshot(disabled, request)).toBeNull();
        expect(mod.readSuccessfulLocalServiceLauncherStartSnapshot({ snapshot: startedSnapshot }, request)).toBeNull();
        expect(mod.readSuccessfulLocalServiceLauncherStartSnapshot(mismatchedSession, request)).toBeNull();
    });
});
