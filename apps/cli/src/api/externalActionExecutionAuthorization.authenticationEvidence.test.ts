import axios from 'axios';
import nacl from 'tweetnacl';
import { afterEach, expect, it, vi } from 'vitest';
import { ExternalActionExecutionAuthorizationRequestV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { computeExternalActionRequestEnvelopeDigestV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { openExternalActionRequestV2 } from '@happier-dev/protocol/actions/externalActionEncryption';
import { projectExternalActionMachineRuntimeDemandV1 } from '@happier-dev/protocol/actions/actionSpecs';
import { prepareExternalActionRequesterAccountAuthorization, resolveExternalActionRootInvocationAuthority } from './externalActionExecutionAuthorization';

afterEach(() => vi.restoreAllMocks());

it.each([
  { mode: 'plain', actionId: 'template.draft' },
  { mode: 'plain', actionId: 'artifact.delete' },
  { mode: 'e2ee', actionId: 'template.draft' },
  { mode: 'e2ee', actionId: 'artifact.delete' },
] as const)('retains signed evidence while preparing $mode $actionId', async ({ mode, actionId }) => {
  const authentication = { kind: 'terminal' as const, tokenEpoch: 1,
    evidence: [{ kind: 'home_method' as const, methodId: 'email_password' }] };
  const token = `e30.${Buffer.from(JSON.stringify({ sub: 'requester', tokenEpoch: 1,
    provenance: { v: 2, kind: 'terminal', authority: 'account_automation', evidence: authentication.evidence },
  })).toString('base64url')}.signature`;
  const material = { type: 'dataKey' as const, machineKey: new Uint8Array(32).fill(21) };
  const target = { kind: 'machine' as const, machineId: 'machine' };
  const input = actionId === 'template.draft' ? { sourceSessionRef: { serverId: 'srv_evidence_home', sessionId: 'main' },
    content: { v: 1, identity: { name: 'Own draft', description: '' }, instructions: { markdown: '' },
      memoryRules: [], skills: [], needs: { software: [], connectedAccounts: [], mcpServers: [] } },
  } : { artifactId: 'own-draft', expectedRevision: { headerVersion: 1, bodyVersion: 1 } };
  const args = { actionId, input, requestId: 'evidence-request', target,
    machineId: 'machine', accountId: 'requester', accountEncryptionMode: mode, tokenEpochHint: 1, token,
    ...(mode === 'e2ee' ? { material } : {}), serverId: 'home-profile', serverIdentityId: 'srv_evidence_home',
    serverHttpBaseUrl: 'https://evidence-home.test', installationId: 'installation',
    privateKey: nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(18)).secretKey };
  let minted = false;
  vi.spyOn(axios, 'post').mockImplementation(async (url, body) => {
    if (String(url).endsWith('/verify')) return { status: 200, data: { ok: true } };
    minted = true;
    const request = ExternalActionExecutionAuthorizationRequestV1Schema.parse(body);
    expect(request.envelope.v).toBe(mode === 'e2ee' ? 2 : 1);
    if (request.envelope.v === 2) {
      expect(openExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1,
        envelope: request.envelope, material, binding: { serverIdentityId: args.serverIdentityId,
          accountId: args.accountId, authentication: { kind: authentication.kind, tokenEpoch: authentication.tokenEpoch },
          actionId, requestId: args.requestId, target } })?.input).toEqual(args.input);
      expect(JSON.stringify(body)).not.toContain('email_password');
    }
    return { status: 200, data: { v: 1, token: 'evidence-home-proof', binding: {
      serverIdentityId: args.serverIdentityId, accountId: args.accountId, authentication, actionId,
      requestId: args.requestId, target, machineId: args.machineId, custodianAccountId: args.accountId,
      installationId: args.installationId, accountEncryptionMode: mode,
      requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(request.envelope),
    } } };
  });
  const prepared = await prepareExternalActionRequesterAccountAuthorization(args);
  expect(minted).toBe(true);
  expect(prepared).toMatchObject({ token: 'evidence-home-proof', binding: { authentication } });
  // A terminal's original CLI invocation may be present-user, but the minted
  // root retains Home's automation floor when used for admitted continuations.
  expect(resolveExternalActionRootInvocationAuthority(prepared!)).toBe('account_automation');
});
