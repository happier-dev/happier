import { describe, expect, it } from 'vitest';
import { DeploymentDomainHeaderV1Schema } from '@happier-dev/protocol/deployments/deploymentDomainV1';
import { createOwnServerDomainActions, prepareOwnServerTeardownDomainReviewedChildren } from './ownServerDomainActions';

const unexpected = async (): Promise<never> => { throw new Error('Provider Domain retirement must not reach this port'); };

describe('Environment Domain retirement', () => {
    it.each([false, true])('reviews another target Link Domain only for whole Environment removal: %s', async removeEnvironment => {
        const domain = DeploymentDomainHeaderV1Schema.parse({ v: 1, id: 'runtime-domain', environmentId: 'environment',
            targetLinkId: 'runtime-link', revision: 1, state: 'active', contentArtifactId: 'runtime-domain-content',
            contentHeaderVersion: 1, contentBodyVersion: 1, createdByAccountId: 'owner', createdAtMs: 1, updatedAtMs: 1, provider: true });
        const result = await prepareOwnServerTeardownDomainReviewedChildren({ actionId: 'deployments.teardown', context: {},
            input: { serverId: 'home', environmentId: 'environment', targetLinkId: 'data-link', ...(removeEnvironment ? { removeEnvironment: true } : {}),
                expectedRevision: 1, expectedTargetLinkRevision: 1, requestKey: 'delete-project', reason: 'manual',
                contentArtifactId: 'receipt', contentHeaderVersion: 1, contentBodyVersion: 1 } }, {
            serverId: 'home', readEnvironment: unexpected, open: unexpected,
            // Home storage is the boundary; the real review owner must select the same scope as retirement.
            storage: async actionId => actionId === 'deployments.domains.list'
                ? { ok: true, environmentId: 'environment', revision: 1, domains: [domain], nextCursor: null }
                : unexpected(),
        });
        if (removeEnvironment) expect(result).toMatchObject({ ok: false, errorCode: 'unsupported_action' });
        else expect(result).toBeNull();
    });

    it.each([false, true])('leaves another target Link Domain untouched except whole Environment removal: %s', async removeEnvironment => {
        const domain = DeploymentDomainHeaderV1Schema.parse({ v: 1, id: 'runtime-domain', environmentId: 'environment',
            targetLinkId: 'runtime-link', revision: 1, state: 'active', contentArtifactId: 'runtime-domain-content',
            contentHeaderVersion: 1, contentBodyVersion: 1, createdByAccountId: 'owner', createdAtMs: 1, updatedAtMs: 1, provider: true });
        const retired: string[] = [];
        const actions = createOwnServerDomainActions({ serverId: 'home', machineId: 'machine',
            credentials: { token: 'fixture', encryption: null }, serverHttpBaseUrl: 'https://home.test',
            // Home storage returns all Environment Domains; retirement owns target selection.
            storage: async actionId => actionId === 'deployments.domains.list'
                ? { ok: true, environmentId: 'environment', revision: 1, domains: [domain], nextCursor: null }
                : unexpected(),
            open: async () => ({ artifactId: domain.contentArtifactId, revision: { headerVersion: 1, bodyVersion: 1 },
                header: { kind: 'deployment-domain.v1', title: 'app.example.test' },
                body: JSON.stringify({ hostname: 'app.example.test', target: { kind: 'provider' } }) }),
            retireProviderDomain: async ({ domain: selected }) => { retired.push(selected.id);
                return { ok: true, environmentId: 'environment', revision: 1, domain: { ...selected, deletedAtMs: 2 } }; },
            dispatch: unexpected, readEnvironment: unexpected,
            readReceipt: unexpected, readInstallation: unexpected, createContent: unexpected,
            persistPreparedContent: unexpected, headers: unexpected });
        expect(await actions.retireEnvironment({ environmentId: 'environment', targetLinkId: 'data-link', ...(removeEnvironment ? { removeEnvironment: true } : {}),
            expectedRevision: 1, requestKey: 'delete-project' }, {})).toBeNull();
        expect(retired).toEqual(removeEnvironment ? [domain.id] : []);
    });

    it('settles a provider removal that only created an approval request as a coded partial failure', async () => {
        const domain = DeploymentDomainHeaderV1Schema.parse({ v: 1, id: 'domain', environmentId: 'environment',
            targetLinkId: 'link', revision: 1, state: 'active', contentArtifactId: 'domain-content',
            contentHeaderVersion: 1, contentBodyVersion: 1, createdByAccountId: 'owner', createdAtMs: 1, updatedAtMs: 1, provider: true });
        const actions = createOwnServerDomainActions({ serverId: 'home', machineId: 'machine',
            credentials: { token: 'fixture', encryption: null }, serverHttpBaseUrl: 'https://home.test',
            // Home storage is the transport boundary: one page holding the provider Domain.
            storage: async actionId => actionId === 'deployments.domains.list'
                ? { ok: true, environmentId: 'environment', revision: 1, domains: [domain], nextCursor: null }
                : unexpected(),
            open: async () => ({ artifactId: 'domain-content', revision: { headerVersion: 1, bodyVersion: 1 },
                header: { kind: 'deployment-domain.v1', title: 'app.example.test' },
                body: JSON.stringify({ hostname: 'app.example.test', target: { kind: 'provider' } }) }),
            // The provider owner parked its removal behind a person's review instead of settling it.
            retireProviderDomain: async () => ({ kind: 'approval_request_created', artifactId: 'approval', actionId: 'deployments.domains.remove' }),
            dispatch: unexpected, readEnvironment: unexpected, readReceipt: unexpected, readInstallation: unexpected,
            createContent: unexpected, persistPreparedContent: unexpected, headers: unexpected });
        const result = await actions.retireEnvironment({ environmentId: 'environment', expectedRevision: 1, requestKey: 'teardown' }, {});
        expect(result).toMatchObject({ ok: false, errorCode: 'invalid_action_output',
            details: { domainId: 'domain', step: 'removeDomain', partial: true } });
    });
});
