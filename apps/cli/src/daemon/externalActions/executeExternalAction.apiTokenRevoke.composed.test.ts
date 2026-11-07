import axios from 'axios';
import { afterEach, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { FeaturesResponseSchema } from '@happier-dev/protocol/features/payload/featuresResponseSchema';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { createExternalMcpServer } from '@/mcp/createExternalMcpServer';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { resetServerFeaturesClientForTests } from '@/features/serverFeaturesClient';
import { withdrawActiveProjectAccountRowsSnapshot } from '@/workspaces/projectAccountRows';
import { createHarness, resetFilesystemApprovalSocketBoundary } from './executeExternalAction.filesystemApprovals.testkit';

afterEach(() => { vi.restoreAllMocks(); resetFilesystemApprovalSocketBoundary();
  withdrawActiveProjectAccountRowsSnapshot(); resetServerFeaturesClientForTests(); });

it('lets an MCP agent request token revocation, with no Home effect until the person approves', async () => {
  const h = await createHarness('account.apiTokens.revoke', 'ask', false, 'srv_n2', undefined, false, false,
    { authentication: 'account', machineCustodianAccountId: 'account', machineRole: 'manage' });
  const tokenId = 'dd03e74b-4aae-4a0a-81ee-1c23ddc4525d';
  const request = vi.mocked(axios.request).getMockImplementation();
  if (!request) throw new Error('Missing installed Home transport');
  let revoked = false;
  // HTTP is the genuine effect boundary; approval policy/replay and Account
  // dispatch remain the installed production owners.
  vi.mocked(axios.request).mockImplementation(async config => {
    if (new URL(String(config.url)).pathname !== '/v1/auth/api-tokens/revoke') return request(config);
    expect(config.data).toEqual({ tokenId });
    revoked = true;
    return { status: 200, data: { revoked: true } };
  });
  const { mcp } = runWithServerHttpBaseUrl('https://home.example.test', () => createExternalMcpServer({
    credentials: { token: h.installedToken, encryption: null, credentialProvenance: 'stored_session' },
    machineId: h.ref.machineId,
    serverFeaturesSnapshot: { status: 'ready', features: FeaturesResponseSchema.parse({ features: {},
      capabilities: { serverIdentity: { serverIdentityId: h.ref.serverId } } }) },
  }));
  const client = new Client({ name: 'token-revoke-agent', version: '1' });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  try {
    await mcp.connect(serverTransport);
    await client.connect(clientTransport);
    expect(getActionSpec('account.apiTokens.create').surfaces).toMatchObject({ agent: false, mcp: false });
    const result = CallToolResultSchema.parse(await client.callTool({ name: 'action_execute', arguments: {
      actionId: 'account.apiTokens.revoke', input: { tokenId },
    } }));
    expect(result.isError, JSON.stringify(result)).not.toBe(true);
    expect(h.hasApproval(), JSON.stringify(result)).toBe(true);
    expect(revoked).toBe(false);
    expect(await h.approval()).toMatchObject({ actionId: 'account.apiTokens.revoke', status: 'open' });
    const decided = await h.decideFromCli();
    expect(decided).toMatchObject({ ok: true });
    expect(revoked, JSON.stringify({ decided, approval: await h.approval(), paths: h.networkPaths })).toBe(true);
    // Creation remains the explicit owner-approved parity exception: its new
    // bearer must never become an Agent result, even behind a review card.
    const create = CallToolResultSchema.parse(await client.callTool({ name: 'action_execute', arguments: {
      actionId: 'account.apiTokens.create', input: { tokenId, label: 'Must stay human-only' },
    } }));
    expect(create.isError).toBe(true);
  } finally { await client.close(); await mcp.close(); await h.close(); }
});
