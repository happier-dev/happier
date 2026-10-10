import { artifactHtmlBundleFromBodyV1 } from '@happier-dev/protocol/artifacts/artifactHtmlV1';
import { describe, expect, it } from 'vitest';

import { prepareCallerHostedHtmlSurface } from './prepareCallerHostedHtmlSurface';

describe('prepareCallerHostedHtmlSurface', () => {
    it('returns source_invalid when a declared local asset is unavailable', () => {
        expect(prepareCallerHostedHtmlSurface({
            serverIdentityId: 'server-1', accountId: 'account-1', approvalSubject: 'record-1',
            source: artifactHtmlBundleFromBodyV1('<script src="missing.js"></script>'),
            requestedCapabilities: {},
            admittedHostMethods: [],
            frameIdentity: { instanceId: 'instance-1', mountNonce: 'nonce-1' },
            hostOrigin: 'https://app.example.com',
        })).toEqual({ kind: 'rejected', code: 'source_invalid' });
    });
    it('produces one stable approval identity and keeps context/input out of authored source', () => {
        const prepared = prepareCallerHostedHtmlSurface({
            serverIdentityId: 'server-1',
            accountId: 'account-1',
            approvalSubject: 'record:server-1/session-1/surface/item.v1/note-1',
            source: artifactHtmlBundleFromBodyV1('<main id="app"></main>'),
            requestedCapabilities: { hostMethods: ['context'], networkOrigins: ['https://api.example.com'] },
            admittedHostMethods: ['context', 'executeAction'],
            frameIdentity: { instanceId: 'instance-1', mountNonce: 'nonce-1' },
            hostOrigin: 'https://app.example.com',
        });
        expect(prepared.kind).toBe('admitted');
        if (prepared.kind !== 'admitted') return;
        expect(prepared.capabilityManifest).toEqual({
            version: 1,
            requested: {
                hostMethods: ['context'],
                resources: [],
                actions: [],
                networkOrigins: ['https://api.example.com'],
            },
            advertisedHostMethods: ['context'],
        });
        expect(prepared.frameSource).toEqual({
            bundle: artifactHtmlBundleFromBodyV1('<main id="app"></main>'),
            networkOrigins: ['https://api.example.com'],
        });
        expect(prepared.advertisedHostMethods).toEqual(['context']);
        expect(prepared.document).toContain('connect-src data:');
        expect(prepared.document).not.toContain('connect-src https://api.example.com');
        expect(prepared.document).toContain('<main id="app"></main>');
        expect(prepared.document).not.toContain('session-1');
        expect(prepared.approvalKey).not.toContain('session-1');
    });

    it('rejects an installed-only host method instead of silently narrowing it', () => {
        expect(prepareCallerHostedHtmlSurface({
            serverIdentityId: 'server-1', accountId: 'account-1', approvalSubject: 'record-1',
            source: artifactHtmlBundleFromBodyV1('<p>Hi</p>'),
            requestedCapabilities: { hostMethods: ['readAccountData'] },
            admittedHostMethods: ['context'],
            frameIdentity: { instanceId: 'instance-1', mountNonce: 'nonce-1' },
            hostOrigin: 'https://app.example.com',
        })).toEqual({ kind: 'rejected', code: 'capability_request_invalid' });
    });

    it('refuses an explicit host-method request when the current realm can serve none of it', () => {
        expect(prepareCallerHostedHtmlSurface({
            serverIdentityId: 'server-1', accountId: 'account-1', approvalSubject: 'record-1',
            source: artifactHtmlBundleFromBodyV1('<p>Hi</p>'),
            requestedCapabilities: {
                hostMethods: ['readResource'],
                resources: [{ pluginId: 'acme.preview', localId: 'status' }],
            },
            admittedHostMethods: ['context'],
            frameIdentity: { instanceId: 'instance-1', mountNonce: 'nonce-1' },
            hostOrigin: 'https://app.example.com',
        })).toEqual({ kind: 'rejected', code: 'capability_request_invalid' });
    });
});
