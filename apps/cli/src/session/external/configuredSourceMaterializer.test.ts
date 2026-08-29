import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { describe, expect, it, vi } from 'vitest';

import {
  resolveExternalSessionsSourceKeyForDeclaration,
  ingestPluginManifestV2,
  MAX_PLUGIN_TRANSCRIPT_SOURCES_PER_CONTRIBUTION,
  type PluginAgentContributionV2,
} from '@happier-dev/protocol';
import type { AgentExternalSessionsContribution } from '@happier-dev/plugin-sdk/sessions/external';
import { PLUGIN_MANIFEST as CLAUDE_PLUGIN_MANIFEST } from '@happier-dev/plugins-claude/manifest';
import { PLUGIN_MANIFEST as CODEX_PLUGIN_MANIFEST } from '@happier-dev/plugins-codex/manifest';
import { PLUGIN_MANIFEST as OPENCODE_PLUGIN_MANIFEST } from '@happier-dev/plugins-opencode/manifest';
import { PLUGIN_MANIFEST as PI_PLUGIN_MANIFEST } from '@happier-dev/plugins-pi/manifest';
import { PLUGIN_MANIFEST as OHMYPI_PLUGIN_MANIFEST } from '@happier-dev/plugins-ohmypi/manifest';
import {
  ExternalSessionProviderFailureError,
  type ExternalSessionFollowProviderOps,
  type ExternalSessionProviderOps,
} from './providerOps';
import {
  EXTERNAL_SESSION_FOLLOW_CLOSE_TRANSPORT_TIMEOUT_MS,
} from './hostOperationOwner';
import type { HostExternalTranscriptFollowEvent } from './privateContract';
import type { ContextualExternalSessionTakeoverAdapter } from './contextualTakeoverAdmission';
import {
  createBoundedAgentExternalSessionsContribution,
} from './agentExternalSessionsInvocation';
import {
  createAgentExternalSessionsExecutionSurface,
} from '@/agent/runtime/registry/agentExternalSessionsExecutionSurface';
import { createUnavailablePluginServices } from '@/plugins/runtime/invocation/services/unavailable';
import { resolveConnectedServiceMaterializedHomeRoot } from '@/daemon/connectedServices/catalogHooks';

import {
  createConfiguredPluginExternalSessionsAdapter,
  createLiveConfiguredPluginExternalSessionsAdapter,
  materializeConfiguredExternalSessionSourceCandidates,
  resolveConfiguredExternalSessionFollowTarget,
  type ConfiguredExternalSessionSourceAccountProjection,
} from './configuredSourceMaterializer';

const codexContribution = {
  id: 'codex',
  title: 'Codex',
  runtime: { kind: 'custom' },
  primary: 'sessions',
  capabilities: {
    sessions: { open: ['create'], delivery: ['newTurn'], cancel: true },
  },
  surfaces: {
    externalSession: {
      sources: [{
        sourceKind: 'codexHome',
        terminalFollow: { userRowClassification: 'explicitV1' },
        schema: {
          fields: [
            { name: 'kind', kind: 'literal', value: 'codexHome' },
            { name: 'home', kind: 'enum', values: ['user', 'connectedService'] },
            { name: 'homePath', kind: 'string', min: 1, optional: true },
            { name: 'connectedServiceId', kind: 'string', min: 1, optional: true },
            { name: 'connectedServiceProfileId', kind: 'string', min: 1, optional: true },
            { name: 'connectedServiceGroupId', kind: 'string', min: 1, optional: true },
          ],
          refinements: [
            {
              kind: 'requiresWhenEquals',
              field: 'connectedServiceId',
              when: { field: 'home', equals: 'connectedService' },
            },
            {
              kind: 'forbidsWhenEquals',
              fields: [
                'connectedServiceId',
                'connectedServiceProfileId',
                'connectedServiceGroupId',
              ],
              when: { field: 'home', equals: 'user' },
            },
          ],
        },
        key: {
          segments: [
            { kind: 'literal', value: 'codexHome' },
            { kind: 'homeMode', field: 'home' },
            {
              kind: 'conditionalField',
              field: 'connectedServiceId',
              when: { field: 'home', equals: 'connectedService' },
            },
            {
              kind: 'connectedServiceScope',
              groupField: 'connectedServiceGroupId',
              profileField: 'connectedServiceProfileId',
              when: { field: 'home', equals: 'connectedService' },
            },
            { kind: 'field', field: 'homePath' },
          ],
        },
        instances: [
          { kind: 'default', constants: { home: 'user' } },
          {
            kind: 'connectedServiceProfiles',
            serviceId: 'openai-codex',
            constants: { home: 'connectedService' },
            fields: { serviceId: 'connectedServiceId', profileId: 'connectedServiceProfileId' },
          },
        ],
      }],
    },
  },
} satisfies PluginAgentContributionV2;

function agent(contribution: PluginAgentContributionV2 = codexContribution) {
  return {
    id: contribution.id,
    identity: { pluginId: 'happier.codex', localId: contribution.id },
    richDefinition: { provenance: 'first_party' as const, definition: contribution },
  };
}

function connectedCodexSource(activeServerDir: string, profileId: string) {
  const homePath = resolveConnectedServiceMaterializedHomeRoot('codex', {
    activeServerDir,
    serviceId: 'openai-codex',
    profileId,
  });
  if (!homePath) {
    throw new Error('Codex connected-service materialized home is unavailable in the test catalog');
  }
  const source = {
    kind: 'codexHome' as const,
    home: 'connectedService' as const,
    connectedServiceId: 'openai-codex',
    connectedServiceProfileId: profileId,
    homePath,
  };
  return {
    source,
    sourceId: resolveExternalSessionsSourceKeyForDeclaration(
      codexContribution.surfaces.externalSession.sources[0],
      source,
    ),
  };
}

async function withTemporaryActiveServerDir<T>(
  run: (activeServerDir: string) => Promise<T>,
): Promise<T> {
  const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-configured-source-materializer-'));
  try {
    return await run(activeServerDir);
  } finally {
    await rm(activeServerDir, { recursive: true, force: true });
  }
}

async function listCandidateIndexFiles(activeServerDir: string): Promise<string[]> {
  const root = join(activeServerDir, 'external-sessions', 'candidate-indexes', 'v1');
  const files: string[] = [];
  const walk = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.name === 'index.json') files.push(path);
    }
  };
  await walk(root);
  return files;
}

async function expectCandidateIndexesRetired(activeServerDir: string): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if ((await listCandidateIndexFiles(activeServerDir)).length === 0) return;
    await delay(10);
  }
  expect(await listCandidateIndexFiles(activeServerDir)).toEqual([]);
}

function readManifestAgentContribution(manifest: unknown, agentId: string) {
  const ingested = ingestPluginManifestV2(manifest);
  if (!ingested.ok) throw new Error(`Plugin manifest for ${agentId} must be valid`);
  const contribution = ingested.manifest.contributes.agents.find(
    (candidate) => candidate.id === agentId,
  );
  if (!contribution) throw new Error(`Plugin manifest must declare Agent ${agentId}`);
  return contribution;
}

async function loadCodexExternalSessionsContribution(params: Readonly<{
  env: NodeJS.ProcessEnv;
}>): Promise<AgentExternalSessionsContribution> {
  const contributionPath =
    '../../../../../packages/plugins/codex/src/agent/surfaces/sessions/external/contribution.js';
  const module = await import(contributionPath);
  const createContribution = module.createCodexExternalSessionsContribution as (
    options: typeof params,
  ) => AgentExternalSessionsContribution;
  return createContribution(params);
}

function providerOpsFromCodexContribution(
  contribution: AgentExternalSessionsContribution,
): ExternalSessionProviderOps {
  const retirement = new AbortController();
  const surface = createAgentExternalSessionsExecutionSurface(
    createBoundedAgentExternalSessionsContribution({
      contribution,
      identity: {
        pluginId: CODEX_PLUGIN_MANIFEST.id,
        agentId: 'codex',
        generation: 'configured-source-materializer-test',
        contributionQualifiedId: `${CODEX_PLUGIN_MANIFEST.id}/agents/codex`,
        immutableGenerationId: null,
      },
      isCurrent: () => true,
      retirementSignal: retirement.signal,
      createInvocationExec: async () => createUnavailablePluginServices().exec,
    }),
  );
  if (
    !surface.validateSource
    || !surface.listCandidates
    || !surface.resolveLinkIdentity
    || !surface.pageTranscript
    || !surface.readAfterTranscript
  ) {
    throw new Error('Expected the real Codex External Sessions source/list/transcript surface');
  }
  return {
    validateSource: surface.validateSource,
    listCandidates: surface.listCandidates,
    resolveLinkIdentity: surface.resolveLinkIdentity,
    pageTranscript: surface.pageTranscript,
    readAfterTranscript: surface.readAfterTranscript,
  };
}

const resolveExactLinkIdentity: NonNullable<ExternalSessionProviderOps['resolveLinkIdentity']> = async ({
  source,
  remoteSessionId,
}) => ({ source, remoteSessionId });

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function isAbortedSignal(signal: AbortSignal | null): boolean {
  return signal?.aborted === true;
}

describe('configured external-session source materializer', () => {
  it('materializes independent Pi-family roots and changes only the configured Agent', () => {
    const pi = agent(readManifestAgentContribution(PI_PLUGIN_MANIFEST, 'pi'));
    const ohmypi = agent(readManifestAgentContribution(OHMYPI_PLUGIN_MANIFEST, 'ohmypi'));
    const materialize = (agentSettings: Readonly<Record<string, unknown>>) =>
      materializeConfiguredExternalSessionSourceCandidates({
        agents: [pi, ohmypi],
        account: { connectedServicesV2: [] },
        agentSettings,
      });

    expect(materialize({})).toEqual([
      { agentId: 'pi', source: { kind: 'piAgentDir' } },
      { agentId: 'ohmypi', source: { kind: 'ohMyPiAgentDir' } },
    ]);
    expect(materialize({
      piAgentDir: '/isolated/pi',
      ohMyPiAgentDir: '/isolated/omp',
    })).toEqual([
      { agentId: 'pi', source: { kind: 'piAgentDir', agentDir: '/isolated/pi' } },
      { agentId: 'ohmypi', source: { kind: 'ohMyPiAgentDir', agentDir: '/isolated/omp' } },
    ]);
    expect(materialize({ piAgentDir: '/changed/pi' })).toEqual([
      { agentId: 'pi', source: { kind: 'piAgentDir', agentDir: '/changed/pi' } },
      { agentId: 'ohmypi', source: { kind: 'ohMyPiAgentDir' } },
    ]);
  });

  it('materializes declared defaults and connected profiles using identifiers only', () => {
    const candidates = materializeConfiguredExternalSessionSourceCandidates({
      agents: [agent()],
      account: {
        connectedServicesV2: [{
          serviceId: 'openai-codex',
          profiles: [
            {
              profileId: 'work', status: 'connected', kind: 'oauth', providerEmail: 'private@example.com',
              providerAccountId: 'acct-secret', expiresAt: null, lastUsedAt: null, health: null,
            },
            {
              profileId: 'reauth', status: 'needs_reauth', kind: 'oauth', providerEmail: null,
              providerAccountId: null, expiresAt: null, lastUsedAt: null, health: null,
            },
          ],
          groups: [],
        }],
      },
    });

    expect(candidates).toEqual([
      { agentId: 'codex', source: { kind: 'codexHome', home: 'user' } },
      {
        agentId: 'codex',
        source: {
          kind: 'codexHome', home: 'connectedService',
          connectedServiceId: 'openai-codex', connectedServiceProfileId: 'work',
        },
      },
    ]);
    expect(JSON.stringify(candidates)).not.toMatch(/private@example|acct-secret|oauth/);
  });

  it('admits a connected Codex profile through the host-materialized home before the real leaf browses it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-codex-connected-source-admission-'));
    try {
      const activeServerDir = join(root, 'active-server');
      const connectedSource = connectedCodexSource(activeServerDir, 'work');
      const connectedCodexHome = connectedSource.source.homePath;
      const remoteSessionId = '11111111-1111-1111-1111-111111111111';
      const sessionDirectory = join(connectedCodexHome, 'sessions', '2026', '08', '25');
      await mkdir(sessionDirectory, { recursive: true });
      await writeFile(
        join(sessionDirectory, `rollout-2026-08-25T12-00-00-${remoteSessionId}.jsonl`),
        `${JSON.stringify({
          type: 'session_meta',
          timestamp: '2026-08-25T12:00:00.000Z',
          payload: {
            id: remoteSessionId,
            timestamp: '2026-08-25T12:00:00.000Z',
            cwd: '/repo/connected-codex',
          },
        })}\n`,
        'utf8',
      );
      const contribution = await loadCodexExternalSessionsContribution({
        env: { CODEX_HOME: join(root, 'empty-user-codex-home') },
      });
      const ops = providerOpsFromCodexContribution(contribution);
      await expect(ops.listCandidates({
        source: connectedSource.source,
        limit: 10,
        searchMode: 'fast',
      })).resolves.toMatchObject({
        candidates: [{
          remoteSessionId,
          linkData: { source: connectedSource.source },
        }],
      });
      const listCandidates = vi.fn(async (request: Parameters<typeof ops.listCandidates>[0]) =>
        await ops.listCandidates(request));
      const observedOps: ExternalSessionProviderOps = { ...ops, listCandidates };
      const basis = {
        contributionGenerationId: 'registry:codex-connected-home',
        accountSettingsRevision: 'account:connected-home',
      };
      const composition = await createConfiguredPluginExternalSessionsAdapter({
        agents: [agent(readManifestAgentContribution(CODEX_PLUGIN_MANIFEST, 'codex'))],
        account: {
          connectedServicesV2: [{
            serviceId: 'openai-codex',
            profiles: [{
              profileId: 'work',
              status: 'connected',
              kind: 'oauth',
              providerEmail: null,
              providerAccountId: null,
              expiresAt: null,
              lastUsedAt: null,
              health: null,
            }],
            groups: [],
          }],
        },
        basis,
        readCurrentBasis: () => basis,
        isCurrent: () => true,
        activeServerDir,
        resolveProviderOps: async () => observedOps,
      });

      try {
        let page = await composition.authorService.list({
          limit: 10,
          sourceId: connectedSource.sourceId,
        });
        expect(listCandidates).toHaveBeenCalledWith(expect.objectContaining({
          searchMode: 'fast',
          source: connectedSource.source,
        }));
        for (let continuation = 0; continuation < 3 && page.items.length === 0; continuation += 1) {
          expect(page.diagnostics).toBeUndefined();
          expect(page.nextCursor).toMatch(/^plugin_external_sessions_v1_/);
          page = await composition.authorService.list({
            limit: 10,
            sourceId: connectedSource.sourceId,
            cursor: page.nextCursor!,
          });
        }

        expect(page.items.map((item) => item.ref.remoteSessionId)).toContain(remoteSessionId);
        expect(composition.sourceRefusals).toEqual([]);
      } finally {
        composition.dispose();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 60_000);

  it('fails closed on malformed account profile identifiers', () => {
    expect(() => materializeConfiguredExternalSessionSourceCandidates({
      agents: [agent()],
      account: {
        connectedServicesV2: [{
          serviceId: 'openai-codex',
          profiles: [{
            profileId: '../secret', status: 'connected', kind: null, providerEmail: null,
            providerAccountId: null, expiresAt: null, lastUsedAt: null, health: null,
          }],
          groups: [],
        }],
      },
    })).toThrow(/profile identifier/i);
  });

  it('fails closed before connected-profile expansion exceeds the canonical source ceiling', () => {
    const profiles = Array.from(
      { length: MAX_PLUGIN_TRANSCRIPT_SOURCES_PER_CONTRIBUTION + 1 },
      (_, index) => ({
        profileId: `profile-${index}`, status: 'connected' as const, kind: 'oauth' as const,
        providerEmail: null, providerAccountId: null, expiresAt: null, lastUsedAt: null, health: null,
      }),
    );
    expect(() => materializeConfiguredExternalSessionSourceCandidates({
      agents: [agent()],
      account: {
        connectedServicesV2: [{ serviceId: 'openai-codex', profiles, groups: [] }],
      },
    })).toThrow(/source capacity/i);
  });

  it('fails closed when static instances across Agent contributions exceed the canonical source ceiling', () => {
    const agents = Array.from(
      { length: MAX_PLUGIN_TRANSCRIPT_SOURCES_PER_CONTRIBUTION + 1 },
      (_, index) => ({ ...agent(), id: `codex-${index}` }),
    );

    expect(() => materializeConfiguredExternalSessionSourceCandidates({
      agents,
      account: { connectedServicesV2: [] },
    })).toThrow(/source capacity/i);
  });

  it('does not infer source instances when the Agent contribution omits declarations', () => {
    const withoutInstances: PluginAgentContributionV2 = {
      ...codexContribution,
      surfaces: {
        externalSession: {
          sources: codexContribution.surfaces.externalSession.sources.map(({ instances: _instances, ...source }) => source),
        },
      },
    };

    expect(materializeConfiguredExternalSessionSourceCandidates({
      agents: [agent(withoutInstances)],
      account: { connectedServicesV2: [] },
    })).toEqual([]);
  });

  it('resolves one configured provider-session follow target', async () => {
    const ops: ExternalSessionFollowProviderOps = {
      validateSource: async ({ source }) => ({ ok: true, source }),
      resolveLinkIdentity: async ({ source, remoteSessionId }) => ({
        source: {
          ...source,
          homePath: '/canonical/codex',
        },
        remoteSessionId,
        linkData: {},
      }),
      pageTranscript: async () => ({
        items: [], nextCursor: null, tailCursor: null, hasMore: false, truncated: false,
      }),
      readAfterTranscript: async () => ({ outcome: 'already_current' }),
    };
    const basis = {
      contributionGenerationId: 'registry:g1',
      accountSettingsRevision: 'account:1',
    };

    await expect(resolveConfiguredExternalSessionFollowTarget({
      agents: [agent()],
      account: { connectedServicesV2: [] },
      basis,
      readCurrentBasis: () => basis,
      isCurrent: () => true,
      agentId: 'codex',
      remoteSessionId: 'remote-1',
      resolveProviderOps: async () => ops,
    })).resolves.toEqual({
      status: 'resolved',
      ref: {
        agentId: 'codex',
        sourceId: 'codexHome:user:::',
        remoteSessionId: 'remote-1',
      },
      source: {
        kind: 'codexHome',
        home: 'user',
        homePath: '/canonical/codex',
      },
    });
  });

  it('follows the Session\'s exact bound source instead of scanning the configured aggregate', async () => {
    // Two configured sources of the same Agent expose the same remote id: the
    // default user home and a Connected Account profile home. Scanning the
    // aggregate makes both resolve, which is indistinguishable from a genuinely
    // ambiguous identity even though this Session already holds an exact source
    // binding from its own link authority.
    const account: ConfiguredExternalSessionSourceAccountProjection = {
      connectedServicesV2: [{
        serviceId: 'openai-codex',
        profiles: [{
          profileId: 'work',
          status: 'connected',
          kind: 'oauth',
          providerEmail: 'private@example.com',
          providerAccountId: 'acct-secret',
          expiresAt: null,
          lastUsedAt: null,
          health: null,
        }],
        groups: [],
      }],
    };
    const basis = {
      contributionGenerationId: 'registry:g1',
      accountSettingsRevision: 'account:1',
    };
    const resolveLinkIdentity = vi.fn<
      ExternalSessionFollowProviderOps['resolveLinkIdentity']
    >(async ({ source, remoteSessionId }) => ({
      source,
      remoteSessionId,
      linkData: {},
    }));
    const ops: ExternalSessionFollowProviderOps = {
      validateSource: async ({ source }) => ({ ok: true, source }),
      resolveLinkIdentity,
      pageTranscript: async () => ({
        items: [], nextCursor: null, tailCursor: null, hasMore: false, truncated: false,
      }),
      readAfterTranscript: async () => ({ outcome: 'already_current' }),
    };
    await withTemporaryActiveServerDir(async (activeServerDir) => {
      const workSource = connectedCodexSource(activeServerDir, 'work');
      const retiredSource = connectedCodexSource(activeServerDir, 'retired-profile');
      const request = {
        agents: [agent()],
        account,
        basis,
        readCurrentBasis: () => basis,
        isCurrent: () => true,
        activeServerDir,
        agentId: 'codex',
        remoteSessionId: 'remote-1',
        resolveProviderOps: async () => ops,
      } as const;

      await expect(resolveConfiguredExternalSessionFollowTarget(request))
        .resolves.toEqual({
          status: 'unavailable',
          code: 'plugin_external_follow_identity_ambiguous',
        });
      expect(resolveLinkIdentity).toHaveBeenCalledTimes(2);

      resolveLinkIdentity.mockClear();
      await expect(resolveConfiguredExternalSessionFollowTarget({
        ...request,
        // The Session carries the exact host-stamped home it was linked through.
        // The aggregate must not decide that another configured source is close
        // enough simply because it reports the same provider session id.
        boundSource: workSource.source,
      })).resolves.toEqual({
        status: 'resolved',
        ref: {
          agentId: 'codex',
          sourceId: workSource.sourceId,
          remoteSessionId: 'remote-1',
        },
        source: workSource.source,
      });
      // The other configured source is never consulted at all: the bound source
      // is an authority, not a preference among scan results.
      expect(resolveLinkIdentity).toHaveBeenCalledOnce();
      expect(resolveLinkIdentity).toHaveBeenCalledWith(
        expect.objectContaining({ source: workSource.source }),
      );

      // A bound source no longer present in the configured aggregate fails
      // closed. Following whichever remaining source answers for the same remote
      // id would hand this Session a transcript it was never linked to.
      resolveLinkIdentity.mockClear();
      await expect(resolveConfiguredExternalSessionFollowTarget({
        ...request,
        boundSource: retiredSource.source,
      })).resolves.toEqual({
        status: 'unavailable',
        code: 'plugin_external_follow_identity_unavailable',
      });
      expect(resolveLinkIdentity).not.toHaveBeenCalled();
    });
  });

  it('bounds configured-source validation within the inherited terminal admission deadline', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(10_000));
    const pendingValidation = deferred<{
      ok: true;
      source: { kind: 'codexHome'; home: 'user' };
    }>();
    let validationSignal: AbortSignal | null = null;
    const resolveLinkIdentity = vi.fn(resolveExactLinkIdentity);
    const basis = {
      contributionGenerationId: 'registry:g1',
      accountSettingsRevision: 'account:1',
    };
    let outcome: Awaited<ReturnType<typeof resolveConfiguredExternalSessionFollowTarget>> | null = null;
    const resolution = resolveConfiguredExternalSessionFollowTarget({
      agents: [agent()],
      account: { connectedServicesV2: [] },
      basis,
      readCurrentBasis: () => basis,
      isCurrent: () => true,
      agentId: 'codex',
      remoteSessionId: 'remote-1',
      admissionDeadlineAtMs: 10_001,
      resolveProviderOps: async () => ({
        validateSource: async ({ signal }) => {
          validationSignal = signal ?? null;
          return await pendingValidation.promise;
        },
        resolveLinkIdentity,
        pageTranscript: async () => ({
          items: [], nextCursor: null, tailCursor: null, hasMore: false, truncated: false,
        }),
        readAfterTranscript: async () => ({ outcome: 'already_current' as const }),
      }),
    }).then((value) => {
      outcome = value;
      return value;
    });

    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(validationSignal).toBeInstanceOf(AbortSignal);

      await vi.advanceTimersByTimeAsync(1);

      expect(outcome).toEqual({
        status: 'unavailable',
        code: 'plugin_operation_deadline_exceeded',
      });
      expect(isAbortedSignal(validationSignal)).toBe(true);
      expect(resolveLinkIdentity).not.toHaveBeenCalled();
    } finally {
      pendingValidation.resolve({
        ok: true,
        source: { kind: 'codexHome', home: 'user' },
      });
      await vi.advanceTimersByTimeAsync(0);
      await resolution;
      vi.useRealTimers();
    }
  });

  it('bounds configured-provider acquisition within the inherited terminal admission deadline', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(10_000));
    const pendingProviderOps = deferred<ExternalSessionFollowProviderOps>();
    const validateSource = vi.fn(async ({ source }: Parameters<
      ExternalSessionFollowProviderOps['validateSource']
    >[0]) => ({ ok: true as const, source }));
    const resolveLinkIdentity = vi.fn(resolveExactLinkIdentity);
    const basis = {
      contributionGenerationId: 'registry:g1',
      accountSettingsRevision: 'account:1',
    };
    let outcome: Awaited<ReturnType<typeof resolveConfiguredExternalSessionFollowTarget>> | null = null;
    const resolution = resolveConfiguredExternalSessionFollowTarget({
      agents: [agent()],
      account: { connectedServicesV2: [] },
      basis,
      readCurrentBasis: () => basis,
      isCurrent: () => true,
      agentId: 'codex',
      remoteSessionId: 'remote-1',
      admissionDeadlineAtMs: 10_001,
      resolveProviderOps: async () => await pendingProviderOps.promise,
    }).then((value) => {
      outcome = value;
      return value;
    });

    try {
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(1);

      expect(outcome).toEqual({
        status: 'unavailable',
        code: 'plugin_operation_deadline_exceeded',
      });
      expect(validateSource).not.toHaveBeenCalled();
      expect(resolveLinkIdentity).not.toHaveBeenCalled();
    } finally {
      pendingProviderOps.resolve({
        validateSource,
        resolveLinkIdentity,
        pageTranscript: async () => ({
          items: [], nextCursor: null, tailCursor: null, hasMore: false, truncated: false,
        }),
        readAfterTranscript: async () => ({ outcome: 'already_current' as const }),
      });
      await vi.advanceTimersByTimeAsync(0);
      await resolution;
      vi.useRealTimers();
    }
  });

  it('keeps terminal follow unavailable when the Agent source omits explicit user-row classification', async () => {
    const sourceWithoutTerminalFollow = {
      ...codexContribution,
      surfaces: {
        externalSession: {
          sources: codexContribution.surfaces.externalSession.sources.map(
            ({ terminalFollow: _terminalFollow, ...source }) => source,
          ),
        },
      },
    } satisfies PluginAgentContributionV2;
    const target = await resolveConfiguredExternalSessionFollowTarget({
      agents: [agent(sourceWithoutTerminalFollow)],
      account: { connectedServicesV2: [] },
      basis: {
        contributionGenerationId: 'registry:g1',
        accountSettingsRevision: 'account:1',
      },
      readCurrentBasis: () => ({
        contributionGenerationId: 'registry:g1',
        accountSettingsRevision: 'account:1',
      }),
      isCurrent: () => true,
      agentId: 'codex',
      remoteSessionId: 'remote-1',
      resolveProviderOps: async () => ({
        validateSource: async ({ source }) => ({ ok: true, source }),
        listCandidates: async () => ({ candidates: [], nextCursor: null }),
        resolveLinkIdentity: async ({ source, remoteSessionId }) => ({
          source,
          remoteSessionId,
          linkData: {},
        }),
        pageTranscript: async () => ({
          items: [],
          nextCursor: null,
          tailCursor: null,
          hasMore: false,
          truncated: false,
        }),
        readAfterTranscript: async () => ({ outcome: 'already_current' }),
      }),
    });

    expect(target).toEqual({
      status: 'unavailable',
      code: 'plugin_external_follow_identity_unavailable',
    });
  });

  it('keeps a configured terminal source unavailable without a bound host follow port', async () => {
    const composition = await createConfiguredPluginExternalSessionsAdapter({
      agents: [agent()],
      account: { connectedServicesV2: [] },
      basis: {
        contributionGenerationId: 'registry:g1',
        accountSettingsRevision: 'account:1',
      },
      readCurrentBasis: () => ({
        contributionGenerationId: 'registry:g1',
        accountSettingsRevision: 'account:1',
      }),
      isCurrent: () => true,
      resolveProviderOps: async () => ({
        validateSource: async ({ source }) => ({ ok: true as const, source }),
        listCandidates: async () => ({ candidates: [], nextCursor: null }),
        resolveLinkIdentity: resolveExactLinkIdentity,
        pageTranscript: async () => ({
          items: [],
          nextCursor: null,
          tailCursor: null,
          hasMore: false,
          truncated: false,
        }),
        readAfterTranscript: async () => ({ outcome: 'already_current' as const }),
      }),
    });

    await expect(composition.compositionPort.resolveFollowTarget({
      agentId: 'codex',
      remoteSessionId: 'remote-1',
    })).resolves.toEqual({
      status: 'unavailable',
      code: 'plugin_external_follow_identity_unavailable',
    });
  });

  it('keeps terminal follow unavailable when the current runtime lacks bounded replay', async () => {
    const incompleteRuntime: ExternalSessionFollowProviderOps & Pick<
      ExternalSessionProviderOps,
      'listCandidates'
    > = {
      validateSource: async ({ source }) => ({ ok: true as const, source }),
      listCandidates: async () => ({
        candidates: [{ remoteSessionId: 'remote-1', updatedAtMs: 1 }],
        nextCursor: null,
      }),
      resolveLinkIdentity: resolveExactLinkIdentity,
      pageTranscript: async () => ({
        items: [],
        nextCursor: null,
        tailCursor: null,
        hasMore: false,
        truncated: false,
      }),
      readAfterTranscript: async () => ({ outcome: 'already_current' as const }),
      // Deliberately malformed runtime-boundary fixture: pageTranscript is the
      // missing fact this fail-closed test exercises.
    };
    expect(Reflect.deleteProperty(incompleteRuntime, 'pageTranscript')).toBe(true);

    await expect(resolveConfiguredExternalSessionFollowTarget({
      agents: [agent()],
      account: { connectedServicesV2: [] },
      basis: {
        contributionGenerationId: 'registry:g1',
        accountSettingsRevision: 'account:1',
      },
      readCurrentBasis: () => ({
        contributionGenerationId: 'registry:g1',
        accountSettingsRevision: 'account:1',
      }),
      isCurrent: () => true,
      agentId: 'codex',
      remoteSessionId: 'remote-1',
      resolveProviderOps: async () => incompleteRuntime,
    })).resolves.toEqual({
      status: 'unavailable',
      code: 'plugin_external_follow_identity_unavailable',
    });

    const composition = await createConfiguredPluginExternalSessionsAdapter({
      agents: [agent()],
      account: { connectedServicesV2: [] },
      basis: {
        contributionGenerationId: 'registry:g1',
        accountSettingsRevision: 'account:1',
      },
      readCurrentBasis: () => ({
        contributionGenerationId: 'registry:g1',
        accountSettingsRevision: 'account:1',
      }),
      isCurrent: () => true,
      resolveProviderOps: async () => incompleteRuntime,
      followTranscript: vi.fn(async () => ({
        status: 'unavailable' as const,
        code: 'plugin_external_follow_unavailable',
      })),
    });
    expect((await composition.authorService.capabilities()).follow).toEqual({
      status: 'unavailable',
      code: 'plugin_external_follow_unavailable',
    });
    expect((await composition.authorService.list()).items[0]?.capabilities)
      .not.toContain('follow');
  });

  it.each([
    ['claude', CLAUDE_PLUGIN_MANIFEST],
    ['codex', CODEX_PLUGIN_MANIFEST],
    ['opencode', OPENCODE_PLUGIN_MANIFEST],
  ] as const)('keeps the shipped %s Agent terminal follow unavailable until its writer proves the strict classification contract', async (agentId, manifest) => {
    const contribution = readManifestAgentContribution(manifest, agentId);
    const resolveProviderOps = vi.fn(async (): Promise<ExternalSessionFollowProviderOps & Pick<
      ExternalSessionProviderOps,
      'listCandidates'
    >> => ({
      validateSource: async ({ source }) => ({ ok: true, source }),
      listCandidates: async () => ({ candidates: [], nextCursor: null }),
      resolveLinkIdentity: async ({ source, remoteSessionId }) => ({
        source,
        remoteSessionId,
        linkData: {},
      }),
      pageTranscript: async () => ({
        items: [],
        nextCursor: null,
        tailCursor: null,
        hasMore: false,
        truncated: false,
      }),
      readAfterTranscript: async () => ({ outcome: 'already_current' }),
    }));

    await expect(resolveConfiguredExternalSessionFollowTarget({
      agents: [{
        id: agentId,
        identity: { pluginId: manifest.id, localId: agentId },
        richDefinition: { provenance: 'first_party', definition: contribution },
      }],
      account: { connectedServicesV2: [] },
      basis: {
        contributionGenerationId: 'registry:g1',
        accountSettingsRevision: 'account:1',
      },
      readCurrentBasis: () => ({
        contributionGenerationId: 'registry:g1',
        accountSettingsRevision: 'account:1',
      }),
      isCurrent: () => true,
      agentId,
      remoteSessionId: 'remote-1',
      resolveProviderOps,
    })).resolves.toEqual({
      status: 'unavailable',
      code: 'plugin_external_follow_identity_unavailable',
    });
    expect(resolveProviderOps).toHaveBeenCalledOnce();
  });

  it('composes opaque configured sources into the native adapter and retires on account drift', async () => {
    let currentBasis = {
      contributionGenerationId: 'registry:g1',
      accountSettingsRevision: 'account:1',
    };
    const listCandidates = vi.fn<ExternalSessionProviderOps['listCandidates']>(async (_params) => ({
      candidates: [{ remoteSessionId: 'remote-1', title: 'Remote', updatedAtMs: 1 }],
      nextCursor: null,
    }));
    const validateSource = vi.fn(async (
      { source }: Parameters<ExternalSessionProviderOps['validateSource']>[0],
    ) => ({ ok: true as const, source }));
    const ops: ExternalSessionProviderOps = {
      validateSource,
      listCandidates,
      pageTranscript: async () => ({
        items: [], nextCursor: null, tailCursor: null, hasMore: false, truncated: false,
      }),
      readAfterTranscript: async () => ({ outcome: 'already_current' }),
    };
    const adapter = await createConfiguredPluginExternalSessionsAdapter({
      agents: [agent()],
      account: { connectedServicesV2: [] },
      basis: currentBasis,
      readCurrentBasis: () => currentBasis,
      isCurrent: () => true,
      resolveProviderOps: async () => ops,
    });
    expect(validateSource).toHaveBeenCalledOnce();

    const listed = await adapter.authorService.list();
    expect(listed.items[0]?.ref).toMatchObject({
      agentId: 'codex',
      sourceId: 'codexHome:user:::',
      remoteSessionId: 'remote-1',
    });
    expect(listCandidates).toHaveBeenCalledOnce();
    expect(validateSource).toHaveBeenCalledOnce();

    currentBasis = { ...currentBasis, accountSettingsRevision: 'account:2' };
    expect((await adapter.authorService.capabilities()).list).toEqual({ status: 'unavailable', code: 'plugin_generation_retired' });
    await expect(adapter.authorService.list()).rejects.toMatchObject({ code: 'plugin_generation_retired' });
  });

  it('routes preparation chunks through the canonical candidate-index owner before publishing candidates', async () => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-configured-candidate-index-'));
    try {
      const listCandidates = vi.fn<ExternalSessionProviderOps['listCandidates']>(async ({ cursor, searchTerm }) => (
        searchTerm
          ? {
              candidates: [{
                remoteSessionId: searchTerm,
                title: `Hydrated ${searchTerm}`,
                updatedAtMs: searchTerm === 'newest' ? 2 : 1,
              }],
              nextCursor: null,
            }
          : cursor
          ? {
              candidates: [{ remoteSessionId: 'newest', title: 'Private title', updatedAtMs: 2 }],
              nextCursor: null,
              preparation: { kind: 'building_candidate_index', scanned: 2 },
            }
          : {
              candidates: [{ remoteSessionId: 'oldest', title: 'Private title', updatedAtMs: 1 }],
              nextCursor: 'scan:2',
              preparation: { kind: 'building_candidate_index', scanned: 1 },
            }
      ));
      const ops: ExternalSessionProviderOps = {
        validateSource: async ({ source }) => ({ ok: true, source }),
        listCandidates,
        resolveLinkIdentity: async ({ source, remoteSessionId }) => ({
          source,
          remoteSessionId,
        }),
        pageTranscript: async () => ({
          items: [], nextCursor: null, tailCursor: null, hasMore: false, truncated: false,
        }),
        readAfterTranscript: async () => ({ outcome: 'already_current' }),
      };
      const adapter = await createConfiguredPluginExternalSessionsAdapter({
        agents: [agent()],
        account: { connectedServicesV2: [] },
        basis: { contributionGenerationId: 'registry:g1', accountSettingsRevision: 'account:1' },
        readCurrentBasis: () => ({
          contributionGenerationId: 'registry:g1',
          accountSettingsRevision: 'account:1',
        }),
        isCurrent: () => true,
        activeServerDir,
        resolveProviderOps: async () => ops,
      });

      const firstPreparation = await adapter.authorService.list();
      expect(firstPreparation.items).toEqual([]);
      expect(firstPreparation.nextCursor).toMatch(/^plugin_external_sessions_v1_/);
      const secondPreparation = await adapter.authorService.list({ cursor: firstPreparation.nextCursor! });
      expect(secondPreparation.items).toEqual([]);
      expect(secondPreparation.nextCursor).toMatch(/^plugin_external_sessions_v1_/);
      await expect(adapter.authorService.list({ cursor: secondPreparation.nextCursor! })).resolves.toMatchObject({
        items: [
          { ref: { remoteSessionId: 'newest' }, title: 'Private title' },
          { ref: { remoteSessionId: 'oldest' }, title: 'Private title' },
        ],
      });
      expect(listCandidates.mock.calls
        .filter(([request]) => request.searchTerm === undefined)
        .map(([request]) => request.cursor ?? null)).toEqual([
        null,
        null,
        'scan:2',
        null,
        'scan:2',
      ]);
      expect(await listCandidateIndexFiles(activeServerDir)).toHaveLength(1);
      adapter.dispose();
      await delay(50);
      expect(await listCandidateIndexFiles(activeServerDir)).toHaveLength(1);

      const successor = await createConfiguredPluginExternalSessionsAdapter({
        agents: [agent()],
        account: { connectedServicesV2: [] },
        basis: { contributionGenerationId: 'registry:g2', accountSettingsRevision: 'account:1' },
        readCurrentBasis: () => ({
          contributionGenerationId: 'registry:g2',
          accountSettingsRevision: 'account:1',
        }),
        isCurrent: () => true,
        activeServerDir,
        resolveProviderOps: async () => ops,
      });
      // The cold composition advanced the build through its public cursors. The
      // successor reuses the retained index instead of rebuilding it.
      await expect(successor.authorService.list()).resolves.toMatchObject({
        items: [
          { ref: { remoteSessionId: 'newest' }, title: 'Private title' },
          { ref: { remoteSessionId: 'oldest' }, title: 'Private title' },
        ],
      });
      successor.dispose();
    } finally {
      await rm(activeServerDir, { recursive: true, force: true });
    }
  });

  it('does not let a retired in-flight source query recreate its candidate index', async () => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-retired-candidate-index-'));
    try {
      let enteredResolve!: () => void;
      let releaseResolve!: () => void;
      const entered = new Promise<void>((resolve) => { enteredResolve = resolve; });
      const release = new Promise<void>((resolve) => { releaseResolve = resolve; });
      const ops: ExternalSessionProviderOps = {
        validateSource: async ({ source }) => ({ ok: true, source }),
        listCandidates: async () => {
          enteredResolve();
          await release;
          return {
            candidates: [{ remoteSessionId: 'retired', updatedAtMs: 1 }],
            nextCursor: 'scan:2',
            preparation: { kind: 'building_candidate_index', scanned: 1, total: 2 },
          };
        },
        resolveLinkIdentity: async ({ source, remoteSessionId }) => ({ source, remoteSessionId }),
        pageTranscript: async () => ({
          items: [], nextCursor: null, tailCursor: null, hasMore: false, truncated: false,
        }),
        readAfterTranscript: async () => ({ outcome: 'already_current' }),
      };
      const basis = { contributionGenerationId: 'registry:g1', accountSettingsRevision: 'account:1' };
      const adapter = await createConfiguredPluginExternalSessionsAdapter({
        agents: [agent()],
        account: { connectedServicesV2: [] },
        basis,
        readCurrentBasis: () => basis,
        isCurrent: () => true,
        activeServerDir,
        resolveProviderOps: async () => ops,
      });

      const listing = adapter.authorService.list();
      await Promise.race([
        entered,
        delay(2_000).then(() => {
          throw new Error('retirement race never entered the source query');
        }),
      ]);
      adapter.dispose();
      releaseResolve();
      await expect(listing).rejects.toMatchObject({ code: 'plugin_generation_retired' });
      await expectCandidateIndexesRetired(activeServerDir);
    } finally {
      await rm(activeServerDir, { recursive: true, force: true });
    }
  });

  it('qualifies a public takeover ref through the current identity owner without listing candidates', async () => {
    const listCandidates = vi.fn<ExternalSessionProviderOps['listCandidates']>(async () => {
      throw new Error('public takeover must not re-list candidates');
    });
    const ops: ExternalSessionProviderOps = {
      validateSource: async ({ source }) => ({ ok: true, source }),
      listCandidates,
      resolveLinkIdentity: async ({ source, remoteSessionId }) => ({
        source: {
          ...source,
          conversationId: 'takeover-current',
        },
        remoteSessionId,
      }),
      pageTranscript: async () => ({
        items: [], nextCursor: null, tailCursor: null, hasMore: false, truncated: false,
      }),
      readAfterTranscript: async () => ({ outcome: 'already_current' }),
    };
    const basis = {
      contributionGenerationId: 'registry:g1',
      accountSettingsRevision: 'account:1',
    };
    const composition = await createConfiguredPluginExternalSessionsAdapter({
      agents: [agent()],
      account: { connectedServicesV2: [] },
      basis,
      readCurrentBasis: () => basis,
      isCurrent: () => true,
      resolveProviderOps: async () => ops,
    });

    await expect(composition.resolveAuthorSource({
      agentId: 'codex',
      sourceId: 'codexHome:user:::',
      remoteSessionId: 'remote-1',
    })).resolves.toEqual({
      source: {
        kind: 'codexHome',
        home: 'user',
        conversationId: 'takeover-current',
      },
      externalLinkedTakeoverWriterSafety: 'unsupported',
    });
    expect(listCandidates).not.toHaveBeenCalled();
  });

  it('projects follow through the canonical host owner without accepting the deprecated provider lease', async () => {
    const dispose = vi.fn();
    const followTranscript = vi.fn(async () => ({
      status: 'following' as const,
      startingCursor: 'cursor-tail',
      subscription: { dispose },
    }));
    const ops: ExternalSessionProviderOps = {
      validateSource: async ({ source }) => ({ ok: true, source }),
      listCandidates: async () => ({
        candidates: [{ remoteSessionId: 'remote-1', updatedAtMs: 1 }],
        nextCursor: null,
      }),
      resolveLinkIdentity: resolveExactLinkIdentity,
      pageTranscript: async () => ({ items: [], nextCursor: null, tailCursor: null, hasMore: false, truncated: false }),
      readAfterTranscript: async () => ({ outcome: 'already_current' }),
    };
    const adapter = await createConfiguredPluginExternalSessionsAdapter({
      agents: [agent()],
      account: { connectedServicesV2: [] },
      basis: { contributionGenerationId: 'registry:g1', accountSettingsRevision: 'account:1' },
      readCurrentBasis: () => ({ contributionGenerationId: 'registry:g1', accountSettingsRevision: 'account:1' }),
      isCurrent: () => true,
      resolveProviderOps: async () => ops,
      followTranscript,
    });

    expect((await adapter.authorService.capabilities()).follow).toEqual({ status: 'available' });
    const listed = await adapter.authorService.list();
    expect(listed.items[0]?.capabilities).toContain('follow');
    const result = await adapter.compositionPort.followTranscript({
      ref: listed.items[0]!.ref,
      source: { kind: 'codexHome', home: 'user' },
    }, {}, vi.fn());
    expect(result.status).toBe('following');
    if (result.status === 'following') await result.subscription.dispose();
    expect(followTranscript).toHaveBeenCalledOnce();
    expect(dispose).toHaveBeenCalledOnce();
    expect(ops).not.toHaveProperty('acquireFollowLease');
  });

  it('delivers a deeply nested valid follow event instead of reclassifying it as invalid', async () => {
    // The canonical transcript value contract carries no generic depth quota,
    // so the author follow-event byte bound must be measured iteratively.
    let deep: unknown = 'leaf';
    for (let depth = 0; depth < 7_000; depth += 1) deep = { nested: deep };
    const dispose = vi.fn();
    const followTranscript = vi.fn(async (input: Readonly<{
      listener(event: HostExternalTranscriptFollowEvent): void | Promise<void>;
    }>) => {
      await input.listener({
        kind: 'data',
        items: [{ id: 'message-deep', kind: 'event', data: deep }],
        fromCursor: null,
        nextCursor: 'cursor-1',
      } as HostExternalTranscriptFollowEvent);
      return { status: 'following' as const, startingCursor: 'cursor-1', subscription: { dispose } };
    });
    const ops: ExternalSessionProviderOps = {
      validateSource: async ({ source }) => ({ ok: true, source }),
      listCandidates: async () => ({
        candidates: [{ remoteSessionId: 'remote-1', updatedAtMs: 1 }],
        nextCursor: null,
      }),
      resolveLinkIdentity: resolveExactLinkIdentity,
      pageTranscript: async () => ({ items: [], nextCursor: null, tailCursor: null, hasMore: false, truncated: false }),
      readAfterTranscript: async () => ({ outcome: 'already_current' }),
    };
    const adapter = await createConfiguredPluginExternalSessionsAdapter({
      agents: [agent()],
      account: { connectedServicesV2: [] },
      basis: { contributionGenerationId: 'registry:g1', accountSettingsRevision: 'account:1' },
      readCurrentBasis: () => ({ contributionGenerationId: 'registry:g1', accountSettingsRevision: 'account:1' }),
      isCurrent: () => true,
      resolveProviderOps: async () => ops,
      followTranscript,
    });

    const listed = await adapter.authorService.list();
    const events: unknown[] = [];
    const result = await adapter.authorService.followTranscript(
      listed.items[0]!.ref,
      {},
      (event) => { events.push(event); },
    );

    expect(result.status).toBe('following');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: 'data', items: [{ id: 'message-deep', kind: 'event' }] });
    if (result.status === 'following') await result.subscription.dispose();
  });

  it('splits stable-ref author operations from the source-bearing Runtime composition port', async () => {
    const dispose = vi.fn(async () => undefined);
    const privateFailure = new Promise<Error>(() => undefined);
    const followTranscript = vi.fn(async (input: Readonly<{
      listener(event: HostExternalTranscriptFollowEvent): void | Promise<void>;
    }>) => {
      await input.listener({
        kind: 'resyncRequired',
        reason: 'providerTruncated',
        cursor: 'cursor-tail',
      });
      return {
        status: 'following' as const,
        startingCursor: 'cursor-tail',
        subscription: { dispose },
        failure: privateFailure,
      };
    });
    const ops: ExternalSessionProviderOps = {
      validateSource: async ({ source }) => ({ ok: true, source }),
      listCandidates: async () => ({
        candidates: [{ remoteSessionId: 'remote-1', updatedAtMs: 1 }],
        nextCursor: null,
      }),
      resolveLinkIdentity: async ({ source, remoteSessionId }) => ({
        source,
        remoteSessionId,
      }),
      pageTranscript: async () => ({
        items: [], nextCursor: null, tailCursor: null, hasMore: false, truncated: false,
      }),
      readAfterTranscript: async () => ({ outcome: 'already_current' }),
    };
    const composition = await createConfiguredPluginExternalSessionsAdapter({
      agents: [agent()],
      account: { connectedServicesV2: [] },
      basis: { contributionGenerationId: 'registry:g1', accountSettingsRevision: 'account:1' },
      readCurrentBasis: () => ({ contributionGenerationId: 'registry:g1', accountSettingsRevision: 'account:1' }),
      isCurrent: () => true,
      resolveProviderOps: async () => ops,
      followTranscript,
    });

    expect(Reflect.ownKeys(composition).sort()).toEqual([
      'authorService',
      'bindAuthorService',
      'candidateIndexIdentities',
      'compositionPort',
      'dispose',
      'resolveAuthorSource',
      'sourceRefusals',
    ]);
    expect(Reflect.ownKeys(composition.authorService).sort()).toEqual([
      'attach',
      'capabilities',
      'followTranscript',
      'list',
      'readTranscript',
      'takeover',
    ]);
    expect(Reflect.get(composition.authorService, 'resolveFollowTarget')).toBeUndefined();
    expect(Reflect.ownKeys(composition.compositionPort).sort()).toEqual([
      'followTranscript',
      'resolveFollowTarget',
    ]);
    expect(Reflect.get(composition.compositionPort, 'list')).toBeUndefined();
    expect(Reflect.get(composition.compositionPort, 'attach')).toBeUndefined();
    expect(Reflect.get(composition.compositionPort, 'readTranscript')).toBeUndefined();

    const listed = await composition.authorService.list();
    const ref = listed.items[0]!.ref;
    await expect(composition.authorService.takeover(ref, {
      targetStorageMode: 'persisted',
      idempotencyKey: 'author-key-1',
    })).rejects.toMatchObject({
      code: 'plugin_external_takeover_contextual_admission_unavailable',
    });
    expect((await composition.authorService.capabilities()).takeover).toEqual({
      status: 'unavailable',
      code: 'plugin_external_takeover_contextual_admission_unavailable',
    });
    expect(listed.items[0]!.capabilities).not.toContain('takeover');
    const publicListener = vi.fn();
    const publicFollow = await composition.authorService.followTranscript(ref, {}, publicListener);
    expect(publicFollow.status).toBe('following');
    expect(publicFollow).not.toHaveProperty('failure');
    expect(publicListener).toHaveBeenCalledWith({
      kind: 'terminated',
      reason: 'resyncRequired',
      cursor: 'cursor-tail',
    });
    if (publicFollow.status === 'following') await publicFollow.subscription.dispose();
    expect(followTranscript).toHaveBeenNthCalledWith(1, expect.objectContaining({
      ref,
      source: { kind: 'codexHome', home: 'user' },
    }));

    const target = await composition.compositionPort.resolveFollowTarget({
      agentId: ref.agentId,
      remoteSessionId: ref.remoteSessionId,
    });
    expect(target).toMatchObject({ status: 'resolved', ref });
    if (target.status !== 'resolved') throw new Error('Expected a private follow target');
    const privateListener = vi.fn();
    const privateFollow = await composition.compositionPort.followTranscript(target, {}, privateListener);
    expect(privateFollow.status).toBe('following');
    expect(privateFollow).toHaveProperty('failure', privateFailure);
    expect(privateListener).toHaveBeenCalledWith({
      kind: 'resyncRequired',
      reason: 'providerTruncated',
      cursor: 'cursor-tail',
    });
    if (privateFollow.status === 'following') await privateFollow.subscription.dispose();
    expect(followTranscript).toHaveBeenCalledTimes(2);

    composition.dispose();
    await expect(composition.authorService.list()).rejects.toMatchObject({
      code: 'plugin_generation_retired',
    });
  });

  it('binds contextual durable takeover without exposing the legacy host operation', async () => {
    const takeover = vi.fn<ContextualExternalSessionTakeoverAdapter['takeover']>(async () => ({
      sessionId: 'linked-1',
      operationId: 'external-takeover:operation-1',
      revision: 1,
    }));
    const ops: ExternalSessionProviderOps = {
      externalLinkedTakeoverWriterSafety: 'native_prevention',
      externalSessionTakeoverAdmitted: true,
      validateSource: async ({ source }) => ({ ok: true, source }),
      listCandidates: async () => ({
        candidates: [{ remoteSessionId: 'remote-1', updatedAtMs: 1 }],
        nextCursor: null,
      }),
      pageTranscript: async () => ({
        items: [], nextCursor: null, tailCursor: null, hasMore: false, truncated: false,
      }),
      readAfterTranscript: async () => ({ outcome: 'already_current' }),
    };
    const composition = await createConfiguredPluginExternalSessionsAdapter({
      agents: [agent()],
      account: { connectedServicesV2: [] },
      basis: { contributionGenerationId: 'registry:g1', accountSettingsRevision: 'account:1' },
      readCurrentBasis: () => ({ contributionGenerationId: 'registry:g1', accountSettingsRevision: 'account:1' }),
      isCurrent: () => true,
      resolveProviderOps: async () => ops,
      contextualTakeover: { takeover },
    });
    const listed = await composition.authorService.list();
    const ref = listed.items[0]!.ref;

    expect((await composition.authorService.capabilities()).takeover).toEqual({
      status: 'available',
      storageModes: ['external-linked', 'persisted'],
    });
    expect(listed.items[0]!.capabilities).not.toContain('takeover');
    expect(listed.items[0]!.takeover).toEqual({
      status: 'available',
      storageModes: ['external-linked', 'persisted'],
    });
    await expect(composition.authorService.takeover(ref, {
      targetStorageMode: 'persisted',
      idempotencyKey: 'author-key-1',
    })).resolves.toEqual({
      sessionId: 'linked-1',
      operationId: 'external-takeover:operation-1',
      revision: 1,
    });
    expect(takeover).toHaveBeenCalledWith(ref, {
      targetStorageMode: 'persisted',
      idempotencyKey: 'author-key-1',
    }, expect.objectContaining({
      retirementSignal: expect.any(AbortSignal),
      isCurrent: expect.any(Function),
    }));
    const takeoverOptions = takeover.mock.calls[0]![2];
    expect(takeoverOptions?.signal).toBeUndefined();
    expect(takeoverOptions?.retirementSignal?.aborted).toBe(false);
    expect(takeoverOptions?.isCurrent?.()).toBe(true);
    expect(Reflect.get(composition.compositionPort, 'takeover')).toBeUndefined();
    composition.dispose();
    expect(takeoverOptions?.retirementSignal?.aborted).toBe(true);
  });

  it('withholds every takeover storage mode from an Agent whose generation admitted no takeover contribution', async () => {
    const takeover = vi.fn<ContextualExternalSessionTakeoverAdapter['takeover']>(async () => ({
      sessionId: 'linked-1',
      operationId: 'external-takeover:operation-1',
      revision: 1,
    }));
    // External Sessions sources list normally and even declare native
    // external-linked writer safety, but this Agent leaf never registered an
    // `externalSessionTakeover` contribution (the Antigravity shape): its
    // takeover launch would always fail after durable admission.
    const ops: ExternalSessionProviderOps = {
      externalLinkedTakeoverWriterSafety: 'native_prevention',
      validateSource: async ({ source }) => ({ ok: true, source }),
      listCandidates: async () => ({
        candidates: [{ remoteSessionId: 'remote-1', updatedAtMs: 1 }],
        nextCursor: null,
      }),
      pageTranscript: async () => ({
        items: [], nextCursor: null, tailCursor: null, hasMore: false, truncated: false,
      }),
      readAfterTranscript: async () => ({ outcome: 'already_current' }),
    };
    const composition = await createConfiguredPluginExternalSessionsAdapter({
      agents: [agent()],
      account: { connectedServicesV2: [] },
      basis: { contributionGenerationId: 'registry:g1', accountSettingsRevision: 'account:1' },
      readCurrentBasis: () => ({ contributionGenerationId: 'registry:g1', accountSettingsRevision: 'account:1' }),
      isCurrent: () => true,
      resolveProviderOps: async () => ops,
      contextualTakeover: { takeover },
    });

    expect((await composition.authorService.capabilities()).takeover).toEqual({
      status: 'unavailable',
      code: 'plugin_external_agent_unavailable',
    });
    const listed = await composition.authorService.list();
    expect(listed.items).toHaveLength(1);
    expect(listed.items[0]!.takeover).toEqual({
      status: 'unavailable',
      code: 'plugin_external_agent_unavailable',
    });
    expect(takeover).not.toHaveBeenCalled();
  });

  it('binds distinct caller principals to one current-global source controller', async () => {
    const alphaTakeover = vi.fn(async () => ({
      sessionId: 'linked-1', operationId: 'operation-alpha', revision: 1,
    }));
    const betaTakeover = vi.fn(async () => ({
      sessionId: 'linked-1', operationId: 'operation-beta', revision: 1,
    }));
    const ops: ExternalSessionProviderOps = {
      validateSource: async ({ source }) => ({ ok: true, source }),
      listCandidates: async () => ({
        candidates: [{ remoteSessionId: 'remote-global', updatedAtMs: 1 }],
        nextCursor: null,
      }),
      resolveLinkIdentity: resolveExactLinkIdentity,
      pageTranscript: async () => ({
        items: [], nextCursor: null, tailCursor: null, hasMore: false, truncated: false,
      }),
      readAfterTranscript: async () => ({ outcome: 'already_current' }),
    };
    const composition = await createConfiguredPluginExternalSessionsAdapter({
      agents: [agent()],
      account: { connectedServicesV2: [] },
      basis: { contributionGenerationId: 'registry:g1', accountSettingsRevision: 'account:1' },
      readCurrentBasis: () => ({ contributionGenerationId: 'registry:g1', accountSettingsRevision: 'account:1' }),
      isCurrent: () => true,
      resolveProviderOps: async () => ops,
    });
    const alpha = composition.bindAuthorService({ takeover: alphaTakeover });
    const beta = composition.bindAuthorService({ takeover: betaTakeover });

    expect(Reflect.ownKeys(alpha).sort()).toEqual([
      'attach', 'capabilities', 'followTranscript', 'list', 'readTranscript', 'takeover',
    ]);
    const [alphaList, betaList] = await Promise.all([alpha.list(), beta.list()]);
    expect(alphaList.items[0]?.ref).toEqual(betaList.items[0]?.ref);
    const ref = alphaList.items[0]!.ref;
    await alpha.takeover(ref, {
      targetStorageMode: 'persisted',
      idempotencyKey: 'same-opaque-key',
    });
    await beta.takeover(ref, {
      targetStorageMode: 'persisted',
      idempotencyKey: 'same-opaque-key',
    });

    expect(alphaTakeover).toHaveBeenCalledOnce();
    expect(betaTakeover).toHaveBeenCalledOnce();
    composition.dispose();
    await expect(alpha.list()).rejects.toMatchObject({ code: 'plugin_generation_retired' });
    await expect(beta.list()).rejects.toMatchObject({ code: 'plugin_generation_retired' });
  });

  it('preserves one opaque logical ref through filtered list, attach, read, follow, and takeover without leaking the private source', async () => {
    const sourceId = 'codexHome:user:::';
    const ref = Object.freeze({
      agentId: 'codex',
      sourceId,
      remoteSessionId: 'remote:session/%?=+#[]',
    });
    const dispose = vi.fn(async () => undefined);
    const attach = vi.fn(async () => ({ sessionId: 'linked-1' }));
    const followTranscript = vi.fn(async (input: Readonly<{
      listener(event: HostExternalTranscriptFollowEvent): void | Promise<void>;
    }>) => {
      await input.listener({
        kind: 'data',
        items: [{
          id: 'message-1',
          localId: 'provider-fact-1',
          userProjection: 'source_fact',
          kind: 'user',
          data: { text: 'hello' },
        }],
        fromCursor: null,
        nextCursor: 'cursor-1',
      });
      return {
        status: 'following' as const,
        startingCursor: 'cursor-1',
        subscription: { dispose },
      };
    });
    const takeover = vi.fn<ContextualExternalSessionTakeoverAdapter['takeover']>(async () => ({
      sessionId: 'linked-1',
      operationId: 'operation-1',
      revision: 1,
    }));
    const ops: ExternalSessionProviderOps = {
      externalLinkedTakeoverWriterSafety: 'native_prevention',
      validateSource: async ({ source }) => ({ ok: true, source }),
      listCandidates: async () => ({
        candidates: [{ remoteSessionId: ref.remoteSessionId, updatedAtMs: 1 }],
        nextCursor: null,
      }),
      resolveLinkIdentity: resolveExactLinkIdentity,
      pageTranscript: async () => ({
        items: [{
          id: 'message-1',
          localId: 'provider-fact-1',
          userProjection: 'source_fact',
          createdAtMs: 1,
          raw: { role: 'user', content: { type: 'text', text: 'hello' } },
        }],
        nextCursor: null,
        tailCursor: 'cursor-1',
        hasMore: false,
        truncated: false,
      }),
      readAfterTranscript: async () => ({ outcome: 'already_current' }),
    };
    const composition = await createConfiguredPluginExternalSessionsAdapter({
      agents: [agent()],
      account: { connectedServicesV2: [] },
      basis: { contributionGenerationId: 'registry:g1', accountSettingsRevision: 'account:1' },
      readCurrentBasis: () => ({ contributionGenerationId: 'registry:g1', accountSettingsRevision: 'account:1' }),
      isCurrent: () => true,
      resolveProviderOps: async () => ops,
      attach,
      followTranscript,
      contextualTakeover: { takeover },
    });

    const listed = await composition.authorService.list({ agentId: ref.agentId, sourceId });
    expect(listed.items).toHaveLength(1);
    expect(listed.items[0]!.ref).toEqual(ref);
    const attached = await composition.authorService.attach(listed.items[0]!.ref);
    const transcript = await composition.authorService.readTranscript(listed.items[0]!.ref, {
      mode: 'page',
      direction: 'older',
    });
    const events: HostExternalTranscriptFollowEvent[] = [];
    const followed = await composition.authorService.followTranscript(
      listed.items[0]!.ref,
      {},
      (event) => {
        events.push(event);
      },
    );
    const takenOver = await composition.authorService.takeover(listed.items[0]!.ref, {
      targetStorageMode: 'persisted',
      idempotencyKey: 'author-key-1',
    });

    expect(attached).toEqual({ sessionId: 'linked-1' });
    expect(transcript).toMatchObject({
      mode: 'page',
      items: [{ id: 'message-1', kind: 'user', data: { role: 'user', text: 'hello' } }],
    });
    expect(events).toEqual([{
      kind: 'data',
      items: [{ id: 'message-1', kind: 'user', data: { text: 'hello' } }],
      fromCursor: null,
      nextCursor: 'cursor-1',
    }]);
    expect(followed).toMatchObject({ status: 'following', startingCursor: 'cursor-1' });
    expect(takenOver).toEqual({ sessionId: 'linked-1', operationId: 'operation-1', revision: 1 });
    expect(takeover).toHaveBeenCalledWith(ref, {
      targetStorageMode: 'persisted',
      idempotencyKey: 'author-key-1',
    }, expect.objectContaining({
      retirementSignal: expect.any(AbortSignal),
      isCurrent: expect.any(Function),
    }));

    const authorVisible = { listed, attached, transcript, events, followed, takenOver };
    expect(JSON.stringify(authorVisible)).not.toContain('"kind":"codexHome"');
    expect(JSON.stringify(authorVisible)).not.toContain('"home":"user"');
    expect(JSON.stringify(authorVisible)).not.toContain('"localId"');
    expect(JSON.stringify(authorVisible)).not.toContain('"userProjection"');
    if (followed.status === 'following') await followed.subscription.dispose();
  });

  it('rejects caller-selected private authority at the author boundary before host or provider effects', async () => {
    const listCandidates = vi.fn(async () => ({
      candidates: [{ remoteSessionId: 'remote-1', updatedAtMs: 1 }],
      nextCursor: null,
    }));
    const attach = vi.fn(async () => ({ sessionId: 'must-not-attach' }));
    const takeover = vi.fn(async () => ({
      sessionId: 'must-not-take-over',
      operationId: 'must-not-create-operation',
      revision: 0,
    }));
    const validateSource = vi.fn(async (
      { source }: Parameters<ExternalSessionProviderOps['validateSource']>[0],
    ) => ({ ok: true as const, source }));
    const ops: ExternalSessionProviderOps = {
      validateSource,
      listCandidates,
      pageTranscript: async () => ({
        items: [], nextCursor: null, tailCursor: null, hasMore: false, truncated: false,
      }),
      readAfterTranscript: async () => ({ outcome: 'already_current' }),
    };
    const composition = await createConfiguredPluginExternalSessionsAdapter({
      agents: [agent()],
      account: { connectedServicesV2: [] },
      basis: { contributionGenerationId: 'registry:g1', accountSettingsRevision: 'account:1' },
      readCurrentBasis: () => ({ contributionGenerationId: 'registry:g1', accountSettingsRevision: 'account:1' }),
      isCurrent: () => true,
      resolveProviderOps: async () => ops,
      attach,
      contextualTakeover: { takeover },
    });
    validateSource.mockClear();
    const privateRef = {
      agentId: 'codex',
      sourceId: 'codexHome:user:::',
      remoteSessionId: 'remote-1',
      source: { kind: 'codexHome', home: 'attacker-selected' },
      machineId: 'machine-private',
      generation: 'generation-private',
      linkData: { private: true },
      operation: { operationId: 'operation-private' },
    };

    await expect(composition.authorService.attach(privateRef as never)).rejects.toMatchObject({
      code: 'plugin_external_ref_invalid',
    });
    await expect(composition.authorService.readTranscript(privateRef as never, {
      mode: 'page',
      direction: 'older',
    })).rejects.toMatchObject({ code: 'plugin_external_ref_invalid' });
    await expect(composition.authorService.takeover(privateRef as never, {
      targetStorageMode: 'persisted',
      idempotencyKey: 'private-ref-rejection',
    })).rejects.toMatchObject({ code: 'plugin_external_ref_invalid' });
    await expect(composition.authorService.list({
      sourceId: 'codexHome:user:::',
      source: { kind: 'codexHome', home: 'attacker-selected' },
      machineId: 'machine-private',
    } as never)).rejects.toMatchObject({ code: 'plugin_external_list_query_invalid' });
    const ref = {
      agentId: 'codex', sourceId: 'codexHome:user:::', remoteSessionId: 'remote-1',
    } as const;
    await expect(composition.authorService.readTranscript(ref, {
      mode: 'page',
      direction: 'older',
      source: { kind: 'codexHome', home: 'attacker-selected' },
      path: '/private/transcript.jsonl',
    } as never)).rejects.toMatchObject({
      code: 'plugin_external_transcript_query_invalid',
    });
    await expect(composition.authorService.takeover(ref, {
      targetStorageMode: 'persisted',
      targetDirectory: '/local/selected/workspace',
      idempotencyKey: 'private-request-rejection',
      operation: {
        operationId: 'caller-selected-operation',
        claim: 'caller-selected-claim',
      },
    } as never)).rejects.toMatchObject({
      code: 'plugin_external_takeover_request_invalid',
    });
    expect({
      listCandidates: listCandidates.mock.calls.length,
      validateSource: validateSource.mock.calls.length,
      attach: attach.mock.calls.length,
      takeover: takeover.mock.calls.length,
    }).toEqual({ listCandidates: 0, validateSource: 0, attach: 0, takeover: 0 });
  });

  it('strict-validates author list and transcript identities and cursors before current-source effects', async () => {
    const listCandidates = vi.fn(async () => ({
      candidates: [{ remoteSessionId: 'remote:session/%?=+#[]', updatedAtMs: 1 }],
      nextCursor: null,
    }));
    const pageTranscript = vi.fn(async () => ({
      items: [], nextCursor: null, tailCursor: null, hasMore: false, truncated: false,
    }));
    const readAfterTranscript = vi.fn(async () => ({ outcome: 'already_current' as const }));
    const validateSource = vi.fn(async (
      { source }: Parameters<ExternalSessionProviderOps['validateSource']>[0],
    ) => ({ ok: true as const, source }));
    const readCurrentBasis = vi.fn(() => ({
      contributionGenerationId: 'registry:g1',
      accountSettingsRevision: 'account:1',
    }));
    const isCurrent = vi.fn(() => true);
    const ops: ExternalSessionProviderOps = {
      validateSource,
      listCandidates,
      pageTranscript,
      readAfterTranscript,
    };
    const composition = await createConfiguredPluginExternalSessionsAdapter({
      agents: [agent()],
      account: { connectedServicesV2: [] },
      basis: { contributionGenerationId: 'registry:g1', accountSettingsRevision: 'account:1' },
      readCurrentBasis,
      isCurrent,
      resolveProviderOps: async () => ops,
    });
    const ref = {
      agentId: 'codex', sourceId: 'codexHome:user:::', remoteSessionId: 'remote-1',
    } as const;
    const hostQualifiedCursorPrefix = 'happier_external_cursor_v1:';
    const maximumPageCursor = `${hostQualifiedCursorPrefix}${'p'.repeat(4_096 - hostQualifiedCursorPrefix.length)}`;
    const maximumReadAfterCursor = `${hostQualifiedCursorPrefix}${'r'.repeat(4_096 - hostQualifiedCursorPrefix.length)}`;
    const hostQualifiedContinuationCursor = `${hostQualifiedCursorPrefix}${'a'.repeat(4_096 - hostQualifiedCursorPrefix.length)}`;
    const rawNativeCursor = "cursor:v1::/%?=+#[]@!$&'()*+,;";
    const effectCounts = () => ({
      isCurrent: isCurrent.mock.calls.length,
      readCurrentBasis: readCurrentBasis.mock.calls.length,
      validateSource: validateSource.mock.calls.length,
      listCandidates: listCandidates.mock.calls.length,
      pageTranscript: pageTranscript.mock.calls.length,
      readAfterTranscript: readAfterTranscript.mock.calls.length,
    });
    const resetEffects = () => {
      isCurrent.mockClear();
      readCurrentBasis.mockClear();
      validateSource.mockClear();
      listCandidates.mockClear();
      pageTranscript.mockClear();
      readAfterTranscript.mockClear();
    };
    const noEffects = {
      isCurrent: 0,
      readCurrentBasis: 0,
      validateSource: 0,
      listCandidates: 0,
      pageTranscript: 0,
      readAfterTranscript: 0,
    };
    resetEffects();

    for (const agentId of ['', ' codex ', 'a'.repeat(129)]) {
      await expect(composition.authorService.list({ agentId })).rejects.toMatchObject({
        code: 'plugin_external_list_query_invalid',
      });
    }
    for (const sourceId of ['', ' codexHome:user::: ', 's'.repeat(2_001)]) {
      await expect(composition.authorService.list({ sourceId })).rejects.toMatchObject({
        code: 'plugin_external_list_query_invalid',
      });
    }
    for (const cursor of [
      '',
      ' cursor:v1::/%?=+#[] ',
      'c'.repeat(4_097),
      'plugin_external_sessions_v1_missing',
    ]) {
      await expect(composition.authorService.list({ cursor })).rejects.toMatchObject({
        code: 'plugin_external_list_query_invalid',
      });
      await expect(composition.authorService.readTranscript(ref, {
        mode: 'page', direction: 'older', cursor,
      })).rejects.toMatchObject({
        code: 'plugin_external_transcript_query_invalid',
      });
      await expect(composition.authorService.readTranscript(ref, {
        mode: 'readAfter', cursor,
      })).rejects.toMatchObject({
        code: 'plugin_external_transcript_query_invalid',
      });
    }
    await expect(composition.authorService.list({ cursor: rawNativeCursor })).rejects.toMatchObject({
      code: 'plugin_external_list_query_invalid',
    });
    expect(effectCounts()).toEqual(noEffects);
    await expect(composition.authorService.readTranscript(ref, {
      mode: 'page', direction: 'older', cursor: rawNativeCursor,
    })).rejects.toMatchObject({
      code: 'plugin_external_transcript_query_invalid',
    });
    await expect(composition.authorService.readTranscript(ref, {
      mode: 'readAfter', cursor: rawNativeCursor,
    })).rejects.toMatchObject({
      code: 'plugin_external_transcript_query_invalid',
    });
    for (const [field, value] of [
      ['limit', 0],
      ['limit', Number.NaN],
      ['limit', Number.POSITIVE_INFINITY],
      ['limit', 1.5],
      ['limit', '1'],
      ['maxBytes', 0],
      ['maxBytes', Number.NaN],
      ['maxBytes', Number.POSITIVE_INFINITY],
      ['maxBytes', 1.5],
      ['maxBytes', '1'],
    ] as const) {
      await expect(composition.authorService.list({
        [field]: value,
      } as never)).rejects.toMatchObject({
        code: 'plugin_external_list_query_invalid',
      });
    }
    for (const [field, value] of [
      ['limit', 0],
      ['limit', Number.NaN],
      ['limit', 1.5],
      ['limit', '1'],
      ['maxBytes', -1],
      ['maxBytes', Number.POSITIVE_INFINITY],
      ['maxBytes', null],
    ] as const) {
      await expect(composition.authorService.readTranscript(ref, {
        mode: 'page',
        direction: 'older',
        [field]: value,
      } as never)).rejects.toMatchObject({
        code: 'plugin_external_transcript_query_invalid',
      });
      await expect(composition.authorService.readTranscript(ref, {
        mode: 'readAfter',
        cursor: maximumReadAfterCursor,
        [field]: value,
      } as never)).rejects.toMatchObject({
        code: 'plugin_external_transcript_query_invalid',
      });
    }
    expect(effectCounts()).toEqual(noEffects);

    await expect(composition.authorService.list({
      agentId: ':plugin/v1?x=1'.padEnd(128, 'a'),
    })).rejects.toMatchObject({ code: 'plugin_external_source_unavailable' });
    await expect(composition.authorService.list({
      agentId: 'codex', sourceId: ':source/v1?x=1'.padEnd(2_000, 's'),
    })).rejects.toMatchObject({ code: 'plugin_external_source_unavailable' });
    await expect(composition.authorService.list({
      cursor: 'plugin_external_sessions_v1_:cursor/%?='.padEnd(4_096, 'c'),
    })).rejects.toMatchObject({ code: 'plugin_external_list_query_invalid' });
    await expect(composition.authorService.list({
      sourceId: 'codexHome:user:::',
    })).resolves.toMatchObject({
      items: [{
        ref: {
          agentId: 'codex',
          sourceId: 'codexHome:user:::',
          remoteSessionId: 'remote:session/%?=+#[]',
        },
      }],
    });
    await expect(composition.authorService.readTranscript(ref, {
      mode: 'page', direction: 'older', cursor: maximumPageCursor,
    })).resolves.toMatchObject({ mode: 'page' });
    await expect(composition.authorService.readTranscript(ref, {
      mode: 'readAfter', cursor: maximumReadAfterCursor,
    })).resolves.toEqual({ mode: 'readAfter', outcome: 'already_current' });
    await expect(composition.authorService.readTranscript(ref, {
      mode: 'page', direction: 'newer', cursor: hostQualifiedContinuationCursor,
    })).resolves.toMatchObject({ mode: 'page' });
    await expect(composition.authorService.readTranscript(ref, {
      mode: 'readAfter', cursor: hostQualifiedContinuationCursor,
    })).resolves.toEqual({ mode: 'readAfter', outcome: 'already_current' });
    expect(pageTranscript).toHaveBeenNthCalledWith(2, expect.objectContaining({
      cursor: hostQualifiedContinuationCursor,
    }));
    expect(readAfterTranscript).toHaveBeenNthCalledWith(2, expect.objectContaining({
      cursor: hostQualifiedContinuationCursor,
    }));
  });

  it('keeps cancellation in public options and rejects option fields before private effects', async () => {
    const listCandidates = vi.fn(async () => ({ candidates: [], nextCursor: null }));
    const pageTranscript = vi.fn(async () => ({
      items: [], nextCursor: null, tailCursor: null, hasMore: false, truncated: false,
    }));
    const attach = vi.fn(async () => ({ sessionId: 'must-not-attach' }));
    const followTranscript = vi.fn(async () => ({
      status: 'following' as const,
      startingCursor: null,
      subscription: { dispose: vi.fn(async () => undefined) },
    }));
    const takeover = vi.fn(async () => ({
      sessionId: 'must-not-take-over',
      operationId: 'must-not-create-operation',
      revision: 0,
    }));
    const ops: ExternalSessionProviderOps = {
      validateSource: async ({ source }) => ({ ok: true, source }),
      listCandidates,
      pageTranscript,
      readAfterTranscript: async () => ({ outcome: 'already_current' }),
    };
    const composition = await createConfiguredPluginExternalSessionsAdapter({
      agents: [agent()],
      account: { connectedServicesV2: [] },
      basis: { contributionGenerationId: 'registry:g1', accountSettingsRevision: 'account:1' },
      readCurrentBasis: () => ({ contributionGenerationId: 'registry:g1', accountSettingsRevision: 'account:1' }),
      isCurrent: () => true,
      resolveProviderOps: async () => ops,
      attach,
      followTranscript,
      contextualTakeover: { takeover },
    });
    const ref = {
      agentId: 'codex', sourceId: 'codexHome:user:::', remoteSessionId: 'remote-1',
    } as const;
    const aborted = new AbortController();
    aborted.abort();

    await expect(Reflect.apply(composition.authorService.list, composition.authorService, [
      {}, { signal: aborted.signal },
    ])).rejects.toMatchObject({ code: 'plugin_operation_aborted' });
    await expect(Reflect.apply(composition.authorService.readTranscript, composition.authorService, [
      ref, { mode: 'page', direction: 'older' }, { signal: aborted.signal },
    ])).rejects.toMatchObject({ code: 'plugin_operation_aborted' });
    await expect(composition.authorService.attach(ref, {
      source: { kind: 'codexHome', home: 'attacker-selected' },
    } as never)).rejects.toMatchObject({ code: 'plugin_external_options_invalid' });
    await expect(composition.authorService.takeover(ref, {
      targetStorageMode: 'persisted',
      idempotencyKey: 'private-options-rejection',
    }, { claim: 'caller-selected-claim' } as never)).rejects.toMatchObject({
      code: 'plugin_external_options_invalid',
    });
    await expect(composition.authorService.followTranscript(ref, {
      source: { kind: 'codexHome', home: 'attacker-selected' },
    } as never, vi.fn())).resolves.toEqual({
      status: 'unavailable',
      code: 'plugin_external_follow_options_invalid',
    });
    expect({
      listCandidates: listCandidates.mock.calls.length,
      pageTranscript: pageTranscript.mock.calls.length,
      attach: attach.mock.calls.length,
      followTranscript: followTranscript.mock.calls.length,
      takeover: takeover.mock.calls.length,
    }).toEqual({
      listCandidates: 0,
      pageTranscript: 0,
      attach: 0,
      followTranscript: 0,
      takeover: 0,
    });
  });

  it('returns typed unavailable for malformed public follow refs before private effects', async () => {
    const followTranscript = vi.fn(async () => ({
      status: 'following' as const,
      startingCursor: null,
      subscription: { dispose: vi.fn(async () => undefined) },
    }));
    const validateSource = vi.fn(async (
      { source }: Parameters<ExternalSessionProviderOps['validateSource']>[0],
    ) => ({ ok: true as const, source }));
    const composition = await createConfiguredPluginExternalSessionsAdapter({
      agents: [agent()],
      account: { connectedServicesV2: [] },
      basis: { contributionGenerationId: 'registry:g1', accountSettingsRevision: 'account:1' },
      readCurrentBasis: () => ({ contributionGenerationId: 'registry:g1', accountSettingsRevision: 'account:1' }),
      isCurrent: () => true,
      resolveProviderOps: async () => ({
        validateSource,
        listCandidates: async () => ({ candidates: [], nextCursor: null }),
        pageTranscript: async () => ({
          items: [], nextCursor: null, tailCursor: null, hasMore: false, truncated: false,
        }),
        readAfterTranscript: async () => ({ outcome: 'already_current' }),
      }),
      followTranscript,
    });
    validateSource.mockClear();

    await expect(composition.authorService.followTranscript({
      agentId: ' codex ',
      sourceId: 'codexHome:user:::',
      remoteSessionId: 'remote-1',
    } as never, {}, vi.fn())).resolves.toEqual({
      status: 'unavailable',
      code: 'plugin_external_ref_invalid',
    });

    expect(validateSource).not.toHaveBeenCalled();
    expect(followTranscript).not.toHaveBeenCalled();
  });

  it('returns typed unavailable when a public follow ref is absent from the current snapshot', async () => {
    const followTranscript = vi.fn(async () => ({
      status: 'following' as const,
      startingCursor: null,
      subscription: { dispose: vi.fn(async () => undefined) },
    }));
    const composition = await createConfiguredPluginExternalSessionsAdapter({
      agents: [agent()],
      account: { connectedServicesV2: [] },
      basis: { contributionGenerationId: 'registry:g1', accountSettingsRevision: 'account:1' },
      readCurrentBasis: () => ({ contributionGenerationId: 'registry:g1', accountSettingsRevision: 'account:1' }),
      isCurrent: () => true,
      resolveProviderOps: async () => ({
        validateSource: async ({ source }) => ({ ok: true as const, source }),
        listCandidates: async () => ({ candidates: [], nextCursor: null }),
        resolveLinkIdentity: async ({ source, remoteSessionId }) => ({ source, remoteSessionId }),
        pageTranscript: async () => ({
          items: [], nextCursor: null, tailCursor: null, hasMore: false, truncated: false,
        }),
        readAfterTranscript: async () => ({ outcome: 'already_current' }),
      }),
      followTranscript,
    });

    await expect(composition.authorService.followTranscript({
      agentId: 'codex',
      sourceId: 'codexHome:missing:::',
      remoteSessionId: 'remote-1',
    }, {}, vi.fn())).resolves.toEqual({
      status: 'unavailable',
      code: 'plugin_external_source_unavailable',
    });
    expect(followTranscript).not.toHaveBeenCalled();
  });

  it('revalidates the current public follow ref identity before host follow effects', async () => {
    const followTranscript = vi.fn(async () => ({
      status: 'following' as const,
      startingCursor: null,
      subscription: { dispose: vi.fn(async () => undefined) },
    }));
    const resolveLinkIdentity = vi.fn(async () => {
      throw new ExternalSessionProviderFailureError({
        code: 'candidate_not_found',
        message: 'stale public ref',
        operation: 'resolveLinkIdentity',
      });
    });
    const composition = await createConfiguredPluginExternalSessionsAdapter({
      agents: [agent()],
      account: { connectedServicesV2: [] },
      basis: { contributionGenerationId: 'registry:g1', accountSettingsRevision: 'account:1' },
      readCurrentBasis: () => ({ contributionGenerationId: 'registry:g1', accountSettingsRevision: 'account:1' }),
      isCurrent: () => true,
      resolveProviderOps: async () => ({
        validateSource: async ({ source }) => ({ ok: true as const, source }),
        listCandidates: async () => ({ candidates: [], nextCursor: null }),
        resolveLinkIdentity,
        pageTranscript: async () => ({
          items: [], nextCursor: null, tailCursor: null, hasMore: false, truncated: false,
        }),
        readAfterTranscript: async () => ({ outcome: 'already_current' }),
      }),
      followTranscript,
    });

    await expect(composition.authorService.followTranscript({
      agentId: 'codex',
      sourceId: 'codexHome:user:::',
      remoteSessionId: 'remote-1',
    }, {}, vi.fn())).resolves.toEqual({
      status: 'unavailable',
      code: 'plugin_external_follow_identity_unavailable',
    });
    expect(resolveLinkIdentity).toHaveBeenCalledOnce();
    expect(followTranscript).not.toHaveBeenCalled();
  });

  it('resolves a public follow through only the exact selected source when remote ids overlap', async () => {
    const dispose = vi.fn(async () => undefined);
    const resolveLinkIdentity = vi.fn(async ({
      source,
      remoteSessionId,
    }: Readonly<{
      source: Parameters<ExternalSessionProviderOps['validateSource']>[0]['source'];
      remoteSessionId: string;
    }>) => ({ source, remoteSessionId }));
    const followTranscript = vi.fn(async () => ({
      status: 'following' as const,
      startingCursor: null,
      subscription: { dispose },
    }));
    await withTemporaryActiveServerDir(async (activeServerDir) => {
      const selectedSource = connectedCodexSource(activeServerDir, 'work');
      const composition = await createConfiguredPluginExternalSessionsAdapter({
        agents: [agent()],
        account: {
          connectedServicesV2: [{
            serviceId: 'openai-codex',
            profiles: [{
              profileId: 'work', status: 'connected', kind: 'oauth', providerEmail: null,
              providerAccountId: null, expiresAt: null, lastUsedAt: null, health: null,
            }],
            groups: [],
          }],
        },
        basis: { contributionGenerationId: 'registry:g1', accountSettingsRevision: 'account:1' },
        readCurrentBasis: () => ({ contributionGenerationId: 'registry:g1', accountSettingsRevision: 'account:1' }),
        isCurrent: () => true,
        activeServerDir,
        resolveProviderOps: async () => ({
          validateSource: async ({ source }) => ({ ok: true as const, source }),
          listCandidates: async () => ({ candidates: [], nextCursor: null }),
          resolveLinkIdentity,
          pageTranscript: async () => ({
            items: [], nextCursor: null, tailCursor: null, hasMore: false, truncated: false,
          }),
          readAfterTranscript: async () => ({ outcome: 'already_current' }),
        }),
        followTranscript,
      });
      try {
        const result = await composition.authorService.followTranscript({
          agentId: 'codex',
          sourceId: selectedSource.sourceId,
          remoteSessionId: 'remote-shared',
        }, {}, vi.fn());

        expect(result).toMatchObject({ status: 'following', startingCursor: null });
        expect(resolveLinkIdentity).toHaveBeenCalledOnce();
        expect(resolveLinkIdentity).toHaveBeenCalledWith(expect.objectContaining({
          source: selectedSource.source,
          remoteSessionId: 'remote-shared',
        }));
        expect(followTranscript).toHaveBeenCalledOnce();
        expect(followTranscript).toHaveBeenCalledWith(expect.objectContaining({
          source: selectedSource.source,
          ref: {
            agentId: 'codex',
            sourceId: selectedSource.sourceId,
            remoteSessionId: 'remote-shared',
          },
        }));
        if (result.status === 'following') await result.subscription.dispose();
        expect(dispose).toHaveBeenCalledOnce();
      } finally {
        composition.dispose();
      }
    });
  });

  it('delivers exactly one canonical disposed acknowledgement before closing an explicit public follow', async () => {
    let privateListener!: (event: HostExternalTranscriptFollowEvent) => Promise<void> | void;
    const dispose = vi.fn(async () => {
      await privateListener({
        kind: 'terminated',
        reason: 'disposed',
        cursor: 'cursor-0',
      });
    });
    const followTranscript = vi.fn(async (input: Readonly<{
      listener(event: HostExternalTranscriptFollowEvent): void | Promise<void>;
    }>) => {
      privateListener = input.listener;
      return {
        status: 'following' as const,
        startingCursor: 'cursor-0',
        subscription: { dispose },
      };
    });
    const composition = await createConfiguredPluginExternalSessionsAdapter({
      agents: [agent()],
      account: { connectedServicesV2: [] },
      basis: { contributionGenerationId: 'registry:g1', accountSettingsRevision: 'account:1' },
      readCurrentBasis: () => ({ contributionGenerationId: 'registry:g1', accountSettingsRevision: 'account:1' }),
      isCurrent: () => true,
      resolveProviderOps: async () => ({
        validateSource: async ({ source }) => ({ ok: true as const, source }),
        listCandidates: async () => ({ candidates: [], nextCursor: null }),
        resolveLinkIdentity: resolveExactLinkIdentity,
        pageTranscript: async () => ({
          items: [], nextCursor: null, tailCursor: 'cursor-0', hasMore: false, truncated: false,
        }),
        readAfterTranscript: async () => ({ outcome: 'already_current' as const }),
      }),
      followTranscript,
    });
    const listener = vi.fn(async () => undefined);
    const result = await composition.authorService.followTranscript({
      agentId: 'codex', sourceId: 'codexHome:user:::', remoteSessionId: 'remote-1',
    }, {}, listener);
    expect(result.status).toBe('following');
    if (result.status !== 'following') throw new Error('expected author follow');

    await result.subscription.dispose();
    await result.subscription.dispose();

    expect(dispose).toHaveBeenCalledOnce();
    expect(listener).toHaveBeenCalledOnce();
    expect(listener).toHaveBeenCalledWith({
      kind: 'terminated',
      reason: 'disposed',
      cursor: 'cursor-0',
    });
    await expect(privateListener({
      kind: 'data', items: [], fromCursor: 'cursor-0', nextCursor: 'cursor-1',
    })).rejects.toThrow('plugin_external_follow_listener_failed');
    await expect(privateListener({
      kind: 'resyncRequired', reason: 'cursorDiscontinuity', cursor: 'cursor-0',
    })).rejects.toThrow('plugin_external_follow_listener_failed');
    await expect(privateListener({
      kind: 'terminated', reason: 'providerFailure', cursor: 'cursor-0',
    })).rejects.toThrow('plugin_external_follow_listener_failed');
    await expect(privateListener({
      kind: 'terminated', reason: 'disposed', cursor: 'cursor-0',
    })).rejects.toThrow('plugin_external_follow_listener_failed');
    expect(listener).toHaveBeenCalledOnce();
  });

  it('strictly projects author follow acquisition results without private fields', async () => {
    const followTranscript = vi.fn(async () => ({
      status: 'unavailable' as const,
      code: 'plugin_external_follow_unavailable',
      source: { kind: 'codexHome', home: 'private-home' },
      path: '/private/transcript.jsonl',
      operation: { operationId: 'private-operation' },
    }));
    const ops: ExternalSessionProviderOps = {
      validateSource: async ({ source }) => ({ ok: true, source }),
      listCandidates: async () => ({ candidates: [], nextCursor: null }),
      resolveLinkIdentity: resolveExactLinkIdentity,
      pageTranscript: async () => ({
        items: [], nextCursor: null, tailCursor: null, hasMore: false, truncated: false,
      }),
      readAfterTranscript: async () => ({ outcome: 'already_current' }),
    };
    const composition = await createConfiguredPluginExternalSessionsAdapter({
      agents: [agent()],
      account: { connectedServicesV2: [] },
      basis: { contributionGenerationId: 'registry:g1', accountSettingsRevision: 'account:1' },
      readCurrentBasis: () => ({ contributionGenerationId: 'registry:g1', accountSettingsRevision: 'account:1' }),
      isCurrent: () => true,
      resolveProviderOps: async () => ops,
      followTranscript: followTranscript as never,
    });

    await expect(composition.authorService.followTranscript({
      agentId: 'codex', sourceId: 'codexHome:user:::', remoteSessionId: 'remote-1',
    }, {}, vi.fn())).resolves.toEqual({
      status: 'unavailable',
      code: 'plugin_external_follow_unavailable',
    });

    const invalidDispose = vi.fn(async () => undefined);
    const invalid = await createConfiguredPluginExternalSessionsAdapter({
      agents: [agent()],
      account: { connectedServicesV2: [] },
      basis: { contributionGenerationId: 'registry:g2', accountSettingsRevision: 'account:1' },
      readCurrentBasis: () => ({ contributionGenerationId: 'registry:g2', accountSettingsRevision: 'account:1' }),
      isCurrent: () => true,
      resolveProviderOps: async () => ops,
      followTranscript: (async () => ({
        status: 'following' as const,
        startingCursor: ' invalid-cursor ',
        subscription: { dispose: invalidDispose },
      })) as never,
    });
    await expect(invalid.authorService.followTranscript({
      agentId: 'codex', sourceId: 'codexHome:user:::', remoteSessionId: 'remote-1',
    }, {}, vi.fn())).resolves.toEqual({
      status: 'unavailable',
      code: 'plugin_external_follow_result_invalid',
    });
    expect(invalidDispose).toHaveBeenCalledOnce();
  });

  it('terminates author follow on listener rejection without cursor advance or late delivery', async () => {
    let privateListener!: (event: HostExternalTranscriptFollowEvent) => Promise<void> | void;
    let acceptedCursor = 'cursor-0';
    const dispose = vi.fn(async () => undefined);
    const followTranscript = vi.fn(async (input: Readonly<{
      listener(event: HostExternalTranscriptFollowEvent): void | Promise<void>;
    }>) => {
      privateListener = input.listener;
      return {
        status: 'following' as const,
        startingCursor: acceptedCursor,
        subscription: { dispose },
      };
    });
    const listener = vi.fn(async () => {
      throw new Error('author-listener-rejected');
    });
    const ops: ExternalSessionProviderOps = {
      validateSource: async ({ source }) => ({ ok: true, source }),
      listCandidates: async () => ({ candidates: [], nextCursor: null }),
      resolveLinkIdentity: resolveExactLinkIdentity,
      pageTranscript: async () => ({
        items: [], nextCursor: null, tailCursor: acceptedCursor, hasMore: false, truncated: false,
      }),
      readAfterTranscript: async () => ({ outcome: 'already_current' }),
    };
    const composition = await createConfiguredPluginExternalSessionsAdapter({
      agents: [agent()],
      account: { connectedServicesV2: [] },
      basis: { contributionGenerationId: 'registry:g1', accountSettingsRevision: 'account:1' },
      readCurrentBasis: () => ({ contributionGenerationId: 'registry:g1', accountSettingsRevision: 'account:1' }),
      isCurrent: () => true,
      resolveProviderOps: async () => ops,
      followTranscript,
    });
    const ref = {
      agentId: 'codex', sourceId: 'codexHome:user:::', remoteSessionId: 'remote-1',
    } as const;
    await expect(composition.authorService.followTranscript(
      ref,
      { cursor: ' cursor-0 ' },
      listener,
    )).resolves.toEqual({
      status: 'unavailable',
      code: 'plugin_external_cursor_invalid',
    });
    expect(followTranscript).not.toHaveBeenCalled();
    const result = await composition.authorService.followTranscript(ref, {}, listener);
    expect(result.status).toBe('following');
    const deliver = async (nextCursor: string) => {
      await privateListener!({
        kind: 'data', items: [], fromCursor: acceptedCursor, nextCursor,
      });
      acceptedCursor = nextCursor;
    };

    await expect(deliver('cursor-1')).rejects.toThrow('author-listener-rejected');
    expect(acceptedCursor).toBe('cursor-0');
    expect(dispose).toHaveBeenCalledOnce();
    await expect(deliver('cursor-2')).rejects.toThrow('plugin_external_follow_listener_failed');
    expect(listener).toHaveBeenCalledOnce();
    expect(acceptedCursor).toBe('cursor-0');
  });

  it('serializes author listener delivery when the composition producer invokes concurrently', async () => {
    let privateListener!: (event: HostExternalTranscriptFollowEvent) => Promise<void> | void;
    const dispose = vi.fn(async () => undefined);
    const followTranscript = vi.fn(async (input: Readonly<{
      listener(event: HostExternalTranscriptFollowEvent): void | Promise<void>;
    }>) => {
      privateListener = input.listener;
      return {
        status: 'following' as const,
        startingCursor: 'cursor-0',
        subscription: { dispose },
      };
    });
    const ops: ExternalSessionProviderOps = {
      validateSource: async ({ source }) => ({ ok: true, source }),
      listCandidates: async () => ({ candidates: [], nextCursor: null }),
      resolveLinkIdentity: resolveExactLinkIdentity,
      pageTranscript: async () => ({
        items: [], nextCursor: null, tailCursor: 'cursor-0', hasMore: false, truncated: false,
      }),
      readAfterTranscript: async () => ({ outcome: 'already_current' }),
    };
    let releaseFirst!: () => void;
    const firstPending = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let inFlight = 0;
    let maximumInFlight = 0;
    const deliveryOrder: string[] = [];
    const listener = vi.fn(async (event: HostExternalTranscriptFollowEvent) => {
      if (event.kind !== 'data') return;
      inFlight += 1;
      maximumInFlight = Math.max(maximumInFlight, inFlight);
      deliveryOrder.push(`start:${event.nextCursor}`);
      if (event.nextCursor === 'cursor-1') await firstPending;
      deliveryOrder.push(`end:${event.nextCursor}`);
      inFlight -= 1;
    });
    const composition = await createConfiguredPluginExternalSessionsAdapter({
      agents: [agent()],
      account: { connectedServicesV2: [] },
      basis: { contributionGenerationId: 'registry:g1', accountSettingsRevision: 'account:1' },
      readCurrentBasis: () => ({ contributionGenerationId: 'registry:g1', accountSettingsRevision: 'account:1' }),
      isCurrent: () => true,
      resolveProviderOps: async () => ops,
      followTranscript,
    });
    const result = await composition.authorService.followTranscript({
      agentId: 'codex', sourceId: 'codexHome:user:::', remoteSessionId: 'remote-1',
    }, {}, listener);
    expect(result.status).toBe('following');

    const first = Promise.resolve(privateListener({
      kind: 'data', items: [], fromCursor: 'cursor-0', nextCursor: 'cursor-1',
    }));
    await vi.waitFor(() => expect(listener).toHaveBeenCalledOnce());
    const second = Promise.resolve(privateListener({
      kind: 'data', items: [], fromCursor: 'cursor-1', nextCursor: 'cursor-2',
    }));
    await vi.waitFor(() => expect(listener).toHaveBeenCalledTimes(1));

    expect(maximumInFlight).toBe(1);
    expect(deliveryOrder).toEqual(['start:cursor-1']);
    releaseFirst();
    await expect(Promise.all([first, second])).resolves.toEqual([undefined, undefined]);
    expect(maximumInFlight).toBe(1);
    expect(deliveryOrder).toEqual([
      'start:cursor-1',
      'end:cursor-1',
      'start:cursor-2',
      'end:cursor-2',
    ]);
    if (result.status === 'following') await result.subscription.dispose();
    expect(dispose).toHaveBeenCalledOnce();
  });

  it('strict-validates and byte-bounds projected author events before listener delivery', async () => {
    let privateListener!: (event: HostExternalTranscriptFollowEvent) => Promise<void> | void;
    const dispose = vi.fn(async () => undefined);
    const followTranscript = vi.fn(async (input: Readonly<{
      listener(event: HostExternalTranscriptFollowEvent): void | Promise<void>;
    }>) => {
      privateListener = input.listener;
      return {
        status: 'following' as const,
        startingCursor: 'cursor-0',
        subscription: { dispose },
      };
    });
    const listener = vi.fn(async () => undefined);
    const ops: ExternalSessionProviderOps = {
      validateSource: async ({ source }) => ({ ok: true, source }),
      listCandidates: async () => ({ candidates: [], nextCursor: null }),
      resolveLinkIdentity: resolveExactLinkIdentity,
      pageTranscript: async () => ({
        items: [], nextCursor: null, tailCursor: 'cursor-0', hasMore: false, truncated: false,
      }),
      readAfterTranscript: async () => ({ outcome: 'already_current' }),
    };
    const composition = await createConfiguredPluginExternalSessionsAdapter({
      agents: [agent()],
      account: { connectedServicesV2: [] },
      basis: { contributionGenerationId: 'registry:g1', accountSettingsRevision: 'account:1' },
      readCurrentBasis: () => ({ contributionGenerationId: 'registry:g1', accountSettingsRevision: 'account:1' }),
      isCurrent: () => true,
      resolveProviderOps: async () => ops,
      followTranscript,
    });
    await composition.authorService.followTranscript({
      agentId: 'codex', sourceId: 'codexHome:user:::', remoteSessionId: 'remote-1',
    }, {}, listener);

    await expect(privateListener({
      kind: 'data', items: [], fromCursor: 'cursor-0', nextCursor: ' cursor-1 ',
    })).rejects.toMatchObject({ code: 'plugin_external_follow_event_invalid' });
    expect(listener).not.toHaveBeenCalled();
    expect(dispose).toHaveBeenCalledOnce();

    const second = await createConfiguredPluginExternalSessionsAdapter({
      agents: [agent()],
      account: { connectedServicesV2: [] },
      basis: { contributionGenerationId: 'registry:g2', accountSettingsRevision: 'account:1' },
      readCurrentBasis: () => ({ contributionGenerationId: 'registry:g2', accountSettingsRevision: 'account:1' }),
      isCurrent: () => true,
      resolveProviderOps: async () => ops,
      followTranscript,
    });
    await second.authorService.followTranscript({
      agentId: 'codex', sourceId: 'codexHome:user:::', remoteSessionId: 'remote-1',
    }, {}, listener);
    await expect(privateListener({
      kind: 'data',
      items: Array.from({ length: 9_000 }, (_, index) => ({
        id: `item-${index}`,
        kind: 'agent' as const,
        data: { text: 'x'.repeat(100) },
      })),
      fromCursor: 'cursor-0',
      nextCursor: 'cursor-1',
    })).rejects.toMatchObject({ code: 'plugin_external_follow_event_too_large' });
    expect(listener).not.toHaveBeenCalled();
    expect(dispose).toHaveBeenCalledTimes(2);
  });

  it('admits bounded host-qualified author follow cursors through acquisition and events', async () => {
    let privateListener!: (event: HostExternalTranscriptFollowEvent) => Promise<void> | void;
    const followTranscript = vi.fn(async (input: Readonly<{
      options: Readonly<{ cursor?: string }>;
      listener(event: HostExternalTranscriptFollowEvent): void | Promise<void>;
    }>) => {
      privateListener = input.listener;
      return {
        status: 'following' as const,
        startingCursor: input.options.cursor ?? null,
        subscription: { dispose: vi.fn(async () => undefined) },
      };
    });
    const ops: ExternalSessionProviderOps = {
      validateSource: async ({ source }) => ({ ok: true, source }),
      listCandidates: async () => ({ candidates: [], nextCursor: null }),
      resolveLinkIdentity: resolveExactLinkIdentity,
      pageTranscript: async () => ({
        items: [], nextCursor: null, tailCursor: null, hasMore: false, truncated: false,
      }),
      readAfterTranscript: async () => ({ outcome: 'already_current' }),
    };
    const composition = await createConfiguredPluginExternalSessionsAdapter({
      agents: [agent()],
      account: { connectedServicesV2: [] },
      basis: { contributionGenerationId: 'registry:g1', accountSettingsRevision: 'account:1' },
      readCurrentBasis: () => ({ contributionGenerationId: 'registry:g1', accountSettingsRevision: 'account:1' }),
      isCurrent: () => true,
      resolveProviderOps: async () => ops,
      followTranscript,
    });
    const ref = {
      agentId: 'codex', sourceId: 'codexHome:user:::', remoteSessionId: 'remote-1',
    } as const;
    const qualifiedPrefix = 'happier_external_cursor_v1:';
    const maximumQualifiedCursor = `${qualifiedPrefix}${'q'.repeat(4_096 - qualifiedPrefix.length)}`;
    const listener = vi.fn(async () => undefined);

    await expect(composition.authorService.readTranscript(
      ref,
      { mode: 'page', direction: 'older', cursor: 'released-native-cursor' },
      {},
    )).rejects.toMatchObject({ code: 'plugin_external_transcript_query_invalid' });
    await expect(composition.authorService.readTranscript(
      ref,
      { mode: 'readAfter', cursor: 'released-native-cursor' },
      {},
    )).rejects.toMatchObject({ code: 'plugin_external_transcript_query_invalid' });
    await expect(composition.authorService.followTranscript(
      ref,
      { cursor: 'released-native-cursor' },
      listener,
    )).resolves.toEqual({
      status: 'unavailable',
      code: 'plugin_external_cursor_invalid',
    });
    expect(followTranscript).not.toHaveBeenCalled();

    await expect(composition.authorService.followTranscript(
      ref,
      { cursor: maximumQualifiedCursor },
      listener,
    )).resolves.toMatchObject({ status: 'following', startingCursor: maximumQualifiedCursor });
    await privateListener({
      kind: 'data', items: [], fromCursor: maximumQualifiedCursor, nextCursor: maximumQualifiedCursor,
    });
    expect(listener).toHaveBeenCalledOnce();
    await privateListener({
      kind: 'data',
      items: Array.from({ length: 1_001 }, (_, index) => ({
        id: `item-${index}`,
        kind: 'agent' as const,
        data: { type: 'text', text: 'x' },
      })),
      fromCursor: maximumQualifiedCursor,
      nextCursor: maximumQualifiedCursor,
    });
    expect(listener).toHaveBeenCalledTimes(2);
    await expect(privateListener({
      kind: 'data',
      items: [],
      fromCursor: maximumQualifiedCursor,
      nextCursor: `${maximumQualifiedCursor}q`,
    })).rejects.toMatchObject({ code: 'plugin_external_follow_event_invalid' });
    await expect(composition.authorService.followTranscript(
      ref,
      { cursor: `${maximumQualifiedCursor}q` },
      listener,
    )).resolves.toEqual({ status: 'unavailable', code: 'plugin_external_cursor_invalid' });
    expect(followTranscript).toHaveBeenCalledOnce();
  });

  it('starts release at the 6s daemon acknowledgement deadline and bounds hanging cleanup to 5s', async () => {
    vi.useFakeTimers();
    try {
      let privateListener!: (event: HostExternalTranscriptFollowEvent) => Promise<void> | void;
      const dispose = vi.fn(() => new Promise<void>(() => undefined));
      const followTranscript = vi.fn(async (input: Readonly<{
        listener(event: HostExternalTranscriptFollowEvent): void | Promise<void>;
      }>) => {
        privateListener = input.listener;
        return {
          status: 'following' as const,
          startingCursor: 'cursor-0',
          subscription: { dispose },
        };
      });
      const ops: ExternalSessionProviderOps = {
        validateSource: async ({ source }) => ({ ok: true, source }),
        listCandidates: async () => ({ candidates: [], nextCursor: null }),
        resolveLinkIdentity: resolveExactLinkIdentity,
        pageTranscript: async () => ({
          items: [], nextCursor: null, tailCursor: 'cursor-0', hasMore: false, truncated: false,
        }),
        readAfterTranscript: async () => ({ outcome: 'already_current' }),
      };
      const composition = await createConfiguredPluginExternalSessionsAdapter({
        agents: [agent()],
        account: { connectedServicesV2: [] },
        basis: { contributionGenerationId: 'registry:g1', accountSettingsRevision: 'account:1' },
        readCurrentBasis: () => ({ contributionGenerationId: 'registry:g1', accountSettingsRevision: 'account:1' }),
        isCurrent: () => true,
        resolveProviderOps: async () => ops,
        followTranscript,
      });
      const result = await composition.authorService.followTranscript({
        agentId: 'codex', sourceId: 'codexHome:user:::', remoteSessionId: 'remote-1',
      }, {}, async () => await new Promise<void>(() => undefined));
      expect(result.status).toBe('following');
      const delivery = Promise.resolve(privateListener({
        kind: 'data', items: [], fromCursor: 'cursor-0', nextCursor: 'cursor-1',
      }));

      // The configured owner is awaiting the daemon's acknowledgement, not the
      // author callback. The runner retains the five-second author deadline;
      // the outer owner waits one additional transport round trip for its
      // rejected acknowledgement before starting physical cleanup.
      await vi.advanceTimersByTimeAsync(
        EXTERNAL_SESSION_FOLLOW_CLOSE_TRANSPORT_TIMEOUT_MS - 1,
      );
      expect(dispose).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(dispose).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(4_999);
      let settled = false;
      void delivery.finally(() => { settled = true; }).catch(() => undefined);
      await Promise.resolve();
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await expect(delivery).rejects.toThrow('plugin_external_follow_listener_deadline_exceeded');
      await expect(privateListener({
        kind: 'data', items: [], fromCursor: 'cursor-0', nextCursor: 'cursor-2',
      })).rejects.toThrow('plugin_external_follow_listener_failed');
      expect(dispose).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps a daemon follow delivery open for the author deadline plus acknowledgement transport margin', async () => {
    vi.useFakeTimers();
    try {
      let privateListener!: (event: HostExternalTranscriptFollowEvent) => Promise<void> | void;
      const dispose = vi.fn(async () => undefined);
      const followTranscript = vi.fn(async (input: Readonly<{
        listener(event: HostExternalTranscriptFollowEvent): void | Promise<void>;
      }>) => {
        privateListener = input.listener;
        return {
          status: 'following' as const,
          startingCursor: 'cursor-0',
          subscription: { dispose },
        };
      });
      const ops: ExternalSessionProviderOps = {
        validateSource: async ({ source }) => ({ ok: true, source }),
        listCandidates: async () => ({ candidates: [], nextCursor: null }),
        resolveLinkIdentity: resolveExactLinkIdentity,
        pageTranscript: async () => ({
          items: [], nextCursor: null, tailCursor: 'cursor-0', hasMore: false, truncated: false,
        }),
        readAfterTranscript: async () => ({ outcome: 'already_current' }),
      };
      const composition = await createConfiguredPluginExternalSessionsAdapter({
        agents: [agent()],
        account: { connectedServicesV2: [] },
        basis: { contributionGenerationId: 'registry:g1', accountSettingsRevision: 'account:1' },
        readCurrentBasis: () => ({ contributionGenerationId: 'registry:g1', accountSettingsRevision: 'account:1' }),
        isCurrent: () => true,
        resolveProviderOps: async () => ops,
        followTranscript,
      });
      const runnerAuthorListener = vi.fn(async (_event: unknown) => await new Promise<void>((resolve) => {
        setTimeout(resolve, 4_999);
      }));
      // This is the daemon-side publisher: author work is complete at 4,999 ms,
      // then the runner acknowledgement takes a positive transport interval.
      const publishToRunner = vi.fn(async (event: unknown) => {
        await runnerAuthorListener(event);
        await new Promise<void>((resolve) => { setTimeout(resolve, 2); });
      });
      const result = await composition.authorService.followTranscript({
        agentId: 'codex', sourceId: 'codexHome:user:::', remoteSessionId: 'remote-1',
      }, {}, publishToRunner);
      expect(result.status).toBe('following');
      const delivery = Promise.resolve(privateListener({
        kind: 'data', items: [], fromCursor: 'cursor-0', nextCursor: 'cursor-1',
      }));

      await vi.advanceTimersByTimeAsync(4_999);
      expect(runnerAuthorListener).toHaveBeenCalledOnce();
      expect(dispose).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(2);
      await expect(delivery).resolves.toBeUndefined();
      expect(publishToRunner).toHaveBeenCalledOnce();
      expect(dispose).not.toHaveBeenCalled();
      expect(EXTERNAL_SESSION_FOLLOW_CLOSE_TRANSPORT_TIMEOUT_MS).toBe(6_000);
    } finally {
      vi.useRealTimers();
    }
  });

  it('never reports unsettled or failed follow cleanup as disposal and keeps the exact handle retryable', async () => {
    vi.useFakeTimers();
    try {
      let privateListener!: (event: HostExternalTranscriptFollowEvent) => Promise<void> | void;
      let failFirstCleanup!: (error: unknown) => void;
      let cleanupAttempts = 0;
      const dispose = vi.fn(() => {
        cleanupAttempts += 1;
        if (cleanupAttempts === 1) {
          return new Promise<void>((_, reject) => {
            failFirstCleanup = reject;
          });
        }
        return Promise.resolve();
      });
      const followTranscript = vi.fn(async (input: Readonly<{
        listener(event: HostExternalTranscriptFollowEvent): void | Promise<void>;
      }>) => {
        privateListener = input.listener;
        return {
          status: 'following' as const,
          startingCursor: 'cursor-0',
          subscription: { dispose },
        };
      });
      const ops: ExternalSessionProviderOps = {
        validateSource: async ({ source }) => ({ ok: true, source }),
        listCandidates: async () => ({ candidates: [], nextCursor: null }),
        resolveLinkIdentity: resolveExactLinkIdentity,
        pageTranscript: async () => ({
          items: [], nextCursor: null, tailCursor: 'cursor-0', hasMore: false, truncated: false,
        }),
        readAfterTranscript: async () => ({ outcome: 'already_current' }),
      };
      const composition = await createConfiguredPluginExternalSessionsAdapter({
        agents: [agent()],
        account: { connectedServicesV2: [] },
        basis: { contributionGenerationId: 'registry:g1', accountSettingsRevision: 'account:1' },
        readCurrentBasis: () => ({ contributionGenerationId: 'registry:g1', accountSettingsRevision: 'account:1' }),
        isCurrent: () => true,
        resolveProviderOps: async () => ops,
        followTranscript,
      });
      const result = await composition.authorService.followTranscript({
        agentId: 'codex', sourceId: 'codexHome:user:::', remoteSessionId: 'remote-1',
      }, {}, vi.fn(async () => undefined));
      if (result.status !== 'following') throw new Error('expected follow');

      // Cleanup that has not settled by the ceiling is unresolved cleanup, not
      // finished cleanup: reporting success here is what let every owner above
      // drop a still-live provider subscription.
      const first = Promise.resolve(result.subscription.dispose());
      const firstSettled = first.catch(() => undefined);
      await vi.advanceTimersByTimeAsync(4_999);
      let settled = false;
      void firstSettled.finally(() => { settled = true; });
      await Promise.resolve();
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await expect(first).rejects.toThrow(
        'plugin_external_follow_cleanup_deadline_exceeded',
      );

      // The follow is still terminal for delivery even though its cleanup hung.
      await expect(privateListener({
        kind: 'data', items: [], fromCursor: 'cursor-0', nextCursor: 'cursor-1',
      })).rejects.toThrow('plugin_external_follow_listener_failed');

      // A retry joins the invocation the provider is still running instead of
      // disposing the same subscription a second time.
      const second = Promise.resolve(result.subscription.dispose());
      const secondSettled = second.catch(() => undefined);
      await Promise.resolve();
      expect(dispose).toHaveBeenCalledOnce();

      // The failure that arrives after the ceiling is surfaced, not swallowed.
      failFirstCleanup(new Error('provider cleanup rejected'));
      await expect(second).rejects.toThrow('provider cleanup rejected');
      await secondSettled;

      // Custody is retained: the next explicit disposal retries the exact handle.
      await expect(result.subscription.dispose()).resolves.toBeUndefined();
      expect(dispose).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('fences a pending author listener immediately when its configured generation retires', async () => {
    let privateListener!: (event: HostExternalTranscriptFollowEvent) => Promise<void> | void;
    let acceptedCursor = 'cursor-0';
    let settleListener!: () => void;
    const listenerSettlement = new Promise<void>((resolve) => {
      settleListener = resolve;
    });
    const dispose = vi.fn(async () => undefined);
    const followTranscript = vi.fn(async (input: Readonly<{
      listener(event: HostExternalTranscriptFollowEvent): void | Promise<void>;
    }>) => {
      privateListener = input.listener;
      return {
        status: 'following' as const,
        startingCursor: acceptedCursor,
        subscription: { dispose },
      };
    });
    const ops: ExternalSessionProviderOps = {
      validateSource: async ({ source }) => ({ ok: true, source }),
      listCandidates: async () => ({ candidates: [], nextCursor: null }),
      resolveLinkIdentity: resolveExactLinkIdentity,
      pageTranscript: async () => ({
        items: [], nextCursor: null, tailCursor: acceptedCursor, hasMore: false, truncated: false,
      }),
      readAfterTranscript: async () => ({ outcome: 'already_current' }),
    };
    const composition = await createConfiguredPluginExternalSessionsAdapter({
      agents: [agent()],
      account: { connectedServicesV2: [] },
      basis: { contributionGenerationId: 'registry:g1', accountSettingsRevision: 'account:1' },
      readCurrentBasis: () => ({ contributionGenerationId: 'registry:g1', accountSettingsRevision: 'account:1' }),
      isCurrent: () => true,
      resolveProviderOps: async () => ops,
      followTranscript,
    });
    const listener = vi.fn(async () => await listenerSettlement);
    const result = await composition.authorService.followTranscript({
      agentId: 'codex', sourceId: 'codexHome:user:::', remoteSessionId: 'remote-1',
    }, {}, listener);
    expect(result.status).toBe('following');
    const deliver = async (nextCursor: string) => {
      await privateListener({
        kind: 'data', items: [], fromCursor: acceptedCursor, nextCursor,
      });
      acceptedCursor = nextCursor;
    };
    const pendingDelivery = deliver('cursor-1');
    await Promise.resolve();
    expect(listener).toHaveBeenCalledOnce();

    const retirementStartedAt = Date.now();
    composition.dispose();
    const settlement = await pendingDelivery.then(
      () => new Error('pending author delivery unexpectedly succeeded'),
      (error: unknown) => error,
    );
    const retirementSettlementMs = Date.now() - retirementStartedAt;
    settleListener();

    expect(retirementSettlementMs).toBeLessThan(1_000);
    expect(settlement).toMatchObject({ message: 'plugin_operation_aborted' });
    expect(dispose).toHaveBeenCalledOnce();
    expect(acceptedCursor).toBe('cursor-0');

    await expect(deliver('cursor-2')).rejects.toThrow('plugin_external_follow_listener_failed');
    expect(listener).toHaveBeenCalledOnce();
    expect(acceptedCursor).toBe('cursor-0');
    expect(dispose).toHaveBeenCalledOnce();
  });

  it('releases an idle author follow on caller abort and fences every late event', async () => {
    let privateListener!: (event: HostExternalTranscriptFollowEvent) => Promise<void> | void;
    const dispose = vi.fn(async () => undefined);
    const followTranscript = vi.fn(async (input: Readonly<{
      listener(event: HostExternalTranscriptFollowEvent): void | Promise<void>;
    }>) => {
      privateListener = input.listener;
      return {
        status: 'following' as const,
        startingCursor: 'cursor-0',
        subscription: { dispose },
      };
    });
    const ops: ExternalSessionProviderOps = {
      validateSource: async ({ source }) => ({ ok: true, source }),
      listCandidates: async () => ({ candidates: [], nextCursor: null }),
      resolveLinkIdentity: resolveExactLinkIdentity,
      pageTranscript: async () => ({
        items: [], nextCursor: null, tailCursor: 'cursor-0', hasMore: false, truncated: false,
      }),
      readAfterTranscript: async () => ({ outcome: 'already_current' }),
    };
    const composition = await createConfiguredPluginExternalSessionsAdapter({
      agents: [agent()],
      account: { connectedServicesV2: [] },
      basis: { contributionGenerationId: 'registry:g1', accountSettingsRevision: 'account:1' },
      readCurrentBasis: () => ({ contributionGenerationId: 'registry:g1', accountSettingsRevision: 'account:1' }),
      isCurrent: () => true,
      resolveProviderOps: async () => ops,
      followTranscript,
    });
    const caller = new AbortController();
    const listener = vi.fn(async () => undefined);
    const result = await composition.authorService.followTranscript({
      agentId: 'codex', sourceId: 'codexHome:user:::', remoteSessionId: 'remote-1',
    }, { signal: caller.signal }, listener);
    expect(result.status).toBe('following');

    caller.abort();
    await vi.waitFor(() => expect(dispose).toHaveBeenCalledOnce());
    await expect(privateListener({
      kind: 'data', items: [], fromCursor: 'cursor-0', nextCursor: 'cursor-1',
    })).rejects.toThrow('plugin_external_follow_listener_failed');
    expect(listener).not.toHaveBeenCalled();
    if (result.status === 'following') await result.subscription.dispose();
    expect(dispose).toHaveBeenCalledOnce();
  });

  it('releases and fences an author follow when its current source retires before a late event', async () => {
    let current = true;
    let privateListener!: (event: HostExternalTranscriptFollowEvent) => Promise<void> | void;
    const dispose = vi.fn(async () => undefined);
    const followTranscript = vi.fn(async (input: Readonly<{
      listener(event: HostExternalTranscriptFollowEvent): void | Promise<void>;
    }>) => {
      privateListener = input.listener;
      return {
        status: 'following' as const,
        startingCursor: 'cursor-0',
        subscription: { dispose },
      };
    });
    const ops: ExternalSessionProviderOps = {
      validateSource: async ({ source }) => ({ ok: true, source }),
      listCandidates: async () => ({ candidates: [], nextCursor: null }),
      resolveLinkIdentity: resolveExactLinkIdentity,
      pageTranscript: async () => ({
        items: [], nextCursor: null, tailCursor: 'cursor-0', hasMore: false, truncated: false,
      }),
      readAfterTranscript: async () => ({ outcome: 'already_current' }),
    };
    const composition = await createConfiguredPluginExternalSessionsAdapter({
      agents: [agent()],
      account: { connectedServicesV2: [] },
      basis: { contributionGenerationId: 'registry:g1', accountSettingsRevision: 'account:1' },
      readCurrentBasis: () => ({ contributionGenerationId: 'registry:g1', accountSettingsRevision: 'account:1' }),
      isCurrent: () => current,
      resolveProviderOps: async () => ops,
      followTranscript,
    });
    const listener = vi.fn(async () => undefined);
    const result = await composition.authorService.followTranscript({
      agentId: 'codex', sourceId: 'codexHome:user:::', remoteSessionId: 'remote-1',
    }, {}, listener);
    expect(result.status).toBe('following');

    current = false;
    await expect(privateListener({
      kind: 'data', items: [], fromCursor: 'cursor-0', nextCursor: 'cursor-1',
    })).rejects.toThrow('plugin_external_follow_listener_failed');
    expect(listener).not.toHaveBeenCalled();
    expect(dispose).toHaveBeenCalledOnce();
  });

  it('releases an author follow on asynchronous connection failure and fences every late event', async () => {
    let privateListener!: (event: HostExternalTranscriptFollowEvent) => Promise<void> | void;
    let failConnection!: (error: Error) => void;
    const connectionFailure = new Promise<Error>((resolve) => {
      failConnection = resolve;
    });
    const dispose = vi.fn(async () => undefined);
    const followTranscript = vi.fn(async (input: Readonly<{
      listener(event: HostExternalTranscriptFollowEvent): void | Promise<void>;
    }>) => {
      privateListener = input.listener;
      return {
        status: 'following' as const,
        startingCursor: 'cursor-0',
        subscription: { dispose },
        failure: connectionFailure,
      };
    });
    const ops: ExternalSessionProviderOps = {
      validateSource: async ({ source }) => ({ ok: true, source }),
      listCandidates: async () => ({ candidates: [], nextCursor: null }),
      resolveLinkIdentity: resolveExactLinkIdentity,
      pageTranscript: async () => ({
        items: [], nextCursor: null, tailCursor: 'cursor-0', hasMore: false, truncated: false,
      }),
      readAfterTranscript: async () => ({ outcome: 'already_current' }),
    };
    const composition = await createConfiguredPluginExternalSessionsAdapter({
      agents: [agent()],
      account: { connectedServicesV2: [] },
      basis: { contributionGenerationId: 'registry:g1', accountSettingsRevision: 'account:1' },
      readCurrentBasis: () => ({ contributionGenerationId: 'registry:g1', accountSettingsRevision: 'account:1' }),
      isCurrent: () => true,
      resolveProviderOps: async () => ops,
      followTranscript,
    });
    const listener = vi.fn(async () => undefined);
    const result = await composition.authorService.followTranscript({
      agentId: 'codex', sourceId: 'codexHome:user:::', remoteSessionId: 'remote-1',
    }, {}, listener);
    expect(result.status).toBe('following');

    failConnection(new Error('connection-closed'));
    await vi.waitFor(() => expect(dispose).toHaveBeenCalledOnce());
    await expect(privateListener({
      kind: 'data', items: [], fromCursor: 'cursor-0', nextCursor: 'cursor-1',
    })).rejects.toThrow('plugin_external_follow_listener_failed');
    expect(listener).not.toHaveBeenCalled();
    if (result.status === 'following') await result.subscription.dispose();
    expect(dispose).toHaveBeenCalledOnce();
  });

  it('reconciles cold candidate indexes against the newly admitted sources after a daemon restart', async () => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-removed-source-candidate-index-'));
    const connectedAccount: ConfiguredExternalSessionSourceAccountProjection = {
      connectedServicesV2: [{
        serviceId: 'openai-codex',
        profiles: [{
          profileId: 'work', status: 'connected', kind: 'oauth', providerEmail: null,
          providerAccountId: null, expiresAt: null, lastUsedAt: null, health: null,
        }],
        groups: [],
      }],
    };
    try {
      let revision = 'settings:1';
      let account: ConfiguredExternalSessionSourceAccountProjection = { connectedServicesV2: [] };
      const listCandidates = vi.fn<ExternalSessionProviderOps['listCandidates']>(async ({ cursor, source }) => {
        const slot = (source as { connectedServiceProfileId?: string }).connectedServiceProfileId ?? 'user';
        return cursor
          ? {
              candidates: [{ remoteSessionId: `${slot}-newest`, title: 'Private title', updatedAtMs: 2 }],
              nextCursor: null,
              preparation: { kind: 'building_candidate_index' as const, scanned: 2 },
            }
          : {
              candidates: [{ remoteSessionId: `${slot}-oldest`, title: 'Private title', updatedAtMs: 1 }],
              nextCursor: 'scan:2',
              preparation: { kind: 'building_candidate_index' as const, scanned: 1 },
            };
      });
      const ops: ExternalSessionProviderOps = {
        validateSource: async ({ source }) => ({ ok: true, source }),
        listCandidates,
        resolveLinkIdentity: async ({ source, remoteSessionId }) => ({ source, remoteSessionId }),
        pageTranscript: async () => ({
          items: [], nextCursor: null, tailCursor: null, hasMore: false, truncated: false,
        }),
        readAfterTranscript: async () => ({ outcome: 'already_current' }),
      };
      const createLifecycle = async () => await createLiveConfiguredPluginExternalSessionsAdapter({
        agents: [agent()],
        contributionGenerationId: 'registry:g1',
        readAccount: async () => account,
        readAccountRevision: () => revision,
        subscribeAccountRevision: () => () => {},
        isCurrent: () => true,
        activeServerDir,
        resolveProviderOps: async () => ops,
      });
      const firstLifecycle = await createLifecycle();
      const listPreparedSource = async (sourceId: string) => {
        const firstPreparation = await firstLifecycle.authorService.list({ sourceId });
        expect(firstPreparation.items).toEqual([]);
        expect(firstPreparation.nextCursor).toMatch(/^plugin_external_sessions_v1_/);
        const secondPreparation = await firstLifecycle.authorService.list({
          sourceId,
          cursor: firstPreparation.nextCursor!,
        });
        expect(secondPreparation.items).toEqual([]);
        expect(secondPreparation.nextCursor).toMatch(/^plugin_external_sessions_v1_/);
        return await firstLifecycle.authorService.list({
          sourceId,
          cursor: secondPreparation.nextCursor!,
        });
      };
      let retainedSourceIndexes: string[] = [];
      try {
        expect(firstLifecycle.candidateIndexIdentities).toHaveLength(1);
        const userPage = await listPreparedSource('codexHome:user:::');
        expect(userPage).toMatchObject({
          items: [{ ref: { remoteSessionId: 'user-newest' } }, { ref: { remoteSessionId: 'user-oldest' } }],
        });
        retainedSourceIndexes = await listCandidateIndexFiles(activeServerDir);
        expect(retainedSourceIndexes).toHaveLength(1);
      } finally {
        firstLifecycle.dispose();
      }

      // This new daemon process admits the retained user source plus a newly
      // connected work source. An aggregate B1 list call attempts each source
      // head once; it preserves the completed user index while building work.
      account = connectedAccount;
      revision = 'settings:2';
      const expandedLifecycle = await createLifecycle();
      try {
        expect(expandedLifecycle.candidateIndexIdentities).toHaveLength(2);
        const initial = await expandedLifecycle.authorService.list();
        expect(initial.items).toEqual([]);
        expect(initial.nextCursor).toMatch(/^plugin_external_sessions_v1_/);
        const continued = await expandedLifecycle.authorService.list({ cursor: initial.nextCursor! });
        expect(continued.items).toEqual([]);
        expect(continued.nextCursor).toMatch(/^plugin_external_sessions_v1_/);
        const complete = await expandedLifecycle.authorService.list({ cursor: continued.nextCursor! });
        expect(complete.items.map((candidate) => candidate.ref.remoteSessionId).sort()).toEqual([
          'user-newest', 'user-oldest', 'work-newest', 'work-oldest',
        ].sort());
        expect(await listCandidateIndexFiles(activeServerDir)).toHaveLength(2);
      } finally {
        expandedLifecycle.dispose();
      }

      // A third process no longer admits work. Rebuild reconciliation discovers
      // and removes that cold on-disk index while retaining the user index.
      account = { connectedServicesV2: [] };
      revision = 'settings:3';
      const restartedLifecycle = await createLifecycle();
      try {
        expect(restartedLifecycle.candidateIndexIdentities).toHaveLength(1);
        expect(await listCandidateIndexFiles(activeServerDir)).toEqual(retainedSourceIndexes);
        await expect(restartedLifecycle.authorService.list({ sourceId: 'codexHome:user:::' })).resolves.toMatchObject({
          items: [{ ref: { remoteSessionId: 'user-newest' } }, { ref: { remoteSessionId: 'user-oldest' } }],
        });
      } finally {
        restartedLifecycle.dispose();
      }
    } finally {
      await rm(activeServerDir, { recursive: true, force: true });
    }
  });

  it('retires old operations immediately and publishes a new immutable snapshot after account revision changes', async () => {
    let revision = 'settings:1';
    const notifyRevision: {
      current: ((next: string) => void) | null;
    } = { current: null };
    let resolveSecondRead!: (account: ConfiguredExternalSessionSourceAccountProjection) => void;
    const secondRead = new Promise<ConfiguredExternalSessionSourceAccountProjection>((resolve) => {
      resolveSecondRead = resolve;
    });
    const accounts: ConfiguredExternalSessionSourceAccountProjection[] = [
      { connectedServicesV2: [] },
    ];
    const readAccount = vi.fn(async () => accounts.shift() ?? await secondRead);
    let releaseList!: () => void;
    const delayedList = new Promise<void>((resolve) => {
      releaseList = resolve;
    });
    const listCandidates = vi.fn<ExternalSessionProviderOps['listCandidates']>(async ({ source }) => {
      if ((source as { connectedServiceProfileId?: string }).connectedServiceProfileId !== 'work') {
        await delayedList;
      }
      return {
        candidates: [{
          remoteSessionId: (source as { connectedServiceProfileId?: string }).connectedServiceProfileId ?? 'default',
          updatedAtMs: 1,
        }],
        nextCursor: null,
      };
    });
    const ops: ExternalSessionProviderOps = {
      validateSource: async ({ source }) => ({ ok: true, source }),
      listCandidates,
      pageTranscript: async () => ({ items: [], nextCursor: null, tailCursor: null, hasMore: false, truncated: false }),
      readAfterTranscript: async () => ({ outcome: 'already_current' }),
    };
    await withTemporaryActiveServerDir(async (activeServerDir) => {
      const workSource = connectedCodexSource(activeServerDir, 'work');
      const lifecycle = await createLiveConfiguredPluginExternalSessionsAdapter({
        agents: [agent()],
        contributionGenerationId: 'registry:g1',
        activeServerDir,
        readAccount,
        readAccountRevision: () => revision,
        subscribeAccountRevision: (listener) => {
          notifyRevision.current = listener;
          return () => {
            notifyRevision.current = null;
          };
        },
        isCurrent: () => true,
        resolveProviderOps: async () => ops,
      });

      try {
        const staleList = lifecycle.authorService.list();
        revision = 'settings:2';
        notifyRevision.current?.(revision);
        expect((await lifecycle.authorService.capabilities()).list).toEqual({
          status: 'unavailable',
          code: 'plugin_external_sources_reconfiguring',
        });
        releaseList();
        await expect(staleList).rejects.toMatchObject({ code: 'plugin_generation_retired' });

        resolveSecondRead({
          connectedServicesV2: [{
            serviceId: 'openai-codex',
            profiles: [{
              profileId: 'work', status: 'connected', kind: 'oauth', providerEmail: null,
              providerAccountId: null, expiresAt: null, lastUsedAt: null, health: null,
            }],
            groups: [],
          }],
        });
        await vi.waitFor(async () => {
          expect((await lifecycle.authorService.capabilities()).list).toEqual({ status: 'available' });
        });
        const current = await lifecycle.authorService.list({ sourceId: workSource.sourceId });
        expect(current.items[0]?.ref.remoteSessionId).toBe('work');
        expect(Object.isFrozen(current.items[0]?.ref)).toBe(true);

        lifecycle.dispose();
        expect((await lifecycle.authorService.capabilities()).list).toEqual({
          status: 'unavailable',
          code: 'plugin_generation_retired',
        });
      } finally {
        lifecycle.dispose();
      }
    });
  });

  it('keeps every other Agent and the current-global service available when one Agent refuses its own source', async () => {
    const flakyContribution: PluginAgentContributionV2 = {
      ...codexContribution,
      id: 'flaky',
      title: 'Flaky',
    };
    const flakyAgent = {
      id: flakyContribution.id,
      identity: { pluginId: 'acme.flaky', localId: flakyContribution.id },
      richDefinition: { provenance: 'first_party' as const, definition: flakyContribution },
    };
    const healthyOps: ExternalSessionProviderOps = {
      validateSource: async ({ source }) => ({ ok: true, source }),
      listCandidates: async () => ({
        candidates: [{ remoteSessionId: 'healthy-remote', updatedAtMs: 1 }],
        nextCursor: null,
      }),
      pageTranscript: async () => ({
        items: [], nextCursor: null, tailCursor: null, hasMore: false, truncated: false,
      }),
      readAfterTranscript: async () => ({ outcome: 'already_current' }),
    };
    const flakyValidate = vi.fn<ExternalSessionProviderOps['validateSource']>(async () => {
      throw new Error('flaky agent home probe failed');
    });

    const lifecycle = await createLiveConfiguredPluginExternalSessionsAdapter({
      agents: [agent(), flakyAgent],
      contributionGenerationId: 'registry:g1',
      readAccount: async () => ({ connectedServicesV2: [] }),
      readAccountRevision: () => 'settings:1',
      subscribeAccountRevision: () => () => {},
      isCurrent: () => true,
      resolveProviderOps: async (agentId) => (agentId === 'flaky'
        ? { ...healthyOps, validateSource: flakyValidate }
        : healthyOps),
    });

    try {
      expect(flakyValidate).toHaveBeenCalledOnce();
      expect((await lifecycle.authorService.capabilities()).list).toEqual({ status: 'available' });
      const listed = await lifecycle.authorService.list({ agentId: 'codex' });
      expect(listed.items[0]?.ref).toMatchObject({
        agentId: 'codex',
        remoteSessionId: 'healthy-remote',
      });
      await expect(lifecycle.authorService.list({ agentId: 'flaky' })).rejects.toMatchObject({
        code: 'plugin_external_source_unavailable',
      });
      expect(lifecycle.sourceRefusals).toEqual([{
        agentId: 'flaky',
        code: 'provider_source_invalid',
        message: expect.stringMatching(/agent 'flaky'/i),
      }]);
    } finally {
      lifecycle.dispose();
    }
  });

  it('publishes only the latest admitted source refusals after an Account revision', async () => {
    const flakyContribution: PluginAgentContributionV2 = {
      ...codexContribution,
      id: 'flaky-diagnostics',
      title: 'Flaky diagnostics',
    };
    const flakyAgent = {
      id: flakyContribution.id,
      identity: { pluginId: 'acme.flaky-diagnostics', localId: flakyContribution.id },
      richDefinition: { provenance: 'first_party' as const, definition: flakyContribution },
    };
    let revision = 'settings:1';
    const notifyRevision: {
      current: ((next: string) => void) | null;
    } = { current: null };
    let refuseFlaky = false;
    const published: Array<readonly Readonly<{
      agentId: string;
      code: string;
      message: string;
    }>[]> = [];
    const ops: ExternalSessionProviderOps = {
      validateSource: async ({ source }) => ({ ok: true, source }),
      listCandidates: async () => ({ candidates: [], nextCursor: null }),
      pageTranscript: async () => ({
        items: [], nextCursor: null, tailCursor: null, hasMore: false, truncated: false,
      }),
      readAfterTranscript: async () => ({ outcome: 'already_current' }),
    };
    const lifecycle = await createLiveConfiguredPluginExternalSessionsAdapter({
      agents: [agent(), flakyAgent],
      contributionGenerationId: 'registry:g1',
      readAccount: async () => ({ connectedServicesV2: [] }),
      readAccountRevision: () => revision,
      subscribeAccountRevision: (listener) => {
        notifyRevision.current = listener;
        return () => { notifyRevision.current = null; };
      },
      isCurrent: () => true,
      resolveProviderOps: async (agentId) => (
        agentId === flakyAgent.id && refuseFlaky
          ? { ...ops, validateSource: async () => { throw new Error('refused latest source'); } }
          : ops
      ),
      onSourceRefusalsChanged: (refusals) => published.push(refusals),
    });

    try {
      expect(published).toEqual([[]]);

      refuseFlaky = true;
      revision = 'settings:2';
      notifyRevision.current?.(revision);
      await vi.waitFor(() => expect(published).toEqual([
        [],
        [expect.objectContaining({
          agentId: flakyAgent.id,
          code: 'provider_source_invalid',
        })],
      ]));

      refuseFlaky = false;
      revision = 'settings:3';
      notifyRevision.current?.(revision);
      await vi.waitFor(() => expect(published).toEqual([
        [],
        [expect.objectContaining({ agentId: flakyAgent.id })],
        [],
      ]));
    } finally {
      lifecycle.dispose();
    }
  });

  it('rebuilds configured sources across account removal, reconnect, and profile switch', async () => {
    let revision = 'settings:1';
    let notifyRevision: ((next: string) => void) | null = null;
    const connectedAccount = (profileId: string): ConfiguredExternalSessionSourceAccountProjection => ({
      connectedServicesV2: [{
        serviceId: 'openai-codex',
        profiles: [{
          profileId, status: 'connected', kind: 'oauth', providerEmail: null,
          providerAccountId: null, expiresAt: null, lastUsedAt: null, health: null,
        }],
        groups: [],
      }],
    });
    let account = connectedAccount('work');
    const ops: ExternalSessionProviderOps = {
      validateSource: async ({ source }) => ({ ok: true, source }),
      listCandidates: async ({ source }) => ({
        candidates: [{
          remoteSessionId: (source as { connectedServiceProfileId?: string }).connectedServiceProfileId ?? 'default',
          updatedAtMs: 1,
        }],
        nextCursor: null,
      }),
      pageTranscript: async () => ({ items: [], nextCursor: null, tailCursor: null, hasMore: false, truncated: false }),
      readAfterTranscript: async () => ({ outcome: 'already_current' }),
    };
    await withTemporaryActiveServerDir(async (activeServerDir) => {
      const workSource = connectedCodexSource(activeServerDir, 'work');
      const backupSource = connectedCodexSource(activeServerDir, 'backup');
      const lifecycle = await createLiveConfiguredPluginExternalSessionsAdapter({
        agents: [agent()],
        contributionGenerationId: 'registry:g1',
        activeServerDir,
        readAccount: async () => account,
        readAccountRevision: () => revision,
        subscribeAccountRevision: (listener) => {
          notifyRevision = listener;
          return () => { notifyRevision = null; };
        },
        isCurrent: () => true,
        resolveProviderOps: async () => ops,
      });

      try {
        await expect(lifecycle.authorService.list({ sourceId: workSource.sourceId }))
          .resolves.toMatchObject({ items: [{ ref: { remoteSessionId: 'work' } }] });

        account = { connectedServicesV2: [] };
        revision = 'settings:2';
        (notifyRevision as ((next: string) => void) | null)?.(revision);
        await vi.waitFor(async () => expect((await lifecycle.authorService.capabilities()).list).toEqual({ status: 'available' }));
        await expect(lifecycle.authorService.list({ sourceId: workSource.sourceId }))
          .rejects.toMatchObject({ code: 'plugin_external_source_unavailable' });

        account = connectedAccount('backup');
        revision = 'settings:3';
        (notifyRevision as ((next: string) => void) | null)?.(revision);
        await vi.waitFor(async () => expect((await lifecycle.authorService.capabilities()).list).toEqual({ status: 'available' }));
        await expect(lifecycle.authorService.list({ sourceId: backupSource.sourceId }))
          .resolves.toMatchObject({ items: [{ ref: { remoteSessionId: 'backup' } }] });
      } finally {
        lifecycle.dispose();
      }
    });
  });

  it('coalesces rapid revisions and repairs a missed account notification from the canonical revision reader', async () => {
    let revision = 'settings:1';
    let account: ConfiguredExternalSessionSourceAccountProjection = { connectedServicesV2: [] };
    let notifyRevision: ((next: string) => void) | null = null;
    let releaseBlockedRead!: () => void;
    let blockNextRead = false;
    let readsInFlight = 0;
    let maxReadsInFlight = 0;
    const readAccount = vi.fn(async () => {
      readsInFlight += 1;
      maxReadsInFlight = Math.max(maxReadsInFlight, readsInFlight);
      if (blockNextRead) {
        blockNextRead = false;
        await new Promise<void>((resolve) => {
          releaseBlockedRead = resolve;
        });
      }
      readsInFlight -= 1;
      return account;
    });
    const ops: ExternalSessionProviderOps = {
      validateSource: async ({ source }) => ({ ok: true, source }),
      listCandidates: async () => ({ candidates: [], nextCursor: null }),
      pageTranscript: async () => ({ items: [], nextCursor: null, tailCursor: null, hasMore: false, truncated: false }),
      readAfterTranscript: async () => ({ outcome: 'already_current' }),
    };
    const lifecycle = await createLiveConfiguredPluginExternalSessionsAdapter({
      agents: [agent()],
      contributionGenerationId: 'registry:g1',
      readAccount,
      readAccountRevision: () => revision,
      subscribeAccountRevision: (listener) => {
        notifyRevision = listener;
        return () => { notifyRevision = null; };
      },
      isCurrent: () => true,
      resolveProviderOps: async () => ops,
    });

    blockNextRead = true;
    revision = 'settings:2';
    (notifyRevision as ((next: string) => void) | null)?.(revision);
    await vi.waitFor(() => expect(readAccount).toHaveBeenCalledTimes(2));
    revision = 'settings:3';
    (notifyRevision as ((next: string) => void) | null)?.(revision);
    revision = 'settings:4';
    (notifyRevision as ((next: string) => void) | null)?.(revision);
    expect(readAccount).toHaveBeenCalledTimes(2);
    releaseBlockedRead();
    await vi.waitFor(async () => expect((await lifecycle.authorService.capabilities()).list).toEqual({ status: 'available' }));
    expect(readAccount).toHaveBeenCalledTimes(3);
    expect(maxReadsInFlight).toBe(1);

    // A throwing earlier listener in the snapshot owner can prevent this listener from
    // observing an emission. The canonical revision reader must still retire the stale
    // snapshot on the next public operation and schedule the replacement.
    account = { connectedServicesV2: [] };
    revision = 'settings:5';
    expect((await lifecycle.authorService.capabilities()).list).toEqual({
      status: 'unavailable',
      code: 'plugin_external_sources_reconfiguring',
    });
    await vi.waitFor(async () => expect((await lifecycle.authorService.capabilities()).list).toEqual({ status: 'available' }));
    expect(readAccount).toHaveBeenCalledTimes(4);
    lifecycle.dispose();
  });

  it('rebuilds one active configured composition for one accepted account revision', async () => {
    let revision = 'settings:1';
    let notifyRevision: ((next: string) => void) | null = null;
    const ops: ExternalSessionProviderOps = {
      validateSource: async ({ source }) => ({ ok: true, source }),
      listCandidates: async () => ({ candidates: [], nextCursor: null }),
      pageTranscript: async () => ({
        items: [], nextCursor: null, tailCursor: null, hasMore: false, truncated: false,
      }),
      readAfterTranscript: async () => ({ outcome: 'already_current' }),
    };
    const resolveProviderOps = vi.fn(async (): Promise<ExternalSessionProviderOps> => ops);
    const lifecycle = await createLiveConfiguredPluginExternalSessionsAdapter({
      agents: [agent()],
      contributionGenerationId: 'registry:g1',
      readAccount: async () => ({ connectedServicesV2: [] }),
      readAccountRevision: () => revision,
      subscribeAccountRevision: (listener) => {
        notifyRevision = listener;
        return () => { notifyRevision = null; };
      },
      isCurrent: () => true,
      resolveProviderOps,
    });

    expect(resolveProviderOps).toHaveBeenCalledOnce();
    revision = 'settings:2';
    (notifyRevision as ((next: string) => void) | null)?.(revision);
    await vi.waitFor(async () => {
      expect((await lifecycle.authorService.capabilities()).list).toEqual({
        status: 'available',
      });
    });

    expect(resolveProviderOps).toHaveBeenCalledTimes(2);
    (notifyRevision as ((next: string) => void) | null)?.(revision);
    await Promise.resolve();
    expect(resolveProviderOps).toHaveBeenCalledTimes(2);
    lifecycle.dispose();
  });

  it('allows only one coalesced same-revision retry after a failed rebuild left no active composition', async () => {
    let revision = 'settings:1';
    let notifyRevision: ((next: string) => void) | null = null;
    const ops: ExternalSessionProviderOps = {
      validateSource: async ({ source }) => ({ ok: true, source }),
      listCandidates: async () => ({ candidates: [], nextCursor: null }),
      pageTranscript: async () => ({
        items: [], nextCursor: null, tailCursor: null, hasMore: false, truncated: false,
      }),
      readAfterTranscript: async () => ({ outcome: 'already_current' }),
    };
    const readAccount = vi.fn(async (): Promise<ConfiguredExternalSessionSourceAccountProjection> => {
      if (readAccount.mock.calls.length === 2) {
        throw new Error('account rebuild failed');
      }
      return { connectedServicesV2: [] };
    });
    const resolveProviderOps = vi.fn(async (): Promise<ExternalSessionProviderOps> => ops);
    const lifecycle = await createLiveConfiguredPluginExternalSessionsAdapter({
      agents: [agent()],
      contributionGenerationId: 'registry:g1',
      readAccount,
      readAccountRevision: () => revision,
      subscribeAccountRevision: (listener) => {
        notifyRevision = listener;
        return () => { notifyRevision = null; };
      },
      isCurrent: () => true,
      resolveProviderOps,
    });

    revision = 'settings:2';
    (notifyRevision as ((next: string) => void) | null)?.(revision);
    await vi.waitFor(() => expect(readAccount).toHaveBeenCalledTimes(2));

    (notifyRevision as ((next: string) => void) | null)?.(revision);
    (notifyRevision as ((next: string) => void) | null)?.(revision);
    await vi.waitFor(() => expect(readAccount).toHaveBeenCalledTimes(3));
    await vi.waitFor(async () => {
      expect((await lifecycle.authorService.capabilities()).list).toEqual({
        status: 'available',
      });
    });
    await expect(lifecycle.authorService.list()).resolves.toMatchObject({
      items: [],
    });

    (notifyRevision as ((next: string) => void) | null)?.(revision);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(readAccount).toHaveBeenCalledTimes(3);
    expect(resolveProviderOps).toHaveBeenCalledTimes(2);
    lifecycle.dispose();
  });

  it('finishes initialization on the newest revision and unsubscribes exactly once', async () => {
    let revision = 'settings:1';
    let notifyRevision: ((next: string) => void) | null = null;
    let releaseInitialRead!: () => void;
    const initialRead = new Promise<void>((resolve) => {
      releaseInitialRead = resolve;
    });
    const readAccount = vi.fn(async () => {
      if (readAccount.mock.calls.length === 1) await initialRead;
      return { connectedServicesV2: [] };
    });
    const unsubscribe = vi.fn();
    const ops: ExternalSessionProviderOps = {
      validateSource: async ({ source }) => ({ ok: true, source }),
      listCandidates: async () => ({ candidates: [], nextCursor: null }),
      pageTranscript: async () => ({ items: [], nextCursor: null, tailCursor: null, hasMore: false, truncated: false }),
      readAfterTranscript: async () => ({ outcome: 'already_current' }),
    };
    const lifecyclePromise = createLiveConfiguredPluginExternalSessionsAdapter({
      agents: [agent()],
      contributionGenerationId: 'registry:g1',
      readAccount,
      readAccountRevision: () => revision,
      subscribeAccountRevision: (listener) => {
        notifyRevision = listener;
        return unsubscribe;
      },
      isCurrent: () => true,
      resolveProviderOps: async () => ops,
    });
    await vi.waitFor(() => expect(readAccount).toHaveBeenCalledOnce());
    revision = 'settings:2';
    (notifyRevision as ((next: string) => void) | null)?.(revision);
    releaseInitialRead();

    const lifecycle = await lifecyclePromise;
    expect(readAccount).toHaveBeenCalledTimes(2);
    expect((await lifecycle.authorService.capabilities()).list).toEqual({ status: 'available' });
    lifecycle.dispose();
    lifecycle.dispose();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('recreates the live adapter from the current account revision after disposal', async () => {
    let revision = 'settings:1';
    const listeners = new Set<(next: string) => void>();
    const followReleases = [vi.fn(async () => undefined), vi.fn(async () => undefined)];
    let followLeaseIndex = 0;
    const followTranscript = vi.fn(async (input: Readonly<{
      options: Readonly<{ signal?: AbortSignal }>;
    }>) => {
      const dispose = followReleases[followLeaseIndex++]!;
      input.options.signal?.addEventListener('abort', () => {
        void dispose();
      }, { once: true });
      return {
        status: 'following' as const,
        startingCursor: revision,
        subscription: { dispose },
      };
    });
    const ops: ExternalSessionProviderOps = {
      validateSource: async ({ source }) => ({ ok: true, source }),
      listCandidates: async () => ({ candidates: [{ remoteSessionId: revision, updatedAtMs: 1 }], nextCursor: null }),
      resolveLinkIdentity: resolveExactLinkIdentity,
      pageTranscript: async () => ({ items: [], nextCursor: null, tailCursor: null, hasMore: false, truncated: false }),
      readAfterTranscript: async () => ({ outcome: 'already_current' }),
    };
    const create = async () => await createLiveConfiguredPluginExternalSessionsAdapter({
      agents: [agent()],
      contributionGenerationId: 'registry:g1',
      readAccount: async () => ({ connectedServicesV2: [] }),
      readAccountRevision: () => revision,
      subscribeAccountRevision: (listener) => {
        listeners.add(listener);
        return () => { listeners.delete(listener); };
      },
      isCurrent: () => true,
      resolveProviderOps: async () => ops,
      followTranscript,
    });

    const first = await create();
    const firstList = await first.authorService.list();
    expect(firstList).toMatchObject({
      items: [{ ref: { remoteSessionId: 'settings:1' } }],
    });
    const firstFollow = await first.authorService.followTranscript(
      firstList.items[0]!.ref,
      {},
      vi.fn(),
    );
    expect(firstFollow.status).toBe('following');
    first.dispose();
    await vi.waitFor(() => expect(followReleases[0]).toHaveBeenCalledOnce());
    expect(listeners).toHaveLength(0);

    revision = 'settings:2';
    const second = await create();
    const secondList = await second.authorService.list();
    expect(secondList).toMatchObject({
      items: [{ ref: { remoteSessionId: 'settings:2' } }],
    });
    const secondFollow = await second.authorService.followTranscript(
      secondList.items[0]!.ref,
      {},
      vi.fn(),
    );
    expect(secondFollow.status).toBe('following');
    expect(listeners).toHaveLength(1);
    second.dispose();
    await vi.waitFor(() => expect(followReleases[1]).toHaveBeenCalledOnce());
    expect(listeners).toHaveLength(0);
  });

  it('rejects noncanonical transcript item identities and source timestamps from author follow events', async () => {
    const invalidItems = [
      { id: ' source-event-1 ', timestampMs: 1 },
      { id: 'source-event-1', timestampMs: 1.5 },
    ] as const;
    const ops: ExternalSessionProviderOps = {
      validateSource: async ({ source }) => ({ ok: true, source }),
      listCandidates: async () => ({
        candidates: [{ remoteSessionId: 'remote-1', updatedAtMs: 1 }],
        nextCursor: null,
      }),
      resolveLinkIdentity: resolveExactLinkIdentity,
      pageTranscript: async () => ({
        items: [], nextCursor: null, tailCursor: null, hasMore: false, truncated: false,
      }),
      readAfterTranscript: async () => ({ outcome: 'already_current' }),
    };

    for (const item of invalidItems) {
      const adapter = await createConfiguredPluginExternalSessionsAdapter({
        agents: [agent()],
        account: { connectedServicesV2: [] },
        basis: { contributionGenerationId: 'registry:g1', accountSettingsRevision: 'account:1' },
        readCurrentBasis: () => ({ contributionGenerationId: 'registry:g1', accountSettingsRevision: 'account:1' }),
        isCurrent: () => true,
        resolveProviderOps: async () => ops,
        followTranscript: async ({ listener }) => {
          await listener({
            kind: 'data',
            items: [{ ...item, kind: 'event', data: { provider: 'source' } }],
            fromCursor: null,
            nextCursor: 'cursor-1',
          } as HostExternalTranscriptFollowEvent);
          return {
            status: 'following' as const,
            startingCursor: 'cursor-1',
            subscription: { dispose: async () => undefined },
          };
        },
      });
      const listed = await adapter.authorService.list();

      await expect(adapter.authorService.followTranscript(
        listed.items[0]!.ref,
        {},
        async () => undefined,
      )).rejects.toMatchObject({ code: 'plugin_external_follow_event_invalid' });
    }
  });
});
