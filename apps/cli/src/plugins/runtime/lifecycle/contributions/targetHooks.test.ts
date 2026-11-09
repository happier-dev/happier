import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import type { PluginInvocationContext } from '@happier-dev/plugin-sdk';
import type { HookHandler } from '@happier-dev/plugin-sdk/hooks';
import { PLUGIN_MANIFEST as HOOK_FIXTURE_MANIFEST } from '@happier-dev/plugins-gemini';

import { ingestCanonicalPluginManifest } from '@/plugins/manifest/ingest';
import { resolvePluginStorePaths } from '@/plugins/store/paths';

import { createContributionRegistrationHost } from '../../api/registrationRightsHost';
import { createProductionPluginInvocationServiceOwners } from '../../invocation/services/production';
import type { ActivationTarget } from '../activation/targets';
import { getPluginHookDefinitionV1 } from '@happier-dev/protocol';
import type { ResolvedPluginHookHandler } from '@/plugins/runtime/types';
import { createDevelopmentPluginSourceCustody } from './runtimeIdentity.testkit';
import { createPluginRuntimeOccurrenceId } from '@/plugins/runtime/runtimeSlots';
import { createTargetHookHandlerRegistry } from './targetHooks';

const HOOK_FIXTURE_OCCURRENCE_ID = createPluginRuntimeOccurrenceId('hook-fixture');

function createTargetHookHandlerRegistryHandlers(
    params: Omit<Parameters<typeof createTargetHookHandlerRegistry>[0],
        'readPluginOccurrenceId' | 'readPluginSourceCustody'>
        & Partial<Pick<Parameters<typeof createTargetHookHandlerRegistry>[0],
            'readPluginOccurrenceId' | 'readPluginSourceCustody'>>,
): ReadonlyMap<string, readonly ResolvedPluginHookHandler[]> {
    return createTargetHookHandlerRegistry({
        readPluginOccurrenceId: () => HOOK_FIXTURE_OCCURRENCE_ID,
        readPluginSourceCustody: () => createDevelopmentPluginSourceCustody('hook-fixture-root'),
        ...params,
    }).handlersByHookId;
}

function target(params: Readonly<{
    daemonEntryPath?: string | null;
    devDaemonEntryPath?: string | null;
}> = {}): ActivationTarget {
    const ingested = ingestCanonicalPluginManifest(HOOK_FIXTURE_MANIFEST, { sourceProvenance: 'localSource',
        manifestAuthority: 'bundled_first_party',
        enforceEngineCompatibility: false,
    });
    if (!ingested.ok) throw new Error(JSON.stringify(ingested.diagnostics));
    return {
        provenance: 'external',
        source: { kind: 'path' },
        pluginId: HOOK_FIXTURE_MANIFEST.id,
        manifestPath: `/plugins/${HOOK_FIXTURE_MANIFEST.id}/plugin.json`,
        daemonEntryPath: params.daemonEntryPath === undefined
            ? `/plugins/${HOOK_FIXTURE_MANIFEST.id}/daemon.js`
            : params.daemonEntryPath,
        devDaemonEntryPath: params.devDaemonEntryPath ?? null,
        sourceSpec: {
            kind: 'path',
            locator: `/plugins/${HOOK_FIXTURE_MANIFEST.id}`,
            trustPolicy: 'local_trusted',
            installPolicy: 'link',
        },
        manifest: ingested.manifest,
    };
}

describe('target hook handler registry', () => {
    it('maps a hook HostAccess request id into its qualified Connected Accounts purpose', async () => {
        const baseTarget = target();
        const accountRequest = {
            id: 'hook-account',
            capability: 'connectedAccounts' as const,
            reason: 'Use the selected hook account',
            scope: {
                serviceRefs: [{ pluginId: 'happier.agent.codex', localId: 'openai-codex' }],
                operations: ['use' as const],
            },
        };
        const activationTarget: ActivationTarget = {
            ...baseTarget,
            manifest: {
                ...baseTarget.manifest,
                hostAccess: {
                    required: [...baseTarget.manifest.hostAccess.required, accountRequest],
                    optional: baseTarget.manifest.hostAccess.optional,
                },
                contributes: {
                    ...baseTarget.manifest.contributes,
                    hooks: baseTarget.manifest.contributes.hooks.map((hook) => (
                        hook.id === 'resolve-prerequisites'
                            ? { ...hook, hostAccess: [accountRequest.id] }
                            : hook
                    )),
                },
            },
        };
        const getBinding = vi.fn(async (input) => Object.freeze({
            purpose: input.purpose.purpose,
            service: input.serviceRefs[0]!,
            account: Object.freeze({
                service: input.serviceRefs[0]!,
                accountId: 'codex-account',
            }),
            target: Object.freeze({ kind: 'account' as const, displayName: 'Codex account' }),
        }));
        const invocationServices = createProductionPluginInvocationServiceOwners({
            connectedAccounts: {
                getBinding,
                requestSelection: vi.fn(),
                materialize: vi.fn(),
                listAccounts: async () => {
                    throw new Error('Connected Account listing is outside this fixture');
                },
                materializeListedAccount: async () => {
                    throw new Error('Exact-listed Connected Account materialization is outside this fixture');
                },
                watch: vi.fn(),
            },
        });
        const host = createContributionRegistrationHost({
            pluginId: HOOK_FIXTURE_MANIFEST.id,
            occurrenceId: HOOK_FIXTURE_OCCURRENCE_ID,
            rights: [{ family: 'hooks', localId: 'resolve-prerequisites', target: { realm: 'daemon' } }],
            isOccurrenceCurrent: () => true,
        });
        host.api.hooks.register('resolve-prerequisites', async (_payload, context) => {
            await context.services.connectedAccounts.getBinding(accountRequest.id);
            return { decision: 'allow' };
        });
        const registry = createTargetHookHandlerRegistryHandlers({
            activationTargets: [activationTarget],
            targetRegistrations: host.commit().map((registration) => ({
                pluginId: HOOK_FIXTURE_MANIFEST.id,
                occurrenceId: HOOK_FIXTURE_OCCURRENCE_ID,
                registration,
            })),
            isOccurrenceCurrent: () => true,
            invocationServices,
        });

        try {
            const resolved = registry.get('agent.resolvePrerequisites')?.[0];
            if (!resolved) throw new Error('Expected target hook handler');
            await expect(resolved.handler({ payload: { agentId: 'kimi' } })).resolves.toEqual({
                decision: 'allow',
            });
            expect(getBinding).toHaveBeenCalledWith(expect.objectContaining({
                purpose: {
                    consumer: {
                        pluginId: HOOK_FIXTURE_MANIFEST.id,
                        localId: 'resolve-prerequisites',
                    },
                    purpose: accountRequest.id,
                },
            }));
        } finally {
            await invocationServices.dispose();
        }
    });

    it('binds invocation services through the production lifecycle owner', async () => {
        const records: unknown[] = [];
        const controller = new AbortController();
        const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-target-hook-services-'));
        const invocationServices = createProductionPluginInvocationServiceOwners({
            loggerSink: { write: (record) => { records.push(record); } },
            storagePaths: resolvePluginStorePaths({ happyHomeDir }),
        });
        const retained = {
            logger: null as PluginInvocationContext['services']['logger'] | null,
        };
        const host = createContributionRegistrationHost({
            pluginId: HOOK_FIXTURE_MANIFEST.id,
            occurrenceId: HOOK_FIXTURE_OCCURRENCE_ID,
            rights: [{ family: 'hooks', localId: 'resolve-prerequisites', target: { realm: 'daemon' } }],
            isOccurrenceCurrent: () => true,
        });
        host.api.hooks.register('resolve-prerequisites', async (_payload, context) => {
            expect(context.services.availability('logger')).toEqual({ status: 'available' });
            expect(context.services.availability('storage')).toEqual({ status: 'available' });
            context.services.logger.info('hook invoked');
            retained.logger = context.services.logger;
            await context.services.storage.daemon.set('invoked', true);
            await expect(context.services.storage.daemon.get('invoked')).resolves.toBe(true);
            controller.abort();
            await expect(context.services.storage.daemon.get('invoked')).rejects.toMatchObject({
                code: 'PLUGIN_STORAGE_CANCELLED',
            });
            return { decision: 'allow' };
        });
        const registryParams = {
            activationTargets: [target()],
            targetRegistrations: host.commit().map((registration) => ({
                pluginId: HOOK_FIXTURE_MANIFEST.id,
                occurrenceId: HOOK_FIXTURE_OCCURRENCE_ID,
                registration,
            })),
            isOccurrenceCurrent: () => true,
            invocationServices,
        };

        try {
            const registry = createTargetHookHandlerRegistryHandlers(registryParams);
            const resolved = registry.get('agent.resolvePrerequisites')?.[0];
            if (!resolved) throw new Error('Expected target hook handler');

            await expect(resolved.handler(
                { payload: { agentId: 'kimi', timestampMs: 1 } },
                { signal: controller.signal },
            ))
                .rejects.toThrow();
            expect(records).toHaveLength(1);
            retained.logger?.info('must not log after hook settlement');
            expect(records).toHaveLength(1);
        } finally {
            await invocationServices.dispose();
        }
    });

    it('rejects pre-cancelled and in-flight invocations without admitting a late result', async () => {
        let release!: (result: { decision: 'allow' }) => void;
        let calls = 0;
        const host = createContributionRegistrationHost({
            pluginId: HOOK_FIXTURE_MANIFEST.id,
            occurrenceId: HOOK_FIXTURE_OCCURRENCE_ID,
            rights: [{ family: 'hooks', localId: 'resolve-prerequisites', target: { realm: 'daemon' } }],
            isOccurrenceCurrent: () => true,
        });
        host.api.hooks.register('resolve-prerequisites', async () => {
            calls += 1;
            return await new Promise<{ decision: 'allow' }>((resolve) => {
                release = resolve;
            });
        });
        const registry = createTargetHookHandlerRegistryHandlers({
            activationTargets: [target()],
            targetRegistrations: host.commit().map((registration) => ({
                pluginId: HOOK_FIXTURE_MANIFEST.id,
                occurrenceId: HOOK_FIXTURE_OCCURRENCE_ID,
                registration,
            })),
            isOccurrenceCurrent: () => true,
        });
        const resolved = registry.get('agent.resolvePrerequisites')?.[0];
        if (!resolved) throw new Error('Expected target hook handler');

        const alreadyCancelled = new AbortController();
        alreadyCancelled.abort();
        await expect(resolved.handler(
            { payload: { agentId: 'kimi', timestampMs: 1 } },
            { signal: alreadyCancelled.signal },
        )).rejects.toThrow();
        expect(calls).toBe(0);

        const inFlight = new AbortController();
        const invocation = resolved.handler(
            { payload: { agentId: 'kimi', timestampMs: 1 } },
            { signal: inFlight.signal },
        );
        await vi.waitFor(() => expect(calls).toBe(1));
        inFlight.abort();
        await expect(invocation).rejects.toThrow();
        release({ decision: 'allow' });
    });

    it('does not admit a synchronous result when the handler aborts its invocation', async () => {
        const controller = new AbortController();
        const host = createContributionRegistrationHost({
            pluginId: HOOK_FIXTURE_MANIFEST.id,
            occurrenceId: HOOK_FIXTURE_OCCURRENCE_ID,
            rights: [{ family: 'hooks', localId: 'resolve-prerequisites', target: { realm: 'daemon' } }],
            isOccurrenceCurrent: () => true,
        });
        host.api.hooks.register('resolve-prerequisites', () => {
            controller.abort();
            return { decision: 'allow' };
        });
        const registry = createTargetHookHandlerRegistryHandlers({
            activationTargets: [target()],
            targetRegistrations: host.commit().map((registration) => ({
                pluginId: HOOK_FIXTURE_MANIFEST.id,
                occurrenceId: HOOK_FIXTURE_OCCURRENCE_ID,
                registration,
            })),
            isOccurrenceCurrent: () => true,
        });
        const resolved = registry.get('agent.resolvePrerequisites')?.[0];
        if (!resolved) throw new Error('Expected target hook handler');

        await expect(resolved.handler(
            { payload: { agentId: 'kimi', timestampMs: 1 } },
            { signal: controller.signal },
        )).rejects.toMatchObject({ name: 'AbortError' });
    });

    it('uses the development daemon entry as the executable hook owner when no production entry exists', () => {
        const host = createContributionRegistrationHost({
            pluginId: HOOK_FIXTURE_MANIFEST.id,
            occurrenceId: HOOK_FIXTURE_OCCURRENCE_ID,
            rights: [{ family: 'hooks', localId: 'resolve-prerequisites', target: { realm: 'daemon' } }],
            isOccurrenceCurrent: () => true,
        });
        host.api.hooks.register('resolve-prerequisites', async () => ({ decision: 'allow' }));

        const registry = createTargetHookHandlerRegistryHandlers({
            activationTargets: [target({
                daemonEntryPath: null,
                devDaemonEntryPath: `/plugins/${HOOK_FIXTURE_MANIFEST.id}/src/daemon.ts`,
            })],
            targetRegistrations: host.commit().map((registration) => ({
                pluginId: HOOK_FIXTURE_MANIFEST.id,
                occurrenceId: HOOK_FIXTURE_OCCURRENCE_ID,
                registration,
            })),
            isOccurrenceCurrent: () => true,
        });

        expect(registry.get('agent.resolvePrerequisites')?.[0]?.daemonEntryPath)
            .toBe(`/plugins/${HOOK_FIXTURE_MANIFEST.id}/src/daemon.ts`);
    });

    it('fails closed when the owning generation retires while an asynchronous hook is running', async () => {
        let active = true;
        let resolveHandler: ((result: { decision: 'allow' }) => void) | undefined;
        const handler: HookHandler = () => new Promise((resolve) => {
            resolveHandler = resolve;
        });
        const host = createContributionRegistrationHost({
            pluginId: HOOK_FIXTURE_MANIFEST.id,
            occurrenceId: HOOK_FIXTURE_OCCURRENCE_ID,
            rights: [{ family: 'hooks', localId: 'resolve-prerequisites', target: { realm: 'daemon' } }],
            isOccurrenceCurrent: () => true,
        });
        host.api.hooks.register('resolve-prerequisites', handler);
        const registry = createTargetHookHandlerRegistryHandlers({
            activationTargets: [target()],
            targetRegistrations: host.commit().map((registration) => ({
                pluginId: HOOK_FIXTURE_MANIFEST.id,
                occurrenceId: HOOK_FIXTURE_OCCURRENCE_ID,
                registration,
            })),
            isOccurrenceCurrent: () => active,
        });
        const resolved = registry.get('agent.resolvePrerequisites')?.[0];
        if (!resolved) throw new Error('Expected target hook handler');

        const pending = resolved.handler({
            payload: {
                agentId: 'kimi',
                timestampMs: 1,
            },
        });
        active = false;
        resolveHandler?.({ decision: 'allow' });

        await expect(pending).rejects.toThrow(/no longer active/i);
    });

    it('preserves the daemon tool-resolution context without surrendering host-owned invocation fields', async () => {
        const resolveSystemTool = vi.fn(async () => ({ ok: true as const }));
        let receivedContext: PluginInvocationContext | undefined;
        const host = createContributionRegistrationHost({
            pluginId: HOOK_FIXTURE_MANIFEST.id,
            occurrenceId: HOOK_FIXTURE_OCCURRENCE_ID,
            rights: [{ family: 'hooks', localId: 'resolve-prerequisites', target: { realm: 'daemon' } }],
            isOccurrenceCurrent: () => true,
        });
        host.api.hooks.register('resolve-prerequisites', async (_payload, context) => {
            receivedContext = context;
            return { decision: 'allow' };
        });
        const registry = createTargetHookHandlerRegistryHandlers({
            activationTargets: [target()],
            targetRegistrations: host.commit().map((registration) => ({
                pluginId: HOOK_FIXTURE_MANIFEST.id,
                occurrenceId: HOOK_FIXTURE_OCCURRENCE_ID,
                registration,
            })),
            isOccurrenceCurrent: () => true,
        });
        const resolved = registry.get('agent.resolvePrerequisites')?.[0];
        if (!resolved) throw new Error('Expected target hook handler');
        const callerSignal = new AbortController().signal;

        await expect(resolved.handler(
            { payload: { agentId: 'kimi', timestampMs: 1 } },
            {
                tools: { resolveSystemTool },
                signal: callerSignal,
                plugin: { id: 'caller-controlled', version: '0.0.0' },
                contribution: { id: 'caller-controlled', qualifiedId: 'caller-controlled' },
                services: { callerControlled: true },
            },
        )).resolves.toEqual({ decision: 'allow' });
        expect(receivedContext).toMatchObject({
            tools: { resolveSystemTool },
            plugin: { id: HOOK_FIXTURE_MANIFEST.id, version: HOOK_FIXTURE_MANIFEST.version },
            contribution: {
                id: 'resolve-prerequisites',
                qualifiedId: `${HOOK_FIXTURE_MANIFEST.id}/hooks/resolve-prerequisites`,
            },
            invokedAtMs: expect.any(Number),
            signal: callerSignal,
        });
        expect(receivedContext?.services).not.toHaveProperty('callerControlled');
    });

    it('uses catalog facts when projecting hook handlers', () => {
        const goodTarget = target();
        const declaredHook = goodTarget.manifest.contributes.hooks[0]!;
        const canonical = getPluginHookDefinitionV1(declaredHook.on);
        if (!canonical) throw new Error('Expected a canonical hook definition');
        const driftedCategory = canonical.category === 'decision' ? 'lifecycle' : 'decision';
        const badTarget: ActivationTarget = {
            ...goodTarget,
            pluginId: 'bad.plugin',
            manifest: {
                ...goodTarget.manifest,
                id: 'bad.plugin',
                contributes: {
                    ...goodTarget.manifest.contributes,
                    hooks: [{ ...declaredHook, category: driftedCategory }],
                },
            },
        };
        const registration = (pluginId: string) => ({
            pluginId,
            occurrenceId: HOOK_FIXTURE_OCCURRENCE_ID,
            registration: {
                family: 'hooks' as const,
                localId: declaredHook.id,
                value: async () => undefined,
            },
        });

        const projected = createTargetHookHandlerRegistry({
            activationTargets: [goodTarget, badTarget],
            targetRegistrations: [
                registration(goodTarget.pluginId),
                registration('bad.plugin'),
            ] as never,
            readPluginOccurrenceId: () => HOOK_FIXTURE_OCCURRENCE_ID,
            readPluginSourceCustody: () => createDevelopmentPluginSourceCustody('hook-fixture-root'),
            isOccurrenceCurrent: () => true,
        });

        const handlers = projected.handlersByHookId.get(declaredHook.on) ?? [];
        expect(handlers.map((handler) => handler.pluginId).sort())
            .toEqual([goodTarget.pluginId, 'bad.plugin'].sort());
        expect(projected.diagnosticsByPluginId[goodTarget.pluginId]).toBeUndefined();
        expect(projected.diagnosticsByPluginId['bad.plugin']).toBeUndefined();
        expect(handlers.find((handler) => handler.pluginId === 'bad.plugin')?.registration.definition)
            .toMatchObject({ category: canonical.category, scope: canonical.scope, executionKind: canonical.executionKind });
    });
});
