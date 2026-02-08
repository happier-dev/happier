import { describe, expect, it } from 'vitest';

import { mergeSessionMetadataForStartup } from './mergeSessionMetadataForStartup';

describe('mergeSessionMetadataForStartup', () => {
    it('does not seed legacy messageQueueV1 metadata', () => {
        const nowMs = 123;
        const merged = mergeSessionMetadataForStartup({
            current: { lifecycleState: 'archived' } as any,
            next: { hostPid: 1 } as any,
            nowMs,
        });

        expect((merged as any).messageQueueV1).toBeUndefined();
        expect(merged.lifecycleState).toBe('running');
        expect(merged.lifecycleStateSince).toBe(nowMs);
    });

    it('preserves existing provider resume ids when next does not define them', () => {
        const nowMs = 1;
        const merged = mergeSessionMetadataForStartup({
            current: { geminiSessionId: 'g1', codexSessionId: 'c1' } as any,
            next: { hostPid: 2 } as any,
            nowMs,
        });

        expect((merged as any).geminiSessionId).toBe('g1');
        expect((merged as any).codexSessionId).toBe('c1');
        expect(merged.hostPid).toBe(2);
    });

    it('preserves path from current metadata when attaching to an existing session', () => {
        const nowMs = 1;
        const merged = mergeSessionMetadataForStartup({
            current: { path: '/workspace/real' } as any,
            next: { path: '/workspace/wrong', hostPid: 2 } as any,
            nowMs,
            mode: 'attach',
        });

        expect(merged.path).toBe('/workspace/real');
        expect(merged.hostPid).toBe(2);
    });

    it('does not seed permissionMode from next metadata when attaching', () => {
        const nowMs = 50;
        const merged = mergeSessionMetadataForStartup({
            current: {} as any,
            next: { permissionMode: 'default', permissionModeUpdatedAt: 123 } as any,
            nowMs,
            mode: 'attach',
        });

        expect((merged as any).permissionMode).toBeUndefined();
        expect((merged as any).permissionModeUpdatedAt).toBeUndefined();
    });

    it('does not stamp permissionModeUpdatedAt when attaching and it is missing', () => {
        const nowMs = 50;
        const merged = mergeSessionMetadataForStartup({
            current: { permissionMode: 'safe-yolo' } as any,
            next: { hostPid: 1 } as any,
            nowMs,
            mode: 'attach',
        });

        expect(merged.permissionMode).toBe('safe-yolo');
        expect((merged as any).permissionModeUpdatedAt).toBeUndefined();
    });

    it('preserves permissionMode when no override is provided', () => {
        const nowMs = 50;
        const merged = mergeSessionMetadataForStartup({
            current: { permissionMode: 'ask', permissionModeUpdatedAt: 10 } as any,
            next: { permissionMode: 'default', permissionModeUpdatedAt: 20 } as any,
            nowMs,
        });

        expect(merged.permissionMode).toBe('ask');
        expect(merged.permissionModeUpdatedAt).toBe(10);
    });

    it('applies explicit permissionMode override when it is newer than existing metadata', () => {
        const nowMs = 50;
        const merged = mergeSessionMetadataForStartup({
            current: { permissionMode: 'ask', permissionModeUpdatedAt: 10 } as any,
            next: { permissionMode: 'default', permissionModeUpdatedAt: 20 } as any,
            nowMs,
            permissionModeOverride: { mode: 'default', updatedAt: 25 },
        });

        expect(merged.permissionMode).toBe('default');
        expect(merged.permissionModeUpdatedAt).toBe(25);
    });

    it('applies explicit permissionMode override even when there is no baseline mode', () => {
        const nowMs = 50;
        const merged = mergeSessionMetadataForStartup({
            current: {} as any,
            next: {} as any,
            nowMs,
            permissionModeOverride: { mode: 'default', updatedAt: 25 },
        });

        expect(merged.permissionMode).toBe('default');
        expect(merged.permissionModeUpdatedAt).toBe(25);
    });

    it('ensures permissionModeUpdatedAt is monotonic when an override is provided with an older timestamp', () => {
        const nowMs = 50;
        const merged = mergeSessionMetadataForStartup({
            current: { permissionMode: 'ask', permissionModeUpdatedAt: 100 } as any,
            next: {} as any,
            nowMs,
            permissionModeOverride: { mode: 'default', updatedAt: 1 },
        });

        expect(merged.permissionMode).toBe('default');
        expect(merged.permissionModeUpdatedAt).toBe(101);
    });

    it('does not seed acpSessionModeOverrideV1 from next metadata when attaching', () => {
        const nowMs = 50;
        const merged = mergeSessionMetadataForStartup({
            current: {} as any,
            next: { acpSessionModeOverrideV1: { v: 1, updatedAt: 123, modeId: 'plan' } } as any,
            nowMs,
            mode: 'attach',
        });

        expect((merged as any).acpSessionModeOverrideV1).toBeUndefined();
    });

    it('applies an explicit ACP session mode override with a monotonic updatedAt', () => {
        const nowMs = 50;
        const merged = mergeSessionMetadataForStartup({
            current: { acpSessionModeOverrideV1: { v: 1, updatedAt: 100, modeId: 'build' } } as any,
            next: {} as any,
            nowMs,
            // This will be plumbed as an explicit override from CLI/UI on startup.
            acpSessionModeOverride: { modeId: 'plan', updatedAt: 1 } as any,
        } as any);

        expect((merged as any).acpSessionModeOverrideV1).toEqual({ v: 1, updatedAt: 101, modeId: 'plan' });
    });

    it('does not seed modelOverrideV1 from next metadata when attaching', () => {
        const nowMs = 50;
        const merged = mergeSessionMetadataForStartup({
            current: {} as any,
            next: { modelOverrideV1: { v: 1, updatedAt: 123, modelId: 'gpt-5-codex-high' } } as any,
            nowMs,
            mode: 'attach',
        } as any);

        expect((merged as any).modelOverrideV1).toBeUndefined();
    });

    it('applies an explicit model override with a monotonic updatedAt', () => {
        const nowMs = 50;
        const merged = mergeSessionMetadataForStartup({
            current: { modelOverrideV1: { v: 1, updatedAt: 100, modelId: 'gpt-5-codex-low' } } as any,
            next: {} as any,
            nowMs,
            modelOverride: { modelId: 'gpt-5-codex-high', updatedAt: 1 } as any,
        } as any);

        expect((merged as any).modelOverrideV1).toEqual({ v: 1, updatedAt: 101, modelId: 'gpt-5-codex-high' });
    });
});
