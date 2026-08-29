import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import {
  HappierStructuredInputV1Schema,
  PluginManifestV2Schema,
  buildComposerReferenceMentionPayloadV1,
  renderSessionInputContextPromptV1,
  type JsonValue,
} from '@happier-dev/protocol';
import { computePluginUiArtifactFileSetSha256DigestV1 } from '@happier-dev/protocol/plugins/ui';
import type {
  AgentRuntimeFactoryContext,
  AgentSessionRuntimeContext,
  AgentSessionRuntimeEvent,
} from '@happier-dev/plugin-sdk/agents/runtime';
import type { PluginJsonValueV2 } from '@happier-dev/plugin-sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  QA_REFERENCE_CANDIDATE_ID,
  QA_REFERENCE_CONTEXT,
  QA_REFERENCE_LABEL,
  QA_REFERENCE_LOCAL_ID,
  createCurrentSourceQaAgentRuntime,
  resolveCurrentSourceQaAttachmentsForDispatch,
  resolveCurrentSourceQaReferenceCandidate,
} from '../../../fixtures/plugin-platform/current-source-native-public/agent/deterministicAgent';
import { QA_REVISION } from '../../../fixtures/plugin-platform/current-source-native-public/revision';
import { resolveStructuredInputProviderDispatchContext } from '../../../../../apps/cli/src/agent/runtime/turns/resolveStructuredInputProviderContext';

import {
  attestCurrentManagedStackPluginUi,
  deleteCurrentManagedStackNewSessionDraft,
  prepareCurrentManagedStackDeclarativeLifecycleFixture,
  prepareCurrentManagedStackNativePublicFixture,
  resolveCurrentManagedStackPluginUiContext,
  stageCurrentSourceNativePublicFixtureSource,
} from './currentManagedStackPluginUiQa';

const roots: string[] = [];

/** The fixture plugin id the deterministic QA Agent must bind resolved facts to. */
const QA_AGENT_PLUGIN_ID = 'qa.current-source.native-public';

/**
 * The fixture module surface the canonical dispatch chain consumes. It is
 * implemented both by the repository's checked-in fixture (the current
 * checkout generation) and by every staged fixture copy, so the exact same
 * regression runs against both generated fixture revisions.
 */
type CurrentSourceQaFixtureModule = Readonly<{
  QA_REVISION: string;
  QA_REFERENCE_CANDIDATE_ID: string;
  QA_REFERENCE_LABEL: string;
  QA_REFERENCE_CONTEXT: string;
  QA_REFERENCE_LOCAL_ID: string;
  createCurrentSourceQaAgentRuntime: typeof createCurrentSourceQaAgentRuntime;
  resolveCurrentSourceQaAttachmentsForDispatch: typeof resolveCurrentSourceQaAttachmentsForDispatch;
  resolveCurrentSourceQaReferenceCandidate: typeof resolveCurrentSourceQaReferenceCandidate;
}>;

const repoFixtureModule: CurrentSourceQaFixtureModule = {
  QA_REVISION,
  QA_REFERENCE_CANDIDATE_ID,
  QA_REFERENCE_LABEL,
  QA_REFERENCE_CONTEXT,
  QA_REFERENCE_LOCAL_ID,
  createCurrentSourceQaAgentRuntime,
  resolveCurrentSourceQaAttachmentsForDispatch,
  resolveCurrentSourceQaReferenceCandidate,
};

/**
 * Imports one staged fixture copy's deterministic Agent and refuses a copy
 * that does not carry exactly the requested generation, so a staging defect
 * can never silently test the repository's checked-in generation instead.
 */
async function importStagedCurrentSourceQaFixture(params: Readonly<{
  root: string;
  revision: 'v1' | 'v2';
}>): Promise<CurrentSourceQaFixtureModule> {
  // The staged copy's own revision module is the generation owner; the agent
  // module imports it but does not re-export it.
  const stagedRevision = await import(join(params.root, 'revision.ts')) as unknown;
  const revisionModule = (stagedRevision && typeof stagedRevision === 'object' ? stagedRevision : {}) as Record<string, unknown>;
  const staged = await import(join(params.root, 'agent', 'deterministicAgent.ts')) as unknown;
  if (!staged || typeof staged !== 'object') {
    throw new Error('staged_current_source_fixture_agent_module_invalid');
  }
  const module = staged as Record<string, unknown>;
  if (
    revisionModule.QA_REVISION !== params.revision
    || module.QA_REFERENCE_CANDIDATE_ID !== `qa:${params.revision}`
    || typeof module.QA_REFERENCE_LABEL !== 'string'
    || typeof module.QA_REFERENCE_CONTEXT !== 'string'
    || typeof module.QA_REFERENCE_LOCAL_ID !== 'string'
    || typeof module.createCurrentSourceQaAgentRuntime !== 'function'
    || typeof module.resolveCurrentSourceQaAttachmentsForDispatch !== 'function'
    || typeof module.resolveCurrentSourceQaReferenceCandidate !== 'function'
  ) {
    throw new Error(`staged_current_source_fixture_agent_generation_mismatch:${params.revision}`);
  }
  return {
    QA_REVISION: params.revision,
    QA_REFERENCE_CANDIDATE_ID: module.QA_REFERENCE_CANDIDATE_ID as string,
    QA_REFERENCE_LABEL: module.QA_REFERENCE_LABEL as string,
    QA_REFERENCE_CONTEXT: module.QA_REFERENCE_CONTEXT as string,
    QA_REFERENCE_LOCAL_ID: module.QA_REFERENCE_LOCAL_ID as string,
    createCurrentSourceQaAgentRuntime: module.createCurrentSourceQaAgentRuntime as CurrentSourceQaFixtureModule['createCurrentSourceQaAgentRuntime'],
    resolveCurrentSourceQaAttachmentsForDispatch: module.resolveCurrentSourceQaAttachmentsForDispatch as CurrentSourceQaFixtureModule['resolveCurrentSourceQaAttachmentsForDispatch'],
    resolveCurrentSourceQaReferenceCandidate: module.resolveCurrentSourceQaReferenceCandidate as CurrentSourceQaFixtureModule['resolveCurrentSourceQaReferenceCandidate'],
  };
}

function encodeModelTextLine(key: string, value: string): string {
  // Mirrors the canonical composer reference context renderer exactly.
  return `${key}=${JSON.stringify(value).replaceAll('<', '\\u003c').replaceAll('>', '\\u003e')}`;
}

function expectedComposerReferenceContextLines(): readonly string[] {
  return [
    encodeModelTextLine('reference_plugin_id', QA_AGENT_PLUGIN_ID),
    encodeModelTextLine('reference_local_id', QA_REFERENCE_LOCAL_ID),
    encodeModelTextLine('candidate_id', QA_REFERENCE_CANDIDATE_ID),
    encodeModelTextLine('label', QA_REFERENCE_LABEL),
    encodeModelTextLine('context', QA_REFERENCE_CONTEXT),
  ];
}

function exactComposerFactsStructuredInput(): Record<string, unknown> {
  return {
    v: 1,
    resolvedComposerAttachments: [{
      v: 1,
      instanceId: 'qa-instance-1',
      attachment: { pluginId: QA_AGENT_PLUGIN_ID, localId: 'qa-item' },
      key: `qa-${QA_REVISION}`,
      value: { qaId: QA_REVISION },
      presentation: {
        label: `Current source QA attachment ${QA_REVISION}`,
        description: 'Immutable transcript fallback proof.',
        typeLabel: 'Current source QA item',
      },
      data: { qaId: QA_REVISION },
    }],
  };
}

function qaAgentSessionContext(): AgentSessionRuntimeContext {
  // Boundary fixture: the deterministic Agent reads only plugin.id, session.id,
  // and the send request; the host-owned service bags are inert here.
  return {
    plugin: { id: QA_AGENT_PLUGIN_ID, version: '0.0.1' },
    agent: { id: 'qa-agent' },
    contribution: { id: 'qa-agent' },
    surface: 'agent',
    invokedAtMs: 0,
    signal: new AbortController().signal,
    services: {},
    session: { id: 'qa-session', services: {} },
    workState: {},
    protocols: {},
  } as unknown as AgentSessionRuntimeContext;
}

async function sendQaTurn(params: Readonly<{ fixture?: CurrentSourceQaFixtureModule; text: string; structuredInput?: unknown }>): Promise<{
  status: string;
  events: AgentSessionRuntimeEvent[];
}> {
  const fixture = params.fixture ?? repoFixtureModule;
  const factory = await fixture.createCurrentSourceQaAgentRuntime({} as AgentRuntimeFactoryContext);
  if (!factory.sessions) throw new Error('current_source_qa_agent_sessions_runtime_missing');
  const runtime = await factory.sessions.open(
    { kind: 'create', sessionId: 'qa-session', cwd: '/tmp' },
    qaAgentSessionContext(),
  );
  const events: AgentSessionRuntimeEvent[] = [];
  runtime.watch((event) => events.push(event));
  const result = await runtime.send({
    inputIds: ['qa-input-1'],
    input: {
      text: params.text,
      ...(params.structuredInput === undefined
        ? {}
        : { structuredInput: params.structuredInput as JsonValue }),
    },
    delivery: { kind: 'newTurn', turnId: 'qa-turn-1' },
  });
  return { status: result.status, events };
}

/** The exact model-visible context lines the canonical dispatch owner renders for one resolved plugin reference. */
function exactComposerFactsPromptText(): string {
  return expectedComposerReferenceContextLines().join('\n');
}

async function resolveCanonicalQaDispatch(params: Readonly<{
  fixture?: CurrentSourceQaFixtureModule;
  includeReference?: boolean;
  includeAttachment?: boolean;
  referencePluginId?: string;
  candidateId?: string;
}> = {}) {
  const fixture = params.fixture ?? repoFixtureModule;
  const revision = fixture.QA_REVISION;
  const candidateId = params.candidateId ?? fixture.QA_REFERENCE_CANDIDATE_ID;
  const mention = {
    ...buildComposerReferenceMentionPayloadV1({
      reference: {
        pluginId: params.referencePluginId ?? QA_AGENT_PLUGIN_ID,
        localId: fixture.QA_REFERENCE_LOCAL_ID,
      },
      candidate: { id: candidateId, label: fixture.QA_REFERENCE_LABEL },
    }),
    token: '@qa-ref',
    start: 0,
    end: 7,
  };
  const raw = HappierStructuredInputV1Schema.parse({
    v: 1,
    ...(params.includeReference === false ? {} : { mentions: [mention] }),
    ...(params.includeAttachment === false ? {} : {
      composerAttachments: [{
        v: 1,
        instanceId: 'qa-instance-1',
        attachment: { pluginId: QA_AGENT_PLUGIN_ID, localId: 'qa-item' },
        key: `qa-${revision}`,
        value: { qaId: revision },
        presentation: {
          label: `Current source QA attachment ${revision}`,
          typeLabel: 'Current source QA item',
        },
      }],
    }),
  });
  const dispatch = await resolveStructuredInputProviderDispatchContext({
    structuredInput: raw,
    composerReferences: {
      resolve: async ({ reference, candidateId: selectedCandidateId }) => {
        if (reference.pluginId !== QA_AGENT_PLUGIN_ID || reference.localId !== fixture.QA_REFERENCE_LOCAL_ID) {
          throw Object.assign(new Error('The Composer reference contribution is not the current QA fixture.'), {
            code: 'plugin_generation_stale',
          });
        }
        return fixture.resolveCurrentSourceQaReferenceCandidate(selectedCandidateId);
      },
      signal: new AbortController().signal,
    },
    composerAttachments: {
      sessionId: 'qa-session',
      localId: 'qa-input-1',
      resolve: async ({ request }) => fixture.resolveCurrentSourceQaAttachmentsForDispatch({
        // The canonical Protocol resolver has already parsed/frozen this
        // ordinary-JSON value. The public fixture helper consumes the same
        // authored JSON vocabulary before returning its dispatch projection.
        attachments: request.attachments.map(({ instanceId, value }) => ({
          instanceId,
          value: value as unknown as PluginJsonValueV2,
        })),
      }),
      signal: new AbortController().signal,
    },
  });
  return Object.freeze({
    structuredInput: dispatch.structuredInput,
    text: renderSessionInputContextPromptV1({
      ...dispatch.promptContext,
      transformedUserText: '@qa-ref',
    }),
  });
}

describe('current-source deterministic QA Agent composer-facts admission', () => {
  it.each([
    { revision: 'v1' as const },
    { revision: 'v2' as const },
  ])('admits exactly the staged $revision generation through the canonical dispatch chain and rejects stale, wrong, and missing facts before input acceptance', async ({ revision }) => {
    const stagedRoot = await mkdtemp(join(tmpdir(), 'current-source-fixture-'));
    roots.push(stagedRoot);
    await stageCurrentSourceNativePublicFixtureSource({ root: stagedRoot, pluginId: QA_AGENT_PLUGIN_ID, revision });
    const fixture = await importStagedCurrentSourceQaFixture({ root: stagedRoot, revision });
    const otherRevision = revision === 'v1' ? 'v2' : 'v1';

    // Current generation: the canonical raw mention+attachment -> actual
    // dispatch resolver -> rendered context prompt -> actual fixture Agent.
    const dispatch = await resolveCanonicalQaDispatch({ fixture });
    const result = await sendQaTurn({ fixture, ...dispatch });
    expect(result.status).toBe('admitted');
    expect(result.events.map((event) => event.kind)).toEqual([
      'provider-session-id',
      'input-accepted',
      'turn-start',
      'message-delta',
      'turn-complete',
    ]);
    const delta = result.events.find((event) => event.kind === 'message-delta');
    expect(delta && 'text' in delta && delta.text.includes('PLUGIN_UI_CURRENT_SOURCE_NATIVE_ACCEPTED')).toBe(true);

    // Stale generation: the other revision's candidate never resolves.
    await expect(resolveCanonicalQaDispatch({ fixture, candidateId: `qa:${otherRevision}` }))
      .rejects.toMatchObject({ code: 'plugin_generation_stale' });

    // Wrong contribution binding: another plugin's mention never resolves.
    await expect(resolveCanonicalQaDispatch({ fixture, referencePluginId: 'qa.other-plugin' }))
      .rejects.toMatchObject({ code: 'plugin_generation_stale' });

    // Missing resolved attachment facts: the fixture Agent rejects the turn
    // through the same canonical chain before any input-accepted event.
    const referenceOnlyDispatch = await resolveCanonicalQaDispatch({ fixture, includeAttachment: false });
    const missingResult = await sendQaTurn({ fixture, ...referenceOnlyDispatch });
    expect(missingResult.status).toBe('rejected');
    expect(missingResult.events.map((event) => event.kind)).toEqual(['input-rejected']);
  });

  it('admits facts produced by the canonical Composer dispatch resolver and actual fixture Agent', async () => {
    const dispatch = await resolveCanonicalQaDispatch();
    const result = await sendQaTurn(dispatch);

    expect(result.status).toBe('admitted');
    expect(result.events.map((event) => event.kind)).toEqual([
      'provider-session-id',
      'input-accepted',
      'turn-start',
      'message-delta',
      'turn-complete',
    ]);
  });

  it('rejects canonical dispatch without the current Composer reference', async () => {
    const dispatch = await resolveCanonicalQaDispatch({ includeReference: false });
    const result = await sendQaTurn(dispatch);
    expect(result.status).toBe('rejected');
    expect(result.events.map((event) => event.kind)).toEqual(['input-rejected']);
  });

  it('rejects a wrong contribution and stale-generation reference before Agent acceptance', async () => {
    await expect(resolveCanonicalQaDispatch({ referencePluginId: 'qa.other-plugin' }))
      .rejects.toMatchObject({ code: 'plugin_generation_stale' });
    const staleRevision = QA_REVISION === 'v1' ? 'v2' : 'v1';
    await expect(resolveCanonicalQaDispatch({ candidateId: `qa:${staleRevision}` }))
      .rejects.toMatchObject({ code: 'plugin_generation_stale' });
  });

  it('rejects a turn whose structured input is missing the exact resolved Composer attachment', async () => {
    const result = await sendQaTurn({
      text: exactComposerFactsPromptText(),
    });

    expect(result.status).toBe('rejected');
    expect(result.events.map((event) => event.kind)).toEqual(['input-rejected']);
    expect(result.events.some((event) => event.kind === 'message-delta'
      && 'text' in event && event.text.includes('PLUGIN_UI_CURRENT_SOURCE_NATIVE_ACCEPTED'))).toBe(false);
  });

  it('rejects a turn whose resolved attachment value does not match the fixture revision', async () => {
    const structuredInput = exactComposerFactsStructuredInput() as Record<string, unknown>;
    const [attachment] = structuredInput.resolvedComposerAttachments as Array<Record<string, unknown>>;
    structuredInput.resolvedComposerAttachments = [{ ...attachment, data: { qaId: 'forged' } }];

    const result = await sendQaTurn({
      text: exactComposerFactsPromptText(),
      structuredInput,
    });

    expect(result.status).toBe('rejected');
    expect(result.events.map((event) => event.kind)).toEqual(['input-rejected']);
  });

  it('rejects a turn whose prompt text lacks the resolved Composer reference context entry', async () => {
    const result = await sendQaTurn({
      text: 'plain text without the canonical composer reference context block',
      structuredInput: exactComposerFactsStructuredInput(),
    });

    expect(result.status).toBe('rejected');
    expect(result.events.map((event) => event.kind)).toEqual(['input-rejected']);
  });

  it('accepts exactly the resolved Composer facts and settles the turn with the transcript sentinel', async () => {
    const result = await sendQaTurn({
      text: exactComposerFactsPromptText(),
      structuredInput: exactComposerFactsStructuredInput(),
    });

    expect(result.status).toBe('admitted');
    expect(result.events.map((event) => event.kind)).toEqual([
      'provider-session-id',
      'input-accepted',
      'turn-start',
      'message-delta',
      'turn-complete',
    ]);
    const delta = result.events.find((event) => event.kind === 'message-delta');
    expect(delta && 'text' in delta && delta.text.includes('PLUGIN_UI_CURRENT_SOURCE_NATIVE_ACCEPTED')).toBe(true);
  });
});

type MutableRuntimePublicationFixture = Record<string, unknown> & {
  runtimePublication: {
    phase: string;
    currentSnapshotId: string;
    components: Record<'web' | 'server' | 'daemon', { phase: string }>;
  };
};

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(roots.splice(0).map(async (root) => {
    await rm(root, { recursive: true, force: true });
  }));
});

function draftCleanupContext(): Awaited<ReturnType<typeof resolveCurrentManagedStackPluginUiContext>> {
  return {
    serverUrl: 'http://server.invalid',
    authStorage: { localStorage: { auth_credentials: JSON.stringify({ token: 'qa-token' }) } },
  } as unknown as Awaited<ReturnType<typeof resolveCurrentManagedStackPluginUiContext>>;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function createManagedStackFixture(): Promise<Readonly<{
  runtimePath: string;
  context: Awaited<ReturnType<typeof resolveCurrentManagedStackPluginUiContext>>;
}>> {
  const root = await mkdtemp(join(tmpdir(), 'plugin-ui-current-stack-'));
  roots.push(root);
  const stackDir = join(root, 'repo-current');
  const cliHome = join(stackDir, 'cli');
  const runtimeRoot = join(root, 'runner');
  const runtimeEntrypoint = join(runtimeRoot, 'index.mjs');
  const daemonPid = 31415;
  const artifactRoot = join(
    runtimeRoot,
    'node_modules',
    '@happier-dev',
    'plugins-inspector',
    'dist',
    'happier-plugin-ui',
  );
  const artifactRelativePath = 'react-native-web/inspector-app-native/entry.mjs.bundle';
  const artifactBytes = Buffer.from('current managed Stack inspector artifact', 'utf8');
  const fileDigest = `sha256:${createHash('sha256').update(artifactBytes).digest('hex')}`;
  const aggregateDigest = computePluginUiArtifactFileSetSha256DigestV1([{
    relativePath: artifactRelativePath,
    bytes: artifactBytes,
  }]);

  await mkdir(runtimeRoot, { recursive: true });
  await writeFile(runtimeEntrypoint, 'export {};\n', 'utf8');
  await writeJson(join(stackDir, 'stack.runtime.json'), {
    stackName: 'repo-current',
    runtimeSnapshotId: 'snapshot-current',
    runtimePublication: {
      phase: 'current',
      currentSnapshotId: 'snapshot-current',
      components: {
        server: { phase: 'current', error: null },
        daemon: { phase: 'current', error: null },
        web: { phase: 'current', error: null },
      },
    },
    updatedAt: '2026-08-28T12:00:00.000Z',
    ports: { server: 53288 },
    expo: { webPort: 19364 },
    processes: { daemonPid },
    daemon: { distClosureFingerprint: '0123456789abcdef' },
  });
  await writeJson(join(stackDir, 'runtime', 'current.json'), {
    version: 1,
    snapshotId: 'snapshot-current',
    snapshotPath: join(stackDir, 'runtime', 'builds', 'snapshot-current'),
  });
  const accessToken = `header.${Buffer.from(JSON.stringify({ sub: 'account-current' })).toString('base64url')}.signature`;
  await writeJson(join(cliHome, 'settings.json'), {
    schemaVersion: 6,
    activeServerId: 'current',
    servers: {
      current: {
        id: 'current',
        serverUrl: 'http://happier-repo-current.localhost:53288',
        serverIdentityId: 'server-identity-current',
      },
    },
  });
  await writeJson(join(cliHome, 'servers', 'current', 'access.key'), {
    token: accessToken,
    encryption: { publicKey: 'public-key', machineKey: 'machine-key' },
  });
  await writeJson(join(cliHome, 'servers', 'current', 'daemon.state.json'), {
    pid: daemonPid,
    httpPort: 44517,
    controlToken: 'control-token',
    runtimeId: 'runtime-current',
    machineId: 'machine-current',
    startedWithRuntimeEntrypoint: runtimeEntrypoint,
    distClosureFingerprint: '0123456789abcdef',
  });
  await writeJson(join(stackDir, 'expo-dev', 'ui', 'expo.state.json'), {
    pid: process.pid,
    port: 19364,
    webEnabled: true,
    projectDir: resolve('apps/ui'),
  });
  await writeJson(join(runtimeRoot, 'node_modules', '@happier-dev', 'plugins-inspector', '.happier-plugin', 'plugin.json'), {
    id: 'happier.inspector',
  });
  await mkdir(dirname(join(artifactRoot, artifactRelativePath)), { recursive: true });
  await writeFile(join(artifactRoot, artifactRelativePath), artifactBytes);
  await writeJson(join(artifactRoot, 'ui-artifacts.json'), {
    version: 1,
    entries: ['web', 'ios', 'android'].map((platform) => ({
      contributionId: 'inspector-app-native',
      tier: 'reactNative',
      platform,
      entry: artifactRelativePath,
      files: [{
        relativePath: artifactRelativePath,
        digest: fileDigest,
        byteSize: artifactBytes.byteLength,
      }],
      digest: aggregateDigest,
    })),
  });

  const runtimePath = join(stackDir, 'stack.runtime.json');
  return {
    runtimePath,
    context: await resolveCurrentManagedStackPluginUiContext({
      env: {
        HAPPIER_QA_STACK_RUNTIME_JSON_PATH: runtimePath,
        HAPPIER_QA_UI_MODE: 'snapshot',
      },
    }),
  };
}

describe('current managed Stack Plugin UI QA', () => {
  it('treats only an HTTP-successful absent New Session draft as retired', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(200, { status: 'absent' })));
    await expect(deleteCurrentManagedStackNewSessionDraft(draftCleanupContext(), 'owned-draft')).resolves.toBeUndefined();
  });

  it('does not hide a New Session draft read failure as successful cleanup', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(500, { status: 'failed' })));
    await expect(deleteCurrentManagedStackNewSessionDraft(draftCleanupContext(), 'owned-draft'))
      .rejects.toThrow('plugin_ui_current_stack_new_session_draft_read_failed:500');
  });

  it('deletes a QA-owned New Session draft with the exact observed revision', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(200, { status: 'available', record: { revision: 7 } }))
      .mockResolvedValueOnce(jsonResponse(200, { status: 'updated' }));
    vi.stubGlobal('fetch', fetchMock);

    await deleteCurrentManagedStackNewSessionDraft(draftCleanupContext(), 'owned-draft');

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toMatchObject({
      address: { kind: 'newSession', draftId: 'owned-draft' },
      expectedRevision: 7,
      content: null,
    });
  });

  it('fails closed when revision-fenced New Session draft deletion is not accepted', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(200, { status: 'available', record: { revision: 7 } }))
      .mockResolvedValueOnce(jsonResponse(200, { status: 'conflict' }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(deleteCurrentManagedStackNewSessionDraft(draftCleanupContext(), 'owned-draft'))
      .rejects.toThrow('plugin_ui_current_stack_new_session_draft_delete_failed:200');
  });

  it('owns the canonical public-source native fixture lifecycle without a packaged candidate', async () => {
    const fixture = await createManagedStackFixture();
    let generation: string | null = null;
    let pluginId = '';
    let rejectUninstall = false;
    const built: Array<Readonly<{ pluginId: string; revision: string }>> = [];
    const postJson = async (params: Readonly<{ path: string; body: Readonly<Record<string, unknown>> }>) => {
      if (params.path === '/plugins/catalog/read') {
        return { status: 200, data: { kind: 'available', plugins: generation ? [{
          pluginId,
          desiredGeneration: generation,
          appliedGeneration: generation,
          contributions: { generation: generation === 'native-v1' ? 41 : 42 },
        }] : [] } };
      }
      if (params.path === '/plugins/change/list') return { status: 200, data: { changes: [] } };
      const kind = params.body.kind;
      if (kind === 'installPath') {
        const manifest = PluginManifestV2Schema.parse(JSON.parse(await readFile(
          join(String(params.body.locator), '.happier-plugin', 'plugin.json'),
          'utf8',
        )));
        pluginId = manifest.id;
        generation = built.at(-1)?.revision === 'v2' ? 'native-v2' : 'native-v1';
      } else if (kind === 'development') {
        generation = 'native-v2';
      } else if (kind === 'uninstall') {
        if (rejectUninstall) return { status: 500, data: { kind: 'failed' } };
        generation = null;
      }
      return { status: 200, data: { kind: 'committed', pluginId, desiredGeneration: generation, appliedGeneration: generation } };
    };
    const row = await prepareCurrentManagedStackNativePublicFixture({
      context: fixture.context,
      rowId: 'native-row',
      postJson: postJson as never,
      buildSource: async ({ root, pluginId: builtPluginId, revision }) => {
        built.push({ pluginId: builtPluginId, revision });
        await writeJson(join(root, '.happier-plugin', 'plugin.json'), {
          schemaVersion: 2,
          id: builtPluginId,
          version: revision === 'v1' ? '0.0.1' : '0.0.2',
          displayName: 'Native public fixture',
          description: 'Unit fixture for canonical lifecycle ownership.',
          engines: { happier: '^0.0.0' },
          runtime: { apiVersion: 1 },
          hostAccess: { required: [], optional: [] },
          secrets: [],
          contributes: {},
        });
        const artifactsRoot = join(root, 'dist', 'happier-plugin-ui');
        const entries = [];
        for (const platform of ['web', 'ios', 'android'] as const) {
          const relativePath = `react-native-${platform}/qa-native/entry.bundle`;
          const bytes = Buffer.from(`${revision}:${platform}`, 'utf8');
          await mkdir(dirname(join(artifactsRoot, relativePath)), { recursive: true });
          await writeFile(join(artifactsRoot, relativePath), bytes);
          entries.push({
            contributionId: 'qa-native',
            tier: 'reactNative',
            platform,
            entry: relativePath,
            files: [{
              relativePath,
              digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
              byteSize: bytes.byteLength,
            }],
            digest: computePluginUiArtifactFileSetSha256DigestV1([{ relativePath, bytes }]),
          });
        }
        const hostedRelativePath = 'hosted-web/web/qa-hosted/index.html';
        const hostedBytes = Buffer.from(`${revision}:hosted:web`, 'utf8');
        await mkdir(dirname(join(artifactsRoot, hostedRelativePath)), { recursive: true });
        await writeFile(join(artifactsRoot, hostedRelativePath), hostedBytes);
        entries.push({
          contributionId: 'qa-hosted',
          tier: 'hostedWeb',
          platform: 'web',
          entry: hostedRelativePath,
          files: [{
            relativePath: hostedRelativePath,
            digest: `sha256:${createHash('sha256').update(hostedBytes).digest('hex')}`,
            byteSize: hostedBytes.byteLength,
          }],
          digest: computePluginUiArtifactFileSetSha256DigestV1([{ relativePath: hostedRelativePath, bytes: hostedBytes }]),
        });
        await writeJson(join(artifactsRoot, 'ui-artifacts.json'), { version: 1, entries });
      },
    });

    expect(row.installed).toMatchObject({ appliedGeneration: 'native-v1', contributionProjectionGeneration: '41' });
    expect(row.rnSurfaceUrlPath).toBe(`/plugins/${encodeURIComponent(row.pluginId)}/native`);
    expect(row.hostedSurfaceUrlPath).toBe(`/plugins/${encodeURIComponent(row.pluginId)}/hosted`);
    expect(row.declarativeSurfaceUrlPath).toBe(`/plugins/${encodeURIComponent(row.pluginId)}/declarative`);
    expect(row.sentinels).toMatchObject({
      actionTestId: `plugin-declarative-action:${row.pluginId}/qa-self-check`,
      actionLabel: 'Run current source self-check',
      composerChoiceLabel: 'Attach Current source QA facts',
    });
    expect((await row.hostedArtifact()).digest).not.toBe((await row.artifact('web')).digest);
    expect(await row.applyV2()).toMatchObject({ appliedGeneration: 'native-v2', contributionProjectionGeneration: '42' });
    await row.disable();
    expect(await row.enable()).toMatchObject({ appliedGeneration: 'native-v2' });
    await row.uninstall();
    expect(await row.reinstallV1()).toMatchObject({ appliedGeneration: 'native-v1' });
    rejectUninstall = true;
    await expect(row.cleanup()).rejects.toThrow();
    expect((await stat(row.pluginRoot)).isDirectory()).toBe(true);
    rejectUninstall = false;
    await row.cleanup();
    expect(built.map((entry) => entry.revision)).toEqual(['v1', 'v2', 'v1']);
  });

  it('refuses an invalid source artifact graph before installing the native public fixture', async () => {
    const fixture = await createManagedStackFixture();
    const mutationKinds: unknown[] = [];
    const postJson = async (params: Readonly<{ path: string; body: Readonly<Record<string, unknown>> }>) => {
      if (params.path === '/plugins/catalog/read') {
        return { status: 200, data: { kind: 'available', plugins: [] } };
      }
      if (params.path === '/plugins/change/list') return { status: 200, data: { changes: [] } };
      mutationKinds.push(params.body.kind);
      return { status: 200, data: { kind: 'committed', pluginId: params.body.pluginId ?? 'unknown' } };
    };
    await expect(prepareCurrentManagedStackNativePublicFixture({
      context: fixture.context,
      rowId: 'invalid-artifact',
      postJson: postJson as never,
      buildSource: async ({ root, pluginId }) => {
        await writeJson(join(root, '.happier-plugin', 'plugin.json'), {
          schemaVersion: 2,
          id: pluginId,
          version: '0.0.1',
          displayName: 'Invalid artifact fixture',
          description: 'Must fail before catalog installation.',
          engines: { happier: '^0.0.0' },
          runtime: { apiVersion: 1 },
          hostAccess: { required: [], optional: [] },
          secrets: [],
          contributes: {},
        });
      },
    })).rejects.toThrow('plugin_ui_current_stack_source_artifacts_invalid');
    expect(mutationKinds).toEqual([]);
  });

  it('owns a repeatable v1 to v2 source lifecycle and retires it in cleanup', async () => {
    const fixture = await createManagedStackFixture();
    let generation: string | null = null;
    let pluginId = '';
    let admittedManifest: unknown = null;
    const calls: Array<Readonly<{ path: string; body: Record<string, unknown> }>> = [];
    const postJson = async (params: Readonly<{
      path: string;
      body: Readonly<Record<string, unknown>>;
    }>) => {
      calls.push({ path: params.path, body: { ...params.body } });
      if (params.path === '/plugins/catalog/read') {
        return {
          status: 200,
          data: {
            kind: 'available',
            plugins: generation ? [{
              pluginId,
              desiredGeneration: generation,
              appliedGeneration: generation,
              contributions: { generation: generation === 'generation-v1' ? 1 : 2 },
            }] : [],
          },
        };
      }
      if (params.path === '/plugins/change/list') return { status: 200, data: { changes: [] } };
      const kind = params.body.kind;
      if (kind === 'installPath' && typeof params.body.locator === 'string') {
        const manifest = PluginManifestV2Schema.parse(
          JSON.parse(await readFile(join(params.body.locator, '.happier-plugin', 'plugin.json'), 'utf8')),
        );
        admittedManifest = manifest;
        pluginId = manifest.id;
      }
      if (typeof params.body.pluginId === 'string') pluginId = params.body.pluginId;
      if (kind === 'installPath') generation = 'generation-v1';
      if (kind === 'development') generation = 'generation-v2';
      if (kind === 'uninstall') generation = null;
      return {
        status: 200,
        data: {
          kind: 'committed',
          pluginId,
          desiredGeneration: generation,
          appliedGeneration: generation,
        },
      };
    };

    const row = await prepareCurrentManagedStackDeclarativeLifecycleFixture({
      context: fixture.context,
      rowId: 'row-a',
      postJson: postJson as never,
    });
    expect(row.installed).toMatchObject({ appliedGeneration: 'generation-v1' });
    expect(await row.applyV2()).toMatchObject({ appliedGeneration: 'generation-v2' });
    await row.disable();
    expect(await row.enable()).toMatchObject({ appliedGeneration: 'generation-v2' });
    await row.uninstall();
    expect(await row.reinstallV1()).toMatchObject({ appliedGeneration: 'generation-v1' });
    expect(row.composer).toEqual({
      actionTestId: `plugin-declarative-action:${row.pluginId}/qa-self-check`,
      actionLabel: 'Run Current Stack external self-check',
      controlTestId: `plugin-composer-control:${row.pluginId}/qa-control`,
      choiceLabel: 'Attach Current Stack QA item',
      attachmentLabel: 'Current Stack QA item 42',
      referenceLabel: 'QA reference 42',
      regionText: 'Current Stack external Composer region mounted',
    });
    const parsedAdmittedManifest = PluginManifestV2Schema.parse(admittedManifest);
    expect(parsedAdmittedManifest.contributes.composerControls).toEqual([
      expect.objectContaining({ id: 'qa-control', scopes: ['session', 'newSession', 'pendingMessage'] }),
    ]);
    expect(parsedAdmittedManifest.contributes.composerAttachments).toEqual([
      expect.objectContaining({
        id: 'qa-item',
        runtime: { prepareForSend: true, resolveForDispatch: true, afterMessageAccepted: true },
      }),
    ]);
    expect(parsedAdmittedManifest.contributes.composerReferences).toEqual([
      expect.objectContaining({ id: 'qa-references', triggers: ['@'] }),
    ]);
    expect(parsedAdmittedManifest.contributes.composerRegions).toEqual([
      expect.objectContaining({ id: 'qa-region', scopes: ['session', 'newSession', 'pendingMessage'] }),
    ]);
    await row.cleanup();
    await row.cleanup();

    expect(calls.filter((call) => call.path === '/plugins/change/request').map((call) => call.body.kind)).toEqual([
      'installPath',
      'development',
      'disable',
      'enable',
      'uninstall',
      'installPath',
      'uninstall',
      'uninstall',
    ]);
  });

  it('resolves the selected Stack, daemon identity, and existing Account credentials without starting services', async () => {
    const fixture = await createManagedStackFixture();

    expect(fixture.context).toMatchObject({
      runtimeJsonPath: fixture.runtimePath,
      stackName: 'repo-current',
      serverUrl: 'http://happier-repo-current.localhost:53288',
      daemon: {
        pid: 31415,
        port: 44517,
        runtimeId: 'runtime-current',
        machineId: 'machine-current',
      },
      runtime: {
        runtimeSnapshotId: 'snapshot-current',
        selectedSnapshotId: 'snapshot-current',
        pendingManualRestart: false,
      },
      uiProducer: {
        mode: 'snapshot',
        stackName: 'repo-current',
        runtimeJsonPath: fixture.runtimePath,
        projectDir: null,
        pid: null,
      },
      account: {
        accountId: 'account-current',
        serverId: 'current',
        serverIdentityId: 'server-identity-current',
        uiServerId: expect.any(String),
      },
    });
    expect(JSON.parse(fixture.context.authStorage.localStorage.auth_credentials)).toMatchObject({
      token: expect.any(String),
      encryption: { publicKey: 'public-key', machineKey: 'machine-key' },
    });
  });

  it('attests the canonical direct Expo producer instead of requiring snapshot web publication', async () => {
    const fixture = await createManagedStackFixture();
    const runtime = JSON.parse(await readFile(fixture.runtimePath, 'utf8')) as MutableRuntimePublicationFixture;
    runtime.runtimePublication.phase = 'stale';
    runtime.runtimePublication.components.web.phase = 'stale';
    await writeJson(fixture.runtimePath, runtime);
    const context = await resolveCurrentManagedStackPluginUiContext({
      env: { HAPPIER_QA_STACK_RUNTIME_JSON_PATH: fixture.runtimePath },
      resolveRunningExpoState: async () => ({
        statePath: join(dirname(fixture.runtimePath), 'expo-dev', 'ui', 'expo.state.json'),
        state: { pid: 222, port: 19364, projectDir: resolve(process.cwd(), '../..', 'apps/ui'), processInstanceFingerprint: 'expo-direct' },
      }),
    });
    expect(context.uiProducer).toMatchObject({ mode: 'expo', stackName: 'repo-current', pid: 222, processInstanceFingerprint: 'expo-direct' });
  });

  it('attributes an exact borrowed Expo producer Stack', async () => {
    const fixture = await createManagedStackFixture();
    const consumerDir = dirname(fixture.runtimePath);
    const stacksDir = dirname(consumerDir);
    const producerDir = join(stacksDir, 'repo-producer');
    await writeFile(join(consumerDir, 'env'), 'HAPPIER_STACK_EXPO_SOURCE_STACK=repo-producer\n', 'utf8');
    await writeJson(join(producerDir, 'stack.runtime.json'), {
      stackName: 'repo-producer',
      expo: { webPort: 19364 },
    });
    const context = await resolveCurrentManagedStackPluginUiContext({
      env: {
        HAPPIER_QA_STACK_RUNTIME_JSON_PATH: fixture.runtimePath,
        HAPPIER_QA_STACKS_DIR: stacksDir,
      },
      resolveRunningExpoState: async (runtimePath) => ({
        statePath: join(dirname(runtimePath), 'expo-dev', 'ui', 'expo.state.json'),
        state: { pid: 333, port: 19364, projectDir: resolve(process.cwd(), '../..', 'apps/ui'), processInstanceFingerprint: 'expo-borrowed' },
      }),
    });
    expect(context.uiProducer).toMatchObject({
      mode: 'borrowedExpo',
      stackName: 'repo-producer',
      runtimeJsonPath: join(producerDir, 'stack.runtime.json'),
      pid: 333,
    });
  });

  it.each([
    {
      label: 'failed publication',
      mutate: (runtime: MutableRuntimePublicationFixture) => { runtime.runtimePublication.phase = 'failed'; },
      error: 'plugin_ui_current_stack_runtime_publication_not_current:failed',
    },
    {
      label: 'snapshot mismatch',
      mutate: (runtime: MutableRuntimePublicationFixture) => { runtime.runtimePublication.currentSnapshotId = 'snapshot-stale'; },
      error: 'plugin_ui_current_stack_runtime_publication_snapshot_mismatch',
    },
    {
      label: 'stale required component',
      mutate: (runtime: MutableRuntimePublicationFixture) => { runtime.runtimePublication.components.daemon.phase = 'stale'; },
      error: 'plugin_ui_current_stack_runtime_component_not_current:daemon:stale',
    },
  ])('refuses $label before current Stack UI evidence', async ({ mutate, error }) => {
    const fixture = await createManagedStackFixture();
    const runtime = JSON.parse(await readFile(fixture.runtimePath, 'utf8')) as MutableRuntimePublicationFixture;
    mutate(runtime);
    await writeJson(fixture.runtimePath, runtime);
    await expect(resolveCurrentManagedStackPluginUiContext({
      env: { HAPPIER_QA_STACK_RUNTIME_JSON_PATH: fixture.runtimePath, HAPPIER_QA_UI_MODE: 'snapshot' },
    })).rejects.toThrow(error);
  });

  it('refuses a selected runtime snapshot that is newer than the loaded Stack lifecycle', async () => {
    const fixture = await createManagedStackFixture();
    await writeJson(join(dirname(fixture.runtimePath), 'runtime', 'current.json'), {
      version: 1,
      snapshotId: 'snapshot-selected-but-not-loaded',
      snapshotPath: join(dirname(fixture.runtimePath), 'runtime', 'builds', 'snapshot-selected-but-not-loaded'),
    });
    await expect(resolveCurrentManagedStackPluginUiContext({
      env: { HAPPIER_QA_STACK_RUNTIME_JSON_PATH: fixture.runtimePath, HAPPIER_QA_UI_MODE: 'snapshot' },
    })).rejects.toThrow('plugin_ui_current_stack_pending_manual_restart:snapshot-selected-but-not-loaded:snapshot-current');
  });

  it('refuses credentials whose exact daemon server profile targets another server', async () => {
    const fixture = await createManagedStackFixture();
    const settingsPath = join(dirname(fixture.runtimePath), 'cli', 'settings.json');
    const settings = JSON.parse(await readFile(settingsPath, 'utf8')) as { servers: { current: { serverUrl: string } } };
    settings.servers.current.serverUrl = 'https://api.example.invalid';
    await writeJson(settingsPath, settings);
    await expect(resolveCurrentManagedStackPluginUiContext({
      env: { HAPPIER_QA_STACK_RUNTIME_JSON_PATH: fixture.runtimePath },
    })).rejects.toThrow('plugin_ui_current_stack_server_profile_url_mismatch');
  });

  it('attests the exact current catalog generation and selected published Inspector artifact graph', async () => {
    const fixture = await createManagedStackFixture();
    const attestation = await attestCurrentManagedStackPluginUi({
      context: fixture.context,
      postJson: async ({ path }) => path === '/ping' ? ({
        status: 200,
        data: { status: 'ok', runtimeId: 'runtime-current', distClosureFingerprint: '0123456789abcdef' },
      }) : ({
        status: 200,
        data: {
          kind: 'available',
          plugins: [{
            pluginId: 'happier.inspector',
            desiredGeneration: 'bundled-generation-7',
            appliedGeneration: 'bundled-generation-7',
            contributions: { generation: 11 },
          }],
        },
      }),
    });

    expect(attestation).toMatchObject({
      stackName: 'repo-current',
      pluginId: 'happier.inspector',
      desiredGeneration: 'bundled-generation-7',
      appliedGeneration: 'bundled-generation-7',
      contributionProjectionGeneration: '11',
      artifact: {
        platform: 'web',
        entry: 'react-native-web/inspector-app-native/entry.mjs.bundle',
      },
    });
    expect(attestation.artifact.byteSize).toBeGreaterThan(0);
    expect(attestation.artifact.digest).toMatch(/^sha256:[a-f0-9]{64}$/u);
  });

  it('attests the platform-specific native Inspector artifact selected by a device row', async () => {
    const fixture = await createManagedStackFixture();
    const attestation = await attestCurrentManagedStackPluginUi({
      context: fixture.context,
      artifactPlatform: 'ios',
      postJson: async ({ path }) => path === '/ping' ? ({
        status: 200,
        data: { status: 'ok', runtimeId: 'runtime-current', distClosureFingerprint: '0123456789abcdef' },
      }) : ({
        status: 200,
        data: {
          kind: 'available',
          plugins: [{
            pluginId: 'happier.inspector',
            desiredGeneration: 'bundled-generation-7',
            appliedGeneration: 'bundled-generation-7',
            contributions: { generation: 11 },
          }],
        },
      }),
    });
    expect(attestation.artifact.platform).toBe('ios');
    expect(attestation.artifact.digest).toMatch(/^sha256:[a-f0-9]{64}$/u);
  });

  it('refuses a live daemon whose ping identity differs from the selected state', async () => {
    const fixture = await createManagedStackFixture();
    await expect(attestCurrentManagedStackPluginUi({
      context: fixture.context,
      postJson: async () => ({
        status: 200,
        data: { status: 'ok', runtimeId: 'runtime-successor', distClosureFingerprint: '0123456789abcdef' },
      }),
    })).rejects.toThrow('plugin_ui_current_stack_daemon_ping_identity_mismatch');
  });

  it('refuses a catalog whose desired generation is not the applied generation', async () => {
    const fixture = await createManagedStackFixture();
    await expect(attestCurrentManagedStackPluginUi({
      context: fixture.context,
      postJson: async ({ path }) => path === '/ping' ? ({
        status: 200,
        data: { status: 'ok', runtimeId: 'runtime-current', distClosureFingerprint: '0123456789abcdef' },
      }) : ({
        status: 200,
        data: {
          kind: 'available',
          plugins: [{
            pluginId: 'happier.inspector',
            desiredGeneration: 'bundled-generation-8',
            appliedGeneration: 'bundled-generation-7',
            contributions: { generation: 11 },
          }],
        },
      }),
    })).rejects.toThrow('plugin_ui_current_stack_inspector_generation_not_current');
  });
});
