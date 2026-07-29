import { describe, expect, it, vi } from 'vitest';

import type { PluginApi } from '@happier-dev/plugin-sdk';

import type { ContributionRuntimeRegistration } from '@/plugins/runtime/api/registrationRightsHost';

import type { ActivationTarget } from '../activation/targets';
import { createTargetScmRuntimeEntries } from './targetScm';

type PluginScmHostingProviderRuntime = Parameters<
    PluginApi['scm']['registerHostingProvider']
>[1];

describe('target SCM runtime generation fencing', () => {
    it('does not enter plugin code when an SCM operation is already aborted', () => {
        const handler = vi.fn(() => Object.freeze({ success: false as const, error: 'unexpected' }));
        const target = {
            pluginId: 'acme.abort-backend',
            manifest: {
                contributes: {
                    scmBackends: [{ id: 'abortable' }],
                    scmHostingProviders: [],
                },
            },
        } as unknown as ActivationTarget;
        const entries = createTargetScmRuntimeEntries({
            generation: 8,
            activationTargets: [target],
            targetRegistrations: [{
                pluginId: 'acme.abort-backend',
                generation: '8',
                registration: {
                    family: 'scmBackends',
                    localId: 'abortable',
                    value: { handlers: { read: { statusSnapshot: handler } } },
                },
            }],
            isGenerationActive: () => true,
        });
        const statusSnapshot = entries.backends[0]?.registration.handlers.read?.statusSnapshot;
        const controller = new AbortController();
        controller.abort();

        expect(() => statusSnapshot?.({ signal: controller.signal } as never)).toThrow(/aborted/i);
        expect(handler).not.toHaveBeenCalled();
    });

    it('fails closed when the owning generation retires while an asynchronous handler is pending', async () => {
        let active = true;
        const statusResult = Object.freeze({ success: false as const, error: 'settled' });
        let settle: ((value: typeof statusResult) => void) | undefined;
        const target = {
            pluginId: 'acme.pending-backend',
            manifest: {
                contributes: {
                    scmBackends: [{ id: 'pending' }],
                    scmHostingProviders: [],
                },
            },
        } as unknown as ActivationTarget;
        const registration: ContributionRuntimeRegistration = {
            family: 'scmBackends',
            localId: 'pending',
            value: {
                handlers: {
                    read: {
                        statusSnapshot: () => new Promise<typeof statusResult>((resolve) => {
                            settle = resolve;
                        }),
                    },
                },
            },
        };

        const entries = createTargetScmRuntimeEntries({
            generation: 7,
            activationTargets: [target],
            targetRegistrations: [{
                pluginId: 'acme.pending-backend',
                generation: '7',
                registration,
            }],
            isGenerationActive: () => active,
        });
        const statusSnapshot = entries.backends[0]?.registration.handlers.read?.statusSnapshot;
        if (!statusSnapshot) throw new Error('Expected guarded status handler');

        const pending = Promise.resolve(statusSnapshot({} as never));
        active = false;
        settle?.(statusResult);

        await expect(pending).rejects.toThrow(/no longer active/);
    });

    it('assimilates a runtime thenable through one stable then lookup', async () => {
        let active = true;
        let thenReads = 0;
        const statusResult = Object.freeze({ success: false as const, error: 'settled' });
        const settledPromise = Promise.resolve(statusResult);
        const thenable = new Proxy(settledPromise, {
            get(target, property, receiver) {
                if (property !== 'then') return Reflect.get(target, property, receiver);
                thenReads += 1;
                return thenReads === 1
                    ? target.then.bind(target)
                    : undefined;
            },
        });
        const target = {
            pluginId: 'acme.thenable-backend',
            manifest: {
                contributes: {
                    scmBackends: [{ id: 'thenable' }],
                    scmHostingProviders: [],
                },
            },
        } as unknown as ActivationTarget;
        const registration: ContributionRuntimeRegistration = {
            family: 'scmBackends',
            localId: 'thenable',
            value: {
                handlers: {
                    read: {
                        statusSnapshot: () => thenable,
                    },
                },
            },
        };

        const entries = createTargetScmRuntimeEntries({
            generation: 6,
            activationTargets: [target],
            targetRegistrations: [{
                pluginId: 'acme.thenable-backend',
                generation: '6',
                registration,
            }],
            isGenerationActive: () => active,
        });
        const statusSnapshot = entries.backends[0]?.registration.handlers.read?.statusSnapshot;
        if (!statusSnapshot) throw new Error('Expected guarded status handler');

        await expect(Promise.resolve(statusSnapshot({} as never))).resolves.toBe(statusResult);
        expect(thenReads).toBe(1);
        active = false;
    });

    it('fences accessor-returned runtime functions after the generation retires', () => {
        let active = true;
        let observedReceiver: unknown;
        const detectRemote = vi.fn(function (this: unknown) {
            observedReceiver = this;
            return null;
        });
        const adapter: Record<string, unknown> = {};
        Object.defineProperty(adapter, 'detectRemote', {
            enumerable: true,
            get: () => detectRemote,
        });
        const runtime = {
            adapter,
        } as PluginScmHostingProviderRuntime;
        const target = {
            pluginId: 'acme.hosting',
            manifest: {
                contributes: {
                    scmBackends: [],
                    scmHostingProviders: [{ id: 'forge' }],
                },
            },
        } as unknown as ActivationTarget;
        const registration: ContributionRuntimeRegistration = {
            family: 'scmHostingProviders',
            localId: 'forge',
            value: runtime,
        };

        const entries = createTargetScmRuntimeEntries({
            generation: 4,
            activationTargets: [target],
            targetRegistrations: [{
                pluginId: 'acme.hosting',
                generation: '4',
                registration,
            }],
            isGenerationActive: () => active,
        });
        const retainedDetectRemote = entries.hostingProviders[0]?.registration.adapter.detectRemote;
        expect(retainedDetectRemote).toBeTypeOf('function');
        expect(retainedDetectRemote?.({ remoteName: null, remoteUrl: 'https://example.test/acme/repo' })).toBeNull();
        expect(observedReceiver).toBe(adapter);

        active = false;

        expect(() => retainedDetectRemote?.({
            remoteName: null,
            remoteUrl: 'https://example.test/acme/repo',
        })).toThrow(/no longer active/);
    });

    it('fences prototype runtime methods after the generation retires', () => {
        let active = true;
        class Adapter {
            [key: string]: unknown;

            detectRemote(_input: Readonly<{ remoteName: string | null; remoteUrl: string }>): null {
                return null;
            }
        }
        const target = {
            pluginId: 'acme.class-hosting',
            manifest: {
                contributes: {
                    scmBackends: [],
                    scmHostingProviders: [{ id: 'class-forge' }],
                },
            },
        } as unknown as ActivationTarget;
        const runtime: PluginScmHostingProviderRuntime = { adapter: new Adapter() };
        const registration: ContributionRuntimeRegistration = {
            family: 'scmHostingProviders',
            localId: 'class-forge',
            value: runtime,
        };

        const entries = createTargetScmRuntimeEntries({
            generation: 5,
            activationTargets: [target],
            targetRegistrations: [{
                pluginId: 'acme.class-hosting',
                generation: '5',
                registration,
            }],
            isGenerationActive: () => active,
        });
        const retainedDetectRemote = entries.hostingProviders[0]?.registration.adapter.detectRemote;
        expect(retainedDetectRemote?.({ remoteName: null, remoteUrl: 'https://example.test/acme/repo' })).toBeNull();

        active = false;

        expect(() => retainedDetectRemote?.({
            remoteName: null,
            remoteUrl: 'https://example.test/acme/repo',
        })).toThrow(/no longer active/);
    });
});
