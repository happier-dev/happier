import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { createManagedServiceEndpointProjectionV1 } from './managedServiceEndpointProjection';

function projectionInput() {
    return {
        sessionId: 'session-one',
        pluginId: 'opencode',
        contributionId: 'opencode/agent',
        serverId: 'opencode-server',
        instanceId: 'instance-one',
        immutableGenerationId: 'generation-one',
        custodyOwner: 'sessionRunner' as const,
        mode: 'managedSpawn' as const,
        endpoint: {
            baseUrl: 'http://127.0.0.1:4312',
            host: '127.0.0.1' as const,
            port: 4312,
        },
        process: {
            pid: 42,
            startIdentity: 'runner-start-42',
        },
        createdAtMs: 1_000,
    };
}

describe('managed service endpoint projection', () => {
    it('uses the retained immutable generation directly for custody', () => {
        const directCustody = projectionInput();
        const projection = createManagedServiceEndpointProjectionV1({
            ...directCustody,
            immutableGenerationId: 'generation-one',
        });

        expect(projection.immutableGenerationId).toBe('generation-one');
        expect(JSON.stringify(projection)).not.toContain(
            'generationFingerprint',
        );
    });

    it('admits only non-secret custody facts into its durable identity', () => {
        const rawHeader = 'Basic raw-secret';
        const secretDerivedFingerprint = createHash('sha256')
            .update(rawHeader)
            .digest('hex');
        const projection = createManagedServiceEndpointProjectionV1(
            projectionInput(),
        );
        const encoded = JSON.stringify(projection);

        expect(encoded).not.toContain(rawHeader);
        expect(encoded).not.toContain(secretDerivedFingerprint);
        expect(encoded).not.toMatch(/"headers"|"serverFingerprint"/u);
        expect(() => createManagedServiceEndpointProjectionV1({
            ...projectionInput(),
            headers: { authorization: rawHeader },
        } as never)).toThrow(/invalid/u);
        expect(() => createManagedServiceEndpointProjectionV1({
            ...projectionInput(),
            serverFingerprint: secretDerivedFingerprint,
        } as never)).toThrow(/invalid/u);
    });

    it('binds a non-secret exact Provider operation claim into projection identity', () => {
        const operationClaimId =
            'session-demand:session-one:provider-p';
        const claimed = createManagedServiceEndpointProjectionV1({
            ...projectionInput(),
            operationClaimId,
        });
        const unclaimed = createManagedServiceEndpointProjectionV1(
            projectionInput(),
        );

        expect(claimed.operationClaimId).toBe(operationClaimId);
        expect(claimed.projectionToken).not.toBe(
            unclaimed.projectionToken,
        );
        expect(() => createManagedServiceEndpointProjectionV1({
            ...projectionInput(),
            operationClaimId: ' ',
        })).toThrow(/invalid/u);
    });

    /**
     * The projection is what the read seam dials, so it applies the same
     * loopback-HTTP/remote-HTTPS admission rule as supervision.
     */
    it.each([
        ['a loopback host over plain http', 'http://127.0.0.1:4096', '127.0.0.1', 4096],
        ['a remote host over https', 'https://opencode.example.com', 'opencode.example.com', 443],
    ])('projects an attached endpoint on %s', (_label, baseUrl, host, port) => {
        const projection = createManagedServiceEndpointProjectionV1({
            ...projectionInput(),
            mode: 'externalAttach',
            process: null,
            endpoint: { baseUrl, host, port },
        });

        expect(projection.endpoint).toEqual({ baseUrl, host, port });
    });

    it('keeps HTTP endpoint projections on loopback and refuses URL credentials', () => {
        expect(() => createManagedServiceEndpointProjectionV1({
            ...projectionInput(),
            endpoint: { baseUrl: 'http://192.168.1.50:4096', host: '192.168.1.50', port: 4096 },
        })).toThrow(/invalid/u);
        expect(() => createManagedServiceEndpointProjectionV1({
            ...projectionInput(),
            mode: 'externalAttach',
            process: null,
            endpoint: { baseUrl: 'http://192.168.1.50:4096', host: '192.168.1.50', port: 4096 },
        })).toThrow(/invalid/u);
        expect(() => createManagedServiceEndpointProjectionV1({
            ...projectionInput(),
            mode: 'externalAttach',
            process: null,
            endpoint: {
                baseUrl: 'https://opencode:secret@example.com',
                host: 'example.com',
                port: 443,
            },
        })).toThrow(/invalid/u);
    });
});
