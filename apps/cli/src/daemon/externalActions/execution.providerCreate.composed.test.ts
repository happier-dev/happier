import axios from 'axios';
import { afterEach, expect, it, vi } from 'vitest';
import { DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1, PROVIDER_CONNECTIONS_ROWS_ROUTE_V1,
  ProviderConnectionsRowMutationV1Schema } from '@happier-dev/protocol/providers/connections/connectionRowsV1';
import { createHarness, resetFilesystemApprovalSocketBoundary } from './executeExternalAction.filesystemApprovals.testkit';
import { PluginAvailabilityActionHttpPathsV1,
  PluginAvailabilityIntentsListActionOutputV1Schema } from '@happier-dev/protocol/plugins/availability';
import { readRequestedIntentPluginIds } from '@/testkit/http/accountPluginAvailability';

afterEach(() => { vi.restoreAllMocks(); resetFilesystemApprovalSocketBoundary(); });

it('creates an approved managed CLIProxyAPI gateway through installed daemon approval replay', async () => {
  const h = await createHarness('providers.connections.create_contribution');
  try {
    let catalog = DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1;
    let revision = 1;
    let writes = 0;
    const read = vi.mocked(axios.get).getMockImplementation()!;
    const write = vi.mocked(axios.post).getMockImplementation()!;
    // Substitute only Home HTTP. Admission, approval replay, custody and the
    // Provider row decoder/writer remain the installed production path.
    vi.mocked(axios.get).mockImplementation(async (url, ...args) => {
      if (new URL(String(url)).pathname === PROVIDER_CONNECTIONS_ROWS_ROUTE_V1)
        return { status: 200, data: { status: 'present', revision, content: { t: 'plain', v: catalog } } };
      return read(url, ...args);
    });
    vi.mocked(axios.post).mockImplementation(async (url, body, ...args) => {
      if (new URL(String(url)).pathname === PluginAvailabilityActionHttpPathsV1['account.plugins.availability.intents.list']) {
        const ids = readRequestedIntentPluginIds(body);
        return { status: 200, data: PluginAvailabilityIntentsListActionOutputV1Schema.parse({ availabilityCursor: 1,
          pluginIds: ids, failedPluginIds: [], intentReads: ids.map(pluginId => ({ pluginId, response: {
            availabilityCursor: 1, hostingCapability: { enabled: false }, intent: null,
            release: null, uiArtifacts: [], packageAssets: [],
          } })), nextCursor: null }) };
      }
      if (new URL(String(url)).pathname !== PROVIDER_CONNECTIONS_ROWS_ROUTE_V1) return write(url, body, ...args);
      const mutation = ProviderConnectionsRowMutationV1Schema.parse(body);
      expect(mutation.expectedRevision).toBe(revision);
      if (mutation.content?.t !== 'plain') throw new Error('Expected plain Provider row');
      catalog = mutation.content.v;
      writes++;
      revision++;
      return { status: 200, data: { status: 'updated', revision, cursor: revision } };
    });
    const input = { action: 'createContribution', connectionId: 'pc_gateway',
      contributionKey: 'happier.provider.cliproxyapi/cliproxyapi', displayName: 'QA gateway', savedSecretId: null, enable: false,
      deployment: { kind: 'managedLocal', purposeBindingDefaults: { 'openai-upstream': { kind: 'account',
        account: { service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' }, accountId: 'explicit-profile' } } } },
      gatewayPlacement: { kind: 'machine', machineId: 'machine' } };
    const proposal = await h.run(input, 'cli', false, 'present_user');
    expect(proposal, JSON.stringify(proposal)).toMatchObject({ ok: true });
    expect(writes).toBe(0);
    expect(h.hasApproval()).toBe(true);
    const decision = await h.decide('approve');
    expect(decision, JSON.stringify(decision)).toMatchObject({ ok: true });
    const approval = await h.approval();
    expect(approval.execution, JSON.stringify(approval.execution)).toMatchObject({ ok: true });
    expect(writes).toBe(1);
    expect(catalog.connections).toMatchObject([{ id: 'pc_gateway', deployment: { kind: 'managedLocal' },
      purposeBindingDefaults: input.deployment.purposeBindingDefaults,
      gatewayPlacement: input.gatewayPlacement }]);
  } finally { await h.close(); }
});

it('removes a Machine through cold approved Provider cleanup', async () => {
  const h = await createHarness('machines.remove');
  try {
    const read = vi.mocked(axios.get).getMockImplementation()!;
    const write = vi.mocked(axios.post).getMockImplementation()!;
    let revocations = 0;
    vi.mocked(axios.get).mockImplementation(async (url, ...args) => {
      if (new URL(String(url)).pathname === PROVIDER_CONNECTIONS_ROWS_ROUTE_V1)
        return { status: 200, data: { status: 'present', revision: 1,
          content: { t: 'plain', v: DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1 } } };
      return read(url, ...args);
    });
    vi.mocked(axios.post).mockImplementation(async (url, body, ...args) => {
      if (new URL(String(url)).pathname === '/v1/machines/machine/revoke') {
        revocations++;
        return { status: 200, data: { success: true } };
      }
      return write(url, body, ...args);
    });
    expect(await h.run({ machineId: 'machine' }, 'cli', false, 'present_user')).toMatchObject({ ok: true });
    expect(revocations).toBe(0);
    expect(await h.decide('approve')).toMatchObject({ ok: true });
    const approval = await h.approval();
    expect(approval.execution, JSON.stringify(approval.execution)).toMatchObject({ ok: true });
    expect(revocations).toBe(1);
  } finally { await h.close(); }
});
