import { expect, it } from 'vitest';
import { StrictJsonValueSchema } from '@happier-dev/protocol';
import { GITHUB_PLUGIN, GITHUB_TRIAGE_ACTION_IDS_V1 } from '@happier-dev/plugins-scm-github';
import { createGithubTaskWriteTestkit } from '@happier-dev/plugins-scm-github/testkit';
import { TriageResolveResourceResultV1Schema } from '@happier-dev/triage-protocol/v1';

import { normalizePluginManifestV2 } from '@/plugins/manifest/normalize';
import { createTargetActionExecutor } from '../actionExecutor';
import { createUnavailablePluginInvocationServiceBinding } from '../services/factory';

it('resolves a Triage link and reads the bound source entry through agent Action admission', async () => {
    const source = await createGithubTaskWriteTestkit('uncertain');
    const manifest = normalizePluginManifestV2(GITHUB_PLUGIN.manifest);
    const occurrenceId = 'github-triage';
    const sessionId = 'c1234567890123456789012345';
    const executor = createTargetActionExecutor({
        resolve: ({ pluginId, localId, input }) => {
            const declaration = manifest.contributes.actions.find(action => action.id === localId);
            if (!declaration || pluginId !== manifest.id) return null;
            return {
                ...declaration, pluginId, localId, input, occurrenceId, hostAccess: [],
                qualifiedId: `${pluginId}/actions/${localId}`,
                sourceCustody: { kind: 'development', registeredRootId: 'github' },
                policyFingerprint: 'a'.repeat(64),
            };
        },
        resolveAuthorizationFacts: () => ({
            generation: { targetGeneration: occurrenceId, desiredGeneration: occurrenceId, appliedGeneration: occurrenceId },
            resourceSelections: [], scopedGrants: [], operatingSystemAuthorization: [],
        }),
        resolveHostBinding: async action => ({
            action, serviceBinding: createUnavailablePluginInvocationServiceBinding(occurrenceId, 'triage-parity'),
        }),
        // The Account execution hop terminates at the real registered source handler.
        invoke: async (action, context) => {
            expect(context.surface).toBe('agent');
            return {
                status: 'executed',
                value: await source.plugin.invokeAction(action.localId, StrictJsonValueSchema.parse(action.input), {
                    surface: 'agent', sessionId: context.sessionId, signal: context.signal,
                }),
            };
        },
    });
    const execute = (localId: string, input: unknown) => executor.execute({
        pluginId: manifest.id, localId, input, sessionId, surface: 'agent', invocationAuthority: 'account_automation',
    });
    try {
        const resolved = await execute(GITHUB_TRIAGE_ACTION_IDS_V1.resolveResource, {
            v: 1, instance: source.instance,
            resource: { kind: 'issue', url: `https://github.com/octo-org/example-app/issues/${source.localRef.entryId}` },
        });
        expect(resolved).toMatchObject({ status: 'executed', value: { kind: 'resolved', localRef: source.localRef } });
        if (resolved.status !== 'executed') throw new Error('Expected admitted Triage link resolution');
        const link = TriageResolveResourceResultV1Schema.parse(resolved.value);
        if (link.kind !== 'resolved') throw new Error('Expected a configured GitHub source entry');
        const entry = await execute(GITHUB_TRIAGE_ACTION_IDS_V1.get, {
            v: 1, instance: source.instance, localRef: link.localRef, lastKnownLocator: link.locator,
        });
        expect(entry).toMatchObject({ status: 'executed', value: { kind: 'present', snapshot: { title: 'Before' } } });
        expect(source.readWrites()).toEqual([]);
    } finally {
        await source.plugin.dispose();
    }
});
