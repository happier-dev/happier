import { afterEach, expect, it, vi } from 'vitest';
import { act, createMachineFixture, renderScreen, renderHook, standardCleanup } from '@/dev/testkit';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { createSeededSkillsHome } from '@/dev/testkit/harness/skillsSurfaceHarness';
import { createPromptRegistrySkillFixture } from '@/dev/testkit/harness/promptMachineTransferBoundary';
import { PromptBundleBodyV1Schema, PromptBundleArtifactHeaderV1Schema } from '@happier-dev/protocol/prompts/library/promptBundleSchemas';
import { decodePlainArtifactStoredContent } from '@happier-dev/protocol/storage/artifactStoredContent';
import { MCP_SERVER_CATALOG_ROWS_ROUTE_V1, McpServerCatalogV1Schema,
  McpServerCatalogRowReadResponseV1Schema } from '@happier-dev/protocol/mcp/servers/serverRowsV1';
import { ACP_CATALOG_ROWS_ROUTE_V1, AcpCatalogRecordV1Schema,
  AcpCatalogRowReadResponseV1Schema } from '@happier-dev/protocol/acp/catalog/catalogRowsV1';
import { checkRegistryUpstreamV1, REGISTRY_ACTION_OUTPUT_SCHEMAS_V1, type RegistryContentRefV1,
  type RegistryUpdateCheckResultV1 } from '@happier-dev/protocol/registries';

const navigation = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn() }));
const daemon = vi.hoisted(() => ({ check: null as (() => Promise<RegistryUpdateCheckResultV1>) | null }));
// The daemon is another process. Preserve the real front door, registry host,
// native upstream checker and strict consumer beneath this transport boundary.
vi.mock('@/sync/api/externalActionAccountTransport', async importOriginal => {
  const actual = await importOriginal<typeof import('@/sync/api/externalActionAccountTransport')>();
  return { ...actual, executeOriginalAccountMachineAction: async (...args: Parameters<typeof actual.executeOriginalAccountMachineAction>) =>
    args[0].actionId === 'registries.updates.check' && daemon.check
      ? { ok: true, result: await daemon.check() }
      : actual.executeOriginalAccountMachineAction(...args) };
});
vi.mock(
  'expo-router',
  async () =>
    (await import('@/dev/testkit/mocks/router')).createExpoRouterMock({
      pathname: '/settings/skills/updates',
      router: navigation,
    }).module,
);
vi.mock('react-native', async () =>
  (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock(),
);
vi.mock('react-native-unistyles', async () =>
  (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock(),
);
installDisconnectedServerSocketBoundary();
const { SkillsUpdatesScreen } = await import('./SkillsUpdatesScreen');
const { StoreUpdatesScreen } = await import('@/components/store/updates/StoreUpdatesScreen');
const { InboxArtifactSourceBoundary } = await import('@/hooks/inbox/useInboxArtifactSource');
const { SurfaceStateCard } = await import('@/components/ui/surfaces/SurfaceStateCard');
const { resetPromptLibraryCatalogEngineForTests } =
  await import('@/sync/engine/settings/promptLibraryCatalogEngine');
const { resetPromptLibraryCatalogSnapshotsForTests } =
  await import('@/sync/store/settings/promptLibraryCatalogSnapshot');

afterEach(() => {
  daemon.check = null;
  standardCleanup();
  resetPromptLibraryCatalogEngineForTests();
  resetPromptLibraryCatalogSnapshotsForTests();
  vi.clearAllMocks();
});

const SKILL_MD =
  '---\nname: release-notes\ndescription: Draft release notes from merged pull requests.\n---\n\n# Release notes\n';

it('keeps a partial native inventory distinct from an empty Updates inventory and carries its reason', async () => {
  const home = await createSeededSkillsHome('https://store-updates-incomplete.test', {
    skills: [],
    handleRequest: async path => path === MCP_SERVER_CATALOG_ROWS_ROUTE_V1
      ? Response.json({ status: 'present', revision: 1, content: { t: 'plain', v: {
        v: 1, servers: [{ id: 'unreadable' }], bindings: [],
      } } }) : null,
  });
  try {
    const screen = await renderScreen(<InboxArtifactSourceBoundary><StoreUpdatesScreen /></InboxArtifactSourceBoundary>);
    const { getMcpServerCatalogSnapshot } = await import('@/sync/store/settings/mcpServerCatalogSnapshot');
    await vi.waitFor(() => expect(getMcpServerCatalogSnapshot(home.storage.getState().settingsScope).status).toBe('partial'));
    await vi.waitFor(() => expect(screen.findByTestId('store.updates.loading')).toBeNull());
    expect(screen.findByTestId('store.updates.noSources')).toBeNull();
    expect(screen.findByTestId('store.updates.upToDate')).toBeNull();
    const failure = screen.tree.findAllByType(SurfaceStateCard)
      .find(node => node.props.testID === 'store.updates.inventory.mcpServer');
    expect(failure?.props.diagnosticCode).toContain('invalid-stored-content');
  } finally {
    await standardCleanup();
    await home.dispose();
  }
});

it('runs a finite update check only on presented intent, rejects retained hidden callbacks and preserves unknown freshness after refusal', async () => {
  const home = await createSeededSkillsHome('https://store-updates-demand.test', {
    skills: [{ id: 'release-notes', text: SKILL_MD }],
  });
  const frontDoor = await import('@/sync/ops/actions/frontDoorRuntimeActionExecutor');
  const create = frontDoor.createFrontDoorActionExecute;
  let checks = 0;
  // Observe the actual Action ingress without replacing its admission or Machine transport.
  const observation = vi.spyOn(frontDoor, 'createFrontDoorActionExecute').mockImplementation((...args) => {
    const execute = create(...args);
    return Object.assign((...invocation: Parameters<typeof execute>) => {
      if (invocation[0] === 'registries.updates.check') checks++;
      return execute(...invocation);
    }, { prepare: execute.prepare });
  });
  const { useSkillsLibrary } = await import('@/sync/domains/skills/useSkillsLibrary');
  const { useMountedActionExecution } = await import('@/components/approvals/useMountedActionExecution');
  const { useRegistryUpdateCheck } = await import('@/registries/useRegistryUpdateCheck');
  const { waitForHomeGovernance } = await import('@/dev/testkit/harness/homeGovernanceHarness');
  const hook = await renderHook(({ enabled }: { enabled: boolean }) => {
    const library = useSkillsLibrary();
    const execution = useMountedActionExecution(library.scope);
    return { ...useRegistryUpdateCheck({ scopeKey: JSON.stringify(library.scope), execute: execution.execute,
      isCurrent: execution.isCurrent, retry: library.retry, enabled }), ready: execution.ready, items: library.items };
  }, { initialProps: { enabled: false } });
  try {
    await waitForHomeGovernance(() => expect(hook.getCurrent().ready).toBe(true));
    await waitForHomeGovernance(() => expect(hook.getCurrent().items.some(item => item.skillId === 'release-notes')).toBe(true));
    expect(checks).toBe(0);
    await act(async () => { await hook.getCurrent().checkNow(); });
    expect(checks).toBe(0);
    await hook.rerender({ enabled: true });
    await act(async () => { await hook.getCurrent().checkNow(); });
    expect(checks).toBe(1);
    // This cold Account has no execution Machine. A finite refusal is honest,
    // and must not turn into a current/checked-at result or a background retry.
    expect(hook.getCurrent().check.failed).toBe(true);
    expect(hook.getCurrent().check.checkedAt).toBeNull();
    expect(checks).toBe(1);
    const retained = hook.getCurrent().checkNow;
    await hook.rerender({ enabled: false });
    expect(hook.getCurrent().check.results).toEqual([]);
    expect(hook.getCurrent().check.failed).toBe(false);
    await act(async () => { await retained(); });
    expect(checks).toBe(1);
  } finally { observation.mockRestore(); await hook.unmount(); await home.dispose(); }
});

function githubUpstream(files: readonly Readonly<{ path: string; content: string }>[]) {
  const latest = '2'.repeat(40);
  const upstream = createPromptRegistrySkillFixture({
    sourceId: 'link',
    itemId: 'review',
    title: 'release-notes',
    files,
  });
  if (upstream.item.payload.kind !== 'skill')
    throw new Error('Expected a skill fixture');
  const skill = upstream.item.payload.skill;
  const ref = { ...skill.ref, commit: latest };
  // GitHub is the external boundary: the newer tree and its one file.
  const github = async (request: string) => {
    if (request === 'https://api.github.com/repos/fixture/skills')
      return Response.json({ name: 'skills', default_branch: 'main' });
    if (request.includes('/commits/')) return Response.json({ sha: latest });
    if (request.includes('/git/trees/'))
      return Response.json({
        sha: ref.treeSha,
        tree: [
          { path: 'review', type: 'tree', mode: '040000', sha: ref.treeSha },
          ...skill.files.map((file) => ({
            path: `review/${file.path}`,
            type: 'blob',
            mode: '100644',
            sha: file.blobSha,
            size: file.size,
          })),
        ],
      });
    const file = files.find(file => request.endsWith(`/review/${file.path}`));
    if (file) return new Response(file.content);
    return new Response(null, { status: 404 });
  };
  return { latest, ref, github };
}

async function installStoreUpdateMachine(home: Awaited<ReturnType<typeof createSeededSkillsHome>>) {
  const accountId = home.storage.getState().settingsScope!.accountId;
  // Registry carrier admission needs a qualified Home, unlike local Skill IO.
  // Use the same real admission as createSkillsSurfaceHarness.
  const { adoptHomeProfile, setActiveServerId } = await import('@/sync/domains/server/serverProfiles');
  const origin = home.home.serverUrl;
  const profile = await adoptHomeProfile({ source: 'manual', descriptor: { v: 1,
    homeServerIdentityId: `srv_${new URL(origin).hostname.replaceAll('.', '_')}`, canonicalServerUrl: origin, revision: 1,
    endpoints: [{ kind: 'https', url: origin }] } });
  if (!profile.serverIdentityId) throw new Error('Expected qualified Home');
  await setActiveServerId(profile.id);
  const scope = { serverId: profile.serverIdentityId, accountId };
  home.storage.setState({ settingsScope: scope, profileScope: scope });
  const machine = createMachineFixture({ id: 'complete-inventory', activeAt: Date.now(), metadata: { ...createMachineFixture().metadata!,
    agentInventory: { checkedAt: 1, installedAgentIds: [] } } });
  home.storage.setState({ machines: { [machine.id]: machine }, machineListByServerId: { [scope.serverId]: [machine] },
    machineListStatusByServerId: { [scope.serverId]: 'idle' } });
  home.storage.getState().applyMachines([machine], true, { sourceServerId: scope.serverId, sourceAccountId: scope.accountId });
  const { observeMachinePresenceForTest } = await import('@/dev/testkit/harness/machinePresence');
  observeMachinePresenceForTest(scope, [machine.id]);
  return scope;
}

async function nativeSkillCheck(ref: Extract<RegistryContentRefV1, { kind: 'gitTree' }>, github: (request: string) => Promise<Response>) {
  const { createUiRegistryHttpV1 } = await import('@/registries/registryHttpV1');
  const upstream = await checkRegistryUpstreamV1({ http: createUiRegistryHttpV1(async url => github(String(url))) }, {
    sources: [{ id: 'link', title: 'Fixture skills', format: 'git', kinds: ['skill'], url: 'https://github.com/fixture/skills',
      enabled: true, addedAt: 1, origin: { kind: 'user' }, removable: false }],
    items: [{ key: 'release-notes', provenance: { sourceId: 'link', format: 'git', sourceUrl: 'https://github.com/fixture/skills',
      itemId: 'review', importedAt: 1, ref } }],
  });
  return REGISTRY_ACTION_OUTPUT_SCHEMAS_V1['registries.updates.check'].parse({ checkedAt: Date.now(),
    results: [{ kind: 'skill', key: 'release-notes', upstream: upstream.get('release-notes') }] });
}

async function emptyUpdateCatalogs(path: string): Promise<Response | null> {
  if (path === MCP_SERVER_CATALOG_ROWS_ROUTE_V1) return Response.json(McpServerCatalogRowReadResponseV1Schema.parse({
    status: 'present', revision: 1, content: { t: 'plain', v: McpServerCatalogV1Schema.parse({ v: 1, servers: [], bindings: [] }) },
  }));
  if (path === ACP_CATALOG_ROWS_ROUTE_V1) return Response.json(AcpCatalogRowReadResponseV1Schema.parse({
    status: 'present', revision: 1, content: { t: 'plain', v: AcpCatalogRecordV1Schema.parse({ v: 1, definitions: [] }) },
  }));
  return null;
}

it('retains the finite reply time for partial coverage without claiming a complete check', async () => {
  const home = await createSeededSkillsHome('https://store-updates-partial-time.test', {
    handleRequest: emptyUpdateCatalogs, skills: [{ id: 'release-notes', text: SKILL_MD }],
  });
  try {
    await installStoreUpdateMachine(home);
    daemon.check = async () => REGISTRY_ACTION_OUTPUT_SCHEMAS_V1['registries.updates.check'].parse({ checkedAt: 42,
      results: [{ kind: 'skill', key: 'release-notes', upstream: { state: 'unchecked', reason: { state: 'unreachable' } } }] });
    const { useRegistryUpdateCheck } = await import('@/registries/useRegistryUpdateCheck');
    const { useMountedActionExecution } = await import('@/components/approvals/useMountedActionExecution');
    const hook = await renderHook(() => {
      const scope = home.storage.getState().settingsScope;
      const execution = useMountedActionExecution(scope);
      return { ...useRegistryUpdateCheck({ scopeKey: JSON.stringify(scope), execute: execution.execute,
        isCurrent: execution.isCurrent, retry: () => {} }), ready: execution.ready };
    });
    await vi.waitFor(() => expect(hook.getCurrent().ready).toBe(true));
    await act(async () => { await hook.getCurrent().checkNow(); });
    expect(hook.getCurrent().check).toMatchObject({ failed: true, checkedAt: null, attemptedAt: 42 });
  } finally { await standardCleanup(); await home.dispose(); }
});

it('withdraws the current empty state when a new tracked native item was not part of the completed check', async () => {
  const { ref, github } = githubUpstream([{ path: 'SKILL.md', content: SKILL_MD }]);
  const home = await createSeededSkillsHome('https://store-updates-new-tracked.test', {
    handleExternalRequest: github,
    handleRequest: emptyUpdateCatalogs,
    skills: [{ id: 'release-notes', text: SKILL_MD, unmodified: true, header: { skillLock: {
      provenance: { kind: 'link', url: 'https://github.com/fixture/skills', ref },
      updatePolicy: 'manual', upstream: { state: 'current' },
    } } }],
  });
  try {
    const scope = await installStoreUpdateMachine(home);
    daemon.check = () => nativeSkillCheck(ref, github);
    const screen = await renderScreen(<InboxArtifactSourceBoundary><StoreUpdatesScreen /></InboxArtifactSourceBoundary>);
    await vi.waitFor(() => expect(screen.findByTestId('store.updates.notChecked'), JSON.stringify(screen.tree.findAllByType(SurfaceStateCard)
      .map(node => ({ id: node.props.testID, reason: node.props.reason, code: node.props.diagnosticCode })))).not.toBeNull());
    await act(async () => { await screen.pressByTestId('store.updates.checkNow'); });
    await vi.waitFor(() => {
      const failed = screen.tree.findAllByType(SurfaceStateCard).find(node => node.props.testID === 'store.updates.checkFailed');
      expect(failed?.props.diagnosticCode).toBeUndefined();
      expect(screen.findByTestId('store.updates.upToDate')).not.toBeNull();
    });
    const { applyMcpServerCatalogSnapshot } = await import('@/sync/store/settings/mcpServerCatalogSnapshot');
    const { McpServerCatalogEntryV1Schema } = await import('@happier-dev/protocol/mcp/servers/settingsV1');
    await act(async () => { applyMcpServerCatalogSnapshot(scope, { status: 'ready', revision: 2, authority: 'active', diagnostics: [],
      catalog: { v: 1, bindings: [], servers: [McpServerCatalogEntryV1Schema.parse({
        id: 'newly-added', name: 'new-docs', title: 'New docs', transport: 'stdio', stdio: { command: 'docs', args: [] }, env: {}, createdAt: 1, updatedAt: 1,
        origin: { kind: 'registry', provenance: { sourceId: 'docs', sourceUrl: 'https://github.com/fixture/docs', format: 'git',
          itemId: 'docs', importedAt: 1, ref: { kind: 'version', version: '1' } }, upstream: { state: 'current' } },
      })] } }, true); });
    expect(screen.findByTestId('store.updates.upToDate')).toBeNull();
    expect(screen.findByTestId('store.updates.notChecked')).not.toBeNull();
  } finally {
    await standardCleanup();
    await home.dispose();
  }
});

it('takes a waiting update the person never changed: View changes shows both sides, Update stores the source version and leaves a receipt', async () => {
  const mineText = `${SKILL_MD}\nLead with user-visible changes.\n`;
  const upstreamText = `${SKILL_MD}\nGroup changes by area.\n`;
  const { latest, ref, github } = githubUpstream([{ path: 'SKILL.md', content: upstreamText }]);
  const home = await createSeededSkillsHome(
    'https://skills-updates-ready.test',
    {
      handleExternalRequest: github,
      handleRequest: emptyUpdateCatalogs,
      skills: [
        {
          id: 'release-notes',
          text: mineText,
          unmodified: true,
          header: {
            skillLock: {
              provenance: {
                kind: 'link',
                url: 'https://github.com/fixture/skills',
                ref: {
                  ...ref,
                  commit: '1'.repeat(40),
                  treeSha: '4'.repeat(40),
                },
              },
              updatePolicy: 'manual',
              upstream: { state: 'update_available', latest: ref },
            },
          },
        },
      ],
    },
  );
  try {
    await installStoreUpdateMachine(home);
    daemon.check = () => nativeSkillCheck({ ...ref, commit: '1'.repeat(40), treeSha: '4'.repeat(40) }, github);
    const screen = await renderScreen(<SkillsUpdatesScreen />);
    const store = await renderScreen(<InboxArtifactSourceBoundary><StoreUpdatesScreen /></InboxArtifactSourceBoundary>);
    await vi.waitFor(() => expect(store.findByTestId('store.updates.section.skill')).not.toBeNull());
    await act(async () => { await store.pressByTestId('store.updates.checkNow'); });
    await vi.waitFor(() => {
      const failed = store.tree.findAllByType(SurfaceStateCard).find(node => node.props.testID === 'store.updates.checkFailed');
      expect(failed?.props.diagnosticCode).toBeUndefined();
      expect(store.getTextContent()).toContain('Checked');
    });
    expect(store.findByTestId('store.updates.checkFailed')).toBeNull();
    await vi.waitFor(
      () =>
        expect(
          screen.findByTestId('skills.updates.ready.release-notes'),
        ).not.toBeNull(),
      { timeout: 10_000 },
    );
    expect(screen.findByTestId('skills.updates.upToDate')).toBeNull();
    await act(async () =>
      screen.pressByTestId('skills.updates.ready.release-notes.view'),
    );
    await vi.waitFor(() => {
      const changes = screen.findByTestId('skills.updates.ready.release-notes.changes');
      expect(changes).not.toBeNull();
      const text = changes!.findAll(node => typeof node.type === 'string')
        .flatMap(node => node.children.filter(child => typeof child === 'string')).join('\n');
      const yoursIndex = text.indexOf('Yours');
      const theirsIndex = text.indexOf('Theirs');
      expect(yoursIndex).toBeGreaterThanOrEqual(0);
      expect(theirsIndex).toBeGreaterThan(yoursIndex);
      const yours = text.slice(yoursIndex, theirsIndex);
      const theirs = text.slice(theirsIndex);
      expect(yours).toContain('Lead with user-visible changes.');
      expect(yours).not.toContain('Group changes by area.');
      expect(theirs).toContain('Group changes by area.');
      expect(theirs).not.toContain('Lead with user-visible changes.');
    });
    await act(async () =>
      screen.pressByTestId('skills.updates.ready.release-notes.update'),
    );
    await vi.waitFor(
      () =>
        expect(home.boundary.readPlainBody('release-notes')).toContain(
          Buffer.from(upstreamText).toString('base64'),
        ),
      { timeout: 10_000 },
    );
    // The receipt stays on the page with the version taken; the actions are gone.
    await vi.waitFor(() =>
      expect(
        screen.findByTestId('skills.updates.ready.release-notes.update'),
      ).toBeNull(),
    );
    expect(
      screen.findByTestId('skills.updates.ready.release-notes'),
    ).not.toBeNull();
    expect(screen.getTextContent()).toContain(latest.slice(0, 7));
    // With only the receipt left, the group says what happened instead of promising a safe update.
    await vi.waitFor(() => expect(screen.getTextContent()).not.toContain('Ready to update'));
    expect(screen.getTextContent()).toContain('Updated');
    // The Store retained a finite update observation before Apply. The native
    // library now owns version 2/current, so that observation cannot revive it.
    await vi.waitFor(() => expect(store.findByTestId('store.updates.section.skill')).toBeNull());
  } finally {
    await standardCleanup();
    await home.dispose();
  }
});

it('retains per-file Mine/Theirs choices and local content after failed Apply, then retries against the reviewed revision', async () => {
  const mineText = `${SKILL_MD}\nKeep my release process.\n`;
  const upstreamText = `${SKILL_MD}\nUse the upstream release process.\n`;
  const referenceText = 'New source reference material.\n';
  const { latest, ref, github } = githubUpstream([
    { path: 'SKILL.md', content: upstreamText },
    { path: 'reference.md', content: referenceText },
  ]);
  let refuseApply = true;
  const home = await createSeededSkillsHome('https://skills-updates-choice-retry.test', {
    handleExternalRequest: github,
    // Return a real non-retryable Home refusal; transient transport errors are retried by its API owner.
    handleRequest: async (path, init) => refuseApply && path === '/v1/artifacts/release-notes' && init?.method === 'POST'
      ? Response.json({ error: 'permission_denied' }, { status: 403 }) : null,
    skills: [{ id: 'release-notes', text: mineText,
      files: [{ path: 'reference.md', content: 'My older source reference.\n' }], header: { skillLock: {
      provenance: { kind: 'link', url: 'https://github.com/fixture/skills',
        ref: { ...ref, commit: '1'.repeat(40), treeSha: '4'.repeat(40) } },
      importedDigest: 'sha256:' + '0'.repeat(64), updatePolicy: 'manual',
      upstream: { state: 'update_available', latest: ref },
    } } }],
  });
  try {
    const screen = await renderScreen(<SkillsUpdatesScreen />);
    const md = 'skills.updates.choice.release-notes.SKILL.md';
    const reference = 'skills.updates.choice.release-notes.reference.md';
    const apply = 'skills.updates.choice.release-notes.apply';
    await vi.waitFor(() => expect(screen.findByTestId(`${md}:mine`)).not.toBeNull(), { timeout: 10_000 });
    expect(screen.findByTestId(`${md}:mine`)?.props.accessibilityState?.checked).toBe(true);
    expect(screen.findByTestId(`${reference}:mine`)?.props.accessibilityState?.checked).toBe(true);
    await act(async () => screen.pressByTestId(`${md}:theirs`));
    await act(async () => screen.pressByTestId(`${md}:mine`));
    await act(async () => screen.pressByTestId(`${reference}:theirs`));
    const before = home.boundary.read('release-notes');
    const beforeBodyVersion = before?.bodyVersion;
    if (beforeBodyVersion === undefined) throw new Error('Expected a stored skill body revision');
    await act(async () => screen.pressByTestId(apply));
    await vi.waitFor(() => expect(screen.findAllByType(SurfaceStateCard).some(node => node.props.kind === 'error')).toBe(true), { timeout: 10_000 });
    expect(home.boundary.read('release-notes')).toEqual(before);
    expect(screen.findByTestId(`${md}:mine`)?.props.accessibilityState?.checked).toBe(true);
    expect(screen.findByTestId(`${reference}:theirs`)?.props.accessibilityState?.checked).toBe(true);
    refuseApply = false;
    await act(async () => screen.pressByTestId(apply));
    await vi.waitFor(() => expect(home.boundary.read('release-notes')?.bodyVersion).toBeGreaterThan(beforeBodyVersion), { timeout: 10_000 });
    const body = PromptBundleBodyV1Schema.parse(JSON.parse(home.boundary.readPlainBody('release-notes')!));
    expect(Object.fromEntries(body.entries.map(entry => [entry.path, Buffer.from(entry.contentBase64, 'base64').toString('utf8')]))).toEqual({
      'SKILL.md': mineText, 'reference.md': referenceText,
    });
    const header = PromptBundleArtifactHeaderV1Schema.parse(decodePlainArtifactStoredContent(home.boundary.read('release-notes')!.header));
    expect(header.skillLock).toMatchObject({ provenance: { kind: 'link', ref: { commit: latest } }, upstream: { state: 'current' } });
    await vi.waitFor(() => expect(screen.findByTestId(apply)).toBeNull());
  } finally {
    await standardCleanup();
    await home.dispose();
  }
});

it('says when no skill comes from a source that can update, and offers no check that means nothing', async () => {
  const home = await createSeededSkillsHome(
    'https://skills-updates-unsourced.test',
    { skills: [{ id: 'meeting-notes' }] },
  );
  try {
    const screen = await renderScreen(<SkillsUpdatesScreen />);
    await vi.waitFor(
      () =>
        expect(screen.findByTestId('skills.updates.upToDate')).not.toBeNull(),
      { timeout: 10_000 },
    );
    expect(screen.getTextContent()).toContain(
      'None of your skills come from a source that updates',
    );
    expect(screen.getTextContent()).not.toContain('Everything is up to date');
    expect(screen.findByTestId('skills.updates.checkNow')?.props.disabled).toBe(
      true,
    );
  } finally {
    await standardCleanup();
    await home.dispose();
  }
});
