import { describe, expect, it } from 'vitest';

import { ingestCanonicalPluginManifest } from '../../../manifest/ingest';
import { buildActivationPolicy } from './policy';

describe('activation metadata', () => {
    it('derives runtime capabilities from declared contributions and HostAccess', () => {
        const ingestion = ingestCanonicalPluginManifest({
            schemaVersion: 2,
            id: 'com.acme.agent-runtime-services',
            version: '1.0.0',
            displayName: 'Agent runtime services',
            engines: { happier: '^0.3.0' }, runtime: { apiVersion: 1 },
            entrypoints: { daemon: './dist/plugin.js' },
            hostAccess: {
                required: [
                    {
                        id: 'terminal-control',
                        capability: 'terminal',
                        reason: 'Control the host terminal for the declared Agent.',
                        scope: { operations: ['open', 'send', 'resize', 'close'] },
                    },
                    {
                        id: 'session-hook-control',
                        capability: 'sessions',
                        reason: 'Read lifecycle events and control authenticated hooks for the current Agent session.',
                        scope: { access: ['read', 'control'] },
                    },
                ],
                optional: [],
            },
            contributes: {
                agents: [{
                    id: 'agent-runtime-services',
                    title: 'Agent runtime services',
                    runtime: { kind: 'custom' },
                    primary: 'sessions',
                    capabilities: {
                        surfaces: ['terminal'],
                        sessions: {
                            open: ['create'],
                            delivery: ['newTurn'],
                            cancel: true,
                        },
                    },
                }],
            },
        }, { sourceProvenance: 'registryCustodied' });
        if (!ingestion.ok) throw new Error('Fixture must normalize');

        const policy = buildActivationPolicy(ingestion.manifest);

        expect(policy.runtimeCapabilities).toEqual(expect.arrayContaining([
            'agents', 'terminalHost', 'sessionHooks',
        ]));
    });

    it('preserves system-tool metadata for the activated registry', () => {
        const ingestion = ingestCanonicalPluginManifest({
            schemaVersion: 2,
            id: 'com.acme.runtime-metadata',
            version: '1.0.0',
            displayName: 'Runtime metadata',
            engines: { happier: '^0.3.0' }, runtime: { apiVersion: 1 },
            entrypoints: { daemon: './dist/plugin.js' },
            contributes: {
                events: [{ id: 'review-ready-event', kind: 'event', title: 'Review ready' }],
                systemTools: [{ id: 'agent-cli', title: 'Agent CLI', executableNames: ['agent-cli'] }],
            },
        }, { sourceProvenance: 'registryCustodied' });
        if (!ingestion.ok) throw new Error('Fixture must normalize');

        const policy = buildActivationPolicy(ingestion.manifest);

        expect(policy.systemTools).toEqual([
            { id: 'agent-cli', title: 'Agent CLI', executableNames: ['agent-cli'] },
        ]);
    });
});
