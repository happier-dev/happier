import { artifactHtmlBundleFromBodyV1 } from '@happier-dev/protocol/artifacts/artifactHtmlV1';
import { describe, expect, it } from 'vitest';

import { prepareCallerHostedHtmlSurface } from './prepareCallerHostedHtmlSurface';

describe('prepareCallerHostedHtmlSurface', () => {
    it('returns source_invalid for malformed source before mounting', async () => {
        expect(await prepareCallerHostedHtmlSurface({
            source: { v: 1, files: {} },
            requestedCapabilities: {},
            admittedHostMethods: [],
        })).toEqual({ kind: 'rejected', code: 'source_invalid' });
    });
    it('projects admitted source and capabilities without building an unused review document', async () => {
        const prepared = await prepareCallerHostedHtmlSurface({
            source: artifactHtmlBundleFromBodyV1('<main id="app"></main>'),
            requestedCapabilities: { hostMethods: ['context'], networkOrigins: ['https://api.example.com'] },
            admittedHostMethods: ['context', 'executeAction'],
        });
        expect(prepared.kind).toBe('admitted');
        if (prepared.kind !== 'admitted') return;
        expect(prepared.capabilityManifest).toEqual({
            version: 1,
            requested: {
                hostMethods: ['context'],
                resources: [],
                actions: [],
                network: 'origins',
                networkOrigins: ['https://api.example.com'],
            },
            advertisedHostMethods: ['context'],
        });
        expect(prepared.frameSource).toEqual({
            bundle: artifactHtmlBundleFromBodyV1('<main id="app"></main>'),
            networkOrigins: ['https://api.example.com'],
            network: undefined,
        });
        expect(prepared.advertisedHostMethods).toEqual(['context']);
        expect(Object.keys(prepared).sort()).toEqual(['advertisedHostMethods', 'capabilityManifest', 'frameSource', 'kind']);
    });

    it('forwards explicit open admission through the physical frame input', async () => {
        const input = { source: artifactHtmlBundleFromBodyV1('<p>Hello</p>'), admittedHostMethods: [] };
        const open = await prepareCallerHostedHtmlSurface({ ...input, requestedCapabilities: { network: 'open' } });
        const none = await prepareCallerHostedHtmlSurface(input);
        expect(open.kind).toBe('admitted');
        expect(none.kind).toBe('admitted');
        if (open.kind !== 'admitted' || none.kind !== 'admitted') return;
        expect(open.frameSource).toMatchObject({ network: 'open', networkOrigins: [] });
        expect(none.frameSource).toMatchObject({ network: 'none', networkOrigins: [] });
    });

    it('rejects an installed-only host method instead of silently narrowing it', async () => {
        expect(await prepareCallerHostedHtmlSurface({
            source: artifactHtmlBundleFromBodyV1('<p>Hi</p>'),
            requestedCapabilities: { hostMethods: ['readAccountData'] },
            admittedHostMethods: ['context'],
        })).toEqual({ kind: 'rejected', code: 'capability_request_invalid' });
    });

    it('admits local HTML when an optional requested method is unavailable in the current realm', async () => {
        expect(await prepareCallerHostedHtmlSurface({
            source: artifactHtmlBundleFromBodyV1('<p>Hi</p>'),
            requestedCapabilities: {
                hostMethods: ['readResource'],
                resources: [{ pluginId: 'acme.preview', localId: 'status' }],
            },
            admittedHostMethods: ['context'],
        })).toMatchObject({ kind: 'admitted', advertisedHostMethods: ['context'] });
    });
});
