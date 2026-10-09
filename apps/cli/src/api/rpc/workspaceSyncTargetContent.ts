import { randomBytes } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import type { SocketRpcContent } from '@happier-dev/sync-client';
import { WorkspaceSyncSourceWriterTargetRoutingV1Schema, type WorkspaceSyncSourceWriterTargetRoutingV1 } from '@happier-dev/protocol/socketRpc';
import type { MachineInstallationIdentityV1, MachineInstallationPublicIdentityV1 } from '@happier-dev/protocol/machines/identity/installationIdentity';
import { decodeBase64, encodeBase64 } from '@happier-dev/protocol/crypto/base64';
import { deriveBoxPublicKeyFromEd25519PublicKey, deriveBoxPublicKeyFromSeed, deriveBoxSecretKeyFromSeed,
  openBoxBundleWithSecretKey, sealBoxBundle, isValidBoxBundlePublicKey } from '@happier-dev/protocol/crypto/boxBundle';

const recipient = { v: z.literal(1), machineId: z.string().min(1), installationId: z.string().min(1) };
const requestEnvelope = z.object({ ...recipient, kind: z.literal('workspace_sync_target_request_v1'), ciphertext: z.string().min(1) }).strict();
const responseEnvelope = z.object({ ...recipient, kind: z.literal('workspace_sync_target_response_v1'), ciphertext: z.string().min(1) }).strict();
const requestContent = z.object({ ...recipient, kind: z.literal('workspace_sync_target_request_v1'), method: z.string().min(1),
  routing: WorkspaceSyncSourceWriterTargetRoutingV1Schema, replyPublicKey: z.string().min(1), rpc: z.unknown() }).strict();
const responseContent = z.object({ ...recipient, kind: z.literal('workspace_sync_target_response_v1'), method: z.string().min(1),
  routing: WorkspaceSyncSourceWriterTargetRoutingV1Schema, rpc: z.unknown() }).strict();
const entropy = (length: number) => new Uint8Array(randomBytes(length));

/** Only this new private carrier selects installed-key decoding; ordinary Account RPC is unchanged. */
export function isWorkspaceSyncTargetInstalledContent(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  try {
    const parsed: unknown = JSON.parse(value);
    return !!parsed && typeof parsed === 'object' && 'kind' in parsed && parsed.kind === 'workspace_sync_target_request_v1';
  } catch { return false; }
}

/** One reply key per call; no destination Account key or retained transport cache. */
export function createWorkspaceSyncTargetContent(input: Readonly<{
  destination: MachineInstallationPublicIdentityV1;
  method: string;
  routing: WorkspaceSyncSourceWriterTargetRoutingV1;
}>): SocketRpcContent {
  const replySeed = entropy(32);
  const destination = { machineId: input.destination.machineId, installationId: input.destination.installationId };
  const publicKey = deriveBoxPublicKeyFromEd25519PublicKey(decodeBase64(input.destination.installationPublicKey, 'base64url'));
  return { mode: 'e2ee', cipher: {
    encryptRaw: async rpc => JSON.stringify({ v: 1, kind: 'workspace_sync_target_request_v1', ...destination,
      ciphertext: encodeBase64(sealBoxBundle({ recipientPublicKey: publicKey, randomBytes: entropy,
        plaintext: new TextEncoder().encode(JSON.stringify(requestContent.parse({ v: 1,
          kind: 'workspace_sync_target_request_v1', ...destination, method: input.method, routing: input.routing,
          replyPublicKey: encodeBase64(deriveBoxPublicKeyFromSeed(replySeed), 'base64url'), rpc }))) }), 'base64url') }),
    decryptRaw: async ciphertext => {
      try {
        const outer = responseEnvelope.parse(JSON.parse(ciphertext));
        if (outer.machineId !== destination.machineId || outer.installationId !== destination.installationId) return null;
        const opened = openBoxBundleWithSecretKey({ bundle: decodeBase64(outer.ciphertext, 'base64url'), recipientSecretKey: deriveBoxSecretKeyFromSeed(replySeed) });
        if (!opened) return null;
        const inner = responseContent.parse(JSON.parse(new TextDecoder().decode(opened)));
        return inner.machineId === destination.machineId && inner.installationId === destination.installationId
          && inner.method === input.method && isDeepStrictEqual(inner.routing, input.routing) ? inner.rpc : null;
      } catch { return null; }
    },
  } };
}

/** Captures only the exact verified request's reply recipient; bad boxes never fall back to Account decoding. */
export function openWorkspaceSyncTargetContent(input: Readonly<{
  ciphertext: string;
  installation: MachineInstallationIdentityV1;
  machineId: string;
  method: string;
  routing: WorkspaceSyncSourceWriterTargetRoutingV1;
}>): SocketRpcContent | null {
  try {
    const outer = requestEnvelope.parse(JSON.parse(input.ciphertext));
    if (outer.machineId !== input.machineId || outer.installationId !== input.installation.installationId) return null;
    const opened = openBoxBundleWithSecretKey({ bundle: decodeBase64(outer.ciphertext, 'base64url'),
      recipientSecretKey: deriveBoxSecretKeyFromSeed(decodeBase64(input.installation.privateKey, 'base64url').subarray(0, 32)) });
    if (!opened) return null;
    const inner = requestContent.parse(JSON.parse(new TextDecoder().decode(opened)));
    if (inner.machineId !== outer.machineId || inner.installationId !== outer.installationId
      || inner.method !== input.method || !isDeepStrictEqual(inner.routing, input.routing)) return null;
    const replyPublicKey = decodeBase64(inner.replyPublicKey, 'base64url');
    if (!isValidBoxBundlePublicKey(replyPublicKey)) return null;
    return { mode: 'e2ee', cipher: {
      decryptRaw: async ciphertext => ciphertext === input.ciphertext ? inner.rpc : null,
      encryptRaw: async rpc => JSON.stringify({ v: 1, kind: 'workspace_sync_target_response_v1',
        machineId: outer.machineId, installationId: outer.installationId,
        ciphertext: encodeBase64(sealBoxBundle({ recipientPublicKey: replyPublicKey, randomBytes: entropy,
          plaintext: new TextEncoder().encode(JSON.stringify(responseContent.parse({ v: 1,
            kind: 'workspace_sync_target_response_v1', machineId: outer.machineId, installationId: outer.installationId,
            method: input.method, routing: input.routing, rpc }))) }), 'base64url') }),
    } };
  } catch { return null; }
}
