import { describe, expect, it, vi } from 'vitest';

import type { PluginApi } from '@happier-dev/plugin-sdk';
import { createPluginRegistrationScope } from '@happier-dev/plugin-sdk/host/registration';

import type { ContributionRuntimeRegistration } from '@/plugins/runtime/api/registrationRightsHost';

import type { ActivationTarget } from '../activation/targets';
import { createTargetScmRuntimeEntries } from './targetScm';

type PluginScmHostingProviderRuntime = Parameters<
    PluginApi['scm']['registerHostingProvider']
>[1];
type PluginScmBackendRuntime = Parameters<PluginApi['scm']['registerBackend']>[1];

function captureHostingRegistration(
    pluginId: string,
    localId: string,
    runtime: PluginScmHostingProviderRuntime,
): Extract<ContributionRuntimeRegistration, { family: 'scmHostingProviders' }> {
    const scope = createPluginRegistrationScope({
        pluginId,
        target: { realm: 'daemon' },
        rights: [{
            family: 'scmHostingProviders',
            localId,
            target: { realm: 'daemon' },
        }],
    });
    scope.api.scm.registerHostingProvider(localId, runtime);
    const [registration] = scope.commit();
    if (registration?.family !== 'scmHostingProviders') {
        throw new Error('Expected committed SCM hosting registration');
    }
    return registration;
}

function captureBackendRegistration(
    pluginId: string,
    localId: string,
    runtime: PluginScmBackendRuntime,
): Extract<ContributionRuntimeRegistration, { family: 'scmBackends' }> {
    const scope = createPluginRegistrationScope({
        pluginId,
        target: { realm: 'daemon' },
        rights: [{
            family: 'scmBackends',
            localId,
            target: { realm: 'daemon' },
        }],
    });
    scope.api.scm.registerBackend(localId, runtime);
    const [registration] = scope.commit();
    if (registration?.family !== 'scmBackends') {
        throw new Error('Expected committed SCM backend registration');
    }
    return registration;
}

describe('target SCM runtime generation fencing', () => {
    it('does not enter captured SCM workspace callbacks when the nested operation signal is already aborted', () => {
        class WorkspaceHandlers {
            calls = 0;

            inspectWorkspaceLocation() {
                this.calls += 1;
                return { rootPath: 'captured' };
            }
        }

        const workspaceHandlers = new WorkspaceHandlers();
        const runtime = {
            handlers: {
                workspaceIntegration: workspaceHandlers,
            },
        } satisfies PluginScmBackendRuntime;
        const registration = captureBackendRegistration('acme.workspace', 'workspace', runtime);
        workspaceHandlers.inspectWorkspaceLocation = () => ({ rootPath: 'mutated' });
        const target = {
            pluginId: 'acme.workspace',
            manifest: {
                contributes: {
                    scmBackends: [{ id: 'workspace' }],
                    scmHostingProviders: [],
                },
            },
        } as unknown as ActivationTarget;
        const entries = createTargetScmRuntimeEntries({
            generation: 7,
            activationTargets: [target],
            targetRegistrations: [{
                pluginId: 'acme.workspace',
                generation: '7',
                registration,
            }],
            isGenerationActive: () => true,
        });
        const inspectWorkspaceLocation = entries.backends[0]?.registration.handlers.workspaceIntegration?.inspectWorkspaceLocation;

        expect(inspectWorkspaceLocation?.({ context: { signal: new AbortController().signal } } as never)).toEqual({ rootPath: 'captured' });
        expect(workspaceHandlers.calls).toBe(1);

        const aborted = new AbortController();
        aborted.abort();
        expect(() => inspectWorkspaceLocation?.({ context: { signal: aborted.signal } } as never)).toThrow(/aborted/i);
        expect(workspaceHandlers.calls).toBe(1);
    });

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

    it('preserves active rejections but fences rejections that settle after retirement', async () => {
        let active = true;
        let rejectPending: ((reason?: unknown) => void) | undefined;
        const target = {
            pluginId: 'acme.rejecting-backend',
            manifest: {
                contributes: {
                    scmBackends: [{ id: 'rejecting' }],
                    scmHostingProviders: [],
                },
            },
        } as unknown as ActivationTarget;
        const registration: ContributionRuntimeRegistration = {
            family: 'scmBackends',
            localId: 'rejecting',
            value: {
                handlers: {
                    read: {
                        statusSnapshot: () => new Promise<never>((_resolve, reject) => {
                            rejectPending = reject;
                        }),
                    },
                },
            },
        };

        const entries = createTargetScmRuntimeEntries({
            generation: 9,
            activationTargets: [target],
            targetRegistrations: [{
                pluginId: 'acme.rejecting-backend',
                generation: '9',
                registration,
            }],
            isGenerationActive: () => active,
        });
        const statusSnapshot = entries.backends[0]?.registration.handlers.read?.statusSnapshot;
        if (!statusSnapshot) throw new Error('Expected guarded status handler');

        const activeError = new Error('active rejection');
        const activeRejection = Promise.resolve(statusSnapshot({} as never));
        rejectPending?.(activeError);
        await expect(activeRejection).rejects.toBe(activeError);

        const retiredRejection = Promise.resolve(statusSnapshot({} as never));
        active = false;
        rejectPending?.(new Error('retired rejection'));

        await expect(retiredRejection).rejects.toThrow(/no longer active/);
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
        const registration = captureHostingRegistration('acme.hosting', 'forge', runtime);

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
        const registration = captureHostingRegistration(
            'acme.class-hosting',
            'class-forge',
            runtime,
        );

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

    it('reports the captured handler structure to enumeration exactly as property access resolves it', () => {
        let active = true;
        const detectRepo = vi.fn(() => null);
        const runtime = {
            handlers: {
                detection: { detectRepo },
            },
        } as unknown as PluginScmBackendRuntime;
        const registration = captureBackendRegistration('acme.structure', 'structure', runtime);
        const target = {
            pluginId: 'acme.structure',
            manifest: {
                contributes: {
                    scmBackends: [{ id: 'structure' }],
                    scmHostingProviders: [],
                },
            },
        } as unknown as ActivationTarget;

        const entries = createTargetScmRuntimeEntries({
            generation: 3,
            activationTargets: [target],
            targetRegistrations: [{
                pluginId: 'acme.structure',
                generation: '3',
                registration,
            }],
            isGenerationActive: () => active,
        });
        const handlers = entries.backends[0]?.registration.handlers;
        const detection = handlers?.detection;
        if (!handlers || !detection) throw new Error('Expected guarded SCM backend handlers');

        expect(Object.keys(handlers)).toEqual(['detection']);
        expect('detection' in handlers).toBe(true);
        expect(Object.keys({ ...handlers })).toEqual(['detection']);
        expect(Object.getOwnPropertyDescriptor(handlers, 'detection')?.enumerable).toBe(true);
        expect(Object.keys(detection)).toEqual(['detectRepo']);

        // Enumeration must hand back the fenced callable, never the captured original.
        const [enumeratedDetectRepo] = Object.values(detection);
        expect(enumeratedDetectRepo).toBe(detection.detectRepo);
        expect(enumeratedDetectRepo).not.toBe(detectRepo);

        active = false;

        expect(() => (enumeratedDetectRepo as () => unknown)()).toThrow(/no longer active/);
        expect(detectRepo).not.toHaveBeenCalled();
    });
});
