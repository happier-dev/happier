import { randomBytes } from 'node:crypto';

import {
  AccountEncryptionModeResponseSchema,
  ARTIFACT_PLAIN_DATA_KEY_MARKER,
  buildAccountStoredContentCompatibilityHttpHeadersV1,
  createPlainSessionOwnerMetadataEnvelopeV1,
  createSessionOwnerMetadataV1,
  CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION,
  encodePlainArtifactStoredContent,
  encodePlainMachineStoredContent,
  formatRecoveryKey,
  MACHINE_PLAIN_DATA_KEY_MARKER,
  projectSessionSharedMetadataV1,
  sealEncryptedDataKeyEnvelopeV1,
} from '@happier-dev/protocol';

import { SESSION_METADATA_LAYOUT_VERSION_V1 } from '@happier-dev/protocol/sessions/metadata/sessionMetadataSchemasV1';

import { buildEncryptedArtifactCreateRequestForCliAccessKey } from '../artifactApi';
import { createTestAuth, type TestAuth, type TestSigningAuth } from '../auth';
import { buildTestAccountCliAuthCredentials } from '../cliAuth';
import { fetchJson } from '../http';
import { createMachineInstallationIdentityFixture, registerMachineIdentity } from '../machineIdentity';
import { encryptDataKeyBase64 } from '../rpcCrypto';
import { createSessionWithCiphertexts } from '../sessions';
import { perfFixtureId } from '../stress/scenarios/perfProfile';
import { runStressTasksWithConcurrencyLimit } from '../stress/scenarios/runStressTasksWithConcurrencyLimit';
import { QA_BED_DEMO_STORY } from './demoStory';
import profileSizes from './profiles.json' with { type: 'json' };

/**
 * The QA bed Account shapes. `large` keeps the sizes the 2026-11-15 signed-in
 * device and web lanes measured (300 Sessions, 3 × 1,200-message transcripts),
 * so new numbers stay comparable with theirs. `huge` holds one 10,000- and one
 * 50,000-message transcript of realistic agent turns (tool calls, large diffs,
 * long terminal output, attachment listings) for transcript-length scaling work. Every message
 * goes through the ordinary message write, as a live Session's do (the historical import would
 * mark each one "Recovered history"), so `huge` takes tens of minutes to seed.
 * `demo` seeds the demo story world (`demoStory.ts`) instead of fixture text; its sizes match it.
 * `longMessages` lists one transcript length per long Session (the first Sessions).
 */
export const QA_BED_PROFILES = profileSizes;

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
  deployments?: Readonly<{ serverId: string; projectId: string; projectSourceId: string; productionEnvironmentId: string;
    previewEnvironmentId: string; deploymentId: string }>;
  demo?: Readonly<{ featuredSessionId: string; pendingApprovalId: string }>;
}>;

export type SeededQaBedAccount = Readonly<{
  auth: TestSigningAuth | TestAuth;
  /** Formatted recovery key: what "Use a key" sign-in and `happier auth login --key` accept. */
  recoveryKey: string;
  summary: QaBedSeedSummary;
}>;

export class QaBedSeedError extends Error {
  constructor(
    readonly phase: 'account_mode' | 'machine_registration' | 'session_create' | 'message_write' | 'artifact_create',
    readonly httpStatus?: number,
  ) {
    super(`QA bed ${phase} failed${httpStatus === undefined ? '' : ` (status=${httpStatus})`}`);
  }
}

function createEncryptedFixtureStorage(auth: TestSigningAuth | TestAuth) {
  if (!('accountMachineKey' in auth)) throw new QaBedSeedError('account_mode');
  const credentials = buildTestAccountCliAuthCredentials({ auth, mode: 'dataKey' });
  if (!('encryption' in credentials)) throw new QaBedSeedError('account_mode');
  const recipientPublicKey = Buffer.from(credentials.encryption.publicKey, 'base64');
  return {
    mode: 'e2ee' as const,
    auth,
    credentials,
    wrapDataKey: (dataKey: Uint8Array) => Buffer.from(sealEncryptedDataKeyEnvelopeV1({
      dataKey, recipientPublicKey, randomBytes,
    })).toString('base64'),
  };
}

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

const TURN_TOOLS = ['Bash', 'Edit', 'Read', 'Bash', 'Grep', 'Edit'] as const;

function fixtureTerminalOutput(index: number, lines: number): string {
  return Array.from({ length: lines }, (_, line) =>
    `${String(line + 1).padStart(4, ' ')} | fixture build step ${index}.${line} ok (${(line * 37) % 1000} ms) src/module${line % 40}/file${line % 9}.ts`).join('\n');
}

function fixtureDiffSide(index: number, lines: number, side: 'old' | 'new'): string {
  return Array.from({ length: lines }, (_, line) =>
    `  const value${line} = ${side === 'old' ? 'computeLegacy' : 'computeNext'}(input${index}, ${line}); // fixture`).join('\n');
}

/**
 * One message of a realistic agent turn, in the 0.2 Claude output shapes: a user
 * prompt (every 5th one lists attachments), assistant text with markdown, a tool
 * call (Bash, Edit with a large diff, Read, Grep) and its result (every 4th one is
 * long terminal output). Nine messages per turn: prompt, text, three tool calls with
 * their results, and a closing text.
 */
function fixtureAgentTurnMessage(localId: string, index: number, idPrefix: string): unknown {
  const turn = Math.floor(index / 9);
  const step = index % 9;
  if (step === 0) {
    const attachments = turn % 5 === 0
      ? `\n\n[attachments]\n- /uploads/fixture-screenshot-${turn}.png\n- /uploads/fixture-log-${turn}.txt\n[/attachments]`
      : '';
    return { role: 'user', content: { type: 'text', text: `fixture request ${turn}: update module ${turn % 40}${attachments}` } };
  }
  if (step === 1 || step === 8) return fixtureMessage(localId, index | 1);
  const call = (step - 2) >> 1;
  const toolUseId = `toolu_${idPrefix}_${turn}_${call}`.replace(/[^A-Za-z0-9_]/g, '_');
  const name = TURN_TOOLS[(turn + call) % TURN_TOOLS.length];
  if (step % 2 === 0) {
    const input = name === 'Edit'
      ? { file_path: `/home/qa/p0/src/module${turn % 40}/file${call}.ts`, old_string: fixtureDiffSide(turn, 60, 'old'),
        new_string: fixtureDiffSide(turn, 80, 'new') }
      : name === 'Read' ? { file_path: `/home/qa/p0/src/module${turn % 40}/file${call}.ts` }
        : name === 'Grep' ? { pattern: `computeLegacy${call}`, path: '/home/qa/p0/src' }
          : { command: `yarn test module${turn % 40}`, description: `Run module ${turn % 40} tests` };
    return { role: 'agent', content: { type: 'output', data: { type: 'assistant', uuid: localId,
      message: { content: [{ type: 'tool_use', id: toolUseId, name, input }] } } } };
  }
  const output = (turn + call) % 4 === 0 ? fixtureTerminalOutput(turn, 200) : fixtureTerminalOutput(turn, 12);
  return { role: 'agent', content: { type: 'output', data: { type: 'user', uuid: localId,
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content: output }] } } } };
}

/**
 * Create one fresh Account and seed it through the server's public HTTP API, so
 * every stored row has the shape the server itself writes. Sessions are created
 * through `POST /v1/sessions`. E2EE Sessions use legacy metadata to exercise
 * 0.2-era shapes. Plain Sessions use the current owner/shared layout.
 * The fixture Machines have no daemon and show as offline.
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
  const auth = await createTestAuth(baseUrl, { allowPlain: true });
  const accountHeaders = { Authorization: `Bearer ${auth.token}`, 'Content-Type': 'application/json' };
  const account = await fetchJson<unknown>(`${baseUrl}/v1/account/encryption`, { headers: accountHeaders });
  if (account.status !== 200) throw new QaBedSeedError('account_mode', account.status);
  const parsedMode = AccountEncryptionModeResponseSchema.safeParse(account.data);
  if (!parsedMode.success) throw new QaBedSeedError('account_mode');
  const storage = parsedMode.data.mode === 'e2ee' ? createEncryptedFixtureStorage(auth) : { mode: 'plain' as const };
  const compatibilityHeaders = storage.mode === 'plain'
    ? buildAccountStoredContentCompatibilityHttpHeadersV1(CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION)
    : {};
  const headers = { ...accountHeaders, ...compatibilityHeaders };
  if (params.profile === 'deploy-preview' && storage.mode === 'plain') {
    throw new QaBedSeedError('account_mode');
  }
  const installation = params.profile === 'deploy-preview' ? createMachineInstallationIdentityFixture() : undefined;
  const story = params.profile === 'demo' ? QA_BED_DEMO_STORY : undefined;

  const machineIds = await runStressTasksWithConcurrencyLimit(
    Array.from({ length: sizes.machines }, (_, index) => index), concurrency, async (index: number) => {
      const host = story?.machine.host ?? `${label}-dev-${String(index).padStart(3, '0')}`;
      const homeDir = story?.machine.homeDir ?? '/home/qa';
      // The fields a released daemon publishes; the client rejects metadata without them.
      const machineMetadata = { host, platform: story?.machine.platform ?? ['linux', 'darwin', 'win32'][index % 3], homeDir,
        happyHomeDir: `${homeDir}/.happier`, happyCliVersion: '0.0.0-qa-bed-fixture', displayName: story?.machine.displayName ?? host };
      const registration = { baseUrl, token: auth.token, machineId: perfFixtureId(seed, 'machine', index), installation };
      let content: Pick<Parameters<typeof registerMachineIdentity>[0], 'metadata' | 'dataEncryptionKey' | 'compatibilityHeaders'>;
      if (storage.mode === 'plain') {
        content = { metadata: encodePlainMachineStoredContent(machineMetadata), dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER, compatibilityHeaders };
      } else {
        const dataKey = randomBytes(32);
        content = { metadata: encryptDataKeyBase64(machineMetadata, dataKey), dataEncryptionKey: storage.wrapDataKey(dataKey) };
      }
      const registered = await registerMachineIdentity({ ...registration, ...content });
      if (registered.status !== 200) throw new QaBedSeedError('machine_registration', registered.status);
      return registered.machineId;
    });

  const sessions = await runStressTasksWithConcurrencyLimit(
    Array.from({ length: sizes.sessions }, (_, index) => index), concurrency, async (index: number) => {
      const storySession = story?.sessions[index];
      const storyUuid = (message: number) => `${label}-${seed}-${index}-${message}`;
      const storyMessages = storySession && story
        ? storySession.featured ? story.featuredTurn(storyUuid) : story.shortExchange(storySession.name, storyUuid)
        : undefined;
      const pendingApproval = storySession?.featured ? story?.pendingApproval : undefined;
      const tag = `${label}-s-${seed}-${index}`;
      const metadata = { name: storySession?.name ?? `${label} session ${index}`,
        path: storySession?.path ?? `/home/qa/p${index % 12}`, homeDir: story?.machine.homeDir ?? '/home/qa',
        machineId: machineIds[index % machineIds.length], host: story?.machine.host ?? `${label}-dev`,
        version: '0.0.0-qa-bed-fixture', flavor: 'claude' };
      const agentState = {
        requests: pendingApproval ? { [pendingApproval.id]: { tool: pendingApproval.tool, arguments: pendingApproval.arguments,
          createdAt: Date.now() } } : {},
        completedRequests: {},
      };
      let sessionId: string;
      let encodeMessage: (value: unknown) => { t: 'plain'; v: unknown } | { t: 'encrypted'; c: string };
      if (storage.mode === 'e2ee') {
        const dataKey = randomBytes(32);
        const created = await createSessionWithCiphertexts({
          baseUrl, token: auth.token, tag, metadataCiphertextBase64: encryptDataKeyBase64(metadata, dataKey),
          dataEncryptionKeyBase64: storage.wrapDataKey(dataKey), agentStateCiphertextBase64: encryptDataKeyBase64(agentState, dataKey),
        });
        sessionId = created.sessionId;
        encodeMessage = (value) => ({ t: 'encrypted', c: encryptDataKeyBase64(value, dataKey) });
      } else {
        const owner = createSessionOwnerMetadataV1({ metadata });
        if (!owner.ok) throw new QaBedSeedError('session_create');
        const created = await fetchJson<{ session?: { id?: string } }>(`${baseUrl}/v1/sessions`, {
          method: 'POST', headers,
          body: JSON.stringify({ tag, encryptionMode: 'plain', metadataLayoutVersion: SESSION_METADATA_LAYOUT_VERSION_V1,
            sharedMetadata: { ciphertext: JSON.stringify(projectSessionSharedMetadataV1({ metadata, agentState })) },
            ownerMetadata: createPlainSessionOwnerMetadataEnvelopeV1(owner.ownerMetadata),
            agentState: JSON.stringify(agentState), dataEncryptionKey: null }),
        });
        const id = created.data?.session?.id;
        if (created.status !== 200 || !id) throw new QaBedSeedError('session_create', created.status);
        sessionId = id;
        encodeMessage = (value) => ({ t: 'plain', v: value });
      }
      const longCount: number | undefined = sizes.longMessages[index];
      const count = storyMessages?.length ?? longCount ?? shortSessionMessageCount(index);
      for (let message = 0; message < count; message++) {
        const localId = storyUuid(message);
        const written = await fetchJson<{ didWrite?: boolean }>(`${baseUrl}/v2/sessions/${sessionId}/messages`, {
          method: 'POST',
          headers: { ...headers, 'Idempotency-Key': localId },
          body: JSON.stringify({ localId, content: encodeMessage(storyMessages?.[message]
            ?? (sizes.agentTurns ? fixtureAgentTurnMessage(localId, message, `${seed}_${index}`) : fixtureMessage(localId, message))) }),
          timeoutMs: 20_000,
        });
        if (written.status !== 200) throw new QaBedSeedError('message_write', written.status);
      }
      return { sessionId, messages: count, long: longCount !== undefined, featured: storySession?.featured === true };
    });

  await runStressTasksWithConcurrencyLimit(
    Array.from({ length: sizes.artifacts }, (_, index) => index), concurrency, async (index: number) => {
      const artifactId = perfFixtureId(seed, 'artifact', index);
      const headerJson = { title: story?.artifact.title ?? `${label} artifact ${index}` };
      const bodyJson = { text: story?.artifact.body ?? 'fixture notes\n'.repeat(16 + (index % 32)) };
      const request = storage.mode === 'e2ee' ? buildEncryptedArtifactCreateRequestForCliAccessKey({
        artifactId, headerJson, bodyJson, cliAccessKey: storage.credentials,
      }) : {
        id: artifactId, header: encodePlainArtifactStoredContent(headerJson), body: encodePlainArtifactStoredContent(bodyJson),
        dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
      };
      const created = await fetchJson<unknown>(`${baseUrl}/v1/artifacts`, {
        method: 'POST', headers, body: JSON.stringify(request),
      });
      if (created.status !== 200) throw new QaBedSeedError('artifact_create', created.status);
    });

  const featuredSessionId = sessions.find((session) => session.featured)?.sessionId;
  const deploymentFixture = installation && storage.mode === 'e2ee'
    ? await (await import('./seedDeployPreview')).seedDeployPreview({ baseUrl, auth: storage.auth, machineId: machineIds[0], installation,
      credentials: storage.credentials })
    : undefined;
  return {
    auth,
    recoveryKey: formatRecoveryKey(auth.accountSigningSeed),
    summary: {
      profile: params.profile,
      sessions: sessions.length,
      messages: sessions.reduce((total, session) => total + session.messages, 0),
      machines: machineIds.length,
      artifacts: sizes.artifacts + (deploymentFixture?.artifactsCreated ?? 0),
      longSessionIds: sessions.filter((session) => session.long).map((session) => session.sessionId),
      ...(deploymentFixture ? { deployments: deploymentFixture.summary } : {}),
      ...(story && featuredSessionId ? { demo: { featuredSessionId, pendingApprovalId: story.pendingApproval.id } } : {}),
    },
  };
}
