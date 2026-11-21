import { describe, expect, it } from 'vitest';
import { DeploymentTargetDomainResultV1ProtocolSchema, type DeploymentTargetDomainInputV1 } from '@happier-dev/plugin-sdk';
import type { PluginAccountActionContext } from '@happier-dev/plugin-sdk/actions';
import { createPluginHttpFixture } from '@happier-dev/plugin-sdk/testing';

import { railwayIdentity } from './account.js';
import { domainActions } from './domains.js';

const selection = { projectId: 'railway-project', environmentId: 'railway-environment', serviceId: 'railway-service' };
const hostname = 'app.example.test';
const account = { service: { pluginId: 'happier.machine.railway', localId: 'railway-account' }, accountId: 'fixture' };
const input = {
  v: 1, serverId: 'home', environmentId: 'happier-environment', expectedRevision: 1,
  credentialRef: account,
  credentialPrincipal: {
    kind: 'account', accountId: 'owner', purpose: { consumer: { pluginId: railwayIdentity.id, localId: 'domains-add' }, purpose: 'cloud-api' },
    target: { kind: 'account', account },
  },
  providerIdentity: { providerAccountId: selection.projectId, providerResourceId: selection.serviceId, providerEnvironment: selection.environmentId },
  providerEnvironment: { kind: 'native', selection },
  targetLinkId: 'link', expectedTargetLinkRevision: 1, domainId: 'happier-domain', domain: { hostname },
} satisfies DeploymentTargetDomainInputV1;

const routing = { type: 'CNAME', name: hostname, value: 'fixture.up.railway.app' };
const verification = { type: 'TXT', name: '_railway-verify.app.example.test', value: 'railway-verify=verification-token' };
const identity = { ...selection, id: 'railway-custom-domain', domain: hostname };
const domain = {
  ...identity,
  status: {
    verified: false, certificateStatus: 'CERTIFICATE_STATUS_TYPE_VALIDATING_OWNERSHIP',
    dnsRecords: [{ fqdn: routing.name, recordType: 'DNS_RECORD_TYPE_CNAME', requiredValue: routing.value, status: 'DNS_RECORD_STATUS_REQUIRES_UPDATE' }],
    verificationDnsHost: verification.name, verificationToken: 'verification-token',
  },
};

function listed(...customDomains: readonly unknown[]) {
  return { data: { domains: { customDomains, serviceDomains: [] } } };
}

function vendor(...answers: readonly (Readonly<{ status: number; body: unknown }> | Error)[]) {
  const documents: unknown[] = [];
  const http = createPluginHttpFixture({ async request(request) {
    expect(request).toMatchObject({
      url: 'https://backboard.railway.com/graphql/v2', method: 'POST',
      credentialBinding: { kind: 'connectedAccountPurpose', purpose: 'cloud-api', headerNames: ['authorization'] },
    });
    expect(new Headers(request.headers).has('authorization')).toBe(false);
    const answer = answers[documents.length];
    documents.push(JSON.parse(new TextDecoder().decode(request.body)));
    expect(answer).toBeDefined();
    if (answer instanceof Error) throw answer;
    return { status: answer.status, headers: {}, body: new TextEncoder().encode(JSON.stringify(answer.body)) };
  } });
  // These provider handlers use only invocation cancellation and brokered HTTP.
  const context = { signal: new AbortController().signal, services: { http } } as PluginAccountActionContext;
  return {
    documents,
    async invoke(action: keyof typeof domainActions, reviewedHostname: string | null = hostname, providerAssigned?: true) {
      return DeploymentTargetDomainResultV1ProtocolSchema.parse(await domainActions[action].run({ ...input, domain: { hostname: reviewedHostname, ...(providerAssigned ? { providerAssigned } : {}) } }, context));
    },
  };
}

const success = (body: unknown) => ({ status: 200, body });
const readDocument = { query: expect.stringContaining('domains(projectId:'), variables: selection };
const deleteDocument = { query: expect.stringContaining('customDomainDelete(id:'), variables: { id: identity.id } };

describe('Railway provider-assigned Domain Actions', () => {
  const assigned = { ...selection, id: 'railway-generated-domain', domain: 'backend-production.up.railway.app', syncStatus: 'ACTIVE' };

  it('requests one hostname for the reviewed service and returns the assigned name', async () => {
    const api = vendor(success({ data: { serviceDomainCreate: assigned } }));
    await expect(api.invoke('domains-add', null)).resolves.toEqual({
      v: 1, hostname: assigned.domain, state: 'active', dns: [],
    });
    expect(api.documents).toEqual([{
      query: expect.stringContaining('serviceDomainCreate(input:'),
      variables: { input: { environmentId: selection.environmentId, serviceId: selection.serviceId } },
    }]);
  });

  it('recovers only the reviewed provider-assigned hostname from a service with several addresses', async () => {
    const other = { ...assigned, id: 'other-generated', domain: 'other-production.up.railway.app' };
    const response = success({ data: { domains: { customDomains: [domain], serviceDomains: [other, assigned] } } });
    const api = vendor(response, response);
    await expect(api.invoke('domains-verify', assigned.domain, true)).resolves.toMatchObject({
      hostname: assigned.domain, state: 'active',
    });
    await expect(api.invoke('domains-verify', hostname, true)).rejects.toMatchObject({ code: 'deployment_unavailable' });
    expect(api.documents).toEqual([readDocument, readDocument]);
  });

  it('removes the exact assigned address through the same Domain role', async () => {
    const api = vendor(
      success({ data: { domains: { customDomains: [], serviceDomains: [assigned] } } }),
      success({ data: { serviceDomainDelete: true } }),
      success(listed()),
    );
    await expect(api.invoke('domains-remove', assigned.domain)).resolves.toMatchObject({ hostname: assigned.domain, state: 'removed' });
    expect(api.documents).toEqual([readDocument, {
      query: expect.stringContaining('serviceDomainDelete(id:'), variables: { id: assigned.id },
    }, readDocument]);
  });
});

describe('Railway custom Domain Actions through brokered HTTP', () => {
  it('returns the routing and ownership DNS, then waits for an issued certificate before reporting active', async () => {
    const dnsReady = { ...domain.status, verified: true, certificateStatus: 'CERTIFICATE_STATUS_TYPE_ISSUING',
      dnsRecords: [{ ...domain.status.dnsRecords[0], status: 'DNS_RECORD_STATUS_PROPAGATED' }],
      verificationToken: null, verificationDnsHost: null };
    const api = vendor(
      success({ data: { customDomainCreate: domain } }),
      success(listed({ ...domain, status: dnsReady })),
      success(listed({ ...domain, status: { ...dnsReady, certificateStatus: 'CERTIFICATE_STATUS_TYPE_VALID' } })),
    );

    await expect(api.invoke('domains-add')).resolves.toEqual({ v: 1, hostname, state: 'pending', dns: [routing, verification] });
    await expect(api.invoke('domains-verify')).resolves.toEqual({ v: 1, hostname, state: 'pending', dns: [] });
    await expect(api.invoke('domains-read')).resolves.toEqual({ v: 1, hostname, state: 'active', dns: [] });
    expect(api.documents).toEqual([
      { query: expect.stringContaining('customDomainCreate(input:'), variables: { input: { ...selection, domain: hostname } } },
      readDocument, readDocument,
    ]);
  });

  it('surfaces a failed certificate while preserving any DNS repair records', async () => {
    const api = vendor(success(listed({ ...domain, status: {
      ...domain.status, certificateStatus: 'CERTIFICATE_STATUS_TYPE_ISSUE_FAILED',
    } })));
    await expect(api.invoke('domains-verify')).resolves.toMatchObject({ hostname, state: 'failed', dns: [routing, verification] });
    expect(api.documents).toEqual([readDocument]);
  });

  it('never deletes a native ID whose hostname belongs to a different service', async () => {
    const api = vendor(success(listed({ ...identity, serviceId: 'other-railway-service' })));
    await expect(api.invoke('domains-remove')).rejects.toMatchObject({ code: 'target_mismatch' });
    expect(api.documents).toEqual([readDocument]);
  });

  it('treats an unsuccessful scoped read as uncertain, even with partial data reporting no domains', async () => {
    const api = vendor(success({ ...listed(), errors: [{ message: 'private vendor refusal' }] }));
    await expect(api.invoke('domains-remove')).rejects.toMatchObject({ code: 'provider_unavailable', message: 'provider_unavailable' });
    expect(api.documents).toEqual([readDocument]);
  });

  it('preserves known access refusal on Add', async () => {
    const api = vendor({ status: 403, body: { error: 'private vendor refusal' } });
    await expect(api.invoke('domains-add')).rejects.toMatchObject({ code: 'deployment_access_denied' });
    expect(api.documents).toHaveLength(1);
  });

  it('reports an unconfirmed Add after one write attempt', async () => {
    const api = vendor(new Error('private transport detail'));
    await expect(api.invoke('domains-add')).rejects.toMatchObject({ code: 'outcome_unknown', message: 'outcome_unknown' });
    expect(api.documents).toHaveLength(1);
  });

  it('settles a lost Remove response from observed absence without replaying the mutation', async () => {
    const api = vendor(success(listed(identity)), new Error('Remove response lost'), success(listed()));
    await expect(api.invoke('domains-remove')).resolves.toEqual({ v: 1, hostname, state: 'removed', dns: [] });
    expect(api.documents).toEqual([readDocument, deleteDocument, readDocument]);
  });

  it('does not report Removed while the scoped inventory still contains the hostname', async () => {
    const api = vendor(success(listed(identity)), success({ data: { customDomainDelete: true } }), success(listed(identity)));
    await expect(api.invoke('domains-remove')).rejects.toMatchObject({ code: 'outcome_unknown' });
    expect(api.documents).toEqual([readDocument, deleteDocument, readDocument]);
  });

  it('settles an already absent Domain without a remote write', async () => {
    const api = vendor(success(listed()));
    await expect(api.invoke('domains-remove')).resolves.toEqual({ v: 1, hostname, state: 'removed', dns: [] });
    expect(api.documents).toEqual([readDocument]);
  });
});
