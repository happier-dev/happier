import { describe, expect, it, vi } from 'vitest';

import type { PluginSettingsContributionV2 } from '@happier-dev/protocol';

import { createStablePluginEventsBroker } from './events';
import {
    createStablePluginSettingsModel,
    createStablePluginSettingsOwner,
    type CanonicalPluginSettingsRecord,
    type StablePluginSettingsModel,
} from './settings';
import { createPluginSettingsActionInvoker } from './settingsActions';
import type { PluginInvocationServicesSeed } from './types';

const contribution: PluginSettingsContributionV2 = {
    id: 'preferences',
    version: 1,
    title: 'Preferences',
    target: { kind: 'plugin' },
    scope: 'daemon',
    fields: [{ id: 'endpoint', title: 'Endpoint', schema: { type: 'string', minLength: 4 } }],
    actions: [{
        id: 'discover',
        title: 'Discover endpoint',
        placement: { kind: 'afterField', fieldId: 'endpoint' },
        confirmation: {
            kind: 'required',
            title: 'Discover endpoint',
            description: 'Contact the provider and save the endpoint?',
            confirmLabel: 'Discover',
        },
        patchFieldIds: ['endpoint'],
    }],
    presentation: { sections: [], subagentSections: [] },
};

function seed(params: Readonly<{
    generation?: string;
    isGenerationCurrent?: () => boolean;
}> = {}): PluginInvocationServicesSeed {
    const controller = new AbortController();
    return {
        plugin: { id: 'acme.plugin', version: '1.0.0' },
        contribution: { id: 'preferences', qualifiedId: 'acme.plugin/settings/preferences' },
        generation: params.generation ?? 'generation-1',
        correlationId: 'correlation-1',
        surface: 'ui',
        signal: controller.signal,
        isGenerationCurrent: params.isGenerationCurrent ?? (() => true),
    };
}

describe('generic plugin settings actions', () => {
    it('requires a user gesture and confirmation before atomically applying the declared patch', async () => {
        let record: unknown | null = null;
        const owner = createStablePluginSettingsOwner({
            recordStore: {
                supports: () => true,
                read: async () => record,
                async update<T>(
                    _model: StablePluginSettingsModel,
                    operation: (current: unknown | null) => Readonly<{
                        record: CanonicalPluginSettingsRecord;
                        result: T;
                    }>,
                ): Promise<T> {
                    const next = operation(record);
                    record = next.record;
                    return next.result;
                },
            },
            broker: createStablePluginEventsBroker(),
        });
        const model = createStablePluginSettingsModel({ pluginId: 'acme.plugin', contribution });
        const confirm = vi.fn(async () => true);
        const execute = vi.fn(async () => ({ patch: { endpoint: 'https://discovered.example' } }));
        const invoker = createPluginSettingsActionInvoker({ owner, confirm, execute });

        await expect(invoker.invoke({
            declaration: contribution.actions![0]!,
            contributionId: contribution.id,
            model,
            seed: seed(),
            userGesture: false,
        })).rejects.toMatchObject({ code: 'plugin_settings_action_user_gesture_required' });
        expect(execute).not.toHaveBeenCalled();

        await expect(invoker.invoke({
            declaration: contribution.actions![0]!,
            contributionId: contribution.id,
            model,
            seed: seed(),
            userGesture: true,
            expectedRevision: '0',
            context: { credentialHandle: 'host-private' },
        })).resolves.toMatchObject({
            revision: '1',
            changedIds: ['endpoint'],
            values: { endpoint: 'https://discovered.example' },
        });
        expect(confirm).toHaveBeenCalledOnce();
        expect(execute).toHaveBeenCalledWith(
            expect.objectContaining({
                actionId: 'discover',
                settings: {},
            }),
            { credentialHandle: 'host-private' },
            expect.objectContaining({ signal: expect.any(AbortSignal) }),
        );
        expect(record).toMatchObject({
            revision: 1,
            values: { endpoint: 'https://discovered.example' },
        });
    });

    it('admits only one invocation for the same contribution action at a time', async () => {
        let release!: () => void;
        const pending = new Promise<void>((resolve) => { release = resolve; });
        const owner = createStablePluginSettingsOwner({
            recordStore: {
                supports: () => true,
                read: async () => null,
                async update<T>(
                    _model: StablePluginSettingsModel,
                    operation: (current: unknown | null) => Readonly<{
                        record: CanonicalPluginSettingsRecord;
                        result: T;
                    }>,
                ): Promise<T> {
                    return operation(null).result;
                },
            },
            broker: createStablePluginEventsBroker(),
        });
        const model = createStablePluginSettingsModel({ pluginId: 'acme.plugin', contribution });
        const invoker = createPluginSettingsActionInvoker({
            owner,
            confirm: async () => true,
            execute: async () => {
                await pending;
                return { patch: { endpoint: 'https://discovered.example' } };
            },
        });
        const input = {
            declaration: contribution.actions![0]!,
            contributionId: contribution.id,
            model,
            seed: seed(),
            userGesture: true,
        } as const;
        const first = invoker.invoke(input);
        await expect(invoker.invoke(input))
            .rejects.toMatchObject({ code: 'plugin_settings_action_busy' });
        release();
        await expect(first).resolves.toMatchObject({ revision: '1' });
    });

    it('does not let a retired generation that ignores cancellation block its replacement', async () => {
        let oldCurrent = true;
        let releaseOld!: () => void;
        let enteredOld!: () => void;
        const oldPending = new Promise<void>((resolve) => { releaseOld = resolve; });
        const oldEntered = new Promise<void>((resolve) => { enteredOld = resolve; });
        const owner = createStablePluginSettingsOwner({
            recordStore: {
                supports: () => true,
                read: async () => null,
                async update<T>(
                    _model: StablePluginSettingsModel,
                    operation: (current: unknown | null) => Readonly<{
                        record: CanonicalPluginSettingsRecord;
                        result: T;
                    }>,
                ): Promise<T> {
                    return operation(null).result;
                },
            },
            broker: createStablePluginEventsBroker(),
        });
        const model = createStablePluginSettingsModel({ pluginId: 'acme.plugin', contribution });
        const invoker = createPluginSettingsActionInvoker({
            owner,
            confirm: async () => true,
            execute: async (_input, context) => {
                if (context === 'old') {
                    enteredOld();
                    await oldPending;
                }
                return { patch: { endpoint: 'https://discovered.example' } };
            },
        });
        const oldInvocation = invoker.invoke({
            declaration: contribution.actions![0]!,
            contributionId: contribution.id,
            model,
            seed: seed({ generation: 'generation-old', isGenerationCurrent: () => oldCurrent }),
            userGesture: true,
            context: 'old',
        });
        await oldEntered;
        oldCurrent = false;

        await expect(invoker.invoke({
            declaration: contribution.actions![0]!,
            contributionId: contribution.id,
            model,
            seed: seed({ generation: 'generation-new' }),
            userGesture: true,
            context: 'new',
        })).resolves.toMatchObject({ revision: '1' });

        releaseOld();
        await expect(oldInvocation).rejects.toMatchObject({
            code: 'plugin_settings_action_generation_retired',
        });
    });
});
