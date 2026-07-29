import { describe, expect, it, vi } from 'vitest';

import type { PluginInvocationContext } from '@happier-dev/plugin-sdk';
import type { PluginRequestInterceptor } from '@happier-dev/plugin-sdk/runtime';

import type { ContributionRuntimeRegistration } from '@/plugins/runtime/api/registrationRightsHost';

import type { ActivationTarget } from '../activation/targets';
import { createTargetRequestInterceptorBindings } from './targetRequestInterceptors';

describe('target request interceptor bindings', () => {
    it('joins the exact qualified declaration and fences retirement before and after async completion', async () => {
        let active = true;
        let release: (() => void) | undefined;
        const started = new Promise<void>((resolveStarted) => {
            release = resolveStarted;
        });
        const receiver = { marker: 'receiver' };
        const handler = vi.fn(async function (this: unknown) {
            expect(this).toBe(receiver);
            await started;
            return { decision: 'continue' as const, request: { url: 'https://api.example.test', method: 'GET' as const, headers: {} } };
        }) as unknown as PluginRequestInterceptor;
        const registration: ContributionRuntimeRegistration = {
            family: 'requestInterceptors',
            localId: 'policy',
            value: handler,
        };
        const target = {
            pluginId: 'acme.policy',
            manifest: {
                version: '1.2.3',
                contributes: {
                    requestInterceptors: [{ id: 'policy', origins: ['https://api.example.test'] }],
                },
            },
        } as unknown as ActivationTarget;
        const [binding] = createTargetRequestInterceptorBindings({
            generation: 4,
            activationTargets: [target],
            targetRegistrations: [{ pluginId: 'acme.policy', generation: '4', registration }],
            isGenerationActive: () => active,
        });
        const request = { url: 'https://api.example.test', method: 'GET' as const, headers: {} };
        const context = {} as PluginInvocationContext;
        const pending = Reflect.apply(binding!.handler, receiver, [request, context]);
        active = false;
        release?.();

        await expect(pending).rejects.toThrow(/retired during invocation/);
        expect(() => binding!.handler(request, context)).toThrow(/no longer active/);
    });

    it('revalidates generation after an asynchronously rejected handler completes', async () => {
        let active = true;
        let rejectHandler: ((error: Error) => void) | undefined;
        const handler = (() => new Promise<never>((_resolve, reject) => {
            rejectHandler = reject;
        })) as PluginRequestInterceptor;
        const target = {
            pluginId: 'acme.policy',
            manifest: {
                version: '1.2.3',
                contributes: {
                    requestInterceptors: [{ id: 'policy', origins: ['https://api.example.test'] }],
                },
            },
        } as unknown as ActivationTarget;
        const [binding] = createTargetRequestInterceptorBindings({
            generation: 4,
            activationTargets: [target],
            targetRegistrations: [{
                pluginId: 'acme.policy',
                generation: '4',
                registration: { family: 'requestInterceptors', localId: 'policy', value: handler },
            }],
            isGenerationActive: () => active,
        });
        const pending = binding!.handler(
            { url: 'https://api.example.test', method: 'GET', headers: {} },
            {} as PluginInvocationContext,
        );
        active = false;
        rejectHandler?.(new Error('secret provider detail'));

        await expect(pending).rejects.toThrow(/retired during invocation/);
    });
});
