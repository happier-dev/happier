import { describe, expect, it } from 'vitest';

import type { Machine } from '@/sync/domains/state/storageTypes';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { readConnectedAccountBrowserSignInMachineSupport } from '@/sync/domains/connectedServices/connectedAccountBrowserSignInMachineSupport';
import type { MachineDisplayRenderable } from './machineDisplayRenderable';
import {
    areMachineDisplayRenderablesEqual,
    areMachineDisplaySemanticsEqual,
    buildMachineDisplayRenderableFromMachine,
    getMachineDisplaySubtitle,
} from './machineDisplayRenderable';

function makeMachineDisplay(partial: Partial<MachineDisplayRenderable> & Pick<MachineDisplayRenderable, 'id'>): MachineDisplayRenderable {
    const updatedAt = partial.updatedAt ?? 0;
    const activeAt = partial.activeAt ?? updatedAt;
    return {
        id: partial.id,
        updatedAt,
        active: partial.active ?? false,
        activeAt,
        revokedAt: partial.revokedAt ?? null,
        ...(partial.availability ? { availability: partial.availability } : {}),
        metadataVersion: partial.metadataVersion ?? 0,
        metadata: partial.metadata ?? null,
    };
}

describe('machine display renderables', () => {
    it('publishes sign-in support changes and withdrawal through the Machine display projection', () => {
        const machine = createMachineFixture({ metadata: null });
        const unavailable = buildMachineDisplayRenderableFromMachine(machine);
        const capable = buildMachineDisplayRenderableFromMachine({ ...machine,
            operationProtocolCapabilities: { connectedAccountAuthentication: { protocolVersions: [1] } },
            operationProtocolCapabilitiesRevision: 1 });
        expect(readConnectedAccountBrowserSignInMachineSupport(unavailable)).toBe('cli_update_required');
        expect(readConnectedAccountBrowserSignInMachineSupport(capable)).toBe('supported');
        expect(areMachineDisplaySemanticsEqual(unavailable, capable)).toBe(false);
        const withdrawn = buildMachineDisplayRenderableFromMachine({ ...machine,
            operationProtocolCapabilitiesRevision: 2 });
        expect(readConnectedAccountBrowserSignInMachineSupport(withdrawn)).toBe('cli_update_required');
        expect(areMachineDisplaySemanticsEqual(capable, withdrawn)).toBe(false);
    });
    it('retains each immutable Machine display and projects a new heartbeat record', () => {
        const machine = createMachineFixture({ activeAt: 10, updatedAt: 10 });
        const first = buildMachineDisplayRenderableFromMachine(machine);
        expect(buildMachineDisplayRenderableFromMachine(machine)).toBe(first);
        const refreshed = buildMachineDisplayRenderableFromMachine({ ...machine, activeAt: 20, updatedAt: 20 });
        expect(refreshed).not.toBe(first);
        expect(refreshed).toMatchObject({ activeAt: 20, updatedAt: 20 });
        expect(first).toMatchObject({ activeAt: 10, updatedAt: 10 });
    });
    it('invalidates an architecture-only update in both display subscription comparisons', () => {
        const before = makeMachineDisplay({ id: 'build', metadata: { platform: 'linux' } });
        const after = { ...before, metadata: { ...before.metadata, arch: 'x64' } };
        expect(areMachineDisplayRenderablesEqual(before, after)).toBe(false);
        expect(areMachineDisplaySemanticsEqual(before, after)).toBe(false);
        expect(areMachineDisplaySemanticsEqual(after, { ...after, metadata: { ...after.metadata } })).toBe(true);
    });
    it('publishes new Session wake capability changes without requiring a presence update', () => {
        const machine = createMachineFixture({
            active: false,
            activeAt: 0,
            isShared: true,
            managedInputRuntime: {
                nativeReady: false,
                wakeState: 'asleep',
                state: 'asleep',
                newSessionWake: { kind: 'unavailable', reason: 'no_controller' },
            },
        });
        const unavailable = buildMachineDisplayRenderableFromMachine(machine);
        const availableMachine = {
            ...machine,
            managedInputRuntime: { ...machine.managedInputRuntime!, newSessionWake: { kind: 'available' as const } },
        };
        const available = buildMachineDisplayRenderableFromMachine(availableMachine);
        const identical = buildMachineDisplayRenderableFromMachine({
            ...availableMachine,
            managedInputRuntime: { ...availableMachine.managedInputRuntime, newSessionWake: { kind: 'available' } },
        });

        expect(areMachineDisplayRenderablesEqual(unavailable, available)).toBe(false);
        expect(areMachineDisplaySemanticsEqual(unavailable, available)).toBe(false);
        expect(areMachineDisplayRenderablesEqual(available, identical)).toBe(true);
        expect(areMachineDisplaySemanticsEqual(available, identical)).toBe(true);
    });
    it('preserves admitted access facts and invalidates them when readiness changes', () => {
        const machine = {
            id: 'shared', seq: 1, createdAt: 1, updatedAt: 2, active: true, activeAt: 1,
            metadataVersion: 0, metadata: null, daemonState: null, daemonStateVersion: 0,
            isShared: true, access: { custodian: { accountId: 'alice', displayName: 'Alice' },
                role: 'use', resourceMode: 'plain', accessState: 'ready' },
        } satisfies Machine;
        const ready = buildMachineDisplayRenderableFromMachine(machine);
        const pending = buildMachineDisplayRenderableFromMachine({ ...machine,
            access: { ...machine.access, accessState: 'key_pending' } });
        expect(ready).toMatchObject({ isShared: true, access: machine.access });
        expect(areMachineDisplayRenderablesEqual(ready, pending)).toBe(false);
    });

    it('publishes a changed refusal reason while retaining an identical refusal display', () => {
        const base = createMachineFixture({ metadata: null, isShared: true });
        const access = { custodian: { accountId: 'alice', displayName: 'Alice' }, role: 'use' as const,
            resourceMode: 'plain' as const, accessState: 'refused' as const, reason: 'content_unpublished' as const };
        const first = buildMachineDisplayRenderableFromMachine({ ...base, access });
        const identical = buildMachineDisplayRenderableFromMachine({ ...base, access: { ...access } });
        const changed = buildMachineDisplayRenderableFromMachine({ ...base,
            access: { ...access, reason: 'custodian_only' as const } });
        expect(areMachineDisplaySemanticsEqual(first, identical)).toBe(true);
        expect(areMachineDisplaySemanticsEqual(first, changed)).toBe(false);
        expect(areMachineDisplayRenderablesEqual(first, changed)).toBe(false);
    });

    it('treats a changed locked availability as a changed display snapshot', () => {
        const available = makeMachineDisplay({
            id: 'machine-a',
            availability: { kind: 'available' },
        });
        const locked = makeMachineDisplay({
            id: 'machine-a',
            availability: { kind: 'locked', reason: 'decryption_failed' },
        });

        expect(areMachineDisplayRenderablesEqual(available, locked)).toBe(false);
    });

    it('uses display fields without resolving a machine by host identity', () => {
        const machine = makeMachineDisplay({
            id: 'machine-a',
            metadata: { displayName: null, host: 'example-host' },
        });

        expect(getMachineDisplaySubtitle(machine, 'machine-a')).toBe('example-host');
    });

    it('carries replacement metadata into display renderables', () => {
        const machine = {
            id: 'machine-old',
            seq: 1,
            createdAt: 1,
            updatedAt: 2,
            active: false,
            activeAt: 1,
            metadataVersion: 3,
            metadata: null,
            daemonState: null,
            daemonStateVersion: 0,
            replacedByMachineId: 'machine-new',
            replacedAt: 4,
            replacementReason: 'manual_repair',
            replacementSource: 'manual',
            replacementActorUserId: 'user-1',
        } satisfies Machine & {
            replacedByMachineId: string;
            replacedAt: number;
            replacementReason: string;
            replacementSource: string;
            replacementActorUserId: string;
        };

        const renderable = buildMachineDisplayRenderableFromMachine(machine);

        expect(renderable).toMatchObject({
            replacedByMachineId: 'machine-new',
            replacedAt: 4,
            replacementReason: 'manual_repair',
            replacementSource: 'manual',
            replacementActorUserId: 'user-1',
        });
    });
});
