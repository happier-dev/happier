import { randomBytes } from 'node:crypto';

import { formatRecoveryKey, sealEncryptedDataKeyEnvelopeV1 } from '@happier-dev/protocol';

import { createEncryptedArtifactViaApi } from '../artifactApi';
import { createTestAuth, type TestAuth } from '../auth';
import { buildTestAccountCliAuthCredentials } from '../cliAuth';
import { fetchJson } from '../http';
import { registerMachineIdentity } from '../machineIdentity';
import { encryptDataKeyBase64 } from '../rpcCrypto';
import { createSessionWithCiphertexts } from '../sessions';
import { perfFixtureId } from '../stress/scenarios/perfProfile';
import { runStressTasksWithConcurrencyLimit } from '../stress/scenarios/runStressTasksWithConcurrencyLimit';

/**
 * The QA bed Account shapes. `large` keeps the sizes the 2026-11-15 signed-in
 * device and web lanes measured (300 Sessions, 3 × 1,200-message transcripts),
 * so new numbers stay comparable with theirs.
 */
export const QA_BED_PROFILES = {
  small: { sessions: 12, longSessions: 1, longMessages: 120, machines: 2, artifacts: 6 },
  large: { sessions: 300, longSessions: 3, longMessages: 1_200, machines: 6, artifacts: 100 },
} as const;

export type QaBedProfileName = keyof typeof QA_BED_PROFILES;

export function isQaBedProfileName(value: string): value is QaBedProfileName {
  return Object.hasOwn(QA_BED_PROFILES, value);
}

export type QaBedSeedSummary = Readonly<{
  profile: QaBedProfileName;
  sessions: number;
  messages: number;
  machines: number;
  artifacts: number;
  longSessionIds: readonly string[];
}>;

export type SeededQaBedAccount = Readonly<{
  auth: TestAuth;
  /** Formatted recovery key: what "Use a key" sign-in and `happier auth login --key` accept. */
  recoveryKey: string;
  summary: QaBedSeedSummary;
}>;

/** Short Sessions get 4–17 messages, spread deterministically. */
function shortSessionMessageCount(index: number): number {
  return 4 + ((index * 7919) % 14);
}

function fixtureMessage(localId: string, index: number): unknown {
  if (index % 2 === 0) return { role: 'user', content: { type: 'text', text: `fixture prompt ${index}` } };
  const heading = index % 6 === 1
    ? `## Step ${index}\n\n- fixture point one\n- fixture point **two**\n\n\`\`\`ts\nconst fixture${index} = compute(${index});\n\`\`\`\n\n`
    : '';
  return {
    role: 'agent',
    content: { type: 'output', data: { type: 'assistant', uuid: localId,
      message: { content: [{ type: 'text', text: `${heading}${'fixture answer '.repeat(10 + (index % 50))}` }] } } },
  };
}

/**
 * Create one fresh Account and seed it through the server's public HTTP API, so
 * every stored row has the shape the server itself writes. Sessions are created
 * through `POST /v1/sessions` with legacy metadata and Artifacts without a
 * classification: the 0.2-era shapes 0.3 must keep reading (0.3 migrates them
 * on first view). The fixture Machines have no daemon and show as offline.
 */
export async function seedQaBedAccount(params: Readonly<{
  baseUrl: string;
  profile: QaBedProfileName;
  /** Distinguishes fixture ids (Machines, Artifacts) between Accounts on one server. */
  seed?: number;
  concurrency?: number;
  label?: string;
}>): Promise<SeededQaBedAccount> {
  const { baseUrl } = params;
  const sizes = QA_BED_PROFILES[params.profile];
  const seed = params.seed ?? Date.now() % 1_000_000;
  const concurrency = params.concurrency ?? 16;
  const label = params.label ?? 'qa';
  const auth = await createTestAuth(baseUrl);
  const credentials = buildTestAccountCliAuthCredentials({ auth, mode: 'dataKey' });
  if (!('encryption' in credentials)) throw new Error('QA bed seeding needs data-key credentials');
  const recipientPublicKey = Buffer.from(credentials.encryption.publicKey, 'base64');
  const wrapDataKey = (dataKey: Uint8Array) => Buffer.from(sealEncryptedDataKeyEnvelopeV1({
    dataKey, recipientPublicKey, randomBytes,
  })).toString('base64');

  const machineIds = await runStressTasksWithConcurrencyLimit(
    Array.from({ length: sizes.machines }, (_, index) => index), concurrency, async (index: number) => {
      const dataKey = randomBytes(32);
      const host = `${label}-dev-${String(index).padStart(3, '0')}`;
      const registered = await registerMachineIdentity({
        baseUrl, token: auth.token, machineId: perfFixtureId(seed, 'machine', index),
        metadata: encryptDataKeyBase64({ host, platform: ['linux', 'darwin', 'win32'][index % 3], homeDir: '/home/qa',
          version: '0.0.0-qa-bed-fixture', displayName: host }, dataKey),
        dataEncryptionKey: wrapDataKey(dataKey),
      });
      if (registered.status !== 200) throw new Error(`QA bed Machine registration failed (status=${registered.status})`);
      return registered.machineId as string;
    });

  const sessions = await runStressTasksWithConcurrencyLimit(
    Array.from({ length: sizes.sessions }, (_, index) => index), concurrency, async (index: number) => {
      const dataKey = randomBytes(32);
      const created = await createSessionWithCiphertexts({
        baseUrl, token: auth.token, tag: `${label}-s-${seed}-${index}`,
        metadataCiphertextBase64: encryptDataKeyBase64({ name: `${label} session ${index}`, path: `/home/qa/p${index % 12}`,
          homeDir: '/home/qa', machineId: machineIds[index % machineIds.length], host: `${label}-dev`,
          version: '0.0.0-qa-bed-fixture', flavor: 'claude' }, dataKey),
        dataEncryptionKeyBase64: wrapDataKey(dataKey),
        agentStateCiphertextBase64: encryptDataKeyBase64({ requests: {}, completedRequests: {} }, dataKey),
      });
      const count = index < sizes.longSessions ? sizes.longMessages : shortSessionMessageCount(index);
      for (let message = 0; message < count; message++) {
        const localId = `${label}-${seed}-${index}-${message}`;
        const written = await fetchJson<{ didWrite?: boolean }>(`${baseUrl}/v2/sessions/${created.sessionId}/messages`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${auth.token}`, 'Content-Type': 'application/json', 'Idempotency-Key': localId },
          body: JSON.stringify({ localId, content: { t: 'encrypted', c: encryptDataKeyBase64(fixtureMessage(localId, message), dataKey) } }),
          timeoutMs: 20_000,
        });
        if (written.status !== 200) throw new Error(`QA bed message write failed (status=${written.status})`);
      }
      return { sessionId: created.sessionId, messages: count, long: index < sizes.longSessions };
    });

  await runStressTasksWithConcurrencyLimit(
    Array.from({ length: sizes.artifacts }, (_, index) => index), concurrency, async (index: number) => {
      await createEncryptedArtifactViaApi({ baseUrl, token: auth.token, artifactId: perfFixtureId(seed, 'artifact', index),
        headerJson: { title: `${label} artifact ${index}` }, bodyJson: { text: 'fixture notes\n'.repeat(16 + (index % 32)) },
        cliAccessKey: credentials });
    });

  return {
    auth,
    recoveryKey: formatRecoveryKey(auth.accountSigningSeed),
    summary: {
      profile: params.profile,
      sessions: sessions.length,
      messages: sessions.reduce((total, session) => total + session.messages, 0),
      machines: machineIds.length,
      artifacts: sizes.artifacts,
      longSessionIds: sessions.filter((session) => session.long).map((session) => session.sessionId),
    },
  };
}
