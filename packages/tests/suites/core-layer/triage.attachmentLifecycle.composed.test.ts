import { describe, expect, it } from 'vitest';
import { internalTaskLocalRefV1 } from '@happier-dev/triage-protocol/v1';
import { PLUGIN_MANIFEST } from '@happier-dev/plugins-triage/manifest';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { createTriageAttachmentLifecycleFixture } from '@happier-tests/ui-triage-attachment-lifecycle';
import type { RpcHandler, RpcHandlerRegistrar } from '../../../../apps/cli/src/api/rpc/types';
import { createAdmittedPluginRuntimeFixture, retireAdmittedPluginRuntimeRegistry } from '../../../../apps/cli/src/plugins/testkit/admittedRuntime';
import { createActionSettingsProvider } from '../../../../apps/cli/src/settings/actionsSettingsProvider';
import { registerDaemonContributionRegistryProjectionHandler } from '../../../../apps/cli/src/rpc/handlers/daemonContributionRegistryProjection';

import { TRIAGE_ENTRY_ATTACHMENT_LOCAL_ID_V1 } from '../../../plugins/triage/src/composer/attachmentValue';
import { planTriageEntryAttachmentMutation } from '../../../plugins/triage/src/composer/mutationPlan';
import { INTERNAL_TASK_SOURCE_RECORD_V1 } from '../../../plugins/triage/src/internalTasks/configuration';

describe('Triage attachment through admitted daemon registry lifecycle', () => {
    it('retains one updated draft identity across replacement, exposes a removable fallback after retirement, and re-admits after reactivation', async () => {
        const scope = { serverId: 'server-triage-attachment', accountId: 'attachment-owner' };
        const machineId = 'machine-attachment-lifecycle';
        const runtimeOptions = {
            pluginIds: [PLUGIN_MANIFEST.id],
            scopedActionRuntime: { credentials: null, actionsSettingsProvider: createActionSettingsProvider() },
            resolveCurrentMachineId: () => machineId,
            resolveCurrentMachineExecutionOriginContext: async () => ({
                serverIdentityId: 'srv_attachment_lifecycle', machineId,
            }),
        };
        const initial = await createAdmittedPluginRuntimeFixture({ runtimeOptions });
        const replacements: Awaited<ReturnType<typeof createAdmittedPluginRuntimeFixture>>[] = [];
        const currentRegistry = () => {
            const registry = initial.controller.getState().activeRegistry;
            if (!registry) throw new Error('Daemon has no published registry');
            return registry;
        };
        const handlers = new Map<string, RpcHandler>();
        const registrar: RpcHandlerRegistrar = { registerHandler(method, handler) { handlers.set(method, handler); } };
        registerDaemonContributionRegistryProjectionHandler(registrar, {
            resolveGeneration: async () => initial.controller.getState().generation,
            resolveRuntimeRegistry: async () => currentRegistry(),
            resolveInstalledPackages: async () => [],
            resolvePluginProjectionExecutionOriginContext: runtimeOptions.resolveCurrentMachineExecutionOriginContext,
        });
        const describeProjection = handlers.get(RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE);
        if (!describeProjection) throw new Error('Daemon projection handler missing');
        const text = '🧑🏽‍💻 e\u0301 العربية\n漢字 unchanged draft';
        let disposeComposer: (() => void) | undefined;
        try {
            const composer = await createTriageAttachmentLifecycleFixture({ scope, text, identity: {
                pluginId: PLUGIN_MANIFEST.id, localId: TRIAGE_ENTRY_ATTACHMENT_LOCAL_ID_V1,
            } });
            disposeComposer = composer.dispose;
            const readProjection = async () => composer.readProjection(await describeProjection({ machineId }));
            const snapshot = composer.readSnapshot;
            const picker = composer.readPicker;
            const sourceInstance = INTERNAL_TASK_SOURCE_RECORD_V1.value.configured.instance;
            const entryRef = { source: sourceInstance.source, ...internalTaskLocalRefV1('2cbe95c5-55c2-4c58-b034-085e8675b06b') };
            const attach = (label: string) => {
                const plan = planTriageEntryAttachmentMutation({ intent: 'attach', snapshot: snapshot(), entryRef,
                    sourceInstance, presentation: { label } });
                if (plan.status !== 'transaction') throw new Error('Triage attachment planner refused valid input');
                return composer.apply(plan.transaction);
            };
            // Positive control enters through the real daemon declaration and Triage
            // producer before any lifecycle withdrawal.
            await readProjection();
            expect(picker()).toBeDefined();
            const firstAttach = attach('Original Task');
            expect(firstAttach, JSON.stringify(firstAttach)).toMatchObject({ status: 'applied' });
            const original = snapshot().attachments[0]!;
            expect(original.availability.status).toBe('ready');
            expect(attach('Updated Task')).toMatchObject({ status: 'applied' });
            expect(snapshot().attachments).toMatchObject([{ instanceId: original.instanceId, presentation: { label: 'Updated Task' } }]);
            expect(snapshot().attachments).toHaveLength(1);
            const retained = composer.readDocument();
            const firstOccurrence = composer.readOccurrenceId();
            expect(firstOccurrence).toBeDefined();

            const replacement = await createAdmittedPluginRuntimeFixture({ happyHomeDir: initial.happyHomeDir,
                controller: initial.controller, runtimeOptions });
            replacements.push(replacement);
            await readProjection();
            expect(composer.readOccurrenceId()).not.toBe(firstOccurrence);
            expect(picker()).toMatchObject({ occurrenceId: composer.readOccurrenceId() });
            expect(snapshot().attachments).toMatchObject([{ instanceId: original.instanceId, availability: { status: 'ready' } }]);
            expect(composer.readDocument()).toEqual(retained);

            await retireAdmittedPluginRuntimeRegistry({ controller: initial.controller, registry: replacement.registry,
                happyHomeDir: initial.happyHomeDir });
            await readProjection();
            expect(picker()).toBeUndefined();
            expect(composer.readOccurrenceId()).toBeUndefined();
            expect(snapshot().attachments).toMatchObject([{ instanceId: original.instanceId,
                presentation: { label: 'Updated Task' }, availability: { status: 'unavailable' } }]);
            expect(composer.readDocument()).toEqual(retained);
            const fallback = composer.readAttachmentRows()[0]!;
            expect(fallback.kind).toBe('badge');
            if (fallback.kind !== 'badge') throw new Error('Unavailable attachment did not retain its host badge');
            expect(fallback.label).toBe('Updated Task');
            expect(fallback.onPress).toBeUndefined();
            expect(fallback.onRemove).toBeTypeOf('function');
            fallback.onRemove?.();
            expect(snapshot().attachments).toEqual([]);
            expect(snapshot().text).toBe(text);

            const reactivated = await createAdmittedPluginRuntimeFixture({ happyHomeDir: initial.happyHomeDir,
                controller: initial.controller, runtimeOptions });
            replacements.push(reactivated);
            await readProjection();
            expect(picker()).toMatchObject({ occurrenceId: composer.readOccurrenceId() });
            expect(attach('Reactivated Task')).toMatchObject({ status: 'applied' });
            const reattached = snapshot().attachments[0]!;
            expect(attach('Current Task')).toMatchObject({ status: 'applied' });
            expect(snapshot().attachments).toHaveLength(1);
            expect(snapshot().attachments[0]).toMatchObject({ instanceId: reattached.instanceId,
                availability: { status: 'ready' }, presentation: { label: 'Current Task' } });
            expect(snapshot().text).toBe(text);
        } finally {
            disposeComposer?.();
            for (const replacement of replacements.reverse()) await replacement.dispose();
            await initial.dispose();
        }
    });
});
