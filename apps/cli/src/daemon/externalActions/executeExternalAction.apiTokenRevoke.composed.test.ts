import axios from 'axios';
import { afterEach, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { FeaturesResponseSchema } from '@happier-dev/protocol/features/payload/featuresResponseSchema';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import {
  ACCOUNT_API_TOKENS_LIST_HTTP_PATH_V1,
  ACCOUNT_API_TOKENS_REVOKE_ALL_HTTP_PATH_V1,
  ACCOUNT_API_TOKENS_REVOKE_HTTP_PATH_V1,
} from '@happier-dev/protocol/auth/accountApiTokens';
import { ACCOUNT_SESSIONS_SIGN_OUT_EVERYWHERE_HTTP_PATH_V1 } from '@happier-dev/protocol/auth/accountSessions';
import { createExternalMcpServer } from '@/mcp/createExternalMcpServer';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { resetServerFeaturesClientForTests } from '@/features/serverFeaturesClient';
import { withdrawActiveProjectAccountRowsSnapshot } from '@/workspaces/projectAccountRows';
import { createHarness, resetFilesystemApprovalSocketBoundary } from './executeExternalAction.filesystemApprovals.testkit';

afterEach(() => { vi.restoreAllMocks(); resetFilesystemApprovalSocketBoundary();
  withdrawActiveProjectAccountRowsSnapshot(); resetServerFeaturesClientForTests(); });

const tokenId = 'dd03e74b-4aae-4a0a-81ee-1c23ddc4525d';
it.each([
  { actionId: 'account.apiTokens.list', path: ACCOUNT_API_TOKENS_LIST_HTTP_PATH_V1, input: {}, output: { tokens: [] }, summary: undefined },
  { actionId: 'account.apiTokens.revoke', path: ACCOUNT_API_TOKENS_REVOKE_HTTP_PATH_V1, input: { tokenId }, output: { revoked: true }, summary: undefined },
  { actionId: 'account.apiTokens.revokeAll', path: ACCOUNT_API_TOKENS_REVOKE_ALL_HTTP_PATH_V1, input: {}, output: { revokedCount: 1 }, summary: undefined },
  { actionId: 'account.sessions.signOutEverywhere', path: ACCOUNT_SESSIONS_SIGN_OUT_EVERYWHERE_HTTP_PATH_V1,
    input: {}, output: { status: 'signed_out' }, summary: /API tokens remain active/ },
  { actionId: 'account.sessions.signOutEverywhere', path: ACCOUNT_SESSIONS_SIGN_OUT_EVERYWHERE_HTTP_PATH_V1,
    input: { revokeApiTokens: true }, output: { status: 'signed_out' }, summary: /API tokens will be revoked/ },
] as const)('applies the default approval policy for MCP $actionId $input', async ({ actionId, path, input, output, summary }) => {
  const h = await createHarness(actionId, 'default', false, 'srv_n2', undefined, false, false,
    { authentication: 'account', machineCustodianAccountId: 'account', machineRole: 'manage' });
  const request = vi.mocked(axios.request).getMockImplementation();
  if (!request) throw new Error('Missing installed Home transport');
  let applied = false;
  // HTTP is the genuine effect boundary; approval policy/replay and Account
  // dispatch remain the installed production owners.
  vi.mocked(axios.request).mockImplementation(async config => {
    if (new URL(String(config.url)).pathname !== path) return request(config);
    expect(config.data).toEqual(input);
    applied = true;
    return { status: 200, data: output };
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
      actionId, input,
    } }));
    expect(result.isError, JSON.stringify(result)).not.toBe(true);
    if (actionId === 'account.apiTokens.list') {
      expect(h.hasApproval()).toBe(false);
      expect(applied, JSON.stringify(result)).toBe(true);
      return;
    }
    expect(h.hasApproval(), JSON.stringify(result)).toBe(true);
    expect(applied).toBe(false);
    expect(await h.approval()).toMatchObject({ actionId, status: 'open',
      ...(summary ? { summary: expect.stringMatching(summary) } : {}),
    });
    const decided = await h.decideFromCli();
    expect(decided).toMatchObject({ ok: true });
    expect(applied, JSON.stringify({ decided, approval: await h.approval(), paths: h.networkPaths })).toBe(true);
    // Creation remains the explicit owner-approved parity exception: its new
    // bearer must never become an Agent result, even behind a review card.
    const create = CallToolResultSchema.parse(await client.callTool({ name: 'action_execute', arguments: {
      actionId: 'account.apiTokens.create', input: { tokenId, label: 'Must stay human-only' },
    } }));
    expect(create.isError).toBe(true);
  } finally { await client.close(); await mcp.close(); await h.close(); }
});
