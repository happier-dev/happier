import { describe, expect, it } from 'vitest';
import type { PluginRuntimeOccurrenceId } from '../runtimeSlots';
import { createTargetActionInvocationRegistry, type TargetActionInvocationRegistration } from './targetActionRegistry';
import { createUnavailablePluginServicesFactory } from './services/factory';
import { createTargetActionHostBindingResolver } from '../hostAccess/resolve';
import { createManagedPluginSourceCustody } from '../lifecycle/contributions/runtimeIdentity.testkit';

describe('target Action registry republish', () => {
    it('does not retire admitted work when unrelated catalog registrations change', async () => {
        let entered = 0;
        let admit!: () => void;
        const admitted = new Promise<void>(resolve => { admit = resolve; });
        const occurrenceId = '7' as PluginRuntimeOccurrenceId;
        let aborted = 0;
        let finish!: () => void;
        const pending = new Promise<void>(resolve => { finish = resolve; });
        const registration: TargetActionInvocationRegistration = {
            pluginId: 'acme.alpha', pluginVersion: '1.0.0', occurrenceId, localId: 'read',
            sourceCustody: createManagedPluginSourceCustody('acme-generation'),
            definition: { id: 'read', dangerLevel: 'safe', scopes: ['global'], surfaces: ['cli'] },
            handler: async (_input, context) => {
                entered++;
                if (entered === 4) admit();
                context.signal.addEventListener('abort', () => { aborted++; }, { once: true });
                await pending;
                expect(context.signal.aborted).toBe(false);
                return { body: 'detail' };
            },
        };
        let actions: readonly TargetActionInvocationRegistration[] = [registration];
        const registry = createTargetActionInvocationRegistry({ actions, readActions: () => actions,
            readCurrentPluginOccurrenceId: () => occurrenceId,
            createServices: createUnavailablePluginServicesFactory(),
            resolveHostBinding: createTargetActionHostBindingResolver(),
            resolveAuthorizationFacts: action => ({ generation: { targetGeneration: action.occurrenceId,
                desiredGeneration: action.occurrenceId, appliedGeneration: action.occurrenceId },
                resourceSelections: [], scopedGrants: [], operatingSystemAuthorization: [] }),
        });
        const calls = Array.from({ length: 4 }, () => registry.invoke({ pluginId: 'acme.alpha', localId: 'read', input: null, surface: 'cli' }));
        // Admission is driven through the real registry, without a timer or a mocked executor.
        await Promise.race([admitted, Promise.all(calls).then(results => { throw new Error('Handlers not admitted: ' + JSON.stringify(results)); })]);
        actions = [registration, { ...registration, pluginId: 'acme.other' }];
        registry.refresh();
        expect(aborted).toBe(0);
        finish();
        expect(await Promise.all(calls)).toEqual(Array.from({ length: 4 }, () => ({ status: 'executed', value: { body: 'detail' } })));
        registry.dispose();
    });
});
