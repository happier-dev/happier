import tweetnacl from 'tweetnacl';
import * as privacyKit from 'privacy-kit';
import { randomBytes } from 'node:crypto';

import { fetchJson } from './http';

export type TestAuth = {
  token: string;
  publicKeyBase64: string;
};

export type TestAuthMtls = {
  token: string;
};

export async function createTestAuth(baseUrl: string): Promise<TestAuth> {
  const kp = tweetnacl.sign.keyPair();
  // privacy-kit Bytes is `Uint8Array<ArrayBuffer>`; ensure our buffers are compatible across TS libs.
  const publicKey = Uint8Array.from(kp.publicKey);
  const secretKey = Uint8Array.from(kp.secretKey);
  const challenge = Uint8Array.from(randomBytes(32));
  const signature = Uint8Array.from(tweetnacl.sign.detached(challenge, secretKey));

  const body = {
    publicKey: privacyKit.encodeBase64(publicKey),
    challenge: privacyKit.encodeBase64(challenge),
    signature: privacyKit.encodeBase64(signature),
  };

  const res = await fetchJson<{ token?: string }>(`${baseUrl}/v1/auth`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    timeoutMs: 15_000,
  });

  if (res.status !== 200 || typeof res.data?.token !== 'string' || res.data.token.length === 0) {
    throw new Error(`Failed to create test auth token (status=${res.status})`);
  }

  return { token: res.data.token, publicKeyBase64: body.publicKey };
}

export async function createTestAuthMtls(
  baseUrl: string,
  identity: {
    email?: string;
    upn?: string;
    subject?: string;
    fingerprint?: string;
    issuer?: string;
  },
): Promise<TestAuthMtls> {
  const headers: Record<string, string> = {};
  if (typeof identity.email === 'string' && identity.email.trim()) {
    headers['x-happier-client-cert-email'] = identity.email.trim();
  }
  if (typeof identity.upn === 'string' && identity.upn.trim()) {
    headers['x-happier-client-cert-upn'] = identity.upn.trim();
  }
  if (typeof identity.subject === 'string' && identity.subject.trim()) {
    headers['x-happier-client-cert-subject'] = identity.subject.trim();
  }
  if (typeof identity.fingerprint === 'string' && identity.fingerprint.trim()) {
    headers['x-happier-client-cert-sha256'] = identity.fingerprint.trim();
  }
  if (typeof identity.issuer === 'string' && identity.issuer.trim()) {
    headers['x-happier-client-cert-issuer'] = identity.issuer.trim();
  }

  const res = await fetchJson<{ token?: string; success?: boolean; error?: unknown }>(`${baseUrl}/v1/auth/mtls`, {
    method: 'POST',
    headers,
    timeoutMs: 15_000,
  });

  if (res.status !== 200 || res.data?.success !== true || typeof res.data?.token !== 'string' || res.data.token.length === 0) {
    throw new Error(`Failed to create test mTLS auth token (status=${res.status})`);
  }

  return { token: res.data.token };
}
