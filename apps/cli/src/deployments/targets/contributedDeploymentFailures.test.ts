import { expect, it } from 'vitest';
import { createContributedDeploymentTargetForHost } from './contributedDeploymentTargetForHost';
import { createContributedDomainActionsForHost } from './contributedDomainActionsForHost';

const unavailable = async (): Promise<never> => { throw new TypeError('Storage reader failed'); };
const base = { serverId: 'home', machineId: 'machine', serverHttpBaseUrl: 'https://home.test',
    credentials: { token: 'test-token', encryption: null }, readEnvironment: unavailable, readReceipt: unavailable };
const target = createContributedDeploymentTargetForHost({ ...base, resolveRequesterIdentity: unavailable,
    readEnvironmentMetadata: unavailable, readTargetLink: unavailable, readPreparedDeploymentContent: unavailable,
    assertCurrent: unavailable, createCandidate: unavailable, writeTransition: unavailable });

it('keeps uncoded log preparation errors in the shared Action vocabulary', async () => {
    await expect(target.prepareLogs({ context: {}, input: { kind: 'build', serverId: 'home',
        environmentId: 'environment', deploymentId: 'deployment' } }))
        .resolves.toMatchObject({ ok: false, errorCode: 'action_failed' });
});

it.each(['verify', 'remove'])('keeps a Domain %s storage preflight failure out of uncertain outcomes', async operation => {
    const domains = createContributedDomainActionsForHost({ ...base, target, storage: unavailable,
        dispatch: unavailable, readInstallation: unavailable, open: unavailable, createContent: unavailable,
        persistPreparedContent: unavailable, headers: unavailable, artifacts: { readForUpdate: unavailable } });
    await expect(domains.execute(`deployments.domains.${operation}`, { serverId: 'home',
        environmentId: 'environment', domainId: 'domain', expectedRevision: 1, expectedDomainRevision: 1, requestKey: 'test' },
    { hostReviewedChild: { preparedChildren: [{ role: `domains.${operation}`,
        action: { pluginId: 'fixture', localId: operation }, input: { domainId: 'domain' } }],
    invoke: unavailable } })).resolves.toMatchObject({ ok: false, errorCode: 'action_failed' });
});
