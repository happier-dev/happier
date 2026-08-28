import { describe, expect, it, vi } from 'vitest';

import type { ActivationTarget } from '../activation/targets';
import type { ContributionRuntimeRegistration } from '../../api/registrationRightsHost';
import { createTargetAgentRuntimeRegistry } from './targetAgents';

function target(): ActivationTarget {
    // Boundary fixture: targetAgents consumes only the admitted target identity and version.
    return {
        provenance: 'external',
        source: { kind: 'path' },
        pluginId: 'acme.spawn-hooks',
        manifestPath: '/plugins/acme.spawn-hooks/.happier-plugin/plugin.json',
        daemonEntryPath: '/plugins/acme.spawn-hooks/daemon.mjs',
        devDaemonEntryPath: null,
        sourceSpec: {
            kind: 'path',
            locator: '/plugins/acme.spawn-hooks',
            trustPolicy: 'local_trusted',
            installPolicy: 'link',
        },
        manifest: { version: '1.0.0' },
    } as unknown as ActivationTarget;
}

function registration(daemonSpawnHooks: unknown): Readonly<{
    pluginId: string;
    generation: string;
    registration: ContributionRuntimeRegistration;
}> {
    return {
        pluginId: 'acme.spawn-hooks',
        generation: 'generation-7',
        registration: {
            family: 'agents',
            localId: 'spawn-agent',
            value: { daemonSpawnHooks },
        } as unknown as ContributionRuntimeRegistration,
    };
}

describe('Agent daemon spawn-hook lease', () => {
    it('binds an Agent spawn hook to its generation and aborts an in-flight call on retirement', async () => {
        const retirement = new AbortController();
        let current = true;
        const observed = { signal: undefined as AbortSignal | undefined };
        let entered: (() => void) | null = null;
        const enteredPromise = new Promise<void>((resolve) => {
            entered = resolve;
        });
        const resolveRuntimePrerequisites = vi.fn(async (selection: {
            tools?: Readonly<{ signal: AbortSignal }>;
        }) => {
            observed.signal = selection.tools?.signal;
            entered?.();
            await new Promise<void>((resolve) => {
                observed.signal?.addEventListener('abort', () => resolve(), { once: true });
            });
            return { ok: true as const };
        });
        const registry = createTargetAgentRuntimeRegistry({
            agents: [{
                id: 'spawn-agent',
                identity: { pluginId: 'acme.spawn-hooks', localId: 'spawn-agent' },
                pluginId: 'acme.spawn-hooks',
            }],
            activationTargets: [target()],
            targetRegistrations: [registration({ resolveRuntimePrerequisites })],
            isGenerationActive: () => current,
            retirementSignal: retirement.signal,
            onDuplicate: vi.fn(),
        });
        const daemonSpawnHooks = (registry.get('spawn-agent') as unknown as {
            daemonSpawnHooks?: Readonly<{
                resolveRuntimePrerequisites?: (selection: unknown) => Promise<unknown>;
            }>;
        } | undefined)?.daemonSpawnHooks;

        expect(daemonSpawnHooks?.resolveRuntimePrerequisites).toBeTypeOf('function');
        const caller = new AbortController();
        const pending = daemonSpawnHooks!.resolveRuntimePrerequisites!({
            cwd: '/workspace',
            tools: { signal: caller.signal },
        });
        await enteredPromise;
        current = false;
        retirement.abort(new Error('retired'));

        await expect(pending).resolves.toEqual({
            ok: false,
            reasonCode: 'plugin_generation_stale',
            errorMessage: 'Agent daemon spawn hook is unavailable because its plugin generation is no longer current.',
        });
        expect(observed.signal).not.toBe(caller.signal);
        expect(observed.signal?.aborted).toBe(true);
        expect(resolveRuntimePrerequisites).toHaveBeenCalledTimes(1);
    });

    it('fails closed when environment augmentation throws instead of silently dropping the required environment', async () => {
        const registry = createTargetAgentRuntimeRegistry({
            agents: [{ id: 'spawn-agent', pluginId: 'acme.spawn-hooks' }],
            activationTargets: [target()],
            targetRegistrations: [registration({
                resolveRuntimePrerequisites: async () => {
                    throw new Error('plugin-private failure');
                },
                augmentEnv: () => {
                    throw new Error('plugin-private failure');
                },
            })],
            isGenerationActive: () => true,
            retirementSignal: new AbortController().signal,
            onDuplicate: vi.fn(),
        });
        const daemonSpawnHooks = (registry.get('spawn-agent') as unknown as {
            daemonSpawnHooks?: Readonly<{
                resolveRuntimePrerequisites?: (selection: unknown) => Promise<unknown>;
                augmentEnv?: (selection: unknown) => Record<string, string>;
            }>;
        } | undefined)?.daemonSpawnHooks;

        expect(daemonSpawnHooks?.resolveRuntimePrerequisites).toBeTypeOf('function');
        expect(daemonSpawnHooks?.augmentEnv).toBeTypeOf('function');
        if (!daemonSpawnHooks?.resolveRuntimePrerequisites || !daemonSpawnHooks.augmentEnv) {
            return;
        }
        await expect(daemonSpawnHooks.resolveRuntimePrerequisites({})).resolves.toEqual({
            ok: false,
            reasonCode: 'plugin_spawn_hook_failed',
            errorMessage: 'Agent daemon spawn prerequisite hook failed.',
        });
        expect(() => daemonSpawnHooks.augmentEnv({})).toThrow(
            'Agent daemon spawn environment hook failed.',
        );
    });

    it('fails closed when environment augmentation returns a non-string value', () => {
        const registry = createTargetAgentRuntimeRegistry({
            agents: [{ id: 'spawn-agent', pluginId: 'acme.spawn-hooks' }],
            activationTargets: [target()],
            targetRegistrations: [registration({
                augmentEnv: () => ({ REQUIRED_ENV: 42 }),
            })],
            isGenerationActive: () => true,
            retirementSignal: new AbortController().signal,
            onDuplicate: vi.fn(),
        });
        const augmentEnv = (registry.get('spawn-agent') as unknown as {
            daemonSpawnHooks?: Readonly<{
                augmentEnv?: (selection: unknown) => Record<string, string>;
            }>;
        } | undefined)?.daemonSpawnHooks?.augmentEnv;

        expect(augmentEnv).toBeTypeOf('function');
        expect(() => augmentEnv?.({})).toThrow(
            'Agent daemon spawn environment hook returned an invalid environment.',
        );
    });

    it('returns the typed cancellation result when the spawn caller aborts', async () => {
        const observed = { signal: undefined as AbortSignal | undefined };
        let entered: (() => void) | null = null;
        const enteredPromise = new Promise<void>((resolve) => {
            entered = resolve;
        });
        const resolveRuntimePrerequisites = vi.fn(async (selection: {
            tools?: Readonly<{ signal: AbortSignal }>;
        }) => {
            observed.signal = selection.tools?.signal;
            entered?.();
            await new Promise<void>((resolve) => {
                observed.signal?.addEventListener('abort', () => resolve(), { once: true });
            });
            return { ok: true as const };
        });
        const registry = createTargetAgentRuntimeRegistry({
            agents: [{ id: 'spawn-agent', pluginId: 'acme.spawn-hooks' }],
            activationTargets: [target()],
            targetRegistrations: [registration({ resolveRuntimePrerequisites })],
            isGenerationActive: () => true,
            retirementSignal: new AbortController().signal,
            onDuplicate: vi.fn(),
        });
        const daemonSpawnHooks = (registry.get('spawn-agent') as unknown as {
            daemonSpawnHooks?: Readonly<{
                resolveRuntimePrerequisites?: (selection: unknown) => Promise<unknown>;
            }>;
        } | undefined)?.daemonSpawnHooks;
        const caller = new AbortController();
        const pending = daemonSpawnHooks!.resolveRuntimePrerequisites!({
            tools: { signal: caller.signal },
        });
        await enteredPromise;
        caller.abort(new Error('caller cancelled'));

        await expect(pending).resolves.toEqual({
            ok: false,
            reasonCode: 'plugin_spawn_hook_aborted',
            errorMessage: 'Agent daemon spawn prerequisite hook was cancelled.',
        });
        expect(observed.signal).not.toBe(caller.signal);
        expect(observed.signal?.aborted).toBe(true);
        expect(resolveRuntimePrerequisites).toHaveBeenCalledTimes(1);
    });
});
