import { expect, it } from 'vitest';
import { createPluginTestkit, type PluginTestServicesFixture } from '@happier-dev/plugin-sdk/testing';
import { plugin } from './manifest.js';

it('saves Inbox by default through the agent setup Action and retains an explicit automatic choice', async () => {
    const kit = await createPluginTestkit({ manifest: plugin.manifest, module: plugin });
    const draft = { v: 1, subject: { kind: 'machineService', machineId: 'watched', serviceId: 'web' },
        checks: [{ checkId: 'tcp', kind: { pluginId: plugin.manifest.id, localId: 'tcp' }, binding: { kind: 'healthCheck' },
            config: { host: 'db.internal', port: 5432 }, periodMs: 60_000, consecutiveFailuresBeforeAlerting: 2 }] };
    try {
        // The daemon host service is the SDK boundary; the real registered Action parses and prepares its saved input.
        const unused = async (): Promise<never> => { throw new Error('Unexpected health service operation'); };
        const services = { healthChecks: { setup: async request => request.sourceConfig,
            listKinds: unused, readSource: unused, manageHeartbeat: unused, read: unused,
        } } satisfies PluginTestServicesFixture;
        expect(await kit.invokeAction('health/setup', draft, { surface: 'agent', services }))
            .toMatchObject({ sourceConfig: { investigation: { mode: 'inbox' } } });
        const investigation = { mode: 'auto_start', configuredActionId: 'investigate-production' };
        expect(await kit.invokeAction('health/setup', { ...draft, investigation }, { surface: 'agent', services }))
            .toMatchObject({ sourceConfig: { investigation } });
    } finally { await kit.dispose(); }
});

it('accepts the full Domain checks and chosen cadence through the same agent setup Action', async () => {
    const kit = await createPluginTestkit({ manifest: plugin.manifest, module: plugin });
    const subject = { kind: 'environment', environmentId: 'production' } as const;
    const domain = { domainId: 'public-domain', targetLinkId: 'serving-target' };
    const checks = [
        { checkId: 'public-http', kind: { pluginId: plugin.manifest.id, localId: 'http' }, config: {},
            binding: { kind: 'domain', ...domain, condition: 'domain_probe_failed' }, periodMs: 300_000, consecutiveFailuresBeforeAlerting: 3 },
        { checkId: 'public-certificate', kind: { pluginId: plugin.manifest.id, localId: 'certificate' }, config: {},
            binding: { kind: 'domain', ...domain, condition: 'certificate_renewal_failed' }, periodMs: 300_000, consecutiveFailuresBeforeAlerting: 3 },
    ];
    try {
        // The SDK host service boundary receives the same full saved configuration as the person-authored form.
        const unused = async (): Promise<never> => { throw new Error('Unexpected health service operation'); };
        const services = { healthChecks: { setup: async request => request.sourceConfig,
            listKinds: unused, readSource: unused, manageHeartbeat: unused, read: unused,
        } } satisfies PluginTestServicesFixture;
        expect(await kit.invokeAction('health/setup', { v: 1, subject, checks }, { surface: 'agent', services }))
            .toMatchObject({ sourceConfig: { v: 1, subject, checks, investigation: { mode: 'inbox' } } });
    } finally { await kit.dispose(); }
});
