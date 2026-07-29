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

    it('uses runtime machine identity fields when attaching with runtime identity replacement', () => {
        const nowMs = 1;
        const merged = mergeSessionMetadataForStartup({
            current: {
                path: '/workspace/source',
                host: 'source-host',
                homeDir: '/Users/source',
                happyHomeDir: '/Users/source/.happier',
                machineId: 'machine-source',
            } as any,
            next: {
                path: '/workspace/target',
                host: 'target-host',
                homeDir: '/Users/target',
                happyHomeDir: '/Users/target/.happier',
                machineId: 'machine-target',
                hostPid: 2,
            } as any,
            nowMs,
            mode: 'attach',
            attachMetadataIdentityPolicy: 'replace_with_runtime_identity',
        });

        expect(merged.path).toBe('/workspace/target');
        expect(merged.host).toBe('target-host');
        expect(merged.homeDir).toBe('/Users/target');
        expect(merged.happyHomeDir).toBe('/Users/target/.happier');
        expect(merged.machineId).toBe('machine-target');
        expect(merged.hostPid).toBe(2);
    });

    it('drops workspace identity fields from metadata when attaching', () => {
        const nowMs = 1;
        const merged = mergeSessionMetadataForStartup({
            current: {
                workspaceId: 'ws_authoritative',
                workspaceLocationId: 'loc_authoritative',
                workspaceCheckoutId: 'checkout_authoritative',
            } as any,
            next: {
                workspaceId: 'ws_wrong',
                workspaceLocationId: 'loc_wrong',
                workspaceCheckoutId: 'checkout_wrong',
                hostPid: 2,
            } as any,
            nowMs,
            mode: 'attach',
        });

        expect((merged as Record<string, unknown>).workspaceId).toBeUndefined();
        expect((merged as Record<string, unknown>).workspaceLocationId).toBeUndefined();
        expect((merged as Record<string, unknown>).workspaceCheckoutId).toBeUndefined();
        expect(merged.hostPid).toBe(2);
    });

    it('does not seed workspace identity from next metadata when attaching', () => {
        const nowMs = 1;
        const merged = mergeSessionMetadataForStartup({
            current: {} as any,
            next: {
                workspaceId: 'ws_wrong',
                workspaceLocationId: 'loc_wrong',
                workspaceCheckoutId: 'checkout_wrong',
            } as any,
            nowMs,
            mode: 'attach',
        });

        expect((merged as Record<string, unknown>).workspaceId).toBeUndefined();
        expect((merged as Record<string, unknown>).workspaceLocationId).toBeUndefined();
        expect((merged as Record<string, unknown>).workspaceCheckoutId).toBeUndefined();
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

    it('preserves permissionMode intent when no override is provided', () => {
        const nowMs = 50;
        const merged = mergeSessionMetadataForStartup({
            current: { permissionMode: 'ask', permissionModeUpdatedAt: 10 } as any,
            next: { permissionMode: 'default', permissionModeUpdatedAt: 20 } as any,
            nowMs,
        });

        expect(merged.permissionMode).toBe('default');
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
            current: { permissionMode: 'read-only', permissionModeUpdatedAt: 100 } as any,
            next: {} as any,
            nowMs,
            permissionModeOverride: { mode: 'default', updatedAt: 1 },
        });

        expect(merged.permissionMode).toBe('default');
        expect(merged.permissionModeUpdatedAt).toBe(101);
    });

    it('does not seed canonical session-mode override metadata from next metadata when attaching', () => {
        const nowMs = 50;
        const merged = mergeSessionMetadataForStartup({
            current: {} as any,
            next: { sessionModeOverrideV1: { v: 1, updatedAt: 123, modeId: 'plan' } } as any,
            nowMs,
            mode: 'attach',
        });

        expect((merged as any).sessionModeOverrideV1).toBeUndefined();
        expect((merged as any).acpSessionModeOverrideV1).toBeUndefined();
    });

    it('preserves legacy-only session-mode override metadata when attaching', () => {
        const merged = mergeSessionMetadataForStartup({
            current: { acpSessionModeOverrideV1: { v: 1, updatedAt: 77, modeId: 'plan' } } as any,
            next: { hostPid: 2 } as any,
            nowMs: 50,
            mode: 'attach',
        });

        expect((merged as any).sessionModeOverrideV1).toEqual({ v: 1, updatedAt: 77, modeId: 'plan' });
        expect((merged as any).acpSessionModeOverrideV1).toEqual({ v: 1, updatedAt: 77, modeId: 'plan' });
    });

    it('uses the newest session-mode override alias during startup merge', () => {
        const merged = mergeSessionMetadataForStartup({
            current: {
                sessionModeOverrideV1: { v: 1, updatedAt: 100, modeId: 'build' },
                acpSessionModeOverrideV1: { v: 1, updatedAt: 200, modeId: 'plan' },
            } as any,
            next: {} as any,
            nowMs: 50,
        });

        expect((merged as any).sessionModeOverrideV1).toEqual({ v: 1, updatedAt: 200, modeId: 'plan' });
        expect((merged as any).acpSessionModeOverrideV1).toEqual({ v: 1, updatedAt: 200, modeId: 'plan' });
    });

    it('applies an explicit canonical session mode override with a monotonic updatedAt', () => {
        const nowMs = 50;
        const merged = mergeSessionMetadataForStartup({
            current: { sessionModeOverrideV1: { v: 1, updatedAt: 100, modeId: 'build' } } as any,
            next: {} as any,
            nowMs,
            // This will be plumbed as an explicit override from CLI/UI on startup.
            sessionModeOverride: { modeId: 'plan', updatedAt: 1 },
        });

        expect((merged as any).sessionModeOverrideV1).toEqual({ v: 1, updatedAt: 101, modeId: 'plan' });
        expect((merged as any).acpSessionModeOverrideV1).toEqual({ v: 1, updatedAt: 101, modeId: 'plan' });
    });

    it('preserves a newer session-mode clear tombstone instead of resurrecting next metadata', () => {
        const merged = mergeSessionMetadataForStartup({
            current: {
                sessionModeOverrideV1: { v: 1, updatedAt: 200, modeId: null },
            } as any,
            next: {
                sessionModeOverrideV1: { v: 1, updatedAt: 100, modeId: 'plan' },
            } as any,
            nowMs: 50,
        });

        expect((merged as any).sessionModeOverrideV1).toEqual({ v: 1, updatedAt: 200, modeId: null });
        expect((merged as any).acpSessionModeOverrideV1).toEqual({ v: 1, updatedAt: 200, modeId: null });
    });

    it('does not seed model selection from next metadata when attaching', () => {
        const nowMs = 50;
        const merged = mergeSessionMetadataForStartup({
            current: {} as any,
            next: { flavor: 'codex', modelOverrideV1: { v: 1, updatedAt: 123, modelId: 'gpt-5-codex-high' } } as any,
            nowMs,
            mode: 'attach',
        } as any);

        expect((merged as any).modelOverrideV1).toBeUndefined();
        expect((merged as any).modelSelectionIntentV1).toBeUndefined();
    });

    it('applies an explicit provider-bound model selection with a monotonic updatedAt', () => {
        const nowMs = 50;
        const merged = mergeSessionMetadataForStartup({
            current: { flavor: 'codex', modelOverrideV1: { v: 1, updatedAt: 100, modelId: 'gpt-5-codex-low' } } as any,
            next: { flavor: 'codex' } as any,
            nowMs,
            modelOverride: {
                v: 1,
                updatedAt: 1,
                selection: {
                    agentTargetKey: 'backend:codex',
                    providerConnectionId: 'pc_work',
                    modelId: 'gpt-5-codex-high',
                },
            } as any,
        } as any);

        expect((merged as any).modelSelectionIntentV1).toEqual({
            v: 1,
            updatedAt: 101,
            selection: {
                agentTargetKey: 'backend:codex',
                providerConnectionId: 'pc_work',
                modelId: 'gpt-5-codex-high',
            },
        });
        expect((merged as any).modelOverrideV1).toBeUndefined();
    });

    it('preserves a newer model clear tombstone instead of resurrecting next metadata', () => {
        const merged = mergeSessionMetadataForStartup({
            current: { flavor: 'codex', modelOverrideV1: { v: 1, updatedAt: 200, modelId: null } } as any,
            next: { flavor: 'codex', modelOverrideV1: { v: 1, updatedAt: 100, modelId: 'gpt-5-codex-high' } } as any,
            nowMs: 50,
        });

        expect((merged as any).modelSelectionIntentV1).toEqual({ v: 1, updatedAt: 200, selection: null });
        expect((merged as any).modelOverrideV1).toEqual({ v: 1, updatedAt: 200, modelId: 'default' });
    });

    it('merges ACP config option overrides per entry through the session-state timestamp policy', () => {
        const merged = mergeSessionMetadataForStartup({
            current: {
                sessionConfigOptionOverridesV1: {
                    v: 1,
                    updatedAt: 100,
                    overrides: {
                        telemetry: { updatedAt: 100, value: true },
                    },
                },
                acpConfigOptionOverridesV1: {
                    v: 1,
                    updatedAt: 100,
                    overrides: {
                        telemetry: { updatedAt: 100, value: true },
                    },
                },
            } as any,
            next: {
                sessionConfigOptionOverridesV1: {
                    v: 1,
                    updatedAt: 20,
                    overrides: {
                        telemetry: { updatedAt: 10, value: false },
                        reasoning: { updatedAt: 20, value: 'high' },
                    },
                },
            } as any,
            nowMs: 50,
        } as any);

        expect((merged as any).sessionConfigOptionOverridesV1).toEqual({
            v: 1,
            updatedAt: 100,
            overrides: {
                telemetry: { updatedAt: 100, value: true },
                reasoning: { updatedAt: 20, value: 'high' },
            },
        });
        expect((merged as any).acpConfigOptionOverridesV1).toEqual((merged as any).sessionConfigOptionOverridesV1);
    });

    it('uses the newest ACP config option override entry across canonical and legacy aliases', () => {
        const merged = mergeSessionMetadataForStartup({
            current: {
                sessionConfigOptionOverridesV1: {
                    v: 1,
                    updatedAt: 10,
                    overrides: {
                        effort: { updatedAt: 10, value: 'medium' },
                    },
                },
                acpConfigOptionOverridesV1: {
                    v: 1,
                    updatedAt: 30,
                    overrides: {
                        effort: { updatedAt: 30, value: 'high' },
                    },
                },
            } as any,
            next: {
                sessionConfigOptionOverridesV1: {
                    v: 1,
                    updatedAt: 20,
                    overrides: {
                        effort: { updatedAt: 20, value: 'low' },
                        speed: { updatedAt: 20, value: 'fast' },
                    },
                },
            } as any,
            nowMs: 50,
        } as any);

        expect((merged as any).sessionConfigOptionOverridesV1).toEqual({
            v: 1,
            updatedAt: 30,
            overrides: {
                effort: { updatedAt: 30, value: 'high' },
                speed: { updatedAt: 20, value: 'fast' },
            },
        });
        expect((merged as any).acpConfigOptionOverridesV1).toEqual((merged as any).sessionConfigOptionOverridesV1);
    });

    it('preserves config option entries that exist only in one alias root during startup merge', () => {
        const merged = mergeSessionMetadataForStartup({
            current: {
                sessionConfigOptionOverridesV1: {
                    v: 1,
                    updatedAt: 10,
                    overrides: {
                        effort: { updatedAt: 10, value: 'medium' },
                    },
                },
                acpConfigOptionOverridesV1: {
                    v: 1,
                    updatedAt: 20,
                    overrides: {
                        speed: { updatedAt: 20, value: 'fast' },
                    },
                },
            } as any,
            next: {} as any,
            nowMs: 50,
        } as any);

        expect((merged as any).sessionConfigOptionOverridesV1).toEqual({
            v: 1,
            updatedAt: 20,
            overrides: {
                effort: { updatedAt: 10, value: 'medium' },
                speed: { updatedAt: 20, value: 'fast' },
            },
        });
        expect((merged as any).acpConfigOptionOverridesV1).toEqual((merged as any).sessionConfigOptionOverridesV1);
    });

    it('keeps canonical config option entries when aliases tie during startup merge', () => {
        const merged = mergeSessionMetadataForStartup({
            current: {
                sessionConfigOptionOverridesV1: {
                    v: 1,
                    updatedAt: 20,
                    overrides: {
                        effort: { updatedAt: 20, value: 'canonical' },
                    },
                },
                acpConfigOptionOverridesV1: {
                    v: 1,
                    updatedAt: 20,
                    overrides: {
                        effort: { updatedAt: 20, value: 'legacy' },
                    },
                },
            } as any,
            next: {} as any,
            nowMs: 50,
        } as any);

        expect((merged as any).sessionConfigOptionOverridesV1).toEqual({
            v: 1,
            updatedAt: 20,
            overrides: {
                effort: { updatedAt: 20, value: 'canonical' },
            },
        });
        expect((merged as any).acpConfigOptionOverridesV1).toEqual((merged as any).sessionConfigOptionOverridesV1);
    });

    it('does not seed ACP config option overrides from next metadata when attaching', () => {
        const merged = mergeSessionMetadataForStartup({
            current: {} as any,
            next: {
                sessionConfigOptionOverridesV1: {
                    v: 1,
                    updatedAt: 20,
                    overrides: {
                        telemetry: { updatedAt: 20, value: true },
                    },
                },
            } as any,
            nowMs: 50,
            mode: 'attach',
        } as any);

        expect((merged as any).sessionConfigOptionOverridesV1).toBeUndefined();
        expect((merged as any).acpConfigOptionOverridesV1).toBeUndefined();
    });

    it('does not seed mcpSelectionV1 from next metadata when attaching', () => {
        const merged = mergeSessionMetadataForStartup({
            current: {} as any,
            next: {
                mcpSelectionV1: {
                    v: 1,
                    managedServersEnabled: false,
                    forceIncludeServerIds: ['server-a'],
                    forceExcludeServerIds: [],
                },
            } as any,
            nowMs: 50,
            mode: 'attach',
        } as any);

        expect((merged as any).mcpSelectionV1).toBeUndefined();
    });

    it('preserves existing mcpSelectionV1 when attaching', () => {
        const merged = mergeSessionMetadataForStartup({
            current: {
                mcpSelectionV1: {
                    v: 1,
                    managedServersEnabled: false,
                    forceIncludeServerIds: ['server-a'],
                    forceExcludeServerIds: ['server-b'],
                },
            } as any,
            next: {
                mcpSelectionV1: {
                    v: 1,
                    managedServersEnabled: true,
                    forceIncludeServerIds: [],
                    forceExcludeServerIds: [],
                },
            } as any,
            nowMs: 50,
            mode: 'attach',
        } as any);

        expect((merged as any).mcpSelectionV1).toEqual({
            v: 1,
            managedServersEnabled: false,
            forceIncludeServerIds: ['server-a'],
            forceExcludeServerIds: ['server-b'],
        });
    });

    it('can remove specific attach-only metadata keys during startup merge', () => {
        const merged = mergeSessionMetadataForStartup({
            current: {
                acpSessionModesV1: { v: 1, provider: 'codex' },
                acpSessionModelsV1: { v: 1, provider: 'codex' },
                acpConfigOptionsV1: { v: 1, provider: 'codex' },
                permissionMode: 'read-only',
            } as any,
            next: { hostPid: 42 } as any,
            nowMs: 50,
            mode: 'attach',
            metadataKeysToUnsetOnAttach: ['acpSessionModesV1', 'acpSessionModelsV1', 'acpConfigOptionsV1'],
        } as any);

        expect((merged as any).acpSessionModesV1).toBeUndefined();
        expect((merged as any).acpSessionModelsV1).toBeUndefined();
        expect((merged as any).acpConfigOptionsV1).toBeUndefined();
        expect(merged.permissionMode).toBe('read-only');
        expect((merged as any).hostPid).toBe(42);
    });
});
