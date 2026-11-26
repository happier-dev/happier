import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { delimiter, join } from 'node:path';
import { createSocketTransportAdapter } from '@happier-dev/sync-client';
import tweetnacl from 'tweetnacl';
import axios from 'axios';
import { afterAll, describe, expect, it, onTestFailed, onTestFinished, vi } from 'vitest';
import { definePlugin } from '@happier-dev/plugin-sdk';
import { createExecutionRunHostBackendFromConversationRuntime,
  type AgentExecutionRunConversationEventV1, type AgentExecutionRunConversationRuntimeV1, type AgentExecutionRunOpenRequest,
  type AgentExecutionRunRuntime, type AgentRuntimeFactory, type AgentSessionOpenRequest,
  type AgentSessionRuntime, type AgentSessionRuntimeEvent } from '@happier-dev/plugin-sdk/agents/runtime';
import type { SessionExecutionRunBrokerAuthorityResponseV1 } from '@happier-dev/protocol';
import { ReviewStartInputSchema } from '@happier-dev/protocol/reviews/reviewStart';
import type { PluginDaemonModuleNamespace } from '@/plugins/runtime/types';
import { createAuthoredAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { resolveCliEngineRegistry } from '@/agent/runtime/registry/engineRegistry';
import { listExecutionRunMarkersForRehydration, readRetainedExecutionRunRecord } from '@/daemon/executionRunRegistry';
import { ExecutionRunHostBridge } from './ExecutionRunHostBridge';
import { reloadConfiguration } from '@/configuration';
import { resolveCliVoicePromptPreparation } from '@/agent/prompts/library/resolveCliVoicePromptStackBlocks';
import { createMutableApiSessionClientFixture } from '@/testkit/backends/sessionFixtures';
import { createTestMetadata } from '@/testkit/backends/sessionMetadata';
import { ProviderEnforcedPermissionHandler } from '@/agent/permissions/providerEnforced/handler';
import { createExecutionRunRuntime } from './runtime/create';
import { prepareCodexConnectedAccountLaunchEnvironment } from '../../../../../../../packages/plugins/codex/src/agent/runtime/connectedAccountKeys';
// Resolve the real native owner during collection, as its existing owner tests
// do, instead of charging its first source transform to the behavior deadline.
import '@/agent/runtime/registry/engineRegistry/runtimeCore';
import 'fake-indexeddb/auto';
import { installVitestRnShim } from '../../../../../../ui/sources/dev/vitestRnShim';
import { createVoiceTurnStreaming } from '../../../../../../ui/sources/voice/runtime/execution/voiceTurnStreaming';
import { createVoiceRunRecovery } from '../../../../../../ui/sources/voice/runtime/execution/voiceRunRecovery';
import type { VoiceAgentHandle } from '../../../../../../ui/sources/voice/agent/types';
import { storage } from '../../../../../../ui/sources/sync/domains/state/storage';
import { createSessionFixture } from '../../../../../../ui/sources/dev/testkit/fixtures/sessionFixtures';
import { normalizeVoiceSettingsLocalDelta } from '../../../../../../ui/sources/sync/domains/settings/voiceSettingsPersistence';
import { readLocalConversationVoiceSettings, writeVoiceProviderSettingsConfig } from '../../../../../../ui/sources/sync/domains/settings/voiceSettings';
import { createRpcCallError } from '../../../../../../ui/sources/sync/runtime/rpcErrors';
import { absentAccountPluginAvailabilityHttpResponse } from '@/testkit/http/accountPluginAvailability';
import { selectHostRequesterExecutionIdentity } from '@/daemon/agentIsolation/agentIsolationLaunchPolicy';
import type { ExecService, PluginProcessResult } from '@happier-dev/plugin-sdk/exec';
import { ReviewFindingsV2Schema } from '@happier-dev/protocol/messages/structured/reviewFindingsV2';
import { ReviewModelOutputV1Schema } from '@happier-dev/protocol/reviews/reviewModelOutputV1';
import { ROBOREV_PLUGIN } from '../../../../../../../packages/plugins/review-panels/src/manifest';
import selectedNativeReview from '../../../../../../../packages/plugins/review-panels/src/agent/reviews/fixtures/selected-review.json';
import { resolveReviewFollowUpAvailability } from '../../../../../../ui/sources/components/sessions/reviews/findings/reviewFollowUpAvailability';
import { resolveExecutionRunRuntimeBackendTarget } from './backendTargets';
import { resolveExecutionRunRoleV1 } from '@/agent/executionRuns/profiles/review/reviewRole';
import { CODERABBIT_PLUGIN } from '../../../../../../../packages/plugins/review-coderabbit/src/manifest';
import { GIT_PLUGIN } from '../../../../../../../packages/plugins/scm-git/src/manifest';
import { runWithRealGitScmRuntime } from '../../../../../../../packages/plugins/scm-git/src/testkit/scmRuntime.test-support';
import { createLocalScmRepositoryFixture } from '@/testkit/scm/scmBackendContractFixtures';
import { writeExecutableShimSync } from '@/testkit/fs/executableShim';
import { ApiSessionClient } from '@/api/session/sessionClient';
import { createPlainSessionFixture, createAccountEncryptionCurrentnessFixture } from '@/testkit/backends/sessionFixtures';
import { createApiSessionSocketStub, createSessionTranscriptHomeStub, createSessionRuntimeActivityHomeStub } from '@/testkit/backends/apiSessionSocketHarness';
import { SESSION_TRANSCRIPT_OBSERVATION_EVENT_V1, SESSION_TRANSCRIPT_OBSERVATION_BATCH_EVENT_V1,
  SessionTranscriptObservationInputSchema, SessionTranscriptObservationBatchInputV1Schema } from '@happier-dev/protocol/sessions/messages/transcriptObservationV1';
import { createCommittedExecutionRunTranscriptPublisher } from './executionRunTranscriptPublisher';
import { createReviewRunCommentService } from '@/agent/executionRuns/profiles/review/reviewComments';
import { createCliReviewCommentActionExecutorFromCredentials } from '@/agent/reviews/comments/executor';
import { deriveReviewCommentStructuralMutationV1, ReviewCommentPrepareMutationRequestV1Schema,
  ReviewCommentCommitMutationRequestV1Schema, type ReviewCommentPreparedRecordV1 } from '@happier-dev/protocol';
import { createReviewRecordPortV1 } from '@happier-dev/protocol/reviews/reviewArtifactV1';
import { createPlainAccountArtifactHttpBoundary } from '@/api/artifacts/accountArtifactStore.testkit';
import { createAccountArtifactStore, createAcknowledgedAccountArtifactTransport } from '@/api/artifacts/accountArtifactStore';
import { readRetainedReviewFindings } from '@/agent/reviews/normalize/readRetainedReviewFindings';
import { logger } from '@/ui/logger';

// The CLI harness has no native theme runtime. Keep the UI owners real beneath
// the same canonical platform boundary used by the existing composed Voice tests.
await vi.hoisted(async () => {
  const { installVitestRnShim } = await import(new URL('../../../../../../ui/sources/dev/vitestRnShim.ts', import.meta.url).href);
  installVitestRnShim();
});
vi.mock('react-native-unistyles', async () => {
  const { createUnistylesMock } = await import('../../../../../../ui/sources/dev/testkit/mocks/unistyles');
  return createUnistylesMock();
});
vi.mock('expo-updates', async () => {
  const { createExpoUpdatesMock } = await import('../../../../../../ui/sources/dev/testkit/mocks/expoUpdates');
  return createExpoUpdatesMock();
});
vi.mock('@shopify/react-native-skia', async () => {
  const { createReactNativeSkiaMock } = await import('../../../../../../ui/sources/dev/testkit/mocks/reactNativeSkia');
  return createReactNativeSkiaMock();
});
vi.mock('expo-file-system', async () => {
  const { createExpoFileSystemFileMock } = await import('../../../../../../ui/sources/dev/testkit/mocks/expoFileSystem');
  return createExpoFileSystemFileMock().module;
});
vi.mock('expo-file-system', async () => {
  const { createExpoFileSystemFileMock } = await import('../../../../../../ui/sources/dev/testkit/mocks/expoFileSystem');
  return createExpoFileSystemFileMock().module;
});
vi.mock('react-native-typography', async () => {
  const { createReactNativeTypographyMock } = await import('../../../../../../ui/sources/dev/testkit/mocks/reactNativeTypography');
  return createReactNativeTypographyMock();
});
vi.mock('@shopify/react-native-skia', async () => {
  const { createReactNativeSkiaMock } = await import('../../../../../../ui/sources/dev/testkit/mocks/reactNativeSkia');
  return createReactNativeSkiaMock();
});
installVitestRnShim();
vi.mock('expo-updates', async () => {
  const { createExpoUpdatesMock } = await import('../../../../../../ui/sources/dev/testkit/mocks/expoUpdates');
  return createExpoUpdatesMock();
});

const { directory, originalHome } = await vi.hoisted(async () => {
  const [{ mkdtemp }, { tmpdir }, { join }] = await Promise.all([
    import('node:fs/promises'), import('node:os'), import('node:path'),
  ]);
  const directory = await mkdtemp(join(tmpdir(), 'happier-connected-run-resume-'));
  const originalHome = process.env.HAPPIER_HOME_DIR;
  process.env.HAPPIER_HOME_DIR = directory;
  return { directory, originalHome };
});

const transport = vi.hoisted(() => ({ materialize: vi.fn(), release: vi.fn(async () => ({ ok: true, released: true })) }));
// Only the runner-to-daemon transport is doubled. Source admission, registry,
// selection, Run lifecycle and broker authority remain real.
vi.mock('@/daemon/controlClient', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/daemon/controlClient')>(),
  requestExecutionRunConnectedServicesMaterialization: transport.materialize,
  releaseExecutionRunConnectedServices: transport.release,
}));
// The current Session service is authenticated by the persisted Account
// boundary. Never read a developer's credentials from this fixture.
vi.mock('@/persistence', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/persistence')>(),
  readStoredCredentials: async () => ({ token: 'connected-resume-fixture', encryption: null }),
}));

describe('connected execution-run resume custody', () => {
  afterAll(async () => {
    logger.flushSync();
    if (originalHome === undefined) delete process.env.HAPPIER_HOME_DIR;
    else process.env.HAPPIER_HOME_DIR = originalHome;
    reloadConfiguration();
    await rm(directory, { recursive: true, force: true });
  });
  it('publishes completed native and resumable Review runRefs and retains only CodeRabbit review content', async () => runWithRealGitScmRuntime(async () => {
    let phase = 'fixture';
    let activeRunId: string | null = null;
    const providerEvents: string[] = [];
    const repository = createLocalScmRepositoryFixture({ executable: 'git', repoMode: '.git', prefix: 'coderabbit-run-privacy-' });
    onTestFinished(() => rm(repository.rootPath, { recursive: true, force: true }));
    await writeFile(join(repository.rootPath, repository.trackedPath), 'reviewable change\n');
    const bin = join(directory, 'coderabbit-native-bin');
    await mkdir(bin, { recursive: true });
    const nativeCalls = join(bin, 'calls.jsonl');
    const privateValues = ['custodian-review@example.invalid', 'custodian-review-organization',
      'coderabbit-review-private-token-2841', 'raw-auth-review-private-marker-5379'];
    const nativeAuth = { type: 'status', phase: 'auth', authenticated: true, email: privateValues[0], organization: privateValues[1],
      accessToken: privateValues[2], raw: privateValues[3] };
    const script = join(bin, 'coderabbit.cjs');
    await writeFile(script, `const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(nativeCalls)}, JSON.stringify({ args, hasCredential: process.env.CODERABBIT_API_KEY === ${JSON.stringify(privateValues[2])} }) + '\\n');
if (args.join(' ') === '--version') process.stdout.write('0.9.5');
else if (args.join(' ') === 'auth status --agent') process.stdout.write(${JSON.stringify(JSON.stringify(nativeAuth))});
else if (args[0] === 'review') {
  process.stderr.write(${JSON.stringify(JSON.stringify(nativeAuth))});
  for (const event of [${JSON.stringify({ type: 'status', ...nativeAuth })},
    ${JSON.stringify({ type: 'finding', severity: 'major', fileName: repository.trackedPath, startLine: 1, endLine: 1,
      title: 'Validate the changed input', comment: 'Reject invalid input before applying the change.', codegenInstructions: 'Add an input validation guard.' })},
    { type: 'complete', status: 'review_completed', outcome: 'completed', findings: 1 }]) process.stdout.write(JSON.stringify(event) + '\\n');
} else process.exitCode = 23;
`);
    writeExecutableShimSync({ dir: bin, fileName: process.platform === 'win32' ? 'coderabbit.cmd' : 'coderabbit',
      contents: process.platform === 'win32' ? `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`
        : `#!/bin/sh\nexec '${process.execPath.replace(/'/g, `'\\''`)}' '${script.replace(/'/g, `'\\''`)}' "$@"\n` });
    vi.stubEnv('PATH', `${bin}${delimiter}${process.env.PATH ?? ''}`);
    vi.stubEnv('CODERABBIT_API_KEY', privateValues[2]);
    onTestFinished(() => vi.unstubAllEnvs());
    const completed = (stdout = ''): PluginProcessResult => ({
      stdout: new TextEncoder().encode(stdout), stderr: new Uint8Array(), stdoutTruncated: false, stderrTruncated: false,
      termination: { observed: { kind: 'exit', exitCode: 0 }, requestedBy: { kind: 'none' } },
    });
    const nativeReview = structuredClone(selectedNativeReview);
    nativeReview.structured_output.findings = [];
    // Only native process IO is substituted. Actual Roborev activation, profile,
    // finite runtime, normalization, host controller and terminal publication run below.
    const run = vi.fn<ExecService['run']>(async ({ args }) => {
      if (args?.[1] === 'list') return completed('[{"id":3}]');
      if (args?.[1] === 'show') return completed(JSON.stringify(nativeReview));
      return completed();
    });
    const nativeModule: { activate: typeof ROBOREV_PLUGIN.activate } = { activate(api) {
      ROBOREV_PLUGIN.activate({ ...api, agents: { register(id, factory, options) {
        api.agents.register(id, async context => {
          const runtime = await factory(context);
          const executionRuns = runtime.executionRuns;
          if (!executionRuns) throw new Error('Native reviewer omitted its execution-run runtime');
          return { ...runtime, executionRuns: { ...executionRuns, open(request, runtimeContext) {
            return executionRuns.open(request, { ...runtimeContext, services: { ...runtimeContext.services,
              exec: { ...runtimeContext.services.exec, run } } });
          } } };
        }, options);
      } } });
    } };
    const resumableReview = ReviewModelOutputV1Schema.parse({ reviewOutcome: 'complete',
      summary: 'Resumable review complete', overviewMarkdown: 'No findings.', findings: [], questions: [], assumptions: [] });
    const openConversation = async (): Promise<AgentExecutionRunConversationRuntimeV1> => {
      let emit: ((event: AgentExecutionRunConversationEventV1) => void) | null = null;
      return {
        watch(listener) {
          providerEvents.push('watch');
          emit = listener;
          emit({ kind: 'provider-session-id', providerSessionId: 'review-provider-thread', emittedAtMs: 1 });
          return { dispose() { emit = null; } };
        },
        async send(input) {
          providerEvents.push('send');
          emit?.({ kind: 'input-accepted', inputIds: input.inputIds, delivery: input.delivery, emittedAtMs: 1 });
          emit?.({ kind: 'turn-start', turnId: input.delivery.turnId, startedBy: 'host' });
          emit?.({ kind: 'message-delta', turnId: input.delivery.turnId, channel: 'assistant',
            text: JSON.stringify(resumableReview) });
          emit?.({ kind: 'turn-complete', turnId: input.delivery.turnId });
          providerEvents.push('turn-complete');
          return { status: 'admitted' };
        },
        async cancel(input) { return { status: 'requested', turnId: input.turnId }; },
        async dispose() { emit = null; },
      };
    };
    const createResumableRuntime: AgentRuntimeFactory = () => ({ sessions: {
      async open() { throw new Error('Detached review does not open a Session'); },
      executionRunContextV1: { open: request => createExecutionRunHostBackendFromConversationRuntime({ request,
        readCheckpointId: event => event.kind === 'provider-session-id' ? event.providerSessionId : null,
        openConversation }), openConversation },
    } });
    const resumable = definePlugin({ id: 'test.review-follow-up', version: '0.0.0', displayName: 'Resumable reviewer',
      entrypoints: { daemon: './daemon.mjs' }, agents: { reviewer: {
        declaration: { title: 'Resumable reviewer', runtime: { kind: 'custom' }, primary: 'sessions',
          capabilities: { sessions: { open: ['create', 'resume'], delivery: ['newTurn'], cancel: true, workspaceWrites: 'deny',
            executionRunContext: { versions: [1] } } } },
        factory: createResumableRuntime,
        sessionRunnerFactory: { module: './agent-runtime.mjs', export: 'createRuntime', runtimeApiVersion: 1 },
      } } });
    // Registry construction performs the real Home Account-plugin census.
    // Install its HTTP boundary before creating the admitted runtime.
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => { throw new Error('Unexpected fixture Home request'); }));
    vi.spyOn(axios, 'get').mockRejectedValue(new Error('Unexpected fixture Home request'));
    vi.spyOn(axios, 'post').mockImplementation(async (url, body) => {
      const availability = absentAccountPluginAvailabilityHttpResponse(String(url), body);
      if (availability) return availability;
      throw new Error('Unexpected fixture Home request');
    });
    onTestFinished(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
    const fixture = await createAuthoredAdmittedPluginRuntimeFixture({ controller: pluginReloadController,
      happyHomeDir: directory,
      runtimeOptions: { agentIsolation: {
        requesterIdentity: selectHostRequesterExecutionIdentity({ hostHomeServerIdentityId: 'fixture-home',
          hostAccountAgent: { accountId: 'fixture-account', custodianAccountId: 'fixture-account',
            machineId: 'fixture-machine', installationId: 'fixture-installation' } }),
        read: () => ({ enabled: false, status: { kind: 'disabled' }, workspaceRoots: [] }),
      } },
      plugins: [
        { manifest: ROBOREV_PLUGIN.manifest, files: {
          '.happier-plugin-build/daemon.js': 'export function activate() {}',
          'resources/review-prompt.md': await readFile(new URL('../../../../../../../packages/plugins/review-panels/resources/review-prompt.md', import.meta.url), 'utf8'),
        }, instantiateCommittedModule: () => nativeModule },
        { manifest: CODERABBIT_PLUGIN.manifest, files: {
          '.happier-plugin-build/daemon.js': 'export function activate() {}',
          'resources/review-prompt.md': await readFile(new URL('../../../../../../../packages/plugins/review-coderabbit/resources/review-prompt.md', import.meta.url), 'utf8'),
        }, instantiateCommittedModule: () => ({ activate: CODERABBIT_PLUGIN.activate }) },
        { manifest: GIT_PLUGIN.manifest, files: { '.happier-plugin-build/daemon.js': 'export function activate() {}' },
          instantiateCommittedModule: () => ({ activate: GIT_PLUGIN.activate }) },
        { manifest: resumable.manifest, files: {
          'agent-runtime.mjs': 'let factory; export function configure(next) { factory = next; } export function createRuntime(context) { return factory(context); }',
          'daemon.mjs': `import * as leaf from './agent-runtime.mjs';
            export function activate(api) { api.agents.register('reviewer', leaf.createRuntime, {
              sessionRunnerFactory: { module: './agent-runtime.mjs', export: 'createRuntime', runtimeApiVersion: 1 } }); }
            export function configureUnitLeaf(factory) { leaf.configure(factory); return { activate }; }`,
        }, instantiateCommittedModule(module) {
          if (typeof module.configureUnitLeaf !== 'function') throw new Error('Missing provider fixture leaf');
          const configured: unknown = module.configureUnitLeaf(createResumableRuntime);
          if (!configured || typeof configured !== 'object' || !('activate' in configured)) throw new Error('Missing activation');
          return configured as PluginDaemonModuleNamespace;
        } },
      ] });
    let bridge: ExecutionRunHostBridge | null = null;
    let transcriptClient: ApiSessionClient | null = null;
    onTestFailed(() => console.error('Review follow-up fixture', JSON.stringify({ phase, providerEvents,
      state: bridge && activeRunId ? bridge.getPublic(activeRunId) : null })));
    try {
      const engineRegistry = await resolveCliEngineRegistry({ runtimeRegistry: fixture.registry });
      for (const identity of [{ pluginId: ROBOREV_PLUGIN.manifest.id, localId: 'roborev' },
        { pluginId: CODERABBIT_PLUGIN.manifest.id, localId: 'coderabbit' },
        { pluginId: resumable.manifest.id, localId: 'reviewer' }]) {
        const isCodeRabbit = identity.pluginId === CODERABBIT_PLUGIN.manifest.id;
        const isNative = identity.pluginId !== resumable.manifest.id;
        const engine = await engineRegistry.resolveForAgentTarget({ kind: 'agent', identity });
        expect(engine?.agent.identity, JSON.stringify({
          diagnostics: engineRegistry.contributions.pluginDiagnosticsByPluginId[identity.pluginId],
          unavailable: engineRegistry.contributions.unavailablePlugins?.filter(plugin => plugin.pluginId === identity.pluginId),
        })).toEqual(identity);
        const backendTarget = resolveExecutionRunRuntimeBackendTarget({ kind: 'agent', identity }, engineRegistry.contributions);
        if (!backendTarget) throw new Error('Review target was not admitted');
        const profileCatalog = await engineRegistry.resolveExecutionRunProfileCatalog({
          resolveAgentIdentity: agentId => engineRegistry.contributions.agentDefinitionsById.get(agentId)?.identity ?? null,
        });
        const observations: ReturnType<typeof SessionTranscriptObservationInputSchema.parse>[] = [];
        const comments: unknown[] = [];
        const artifactBoundary = isCodeRabbit ? createPlainAccountArtifactHttpBoundary() : null;
        const artifactGet = vi.mocked(axios.get).getMockImplementation();
        const artifactPost = vi.mocked(axios.post).getMockImplementation();
        const credentials = artifactBoundary?.credentials ?? { token: 'review-retention-fixture', encryption: null };
        const records = artifactBoundary ? createReviewRecordPortV1(createAcknowledgedAccountArtifactTransport(
          createAccountArtifactStore({ credentials, getAccountEncryptionMode: async () => 'plain' }))) : null;
        const reviewRound = isCodeRabbit ? await records!.start({ reviewId: 'coderabbit-privacy-review',
          title: 'Review changed input', subjectKind: 'comparison', sourceKind: 'direct',
          reviewerIds: [engine!.agent.id], startedAt: Date.now() }) : undefined;
        if (isCodeRabbit) {
          const home = createSessionTranscriptHomeStub();
          const activity = createSessionRuntimeActivityHomeStub({ machineId: 'fixture-machine' });
          // The Home transport/persistence boundary retains exactly what the
          // ordinary Session writer commits; no transcript or masking owner is replaced.
          const socket = createApiSessionSocketStub({ connected: true, emitWithAck(event, payload) {
            const answer = home.answer(event, payload) ?? activity.answer(event, payload);
            if (event === SESSION_TRANSCRIPT_OBSERVATION_EVENT_V1) observations.push(SessionTranscriptObservationInputSchema.parse(payload));
            if (event === SESSION_TRANSCRIPT_OBSERVATION_BATCH_EVENT_V1) observations.push(...SessionTranscriptObservationBatchInputV1Schema.parse(payload).observations);
            if (answer === null) throw new Error(`Unexpected fixture socket event: ${event}`);
            return answer;
          } });
          vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ features: {}, capabilities: {
            session: { pendingInput: { protocolVersion: 1 }, runtimeActivity: { protocolVersion: 2 }, publisherAuthority: { protocolVersion: 1 } },
          } }), { status: 200 })));
          vi.spyOn(axios, 'get').mockImplementation(async (url, config) => {
            if (String(url).includes('/v1/artifacts') || String(url).endsWith('/v1/account/encryption')) return artifactGet!(url, config);
            if (String(url).endsWith('/v1/auth/ping')) return { status: 200, data: {} };
            if (String(url).endsWith('/v1/account/encryption/currentness')) return {
              status: 200, data: createAccountEncryptionCurrentnessFixture({ mode: 'plain' }) };
            const localId = String(url).split('/messages/by-local-id/')[1];
            const observation = observations.find(row => row.localId === decodeURIComponent(localId ?? ''));
            if (observation) return { status: 200, data: { message: {
              id: `stored-${observation.localId}`, seq: observations.indexOf(observation) + 1,
              localId: observation.localId, sidechainId: observation.sidechainId ?? null,
              content: observation.content, createdAt: observation.createdAt, updatedAt: observation.updatedAt,
              messageRole: observation.messageRole,
            } } };
            return { status: 404, data: {} };
          });
          let prepared: readonly ReviewCommentPreparedRecordV1[] = [];
          vi.spyOn(axios, 'post').mockImplementation(async (url, body, config) => {
            if (String(url).includes('/v1/artifacts')) return artifactPost!(url, body, config);
            const availability = absentAccountPluginAvailabilityHttpResponse(String(url), body);
            if (availability) return availability;
            if (String(url).endsWith('/v1/reviews/comments/mutations/prepare')) {
              const request = ReviewCommentPrepareMutationRequestV1Schema.parse(body);
              const result = deriveReviewCommentStructuralMutationV1({ mutation: request.mutation, accountId: 'owner',
                actor: { kind: 'agent', agentId: engine!.agent.id, sessionId: 'review-owner-session' }, current: [],
                runtime: { now: () => 1, createId: kind => kind === 'review-comment' ? 'comment-coderabbit-1' : `${kind}-1` } });
              prepared = result.records;
              return { status: 200, data: { v: 1, receipt: 'comment-fixture-receipt', request, ...result, replayed: false } };
            }
            if (String(url).endsWith('/v1/reviews/comments/mutations/commit')) {
              const request = ReviewCommentCommitMutationRequestV1Schema.parse(body);
              const stored = request.records.map(row => ({ v: 1, structural: prepared.find(item => item.structural.id === row.commentId)!.structural,
                sensitiveEnvelope: row.sensitiveEnvelope }));
              comments.push(...stored);
              return { status: 200, data: { v: 1, comments: stored, replayed: false, failed: [] } };
            }
            throw new Error('Unexpected fixture Home request');
          });
          transcriptClient = new ApiSessionClient(credentials.token, createPlainSessionFixture({ id: 'review-owner-session' }), {
            metadataAuthority: { kind: 'shared_editor' }, runtimePrincipalAccountId: 'fixture-account',
            localMachineId: 'fixture-machine', durableMutationDeliveryInitiallyActive: false,
            transport: { serverId: 'fixture-home', serverUrl: 'https://review-retention.test',
              createSessionSocketTransport: () => ({ socket: socket as never, transport: createSocketTransportAdapter(socket as never) }) },
          });
        }
        const signingKeys = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(11));
        const reviewComments = isCodeRabbit ? createReviewRunCommentService({ cwd: repository.rootPath,
          scope: { workspace: { machineId: 'fixture-machine', path: repository.rootPath } }, reviewRecords: records!,
          execute: createCliReviewCommentActionExecutorFromCredentials({ credentials, resolveAccountId: () => 'owner',
            resolveAccountEncryptionMode: async () => 'plain', resolvePrincipalSigningContext: async () => ({
              machineId: 'fixture-machine', installationId: 'fixture-installation',
              privateKeyBase64Url: Buffer.from(signingKeys.secretKey).toString('base64url'),
            }) }),
        }) : undefined;
        const parentPermissionHandler = transcriptClient ? new ProviderEnforcedPermissionHandler(transcriptClient,
          { logPrefix: '[coderabbit-retention-fixture]' }) : null;
        parentPermissionHandler?.setPermissionMode('read-only');
        if (transcriptClient && parentPermissionHandler) transcriptClient.setSessionRuntimeControls({
          readPermissionHandler: () => parentPermissionHandler,
        });
        bridge = new ExecutionRunHostBridge({ parentProvider: 'codex', cwd: isCodeRabbit ? repository.rootPath : fixture.happyHomeDir,
          happyHomeDir: fixture.happyHomeDir, resolveAccountSettings: async () => ({}),
          resolveRunReportPolicy: async () => ({ preset: 'important' }),
          ...(reviewComments ? { reviewComments } : {}),
          ...(transcriptClient && parentPermissionHandler ? { sessionInteractionHost: { session: transcriptClient,
            machineId: 'fixture-machine', permissionHandler: parentPermissionHandler,
            readOwnerAccountCredentials: async () => credentials } } : {}),
          sendAcp: transcriptClient ? createCommittedExecutionRunTranscriptPublisher({
            enqueueAgentMessageCommitted: transcriptClient.enqueueAgentMessageCommitted.bind(transcriptClient),
            readParentToolNormalizationSource: () => null,
          }) : async () => {},
          resolveExecutionRunProfileCatalog: () => ({ profileCatalog, engineRegistry }) });
        const sourceCustody = fixture.registry.readPluginSourceCustody?.(identity.pluginId);
        if (!sourceCustody) throw new Error('Review source was not admitted');
        phase = `start:${identity.pluginId}`;
        const started = await bridge.start({ sessionId: isCodeRabbit ? 'review-owner-session' : null, intent: 'review', instructions: 'Review uncommitted changes.',
          backendTarget,
          // The contributed native profile, rather than a copied request row,
          // must lower this request to its own ephemeral/streaming defaults.
          permissionMode: 'read_only', retentionPolicy: 'resumable',
          runClass: 'bounded', ioMode: 'request_response',
          ...(isCodeRabbit ? { modelSelection: null, connectedServices: null } : {}),
          resolvedRole: resolveExecutionRunRoleV1({ roleId: 'reviewer', accountRoleOverrides: { status: 'ready', overrides: {} } }),
          ...(isNative ? { profileId: `${identity.pluginId}/review`, profileSourceCustody: sourceCustody } : {}),
          intentInput: ReviewStartInputSchema.parse({ reviewers: [{ kind: 'engine', engineId: engine!.agent.id }],
            ...(reviewRound ? { reviewRound, reviewRoundSettlement: 'execution', reviewReviewerId: engine!.agent.id } : {}),
            instructions: 'Review uncommitted changes.', scope: 'changes', changeType: 'uncommitted', base: { kind: 'none' } }) });
        activeRunId = started.runId;
        phase = `wait:${identity.pluginId}`;
        await bridge.waitForTerminal(started.runId);
        phase = `result:${identity.pluginId}`;
        expect(bridge.getPublic(started.runId), JSON.stringify(bridge.getPublic(started.runId))).toMatchObject({ status: 'succeeded' });
        // Detached Runs intentionally have no parent Session transcript. Read
        // the actual terminal metadata retained by finishExecutionRun.
        const published = ReviewFindingsV2Schema.parse(bridge.getStructuredMeta(started.runId)?.payload);
        expect(published.runRef).toMatchObject({ runId: started.runId,
          retentionPolicy: isNative ? 'ephemeral' : 'resumable' });
        expect(resolveReviewFollowUpAvailability(published.runRef, { sessionId: 'review-owner-session' }))
          .toMatchObject({ available: !isNative });
        if (isCodeRabbit) {
          expect(published).toMatchObject({ reviewOutcome: 'complete', findings: [{ title: 'Validate the changed input',
            summary: 'Reject invalid input before applying the change.', filePath: repository.trackedPath,
            comment: { id: 'comment-coderabbit-1' } }] });
          expect(comments).toHaveLength(1);
          await transcriptClient!.activateDurableMutationDelivery();
          await transcriptClient!.flushDurableMutationDelivery();
          expect(observations.length).toBeGreaterThan(0);
          expect(JSON.stringify(observations)).toContain('Validate the changed input');
          const transcript = await Promise.all(observations.map(row => transcriptClient!.readCommittedTranscriptMessageByLocalId(row.localId)));
          expect(transcript.every(row => row.type === 'found')).toBe(true);
          expect(JSON.stringify(transcript)).toContain('Validate the changed input');
          const retained = await readRetainedExecutionRunRecord(started.runId);
          expect(retained?.state.status).toBe('succeeded');
          expect(retained && readRetainedReviewFindings(retained.state)).toEqual(published);
          const artifact = await records!.read(reviewRound!.reviewId);
          expect(artifact?.rounds[0]).toMatchObject({ state: 'completed', runs: [{ runId: started.runId }] });
          const calls = (await readFile(nativeCalls, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as { args: string[]; hasCredential: boolean });
          expect(calls).toContainEqual(expect.objectContaining({ args: expect.arrayContaining(['review', '--agent']), hasCredential: false }));
          const log = await readFile(logger.getLogPath(), 'utf8');
          expect(log.length).toBeGreaterThan(0);
          const retainedEvidence = JSON.stringify({ observations, transcript, retained, artifact,
            artifactStorage: [...artifactBoundary!.rows.values()], comments, published,
            publicRun: bridge.getPublic(started.runId), log });
          for (const value of privateValues) expect(retainedEvidence).not.toContain(value);
        }
        await bridge.dispose();
        bridge = null;
        await transcriptClient?.close();
        transcriptClient = null;
      }
      expect(run.mock.calls.some(([request]) => request.args?.[0] === 'review')).toBe(true);
    } finally {
      await bridge?.dispose();
      await transcriptClient?.close();
      await fixture.dispose();
    }
  }));
  it('attests backend and voice resumes and publishes only their successfully resumed registrations', async () => {
    let intent: 'task' | 'agent' | 'voice_agent' = 'agent';
    transport.materialize.mockClear();
    // The fixture Home has no installed Account plugins. Other Home requests
    // fail immediately rather than reaching a live Account with this token.
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => { throw new Error('Unexpected fixture Home request'); }));
    vi.spyOn(axios, 'get').mockRejectedValue(new Error('Unexpected fixture Home request'));
    vi.spyOn(axios, 'post').mockImplementation(async (url, body) => {
      const availability = absentAccountPluginAvailabilityHttpResponse(String(url), body);
      if (availability) return availability;
      throw new Error('Unexpected fixture Home request');
    });
    const service = { pluginId: 'happier.agent.codex', localId: 'openai-codex' };
    const disclosedMember = { service, accountId: 'member' };
    let failLoad = false;
    let loadGate: Promise<void> | null = null;
    let loadEntered: (() => void) | null = null;
    let emitCheckpoint: (() => void) | null = null;
    const providerRequests: Array<AgentExecutionRunOpenRequest | AgentSessionOpenRequest> = [];
    let resolveProviderOpened!: () => void;
    let providerOpened = new Promise<void>((resolve) => { resolveProviderOpened = resolve; });
    const finiteTurnAuthorities: SessionExecutionRunBrokerAuthorityResponseV1[] = [];
    // The authored public-SDK leaf stands in for the external provider process.
    // Its canonical SDK conversation adapter and every host owner remain real.
    const openProvider = async (request: AgentExecutionRunOpenRequest): Promise<AgentExecutionRunRuntime> => {
      providerRequests.push(request);
      if (request.kind === 'fork') throw new Error('Fixture does not support fork');
      if (request.kind === 'resume') {
        loadEntered?.();
        await loadGate;
        if (failLoad) throw new Error('Provider refused resume');
      }
      let emit: ((event: AgentExecutionRunConversationEventV1) => void) | null = null;
      const runtime = await createExecutionRunHostBackendFromConversationRuntime({ request,
        readCheckpointId: (event) => event.kind === 'turn-start' ? 'provider-thread' : null,
        openConversation: () => ({
          watch(listener) {
            emit = listener;
            emitCheckpoint = () => emit?.({ kind: 'turn-start', turnId: 'checkpoint', startedBy: 'host' });
            return { dispose() { emit = null; } };
          },
          async send(input) {
            if (intent === 'task') finiteTurnAuthorities.push(bridge!.resolveLiveBrokerAuthority({
              v: 1, executionRunId: request.runId, expectedOccurrenceId: null,
            }));
            emit?.({ kind: 'turn-start', turnId: input.delivery.turnId, startedBy: 'host' });
            return { status: 'admitted' };
          },
          async cancel(input) {
            emit?.({ kind: 'turn-cancelled', turnId: input.turnId, cause: input.reason });
            return { status: 'requested', turnId: input.turnId };
          },
          async dispose() {},
        }),
      });
      resolveProviderOpened();
      return runtime;
    };
    // Retained Runs open the conversation facet; finite open terminalizes after
    // one turn and cannot supply the retained handle this test exercises.
    const openConversation = async (request: AgentExecutionRunOpenRequest): Promise<AgentExecutionRunConversationRuntimeV1> => {
      providerRequests.push(request);
      if (request.kind === 'fork') throw new Error('Fixture does not support fork');
      if (request.kind === 'resume') {
        loadEntered?.();
        await loadGate;
        if (failLoad) throw new Error('Provider refused resume');
      }
      let emit: ((event: AgentExecutionRunConversationEventV1) => void) | null = null;
      resolveProviderOpened();
      return {
        watch(listener) {
          emit = listener;
          emitCheckpoint = () => emit?.({ kind: 'provider-session-id', providerSessionId: 'provider-thread', emittedAtMs: 1 });
          emitCheckpoint();
          return { dispose() { emit = null; } };
        },
        async send(input) {
          emit?.({ kind: 'input-accepted', inputIds: input.inputIds, delivery: input.delivery, emittedAtMs: 1 });
          emit?.({ kind: 'turn-start', turnId: input.delivery.turnId, startedBy: 'host', emittedAtMs: 1 });
          return { status: 'admitted' };
        },
        async cancel(input) {
          emit?.({ kind: 'turn-cancelled', turnId: input.turnId, cause: input.reason, emittedAtMs: 1 });
          return { status: 'requested', turnId: input.turnId };
        },
        async dispose() { emit = null; },
      };
    };
    // Session-owned Voice uses the ordinary public Session facet, not the
    // detached executionRunContext facet. This mirrors the successful native
    // Voice fixture's external provider boundary.
    const openSession = async (request: AgentSessionOpenRequest): Promise<AgentSessionRuntime> => {
      providerRequests.push(request);
      // The external provider sees the selected profile's materialized auth,
      // not just a selection recorded on the host's launch projection.
      expect(request.launchEnvironment?.values.HAPPIER_TEST_AUTH).toBe('voice-profile-credential');
      if (request.kind === 'fork') throw new Error('Fixture does not support fork');
      if (request.kind === 'resume') {
        loadEntered?.();
        await loadGate;
        if (failLoad) throw new Error('Provider refused resume');
      }
      let listener: ((event: AgentSessionRuntimeEvent) => void) | null = null;
      let sequence = 0;
      const runtime: AgentSessionRuntime = {
        watch(next) {
          listener = next;
          emitCheckpoint = () => listener?.({ kind: 'provider-session-id', providerSessionId: 'provider-thread',
            sessionId: request.sessionId, sequence: ++sequence, emittedAtMs: sequence });
          emitCheckpoint();
          return { dispose() { listener = null; } };
        },
        async send(input) {
          const turnId = input.delivery.turnId;
          listener?.({ kind: 'input-accepted', sessionId: request.sessionId, sequence: ++sequence,
            emittedAtMs: sequence, inputIds: input.inputIds, delivery: input.delivery });
          listener?.({ kind: 'turn-start', sessionId: request.sessionId, sequence: ++sequence,
            emittedAtMs: sequence, turnId, startedBy: 'host' });
          listener?.({ kind: 'message-delta', sessionId: request.sessionId, sequence: ++sequence,
            emittedAtMs: sequence, turnId, channel: 'assistant', text: 'Fresh Voice reply.' });
          listener?.({ kind: 'turn-complete', sessionId: request.sessionId, sequence: ++sequence,
            emittedAtMs: sequence, turnId });
          return { status: 'admitted' };
        },
        async cancel({ turnId }) { return { status: 'requested', turnId }; },
        async dispose() { listener = null; },
      };
      resolveProviderOpened();
      return runtime;
    };
    const plugin = definePlugin({ id: 'test.connected-resume', version: '0.0.0', displayName: 'Resume boundary Agent',
      // Claude's supported Session-owned Voice runtime declares this same
      // current-Session authority; connected account purposes do not imply it.
      hostAccess: { required: [{ id: 'session-runtime', capability: 'sessions',
        reason: 'Use the authenticated current Session for retained Voice.',
        scope: { access: ['read', 'write', 'control'] } }], optional: [] },
      entrypoints: { daemon: './daemon.mjs' }, agents: { agent: {
        declaration: { title: 'Resume boundary Agent', runtime: { kind: 'custom' }, primary: 'sessions',
          connectedAccounts: [{ purpose: 'primary', service }],
          capabilities: { sessions: { open: ['create', 'resume'], delivery: ['newTurn'], cancel: true,
            executionRunContext: { versions: [1] } } } },
        factory: () => ({ sessions: { open: openSession,
          executionRunContextV1: { open: openProvider, openConversation } } }),
        sessionRunnerFactory: { module: './agent-runtime.mjs', export: 'createRuntime', runtimeApiVersion: 1 },
      } } });
    const agent = { pluginId: plugin.manifest.id, localId: 'agent' };
    const agentId = `${agent.pluginId}/${agent.localId}`;
    const fixture = await createAuthoredAdmittedPluginRuntimeFixture({ controller: pluginReloadController, happyHomeDir: directory,
      runtimeOptions: { agentIsolation: {
        requesterIdentity: selectHostRequesterExecutionIdentity({ hostHomeServerIdentityId: 'fixture-home',
          hostAccountAgent: { accountId: 'fixture-account', custodianAccountId: 'fixture-account',
            machineId: 'fixture-machine', installationId: 'fixture-installation' } }),
        read: () => ({ enabled: false, status: { kind: 'disabled' }, workspaceRoots: [] }),
      } },
      plugins: [{ manifest: plugin.manifest, files: {
        'agent-runtime.mjs': `let open, openSession, openConversation, prepare; export function configure(callback, sessionCallback, conversationCallback, prepareCallback) { open = callback; openSession = sessionCallback; openConversation = conversationCallback; prepare = prepareCallback; }
          export function prepareEnvironment(input) { return prepare(input); }
          export function createRuntime() { return { sessions: {
            open: request => openSession(request),
            executionRunContextV1: { open: request => open(request), openConversation: request => openConversation(request) } } }; }`,
        'daemon.mjs': `import * as leaf from './agent-runtime.mjs';
          export function activate(api) { api.agents.register('agent', leaf.createRuntime, {
            sessionRunnerFactory: { module: './agent-runtime.mjs', export: 'createRuntime', runtimeApiVersion: 1 },
            connectedAccountLaunch: { prepareEnvironment: input => leaf.prepareEnvironment(input) } }); }
          export function configureUnitLeaf(open, openSession, openConversation, prepare) { leaf.configure(open, openSession, openConversation, prepare); return { activate }; }`,
      }, instantiateCommittedModule(module) {
        const configure = module.configureUnitLeaf;
        if (typeof configure !== 'function') throw new Error('Missing provider boundary fixture');
        const configured: unknown = configure(openProvider, openSession, openConversation, prepareCodexConnectedAccountLaunchEnvironment);
        if (!configured || typeof configured !== 'object' || !('activate' in configured)) throw new Error('Missing activation');
        return configured as PluginDaemonModuleNamespace;
      } }] });
    let bridge: ExecutionRunHostBridge | null = null;
    const parentSession = createMutableApiSessionClientFixture({ sessionId: 'voice-parent-session',
      metadata: createTestMetadata({ path: fixture.happyHomeDir }) });
    const parentPermissions = new ProviderEnforcedPermissionHandler(parentSession, { logPrefix: '[Voice fixture]' });
    let phase = 'admitted runtime resolution';
    let completed = false;
    onTestFinished(() => {
      if (!completed) console.error('Actual connected Run fixture failure phase', phase,
        { materializations: transport.materialize.mock.calls.length, providerOpens: providerRequests.map((request) => request.kind) });
    });
    try {
      const engineRegistry = await resolveCliEngineRegistry({ runtimeRegistry: fixture.registry });
      phase = 'admitted profile catalog resolution';
      const profileCatalog = await engineRegistry.resolveExecutionRunProfileCatalog({ resolveAgentIdentity: () => agent });
      phase = 'admitted native runtime resolution';
      const engine = await engineRegistry.resolveForBackendId(agentId);
      expect(engine?.agent.identity).toEqual(agent);
      const sourceCustody = fixture.registry.readPluginSourceCustody?.(agent.pluginId);
      if (!sourceCustody) throw new Error('Missing admitted source custody');
      // Authored launch values keep this fixture independent of the runner's
      // environment. The targeted gate also supplies these same inherited
      // values, exercising the real plugin-engine isolation bundle without
      // mutating process.env. Both reach the public native launch schema.
      phase = 'selected-purpose execution-run environment';
      for (const connected of [true, false]) {
        transport.materialize.mockImplementation(async (request: { runId: string; connectedServices: unknown }) => {
          const activationId = randomUUID();
          return { ok: true, result: { activationId, env: { CODEX_HOME: `${fixture.happyHomeDir}/selected-codex` },
            producedConnectedAccountPurposes: ['primary'],
            unsetEnvKeys: ['AGY_ACP_CCPA_BASE_URL', 'AGY_ACP_CCPA_PROJECT'],
            connectedServicesBindings: request.connectedServices,
            registration: { v: 1, activationId, runKey: request.runId, agentId,
              agentContribution: { ...agent, sourceCustody }, materializationKey: request.runId,
              connectedServicesBindings: request.connectedServices, connectedServiceSelectionsEnv: {},
              sessionDirectory: fixture.happyHomeDir, materializedRoot: `${fixture.happyHomeDir}/environment-home` } } };
        });
        const run = createExecutionRunRuntime({
          engineRegistry, happyHomeDir: fixture.happyHomeDir, cwd: fixture.happyHomeDir,
          backendId: agentId, backendTarget: { kind: 'builtInAgent', agentId },
          runnerAgentTarget: { kind: 'agent', identity: agent },
          scope: 'detached', permissionMode: 'read_only', runId: `environment-${connected}`,
          start: { intent: 'agent', profileId: 'agent' },
          secretReferenceEnvironment: { AGY_ACP_CCPA_BASE_URL: 'https://native.example',
            agy_acp_ccpa_project: 'native-project' },
          connectedServices: { v: 2, bindingsByServiceId: { [`${service.pluginId}/${service.localId}`]: connected
            ? { source: 'connected', selection: 'profile', profileId: 'environment-profile' }
            : { source: 'native' } } },
        });
        try {
          await expect(run.provisionRuntime({ initialPrompt: 'Check the selected launch environment.' }))
            .resolves.toMatchObject({ runtimeId: expect.any(String) });
          const opened = providerRequests.at(-1);
          if (!opened || !('runId' in opened)) throw new Error('Expected the real execution-run open');
          expect(opened.runnerConnectedAccountPurposes).toEqual(connected ? ['primary'] : []);
          expect(opened.runnerConnectedAccountMaterialization).toEqual(connected
            ? { v: 1, kind: 'configFile', rootPath: `${fixture.happyHomeDir}/selected-codex`, relativePaths: ['auth.json'] }
            : undefined);
          const launch = opened.launchEnvironment;
          if (!launch) throw new Error('Actual external provider launch environment unavailable');
          if (connected) {
            expect(launch.values).not.toHaveProperty('AGY_ACP_CCPA_BASE_URL');
            expect(launch.values).not.toHaveProperty('agy_acp_ccpa_project');
            expect(launch.unset).toEqual(['AGY_ACP_CCPA_BASE_URL', 'AGY_ACP_CCPA_PROJECT']);
          } else {
            expect(launch.values).toMatchObject({ AGY_ACP_CCPA_BASE_URL: 'https://native.example',
              agy_acp_ccpa_project: 'native-project' });
            expect(launch.unset).toEqual([]);
          }
        } finally { await run.dispose(); }
      }
      providerRequests.length = 0;
      transport.materialize.mockClear();
      const queries: SessionExecutionRunBrokerAuthorityResponseV1[] = [];
      const activations: string[] = [];
      const materializationOccurrences: Array<{ actual: string | undefined; expected: string | undefined }> = [];
      const resumeMaterializations: Array<NonNullable<ReturnType<ExecutionRunHostBridge['captureResumeMaterialization']>>> = [];
      transport.materialize.mockImplementation(async (request: { runId: string; connectedServices: unknown; controllerOccurrenceId?: string }) => {
        materializationOccurrences.push({ actual: request.controllerOccurrenceId,
          expected: bridge!.readExecutionRunOccurrenceWitnessReader().readCurrentRunOccurrence(request.runId)?.occurrenceId });
        const resume = request.controllerOccurrenceId
          ? bridge!.captureResumeMaterialization(request.runId, request.controllerOccurrenceId) : null;
        if (resume) resumeMaterializations.push(resume);
        if (intent === 'agent') {
        const authority = bridge!.resolveLiveBrokerAuthority({ v: 1, executionRunId: request.runId,
          expectedOccurrenceId: null, expectedDirectMaterialUse: { resourceId: 'direct-resource',
            slot: { kind: 'connected_service_purpose', purpose: { consumer: agent, purpose: 'primary' } }, disclosedMember } });
        queries.push(authority);
        if (authority.status !== 'current') return { ok: false, error: 'Run broker authority is not current' };
        }
        const activationId = randomUUID();
        activations.push(activationId);
        return { ok: true, result: { activationId,
          env: intent === 'voice_agent' ? { HAPPIER_TEST_AUTH: 'voice-profile-credential' } : {},
          connectedServicesBindings: request.connectedServices,
          registration: { v: 1, activationId, runKey: request.runId, agentId,
            agentContribution: { ...agent, sourceCustody }, materializationKey: request.runId,
            connectedServicesBindings: request.connectedServices, connectedServiceSelectionsEnv: {},
            sessionDirectory: fixture.happyHomeDir, materializedRoot: `${fixture.happyHomeDir}/durable-home` } } };
      });
      for (const runIntent of ['task', 'agent', 'voice_agent'] as const) {
      intent = runIntent;
      failLoad = false;
      loadGate = null;
      loadEntered = null;
      emitCheckpoint = null;
      providerRequests.length = 0;
      queries.length = 0;
      activations.length = 0;
      providerOpened = new Promise<void>((resolve) => { resolveProviderOpened = resolve; });
      bridge = new ExecutionRunHostBridge({ parentProvider: 'codex', cwd: fixture.happyHomeDir,
        resolveRunReportPolicy: async () => ({ preset: 'important' }),
        happyHomeDir: fixture.happyHomeDir, sendAcp: async () => {}, getNowMs: () => 1_700_000_000_000,
        sessionInteractionHost: { session: parentSession, machineId: 'fixture-machine', permissionHandler: parentPermissions },
        // Prepare the actual, empty attached Session prompt sources through the
        // real prompt owner; this fixture has no network-owned Account overlays.
        resolveVoicePromptPreparation: async (args) => await resolveCliVoicePromptPreparation({ ...args,
          sessionMetadata: parentSession.getMetadataSnapshot(), accountEntries: [], profileEntries: [], projectEntries: [],
          directory: args.workingDirectory ?? undefined }),
        // This is the same daemon generation-check transport boundary as materialization.
        checkConnectedServicesGenerationCurrent: async ({ registration }) => ({
          current: registration.activationId === activations.at(-1),
        }),
        resolveExecutionRunProfileCatalog: async () => ({ profileCatalog, engineRegistry }) });
      phase = 'initial provider startup';
      const started = await bridge.start({ sessionId: intent === 'voice_agent' ? 'voice-parent-session' : null, intent,
        backendTarget: { kind: 'builtInAgent', agentId }, instructions: 'Wait for input.',
        permissionMode: 'read_only', retentionPolicy: 'resumable', runClass: intent === 'task' ? 'bounded' : 'long_lived',
        ioMode: intent === 'voice_agent' ? 'streaming' : 'request_response',
        ...(intent === 'voice_agent' ? { bootstrapMode: 'none' as const, initialContextMode: 'first_turn' as const,
          chatModelId: 'voice-model', commitModelId: 'default' } : {}),
        connectedServices: { v: 2, bindingsByServiceId: { [`${service.pluginId}/${service.localId}`]: {
          ...(intent === 'agent'
            ? { source: 'team_resource' as const, resourceId: 'direct-resource', deliveryMode: 'direct' as const, disclosedMember }
            : { source: 'connected' as const, selection: 'profile' as const, profileId: 'voice-profile' }),
        } } } });
      await Promise.race([
        providerOpened,
        bridge.waitForTerminal(started.runId).then(() => {
          throw new Error(`Provider failed before opening: ${JSON.stringify(bridge!.get(started.runId)?.error)}`);
        }),
      ]);
      if (intent === 'task') {
        expect(finiteTurnAuthorities).toEqual([expect.objectContaining({
          status: 'current', parentSessionId: null, intent: 'task', runtimeState: 'active_turn',
          activeTurnId: expect.any(String),
        })]);
        await bridge.stop(started.runId);
        await bridge.waitForTerminal(started.runId);
        expect(bridge.resolveLiveBrokerAuthority({ v: 1, executionRunId: started.runId,
          expectedOccurrenceId: null })).toMatchObject({ status: 'not_current' });
        await bridge.dispose();
        bridge = null;
        continue;
      }
      for (const occurrence of materializationOccurrences) {
        expect(occurrence.actual).toEqual(expect.any(String));
        expect(occurrence.actual).toBe(occurrence.expected);
      }
      phase = 'initial provider checkpoint';
      await vi.waitFor(() => {
        emitCheckpoint?.();
        expect(bridge!.get(started.runId), JSON.stringify({
          status: bridge!.get(started.runId)?.status, resumeHandle: bridge!.get(started.runId)?.resumeHandle,
          error: bridge!.get(started.runId)?.error, queries: queries.map((query) => query.status),
          providerRequests: providerRequests.map((request) => request.kind),
        })).toMatchObject({
          // The commit role is lazy; both this native Voice and detached Agent
          // have exactly one opened provider Session at this boundary.
          status: 'running', resumeHandle: { kind: 'provider_session.v1' },
        });
      });
      expect(queries).toEqual(intent === 'agent' ? [expect.objectContaining({ status: 'current' })] : []);
      if (intent === 'voice_agent') expect(bridge.get(started.runId)?.launch?.connectedServicesSelection)
        .toMatchObject({ bindingsByServiceId: { [`${service.pluginId}/${service.localId}`]: {
          source: 'connected', selection: 'profile', profileId: 'voice-profile',
        } } });
      await bridge.stop(started.runId);
      await bridge.waitForTerminal(started.runId);
      phase = 'successful resume';
      await expect(bridge.ensure(started.runId, { resume: true })).resolves.toEqual({ ok: true });
      const resumedMaterialization = resumeMaterializations.at(-1);
      expect(resumedMaterialization).toBeDefined();
      if (!resumedMaterialization) throw new Error('The native resume did not carry its canonical materialization');
      expect(resumedMaterialization.isCurrent()).toBe(true);
      expect(bridge.captureResumeMaterialization(started.runId, resumedMaterialization.occurrenceId)).toBeNull();
      for (const occurrence of materializationOccurrences) {
        expect(occurrence.actual).toEqual(expect.any(String));
        expect(occurrence.actual).toBe(occurrence.expected);
      }
      expect(queries).toHaveLength(intent === 'agent' ? 2 : 0);
      const registration = bridge.get(started.runId)?.launch?.connectedServicesRegistration;
      expect(registration?.activationId).toBe(activations.at(-1));
      expect((await listExecutionRunMarkersForRehydration()).find((marker) => marker.runId === started.runId))
        .toMatchObject({ status: 'running', executionRunConnectedServicesCleanupReceiptV1: { activationId: activations.at(-1) } });

      if (intent === 'voice_agent') {
        const currentBridge = bridge;
        const previousUi = storage.getState();
        const sessionId = 'voice-parent-session';
        const session = createSessionFixture({ id: sessionId, metadata: { ...createSessionFixture().metadata!,
          agentRuntimeFacetsV1: { v: 1, transcriptSource: { supported: true, followLeaseSupported: true } } } });
        const local = readLocalConversationVoiceSettings(previousUi.settings.voice);
        storage.getState().applySettingsLocal(normalizeVoiceSettingsLocalDelta({ voice: writeVoiceProviderSettingsConfig(
          previousUi.settings.voice, 'local_conversation', { ...local, streaming: { ...local.streaming, enabled: true },
            agent: { ...local.agent, resumabilityMode: 'provider_resume',
              transcript: { ...local.agent.transcript, persistenceMode: 'persistent' } } },
        ) }, previousUi.settings));
        storage.setState({ sessions: { ...previousUi.sessions, [sessionId]: session } });
        const unused = async (): Promise<never> => { throw new Error('Unexpected Voice transport method'); };
        // This is the UI-to-runner network boundary. The cached-handle owner,
        // stream producer, lifecycle, native runtime and materialization stay real.
        const handle: VoiceAgentHandle = { backend: 'daemon', rpcSessionId: sessionId,
          voiceAgentId: started.runId, metadataSessionId: sessionId, transcriptEpoch: 0, agentBackendId: agentId,
          accountLifetime: { scope: { serverId: 'voice-test-home', accountId: 'voice-test-account' },
            isCurrent: () => true, onRetire: () => ({ dispose() {} }) },
          client: { start: unused, sendTurn: unused, welcome: unused, commit: unused, stop: unused,
            async startTurnStream(request) {
              const result = await currentBridge.startTurnStream(request.voiceAgentId, { message: request.userText,
                ...(request.resume === true ? { resume: true } : {}) });
              if (!result.ok) throw createRpcCallError(result);
              return { streamId: result.streamId };
            },
            async readTurnStream(request) {
              const result = await currentBridge.readTurnStream(request.voiceAgentId, request);
              if (!result.ok) throw createRpcCallError(result);
              return result;
            },
            async cancelTurnStream(request) {
              const result = await currentBridge.cancelTurnStream(request.voiceAgentId, request);
              if (!result.ok) throw createRpcCallError(result);
              return result;
            },
          } };
        const createHandle = vi.fn(async () => handle);
        const context = { voiceAttemptExplicitContextBySessionId: new Map<string, string[]>(),
          deferredTargetSessionContextBySessionId: new Map<string, string | null>(),
          latestAutomaticUiContextBySessionId: new Map<string, string>() };
        const recovery = createVoiceRunRecovery({ ...context, createHandle,
          voiceAgentBySessionId: new Map([[sessionId, handle]]), voiceAgentInitBySessionId: new Map() });
        const voice = createVoiceTurnStreaming({ ...context, getVoiceAgentHandle: recovery.getVoiceAgentHandle,
          resetCachedHandle: recovery.resetCachedHandle, interruptActiveTurn() {},
          trackActiveTurn: async (_sessionId, task) => task(), voiceAgentTurnAbortControllerBySessionId: new Map() });
        try {
          for (const terminal of ['failed', 'cancelled'] as const) {
            phase = `ordinary cached Voice input after ${terminal}`;
            await currentBridge.stop(started.runId);
            await currentBridge.waitForTerminal(started.runId);
            if (terminal === 'failed') {
              // Seed the terminal snapshot before the cached-input boundary.
              // Native failure detection is a separate owner contract; this
              // regression covers ordinary input to either retained status.
              const retained = currentBridge.get(started.runId);
              if (!retained) throw new Error('Missing retained Voice Run');
              retained.status = 'failed';
            }
            expect(currentBridge.getPublic(started.runId)?.status).toBe(terminal);
            const occurrence = currentBridge.readExecutionRunOccurrenceWitnessReader().readCurrentRunOccurrence(started.runId);
            const materializations = transport.materialize.mock.calls.length;
            const opens = providerRequests.length;
            const refused = await voice.sendTurn(sessionId, 'Ordinary input').then(() => null, (error: unknown) => error);
            expect(refused).toMatchObject({ rpcErrorCode: 'execution_run_not_allowed' });
            expect(transport.materialize.mock.calls).toHaveLength(materializations);
            expect(providerRequests).toHaveLength(opens);
            expect(currentBridge.readExecutionRunOccurrenceWitnessReader().readCurrentRunOccurrence(started.runId)).toEqual(occurrence);
            expect(createHandle).not.toHaveBeenCalled();
            await expect(currentBridge.ensure(started.runId, { resume: true })).resolves.toEqual({ ok: true });
            await expect(voice.sendTurn(sessionId, 'Fresh input after explicit recovery')).resolves.toMatchObject({ assistantText: 'Fresh Voice reply.' });
            expect(transport.materialize.mock.calls).toHaveLength(materializations + 1);
          }
        } finally { storage.setState({ settings: previousUi.settings, sessions: previousUi.sessions }); }
      }

      await bridge.stop(started.runId);
      await bridge.waitForTerminal(started.runId);
      expect(resumedMaterialization.isCurrent()).toBe(false);
      // The evolved recovery owner deliberately omits transient registrations.
      // Failure must preserve that actual retained launch, not resurrect an
      // already-released runtime registration from the preceding occurrence.
      await bridge.recoverRetainedRuns();
      const retainedLaunch = bridge.get(started.runId)?.launch;
      const retainedStatus = bridge.get(started.runId)?.status;
      const priorTerminalMarker = (await listExecutionRunMarkersForRehydration()).find((marker) => marker.runId === started.runId);
      phase = 'failed provider load';
      failLoad = true;
      await expect(bridge.ensure(started.runId, { resume: true })).resolves.toMatchObject({
        ok: false, errorCode: intent === 'agent' ? 'execution_run_failed' : 'execution_run_not_allowed',
      });
      const terminalMarker = (await listExecutionRunMarkersForRehydration()).find((marker) => marker.runId === started.runId);
      if (intent === 'agent') {
        expect(bridge.get(started.runId)?.launch).toEqual({ ...retainedLaunch, connectedServicesSelectionAgent: agent });
        expect(bridge.get(started.runId)).toMatchObject({ status: 'failed', error: { code: 'execution_run_failed' } });
        expect(terminalMarker).toMatchObject({ status: 'failed', errorCode: 'execution_run_failed' });
      } else {
        expect(bridge.get(started.runId)?.launch).toEqual(retainedLaunch);
        expect(bridge.get(started.runId)?.status).toBe(retainedStatus);
        expect(terminalMarker).toEqual(priorTerminalMarker);
      }

      failLoad = false;
      let releaseLoad!: () => void;
      loadGate = new Promise<void>((resolve) => { releaseLoad = resolve; });
      const enteringLoad = new Promise<void>((resolve) => { loadEntered = resolve; });
      phase = 'stop during provider provisioning';
      const resuming = bridge.ensure(started.runId, { resume: true });
      await enteringLoad;
      expect(bridge.get(started.runId)?.status).toBe('running');
      expect(bridge.get(started.runId)?.launch?.connectedServicesRegistration).toEqual(retainedLaunch?.connectedServicesRegistration);
      expect((await listExecutionRunMarkersForRehydration()).find((marker) => marker.runId === started.runId)).toEqual(terminalMarker);
      const stopping = bridge.stop(started.runId);
      await vi.waitFor(() => expect(bridge!.get(started.runId)?.status).toBe('cancelled'));
      releaseLoad();
      await stopping;
      await expect(resuming).resolves.toMatchObject({ ok: false });
      expect(bridge.get(started.runId)?.status).toBe('cancelled');
      expect(bridge.get(started.runId)?.launch?.connectedServicesRegistration).toEqual(retainedLaunch?.connectedServicesRegistration);
      await bridge.dispose();
      bridge = null;
      }
      completed = true;
    } finally {
      await bridge?.dispose();
      await parentSession.close();
      await fixture.dispose();
      vi.restoreAllMocks();
      vi.unstubAllGlobals();
    }
  });
});
