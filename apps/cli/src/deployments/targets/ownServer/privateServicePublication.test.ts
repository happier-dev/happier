import { expect, it } from 'vitest';
import { projectNativeComposeReview } from '@/workspaces/projectSetup/nativeComposeReview';
import type { MachinePrivateNetworkObservationV1 } from '@happier-dev/protocol/plugins/contributions/accessProviders';
import { privateServicePublicationBindings } from './privateServicePublication';

const network: MachinePrivateNetworkObservationV1 = { provider: { kind: 'builtin', id: 'tailscale' },
    networkIdentity: 'shop-net', displayName: 'Shop', dnsName: null, addresses: ['100.81.1.12'],
    state: 'ready', interfaceName: 'tailscale0', sourceRanges: ['100.64.0.0/10'], magicDnsEnabled: false };
const exported = { key: 'database', service: 'db', containerPort: 5432, scheme: 'postgres',
    exposure: 'privateNetwork' as const, privateNetwork: 'shop-net' };
const review = (host_ip: string) => projectNativeComposeReview({ services: { db: { ports: [
    { target: 5432, published: '15432', host_ip, protocol: 'tcp' },
] } } }, '/release', value => value);

it('uses the effective saved publication and observed interface and source ranges for the same private Network', () => {
    expect(privateServicePublicationBindings({ environmentId: 'environment-db', exports: [exported],
        services: review('100.81.1.12').services, privateNetworks: [network] })).toEqual({ environmentId: 'environment-db', bindings: [{
        exposure: { requirementId: 'database', exposure: 'privateNetwork', providerId: 'tailscale', networkIdentity: 'shop-net',
            hostAddress: '100.81.1.12', hostPort: 15432, containerPort: 5432, protocol: 'tcp' },
        interfaceName: 'tailscale0', sourceRanges: ['100.64.0.0/10'],
    }] });
});

it.each(['0.0.0.0', '127.0.0.1', '100.81.1.13'])('refuses a saved bind %s that is not an observed address of the selected Network', host => {
    expect(() => privateServicePublicationBindings({ environmentId: 'environment-db', exports: [exported],
        services: review(host).services, privateNetworks: [network] })).toThrow(expect.objectContaining({ code: 'private_scope_unenforceable' }));
});

it('refuses an exported container port that also retains a wildcard TCP publication', () => {
    const services = review('100.81.1.12').services;
    services[0]!.ports.push({ target: 5432, published: '25432', bindAddress: '0.0.0.0', protocol: 'tcp' });
    expect(() => privateServicePublicationBindings({ environmentId: 'environment-db', exports: [exported],
        services, privateNetworks: [network] })).toThrow(expect.objectContaining({ code: 'private_scope_unenforceable' }));
});
