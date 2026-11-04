import { describe, expect, it, vi } from 'vitest';
import axios from 'axios';
import { createPluginReloadController } from '@/plugins/runtime/reload/controller';
import { openDaemonSessionTeamCredentialProviderBinding } from '@/daemon/providers/sessionTeamCredentialProviderBindingComposition';
import { createManagedRunLaunchFixture } from '@/providers/lifecycle/managedRunLaunch.testkit';
import { resolveProviderSourceFacts } from '@/providers/registry/sourceFacts';
import { ProviderModelBindingSourceV1Schema } from '@happier-dev/protocol/providers/binding-compatibility';
import { TeamCredentialResourceReadInputV1Schema, TeamCredentialResourceCatalogEntryV1Schema } from '@happier-dev/protocol/teams/credentials/resourceV1';
import type { TeamCredentialResourceReadinessV1 } from '@happier-dev/protocol/teams/credentials/readinessV1';
import { readSessionTeamCredentialProviderModels } from './sessionTeamCredentialLaunch';
import { prepareSessionTeamCredentialLaunch } from '@/daemon/startup/prepareSessionTeamCredentialLaunch';
import { TeamPolicyV1Schema, NO_TEAM_CAPABILITIES_V1, resolveTeamAdmissionProjectionV1 } from '@happier-dev/protocol/teams';
import { qualifySessionTeamCredentialProviderModels } from '@/providers/broker/sessionTeamCredentialProviderBinding';

describe('Session Team runtime catalog', () => {
  it.each([false, true])('preserves worker qualification without Team experimental consent (experimental=%s)', async experimental => {
    const worker = await createManagedRunLaunchFixture({ experimental, acceptedCredentialFormats: ['raw', 'bearer'],
      catalogModels: [{ id: 'gpt-5.6-luna', name: 'GPT-5.6 Luna' }] });
    try {
      const source = resolveProviderSourceFacts(worker.record);
      const endpoint = source.endpointTemplates[0]!;
      const resource = TeamCredentialResourceCatalogEntryV1Schema.parse({
        id: 'resource', teamId: 'team', displayName: 'Team source', resourceRevision: 4,
        readiness: { kind: 'available' }, recoveryAction: null, mayBroker: true, mayReceiveDirect: false,
        directMaterialState: 'never_delivered', sessionUsePolicy: 'personal_allowed', connectedServiceSelections: [],
        sourcePresentation: { kind: 'provider', provider: {
          identity: { pluginId: 'acme.managed-run', localId: 'gateway' }, definitionRevision: 1,
        } },
        providerModels: [{ application: { agentTargetKey: worker.agentTargetKey,
          implementationIdentity: { pluginId: 'acme.managed-run', localId: 'gateway' },
          endpointTemplateId: endpoint.id, protocol: endpoint.protocol },
          descriptor: { id: 'gpt-5.6-luna', name: 'GPT-5.6 Luna' }, sourceRevision: 'source-v4', availability: 'available',
          confidence: 'account_unverified', sources: { manual: false, static: true, probe: false },
          sourceFacts: ProviderModelBindingSourceV1Schema.parse({ endpoint: {
            id: endpoint.id, protocol: endpoint.protocol, capabilities: endpoint.capabilities,
          }, credential: source.credential, compatibilityOverrides: source.compatibilityOverrides }),
          selection: { kind: 'team_credential_provider_model', resourceId: 'resource', teamId: 'team',
            expectedResourceRevision: 4, deliveryMode: 'brokered', agentTargetKey: worker.agentTargetKey, modelId: 'gpt-5.6-luna' },
        }],
      });
      const qualified = await qualifySessionTeamCredentialProviderModels({ resource, lease: worker.lease, agentId: worker.agentId });
      expect(qualified.providerModels[0]).toMatchObject({ availability: 'available', compatibility: { confirmed: true } });
      let catalogReads = 0;
      const pending = prepareSessionTeamCredentialLaunch({
        options: { directory: worker.happyHomeDir,
          modelSelection: { v: 1, ref: { agentTargetKey: worker.agentTargetKey, providerConnectionId: null, modelId: 'gpt-5.6-luna' }, updatedAt: 1 },
          teamCredentialBindings: [{ v: 1, slot: { kind: 'provider_model' }, resourceId: 'resource', teamId: 'team',
            expectedResourceRevision: 4, deliveryMode: 'brokered' }],
        }, agentId: worker.agentId, agentTargetKey: worker.agentTargetKey, executionMachineId: worker.machineId, lease: worker.lease,
        // Home HTTP is the boundary. Plugin admission, source facts, worker
        // qualification, catalog parsing and launch normalization stay real.
        homeDomainAction: async request => {
          if (request.actionId === 'teams.list') return { items: [{ id: 'team', name: 'Team',
            description: null, logo: null, archivedAt: null, recovery: null, counts: null,
            policy: TeamPolicyV1Schema.parse({ v: 1, sessionCreationPolicy: 'private_default', externalSharingPolicy: 'allowed',
              defaultSessionHistoryAccess: 'from_membership', admissionMode: 'invite_only', authenticationPolicy: null }), viewerRole: 'member',
            capabilities: { ...NO_TEAM_CAPABILITIES_V1, viewTeam: true }, admission: resolveTeamAdmissionProjectionV1(),
          }], nextCursor: null };
          catalogReads++;
          return { resources: [resource], nextCursor: null };
        },
      });
      await expect(pending).resolves.toMatchObject({ teamModelRow: { confidence: 'account_unverified', availability: 'available' } });
      expect(catalogReads).toBe(1);
    } finally { await worker.cleanup(); }
  });

  it('prepares an installed native Session from its accepted private model without controller discovery or fallback', async () => {
    const worker = await createManagedRunLaunchFixture();
    const source = resolveProviderSourceFacts(worker.record);
    const endpoint = source.endpointTemplates[0]!;
    const nativeDelivery = { managedId: 'managed', controllerInstallationId: 'controller-installation',
      guestInstallationId: 'guest-installation', bindingKey: 'binding', placeholderRef: 'placeholder',
      sourceRevision: 'source-1', providerTicket: 't'.repeat(43) };
    const binding = { v: 1 as const, slot: { kind: 'provider_model' as const }, resourceId: 'resource', teamId: 'team',
      expectedResourceRevision: 1, deliveryMode: 'vendor-native' as const, nativeDelivery };
    const row = { selection: { kind: 'team_credential_provider_model' as const, resourceId: binding.resourceId,
      teamId: binding.teamId, expectedResourceRevision: binding.expectedResourceRevision, deliveryMode: binding.deliveryMode, nativeDelivery,
      agentTargetKey: worker.agentTargetKey, modelId: 'model-a' },
      descriptor: { id: 'model-a', name: 'Model A' }, sourceRevision: 'source-1', availability: 'available' as const,
      nativeSource: { providerTicket: nativeDelivery.providerTicket },
      application: { agentTargetKey: worker.agentTargetKey, implementationIdentity: { pluginId: 'acme.managed-run', localId: 'gateway' },
        endpointTemplateId: endpoint.id, protocol: endpoint.protocol },
      sourceFacts: ProviderModelBindingSourceV1Schema.parse({ endpoint: { id: endpoint.id, protocol: endpoint.protocol, capabilities: endpoint.capabilities },
        credential: source.credential, compatibilityOverrides: source.compatibilityOverrides }) };
    let privateReads = 0;
    let current = row;
    const prepare = (readInstalled = true, accepted: typeof binding | null = binding) => prepareSessionTeamCredentialLaunch({
      options: { directory: worker.happyHomeDir, existingSessionId: 'session', teamCredentialBindings: [binding],
        modelSelection: { v: 1, updatedAt: 1, ref: { agentTargetKey: worker.agentTargetKey, providerConnectionId: null, modelId: 'model-a' } } },
      acceptedTeamCredentialBinding: accepted, executionMachineId: worker.machineId, lease: worker.lease,
      agentId: worker.agentId, agentTargetKey: worker.agentTargetKey,
      homeDomainAction: async () => { throw new Error('Installed native preparation reached controller discovery'); },
      ...(readInstalled ? { readInstalledTeamCredentialProviderModel: async () => { privateReads++; return current; } } : {}),
    });
    try {
      await expect(prepare()).resolves.toMatchObject({ teamModelRow: row });
      expect(privateReads).toBe(1);
      await expect(prepare(false)).rejects.toMatchObject({ code: 'team_credential_provider_selection_not_current' });
      await expect(prepare(true, null)).rejects.toMatchObject({ code: 'team_credential_provider_selection_not_current' });
      current = { ...row, sourceRevision: 'changed-source' };
      await expect(prepare()).rejects.toMatchObject({ code: 'team_credential_provider_selection_not_current' });
    } finally { await worker.cleanup(); }
  });
  it('carries Direct delivery through the real daemon composition before opening disclosed material', async () => {
    const controller = createPluginReloadController();
    const worker = await createManagedRunLaunchFixture({ controller });
    const source = resolveProviderSourceFacts(worker.record);
    const endpoint = source.endpointTemplates[0];
    if (!endpoint) throw new Error('Expected the real fixture Provider endpoint');
    const disclosureBoundary = new Error('Controlled Direct disclosure boundary reached');
    let disclosures = 0;
    let reads = 0;
    let readInput: unknown;
    const resource = TeamCredentialResourceCatalogEntryV1Schema.parse({
      id: 'resource', teamId: 'team', displayName: 'Team Pool', resourceRevision: 1,
      readiness: { kind: 'limit_reached', metric: 'inference_requests', resetsAtUtc: '2026-10-29T00:00:00.000Z' },
      recoveryAction: null, mayBroker: true, mayReceiveDirect: true, directMaterialState: 'current',
      sessionUsePolicy: 'personal_allowed', connectedServiceSelections: [],
      sourcePresentation: { kind: 'connected_service', service: { pluginId: 'acme.managed-run', localId: 'accounts' } },
      providerModels: [{
        application: { agentTargetKey: worker.agentTargetKey, implementationIdentity: { pluginId: 'acme.managed-run', localId: 'gateway' },
          endpointTemplateId: 'responses', protocol: 'openai-responses' },
        descriptor: { id: 'model-a', name: 'Model A' }, sourceRevision: 'source-v1', availability: 'available',
        sourceFacts: ProviderModelBindingSourceV1Schema.parse({
          endpoint: { id: endpoint.id, protocol: endpoint.protocol, capabilities: endpoint.capabilities },
          credential: source.credential, compatibilityOverrides: source.compatibilityOverrides,
        }),
        selection: { kind: 'team_credential_provider_model', resourceId: 'resource', teamId: 'team',
          expectedResourceRevision: 1, deliveryMode: 'direct', agentTargetKey: worker.agentTargetKey, modelId: 'model-a' },
        direct: { sourceMemberKey: 'provider:source-member', sourceVersion: 'source-v1' },
      }],
    });
    // Home HTTP and Direct disclosure are genuine external boundaries. The
    // composition, lease, catalog transport and admission remain production code.
    const home = vi.spyOn(axios, 'request').mockImplementation(async request => {
      readInput = request.data;
      const input = TeamCredentialResourceReadInputV1Schema.parse(request.data);
      expect(input.application?.agentTargetKey).toBe(worker.agentTargetKey);
      reads++;
      return { status: 200, data: { resources: [resource], nextCursor: null } };
    });
    try {
      await expect(openDaemonSessionTeamCredentialProviderBinding({ sessionId: 'session', teamId: 'team',
        resourceId: 'resource', expectedResourceRevision: 1, deliveryMode: 'direct', agentId: worker.agentId,
        agentTargetKey: worker.agentTargetKey, modelId: 'model-a', signal: new AbortController().signal,
      }, { machineId: worker.machineId, accountId: 'recipient', serverId: 'home', serverHttpBaseUrl: 'https://home.test',
        credentials: { token: 'synthetic-recipient-token', encryption: null }, happyHomeDir: worker.happyHomeDir, controller,
        resolveTrustRoots: () => [], openTeamDirect: async () => { disclosures++; throw disclosureBoundary; },
      })).rejects.toBe(disclosureBoundary);
      expect(reads).toBe(1);
      expect(readInput).toMatchObject({ executionMachineId: worker.machineId });
      expect(disclosures).toBe(1);
    } finally { home.mockRestore(); await worker.cleanup(); }
  });
  it.each([
    { deliveryMode: 'direct', readiness: { kind: 'limit_reached', metric: 'inference_requests', resetsAtUtc: '2026-10-29T00:00:00.000Z' }, code: null },
    { deliveryMode: 'brokered', readiness: { kind: 'limit_reached', metric: 'inference_requests', resetsAtUtc: '2026-10-29T00:00:00.000Z' }, code: 'team_credential_usage_limit' },
    { deliveryMode: 'direct', readiness: { kind: 'source_unavailable', reason: 'connected_service_credential_reconnect_required' }, code: 'connected_service_credential_reconnect_required' },
    { deliveryMode: 'brokered', readiness: { kind: 'source_unavailable', reason: 'connected_service_credential_reconnect_required' }, code: 'connected_service_credential_reconnect_required' },
    { deliveryMode: 'brokered', readiness: { kind: 'update_required' }, code: 'update_required' },
  ] satisfies readonly { deliveryMode: 'direct' | 'brokered'; readiness: TeamCredentialResourceReadinessV1; code: string | null }[])(
    'retains runtime readiness for $deliveryMode / $readiness.kind', async ({ deliveryMode, readiness, code }) => {
      const worker = await createManagedRunLaunchFixture();
      try {
        const resource = TeamCredentialResourceCatalogEntryV1Schema.parse({
          id: 'resource', teamId: 'team', displayName: 'Team Pool', resourceRevision: 1,
          readiness, recoveryAction: null, mayBroker: true, mayReceiveDirect: true,
          directMaterialState: 'current', sessionUsePolicy: 'personal_allowed', connectedServiceSelections: [],
          sourcePresentation: { kind: 'connected_service', service: { pluginId: 'acme.managed-run', localId: 'accounts' } },
          providerModels: code ? [] : [{
            application: { agentTargetKey: worker.agentTargetKey, implementationIdentity: { pluginId: 'acme.managed-run', localId: 'gateway' },
              endpointTemplateId: 'responses', protocol: 'openai-responses' },
            descriptor: { id: 'model-a', name: 'Model A' }, sourceRevision: 'source-v1', availability: 'available',
            selection: { kind: 'team_credential_provider_model', resourceId: 'resource', teamId: 'team',
              expectedResourceRevision: 1, deliveryMode, agentTargetKey: worker.agentTargetKey, modelId: 'model-a' },
          }],
        });
        let reads = 0;
        const pending = readSessionTeamCredentialProviderModels({
          lease: worker.lease, agentId: worker.agentId, agentTargetKey: worker.agentTargetKey,
          resourceId: resource.id, teamId: resource.teamId, deliveryMode, signal: new AbortController().signal,
          homeDomainAction: async () => { reads++; return { resources: [resource], nextCursor: null }; },
        });
        if (code) await expect(pending).rejects.toMatchObject({ code, phase: 'readiness' });
        else await expect(pending).resolves.toEqual(resource.providerModels);
        expect(reads).toBe(1);
      } finally { await worker.cleanup(); }
    },
  );
  it('qualifies a runtime open with the locally admitted external Agent application', async () => {
    const worker = await createManagedRunLaunchFixture();
    try {
      const application = { agentTargetKey: worker.agentTargetKey,
        implementationIdentity: { pluginId: 'acme.managed-run', localId: 'gateway' },
        endpointTemplateId: 'responses', protocol: 'openai-responses' };
      const resource = TeamCredentialResourceCatalogEntryV1Schema.parse({
        id: 'resource', teamId: 'team', displayName: 'Team Pool', resourceRevision: 1,
        readiness: { kind: 'available' }, recoveryAction: null, mayBroker: true, mayReceiveDirect: false,
        directMaterialState: 'never_delivered', sessionUsePolicy: 'personal_allowed', connectedServiceSelections: [],
        sourcePresentation: { kind: 'connected_service', service: { pluginId: 'acme.managed-run', localId: 'accounts' } },
        providerModels: [{ application, descriptor: { id: 'gpt-5.5', name: 'GPT-5.5' }, sourceRevision: 'source-v1', availability: 'available',
          selection: { kind: 'team_credential_provider_model', resourceId: 'resource', teamId: 'team',
            expectedResourceRevision: 1, deliveryMode: 'brokered', agentTargetKey: worker.agentTargetKey, modelId: 'gpt-5.5' } }],
      });
      const seen: unknown[] = [];
      let current: typeof resource | null = resource;
      const siblings = Array.from({ length: 350 }, (_, index) => ({ ...resource, id: `sibling-${index}`,
        providerModels: resource.providerModels.map(model => ({ ...model,
          selection: { ...model.selection, resourceId: `sibling-${index}` } })) }));
      const selectedApplication = resource.providerModels[0]!.application;
      const read = (application?: typeof selectedApplication) => readSessionTeamCredentialProviderModels({
        lease: worker.lease, agentId: worker.agentId, agentTargetKey: worker.agentTargetKey,
        resourceId: 'resource', teamId: 'team', deliveryMode: 'brokered', signal: new AbortController().signal,
        ...(application ? { application } : {}),
        homeDomainAction: async request => {
          const input = TeamCredentialResourceReadInputV1Schema.parse(request.input);
          seen.push(input);
          // Model Home's paginated HTTP boundary; internal catalog/application logic stays real.
          const inventory = input.application ? [...siblings, ...(current ? [current] : [])] : [];
          const selected = 'resourceId' in input ? inventory.filter(row => row.id === input.resourceId) : inventory;
          const offset = Number(input.cursor ?? 0);
          return { resources: selected.slice(offset, offset + input.limit),
            nextCursor: offset + input.limit < selected.length ? String(offset + input.limit) : null };
        },
      });
      const rows = await read();
      expect(rows).toEqual(resource.providerModels);
      expect(seen).toMatchObject([{ teamId: 'team', application: {
        agentTargetKey: worker.agentTargetKey,
        implementationIdentity: { pluginId: 'acme.managed-run', localId: 'gateway' },
        endpointTemplateId: 'responses', protocol: 'openai-responses',
      } }]);
      current = TeamCredentialResourceCatalogEntryV1Schema.parse({ ...resource, resourceRevision: 2,
        providerModels: resource.providerModels.map(model => ({ ...model,
          selection: { ...model.selection, expectedResourceRevision: 2 } })),
      });
      expect(await read(selectedApplication)).toEqual(current.providerModels);
      expect(seen).toHaveLength(2);
      expect(seen[1]).toMatchObject({ application: selectedApplication, resourceId: resource.id });
      await expect(read({ ...selectedApplication, endpointTemplateId: 'retired-endpoint' }))
        .rejects.toMatchObject({ code: 'provider_incompatible_with_agent' });
      expect(seen).toHaveLength(2);
      current = null;
      await expect(read(selectedApplication)).resolves.toEqual([]);
      expect(seen).toHaveLength(3);
    } finally { await worker.cleanup(); }
  });
});
