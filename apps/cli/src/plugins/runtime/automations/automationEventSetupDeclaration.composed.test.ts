import { afterEach, expect, it, vi } from 'vitest';
import { DEPLOYMENT_RECEIPT_EVENT_REFS_V1 } from '@happier-dev/protocol/deployments/deploymentReceiptEventsV1';
import { PluginAvailabilityCollectionWritersClaimActionInputV1Schema } from '@happier-dev/protocol/plugins/availability/actions';
import * as persistence from '@/persistence';
import { createAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import type { StoredCredentials } from '@/persistence';

afterEach(() => vi.restoreAllMocks());

it.each(['admitted', 'refused'] as const)('joins the source declaration claim before Event setup: %s', async outcome => {
    // Credential persistence and authenticated HTTP are the external boundaries.
    vi.spyOn(persistence, 'readStoredCredentials').mockResolvedValue(null);
    const credentials = { token: 'event-setup-account', encryption: null } satisfies StoredCredentials;
    const pluginId = DEPLOYMENT_RECEIPT_EVENT_REFS_V1.failed.pluginId;
    let releaseClaim!: () => void;
    const claimResponse = new Promise<void>(resolve => { releaseClaim = resolve; });
    let claimStarted!: () => void;
    const claiming = new Promise<void>(resolve => { claimStarted = resolve; });
    let bodyClaims = 0;
    const fixture = await createAdmittedPluginRuntimeFixture({ runtimeOptions: {
        pluginIds: [pluginId],
        resolveCurrentMachineId: () => 'event-observer-machine',
        accountStorageDependencies: {
            readCredentials: async () => credentials,
            isCurrentAccount: () => true,
            resolveAccountScopeKey: () => 'event-setup-account-scope',
            resolveBaseUrl: () => 'https://event-setup.example.test',
            http: {
                get: async () => { throw new Error('Event setup does not read Account storage'); },
                post: async (url, body) => {
                    expect(url).toBe('https://event-setup.example.test/v1/plugins/availability/collection-writers/claim');
                    const input = PluginAvailabilityCollectionWritersClaimActionInputV1Schema.parse(JSON.parse(body));
                    if (!('manifest' in input)) return { status: 404, data: { error: 'plugin_declaration_not_found' } };
                    expect(input.manifest.id).toBe(pluginId);
                    bodyClaims += 1;
                    claimStarted();
                    await claimResponse;
                    return outcome === 'admitted' ? { status: 200, data: {} }
                        : { status: 409, data: { error: 'plugin_intent_release_selected' } };
                },
            },
        },
    } });
    let publication: Promise<void> | undefined;
    try {
        const event = fixture.registry.contributes.automationEligibleEvents?.find(entry =>
            entry.event.identity.localId === DEPLOYMENT_RECEIPT_EVENT_REFS_V1.failed.localId);
        if (!event) throw new Error('Deployment Event setup declaration unavailable');
        const action = event.setupAction.identity;
        const ordinary = fixture.registry.contributes.actions.find(entry => entry.pluginId === pluginId
            && !fixture.registry.contributes.automationEligibleEvents?.some(source =>
                source.setupAction.identity.localId === entry.definition.localId));
        if (!ordinary) throw new Error('An ordinary Action is required beside the source setup');
        await fixture.registry.activateContributionsOnDemand([{ pluginId,
            family: 'actions', localId: ordinary.definition.localId }]);
        // The daemon starts this best-effort publication without holding ordinary readiness.
        publication = fixture.registry.claimReleaseLessDeclarations();
        // A background refusal is observed below after the source demand settles.
        void publication.catch(() => {});
        await claiming;
        const invoke = () => fixture.registry.targetActionInvocations.invoke({ pluginId: action.pluginId,
            localId: action.localId, input: { v: 1, serverId: 'srv_event_setup' }, surface: 'cli' });
        let settled = false;
        const setup = invoke().finally(() => { settled = true; });
        // Pending source setup never holds an ordinary Action on the same plugin.
        await fixture.registry.activateContributionsOnDemand([{ pluginId,
            family: 'actions', localId: ordinary.definition.localId }]);
        // The warm Action has no further asynchronous boundary until its declaration admission.
        await new Promise<void>(resolve => setImmediate(resolve));
        if (settled) expect(await setup).toMatchObject({ status: 'executed', value: { v: 1, sourceContractVersion: 1 } });
        expect(settled, 'source setup cannot advertise an observer before its Account declaration exists').toBe(false);
        releaseClaim();
        if (outcome === 'admitted') {
            await publication;
            expect(await setup).toMatchObject({ status: 'executed', value: { v: 1, sourceContractVersion: 1 } });
            expect(await invoke()).toMatchObject({ status: 'executed', value: { v: 1 } });
        } else {
            await expect(publication).rejects.toBeInstanceOf(AggregateError);
            expect(await setup).toMatchObject({ code: 'plugin_intent_release_selected', actionHandlerInvocation: 'notStarted' });
            expect(await invoke()).toMatchObject({ code: 'plugin_intent_release_selected', actionHandlerInvocation: 'notStarted' });
        }
        expect(bodyClaims).toBe(1);
    } finally {
        releaseClaim();
        await Promise.allSettled([publication]);
        await fixture.dispose();
    }
});
