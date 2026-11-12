import { expect, it } from 'vitest';
import { createDomainDnsActionsForHost } from './domainDnsActionsForHost.js';
import { createHostReviewedChildPortV1 } from '@happier-dev/protocol/actions/executor/deploymentRoleChild';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import type { ActionExecutorContext } from '@happier-dev/protocol';

const actionId = 'deployments.domains.dns.create' as const;
const input = { serverId: 'home', environmentId: 'environment', domainId: 'domain', expectedDomainRevision: 4,
  expectedRevision: 2, requestKey: 'dns-create', dns: { action: { pluginId: 'happier.dns.route53', localId: 'records-create' },
    credentialRef: { service: { pluginId: 'happier.dns.route53', localId: 'aws' }, accountId: 'account' }, zoneId: 'Z123', ttl: 300 } };
const content = { hostname: 'app.example.test', target: { kind: 'provider' }, providerObservation: {
  v: 1, hostname: 'app.example.test', state: 'pending', dns: [{ name: 'app.example.test', type: 'A', value: '192.0.2.1' }] } };
const domain = { v: 1, id: 'domain', environmentId: 'environment', targetLinkId: 'link', revision: 4, state: 'pending',
  contentArtifactId: 'artifact', contentHeaderVersion: 1, contentBodyVersion: 1, createdByAccountId: 'owner', createdAtMs: 1, updatedAtMs: 1 };
it('admits the retained provider records and consumes them through the existing reviewed child issuer', async () => {
  // These host ports terminate authenticated storage/artifact reads; the Domain owner, parsers and child issuer are real.
  const host = {
    readEnvironment: async () => ({ environment: { revision: 2 } }),
    storage: async () => ({ ok: true, environmentId: 'environment', revision: 2, domain }),
    open: async () => ({ artifactId: 'artifact', revision: { headerVersion: 1, bodyVersion: 1 },
      header: { kind: 'deployment-domain.v1', title: 'App' }, body: JSON.stringify(content) }),
  };
  const spec = getActionSpec(actionId);
  expect(spec.inputSchema.parse(input)).toEqual(input);
  expect(spec.executionPlacement).toBe('machine');
  expect(spec.sideEffectClass).toBe('write');
  const owner = createDomainDnsActionsForHost(host as Parameters<typeof createDomainDnsActionsForHost>[0]);
  const context: ActionExecutorContext = { surface: 'cli', authority: 'present_user', serverId: 'home', signal: new AbortController().signal };
  const plan = await owner({ actionId, input, context });
  expect(plan).toMatchObject({ children: [{ action: input.dns.action, input: { name: 'app.example.test.', values: ['192.0.2.1'], ttl: 300 } }] });
  if (!plan || !('children' in plan)) throw new Error('Missing admitted child plan');
  const effects: unknown[] = [];
  const port = createHostReviewedChildPortV1({ actionId, input, context, plan,
    policies: plan.children.map(child => ({ action: child.action, role: child.role!, surface: 'cli' as const })), reviewAdmitted: true,
    // The plugin gateway is the effect boundary; it receives the actual admitted Action envelope.
    execute: async envelope => { effects.push(envelope); return { ok: true, result: { kind: 'pending', changeId: '/change/C123' } }; },
  });
  expect(await owner.execute(actionId, input, { ...context, hostReviewedChild: port })).toMatchObject({ ok: true,
    result: { ok: true, domainId: 'domain', records: [{ name: 'app.example.test.', type: 'A', result: { kind: 'pending' } }] } });
  expect(effects).toHaveLength(1);
  expect(effects[0]).toMatchObject({ action: input.dns.action, input: { credentialRef: input.dns.credentialRef, name: 'app.example.test.', values: ['192.0.2.1'] } });
});
