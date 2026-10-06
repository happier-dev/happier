import { describe, expect, it } from 'vitest';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseConnectedAccountRequestAuthCapabilityDocument } from '@happier-dev/agents/request-auth';
import type { AgentConnectedAccountLaunchContributionV1 } from '@happier-dev/plugin-sdk/agents/runtime';

import { createConnectedAccountRequestAuthSubjectRegistry } from '@/daemon/connectedServices/requestAuth/ConnectedAccountRequestAuthSubjectRegistry';
import { createConnectedAccountRequestAuthService } from '@/daemon/connectedServices/requestAuth/ConnectedAccountRequestAuthService';
import { resolvePurposeTeamCredentialBindingIntentsFromHome } from '@/session/services/spawnConnectedServicesDefaults';
import { withRealForegroundAdmissionFixture } from './foregroundAdmission.testkit';
import { createExternalConnectedAccountForegroundFixture } from './prepareForegroundAdmission.connectedServices.testkit';

const nativeHomeLaunch: AgentConnectedAccountLaunchContributionV1 = {
  stateSharingDescriptor: {
    providerSupportStatus: 'supported',
    config: { supported: true, modes: ['copied'], entries: [{ path: 'config.toml', mode: 'force_copied' }] },
    state: { supported: true, modes: ['isolated'], entries: [], symlinkUnavailableDegradePolicy: 'degrade_to_isolated' },
    authIsolation: { mode: 'materialized_home', secretEntries: ['auth.json'] },
    nativeHome: { environmentKey: 'ACME_NATIVE_HOME', defaultRelativePath: '.acme-native-home' },
  },
};

const claimInput = {
  canonicalSessionId: 'canonical-session-external', httpPort: 40123,
  foregroundSatisfiedProfileSecretRequirementNames: [],
} as const;

describe('foreground Connected Account custody through real authored Agent activation', () => {
  it.each([
    { label: 'a novel service', service: { pluginId: 'acme.connected-account', localId: 'credential' } },
    { label: 'a legacy-mapped service', service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' } },
  ] as const)('activates an external Agent request-auth capability for $label without host-issued compatibility provenance', async ({ service }) => {
    const revision = 'csr_0123456789ABCDEFGHJKMNPQRS';
    const account = createExternalConnectedAccountForegroundFixture({
      service, materializationKinds: ['httpHeaders'],
      launch: { requestAuthUses: [{ purpose: 'primary', materialization: { kind: 'httpHeaders', origin: 'https://api.example.test', headerNames: ['authorization'] } }] },
      resolveCredentialRevision: async () => revision,
      // The opaque Account materializer is a system boundary. Real purpose
      // currentness and the request-auth broker fence this returned material.
      materializeAccount: async ({ account, request, credentialRevisionBasis }) => {
        if (request.kind !== 'httpHeaders') throw new Error('Unexpected Account materialization kind');
        credentialRevisionBasis?.captureCredentialRevision(revision);
        return { kind: 'httpHeaders', headers: { authorization: `Bearer ${account.accountId}-${revision}` } };
      },
    });
    await withRealForegroundAdmissionFixture({ plugins: account.plugins, runtimeOptions: { connectedAccounts: account.owner } }, async (fixture) => {
      const registry = createConnectedAccountRequestAuthSubjectRegistry();
      const admitted = await fixture.prepare(account.requestFor(fixture.runtime.registry), {
        ...account.dependencies, connectedServicesMaterializationBaseDir: join(fixture.directory, 'materialized'),
        connectedAccountRequestAuthRegistry: registry, resolveConnectedAccountRequestAuthHttpPort: () => 43123,
      });
      expect(admitted.ok).toBe(true);
      if (!admitted.ok) throw new Error(admitted.error.code);
      const claimed = await admitted.prepared.claim(claimInput);
      expect(claimed.ok).toBe(true);
      if (!claimed.ok) throw new Error(claimed.error.code);
      const capabilityPath = claimed.environment.HAPPIER_CONNECTED_ACCOUNT_REQUEST_AUTH_CAPABILITY_PATH;
      expect(capabilityPath).toContain('qualified-request-auth');
      const capability = parseConnectedAccountRequestAuthCapabilityDocument(JSON.parse(await readFile(capabilityPath!, 'utf8')));
      if (!capability) throw new Error('Canonical request-auth capability was not published');
      expect(capability.httpPort).toBe(43123);
      expect(capability.materializationId).toBe('session-1');
      const subject = registry.authenticate(capability.capability);
      if (!subject) throw new Error('Published capability has no active subject');
      expect(subject.legacyServiceKeyedCompatibility).toBeUndefined();
      expect(subject.subjectId).toBe('agent-session:canonical-session-external');
      const broker = createConnectedAccountRequestAuthService({
        resolveCurrentBinding: async ({ subject, binding }) => await account.owner.resolveCurrentRequestAuthBinding({
          subjectId: subject.subjectId, binding, signal: new AbortController().signal,
        }),
        materializeBearer: async ({ subject, binding, resolved, materialization }) => await account.owner.materializeRequestAuthBearer({
          subjectId: subject.subjectId, binding, resolved, materialization, signal: new AbortController().signal,
        }),
        refreshAfterAuthFailure: async () => { throw new Error('No external auth failure occurred'); },
        reportQuotaFailure: async () => { throw new Error('No external quota failure occurred'); },
      });
      expect(JSON.stringify(claimed)).not.toContain(revision);
      await expect(broker.lookupRequestAuth({ subject, purpose: account.purpose })).resolves.toMatchObject({
        accessToken: `selected-account-${revision}`,
        credentialContext: { account: { service, accountId: 'selected-account' }, credentialRevision: revision },
      });
      await admitted.prepared.cleanup();
      expect(registry.authenticate(capability.capability)).toBeNull();
      await expect(stat(capabilityPath!)).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(broker.lookupRequestAuth({ subject, purpose: account.purpose })).rejects.toMatchObject({ code: 'request_auth_not_active' });
    });
  });

  it('admits a durable Team default and hands its exact Home slot binding to Session creation', async () => {
    const service = { pluginId: 'acme.connected-account', localId: 'credential' } as const;
    const account = createExternalConnectedAccountForegroundFixture({
      service, materializationKinds: ['files'],
      materializeAccount: async () => { throw new Error('Admission does not open Team material'); },
    });
    const selection = {
      source: 'team_resource', resourceId: 'resource-acme', deliveryMode: 'direct',
      disclosedMember: { service, accountId: 'source-member' },
    } as const;
    await account.store.update(() => ({ v: 1, bindings: [], teamResourceSelections: [{ purpose: account.purpose, teamId: 'team-acme', selection }] }));
    const resource = {
      id: 'resource-acme', teamId: 'team-acme', displayName: 'Acme credential',
      resourceRevision: 4, readiness: { kind: 'available' as const }, recoveryAction: null,
      mayBroker: false, mayReceiveDirect: true, directMaterialState: 'current' as const,
      sessionUsePolicy: 'personal_allowed' as const, providerModels: [],
      connectedServiceSelections: [selection], sourcePresentation: { kind: 'connected_service' as const, service },
    };
    await withRealForegroundAdmissionFixture({ plugins: account.plugins, runtimeOptions: { connectedAccounts: account.owner } }, async (fixture) => {
      const admit = async (attemptId: string, resources: readonly (typeof resource)[], withHome = true) => await fixture.prepare({
        ...account.requestFor(fixture.runtime.registry), attemptId,
      }, {
        ...account.dependencies,
        ...(withHome ? {
          resolveSessionTeamCredentialBindingIntents: async ({ teamResourceSelections }) => await resolvePurposeTeamCredentialBindingIntentsFromHome({
            teamResourceSelections,
            // The Home catalog is the network projection boundary; its
            // canonical defaults owner resolves these values into slot intent.
            resolveTeamCredentialResourceCatalog: async () => ({ serverId: 'home-a', accountId: 'recipient', resources }),
          }),
        } : {}),
      });
      const admitted = await admit('attempt-team-slot', [resource]);
      expect(admitted.ok).toBe(true);
      if (!admitted.ok) throw new Error(admitted.error.code);
      expect(admitted.prepared.teamCredentialBindings).toEqual([{
        v: 1, slot: { kind: 'connected_service_purpose', purpose: account.purpose },
        resourceId: 'resource-acme', expectedResourceRevision: 4, deliveryMode: 'direct', teamId: 'team-acme',
      }]);
      await admitted.prepared.cleanup();
      await expect(admit('attempt-team-withdrawn', [])).resolves.toMatchObject({ ok: false, error: { code: 'provider_binding_changed' } });
      await expect(admit('attempt-team-no-home', [resource], false)).resolves.toMatchObject({ ok: false, error: { code: 'provider_agent_runtime_unsupported' } });
    });
  });

  it('materializes exact-account opaque credentials into an isolated native home without changing the persistent home', async () => {
    const service = { pluginId: 'happier.agent.codex', localId: 'openai-codex' } as const;
    const persistentAuth = new Uint8Array([11, 22, 33, 44]);
    const selectedAuth = new Uint8Array([0, 255, 17, 99]);
    let replaceDuringMaterialization = false;
    const account = createExternalConnectedAccountForegroundFixture({
      service, materializationKinds: ['files'], launch: nativeHomeLaunch,
      materializeAccount: async ({ account: selected, request }) => {
        expect(selected.accountId).toBe('selected-account');
        expect(request).toEqual({ kind: 'files', fileIds: ['auth.json'] });
        if (replaceDuringMaterialization) await account.store.update(current => ({
          ...current, bindings: [{ purpose: account.purpose, target: { kind: 'account', account: { service, accountId: 'replacement-account' } } }],
        }));
        return { kind: 'files', files: { 'auth.json': selectedAuth } };
      },
    });
    await withRealForegroundAdmissionFixture({ plugins: account.plugins, runtimeOptions: { connectedAccounts: account.owner } }, async (fixture) => {
      const sourceRoot = join(fixture.directory, 'persistent-home');
      await mkdir(sourceRoot, { recursive: true });
      await writeFile(join(sourceRoot, 'auth.json'), persistentAuth);
      await writeFile(join(sourceRoot, 'config.toml'), 'profile-source\n');
      const baseDir = join(fixture.directory, 'materialized');
      const admit = async (attemptId: string) => await fixture.prepare({ ...account.requestFor(fixture.runtime.registry), attemptId }, {
        ...account.dependencies, connectedServicesMaterializationBaseDir: baseDir,
      });
      const admitted = await admit('attempt-native-home');
      expect(admitted.ok).toBe(true);
      if (!admitted.ok) throw new Error(admitted.error.code);
      const claimed = await admitted.prepared.claim({ ...claimInput, nativeHomeSourceEnvironmentValue: sourceRoot });
      expect(claimed.ok).toBe(true);
      if (!claimed.ok) throw new Error(claimed.error.code);
      const targetRoot = claimed.environment.ACME_NATIVE_HOME;
      expect(targetRoot).toBeTruthy();
      await expect(readFile(join(targetRoot!, 'auth.json'))).resolves.toEqual(Buffer.from(selectedAuth));
      await expect(readFile(join(targetRoot!, 'config.toml'), 'utf8')).resolves.toBe('profile-source\n');
      await expect(readFile(join(sourceRoot, 'auth.json'))).resolves.toEqual(Buffer.from(persistentAuth));
      await admitted.prepared.cleanup();
      await expect(stat(targetRoot!)).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(readFile(join(sourceRoot, 'auth.json'))).resolves.toEqual(Buffer.from(persistentAuth));

      replaceDuringMaterialization = true;
      const invalidated = await admit('attempt-native-home-invalidated');
      expect(invalidated.ok).toBe(true);
      if (!invalidated.ok) throw new Error(invalidated.error.code);
      await expect(invalidated.prepared.claim({ ...claimInput, nativeHomeSourceEnvironmentValue: sourceRoot })).resolves.toMatchObject({
        ok: false, error: { code: 'provider_agent_runtime_unsupported' },
      });
      await invalidated.prepared.cleanup();
      await expect(readFile(join(sourceRoot, 'auth.json'))).resolves.toEqual(Buffer.from(persistentAuth));

      replaceDuringMaterialization = false;
      await account.store.update(() => ({ v: 1, bindings: [] }));
      const unbound = await admit('attempt-native-unbound');
      expect(unbound.ok).toBe(true);
      if (!unbound.ok) throw new Error(unbound.error.code);
      const unboundClaim = await unbound.prepared.claim(claimInput);
      expect(unboundClaim.ok).toBe(true);
      if (!unboundClaim.ok) throw new Error(unboundClaim.error.code);
      expect(unboundClaim.environment).not.toHaveProperty('ACME_NATIVE_HOME');
      await unbound.prepared.cleanup();
    });
  });

  it('refuses external catalog Agents on the released service-keyed ingress instead of issuing compatibility provenance', async () => {
    const account = createExternalConnectedAccountForegroundFixture({
      service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' }, materializationKinds: ['files'],
      materializeAccount: async () => { throw new Error('Refused service-keyed launch must not open Account material'); },
    });
    await withRealForegroundAdmissionFixture({ plugins: account.plugins, runtimeOptions: { connectedAccounts: account.owner } }, async (fixture) => {
      await expect(fixture.prepare({ ...account.requestFor(fixture.runtime.registry), connectedServices: {
        v: 1, bindingsByServiceId: { 'openai-codex': { source: 'connected', profileId: 'selected-account' } },
      } }, account.dependencies)).resolves.toMatchObject({ ok: false, error: { code: 'provider_agent_runtime_unsupported' } });
    });
  });

  it('refuses a selected service absent from the real leased Codex manifest projection', async () => {
    await withRealForegroundAdmissionFixture({}, async (fixture) => {
      const admission = await fixture.prepare({ connectedServices: {
        v: 1, bindingsByServiceId: { 'anthropic': { source: 'connected', profileId: 'must-not-materialize' } },
      } });
      expect(admission).toMatchObject({ ok: false, error: { code: 'provider_agent_runtime_unsupported' } });
    });
  });
});
