import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

test('authors independently bound UsageQuery fields and subscribes to their admitted host read', async () => {
  const { usageQueryAuthoring: example } = await import('../dist/daemon.js');
  assert.ok(example, 'the public author build must expose the UsageQuery consumer');
  const { parsePluginManifest } = await import('@happier-dev/plugin-sdk/manifest');
  const { createWidgetActionInputResolverV1 } = await import('@happier-dev/protocol/widgets/widgetActionInputResolverV1');
  const { createPluginUiTestkit, createSurfaceContextFixture } = await import('@happier-dev/plugin-sdk/testing');
  const parsed = parsePluginManifest(example.manifest);
  assert.equal(parsed.ok, true, JSON.stringify(parsed));
  const descriptor = parsed.manifest.contributes.ui.views[0];
  let scope = { agents: [['claude']], machines: [['machine-one']], projects: [['project-one']],
    sources: [['runtime']], session: [null], costBasis: ['reported'] };
  const resolver = createWidgetActionInputResolverV1({
    readDescriptor: async () => descriptor,
    readContext: async () => scope,
    readViewerValues: async () => ({ values: {} }),
    validateValue: async () => ({ status: 'valid' }),
    resolveOptions: async () => { throw new Error('The public host type needs no plugin options Resource'); },
  });
  const request = { ref: { surface: { serverId: 'home', accountId: 'account', owner: { kind: 'home' } }, instanceId: 'usage' },
    instance: { v: 1, id: 'usage', definition: { kind: 'installed', surface: { pluginId: example.manifest.id, localId: descriptor.id } },
      bindings: example.bindings }, context: {} };
  const first = await resolver.resolve(request);
  assert.equal(first.status, 'ready', JSON.stringify(first));
  scope = { agents: [['codex']], machines: [['machine-two']], projects: [['project-two']],
    sources: [['native']], session: ['session-two'], costBasis: ['estimated'] };
  const second = await resolver.resolve(request);
  assert.equal(second.status, 'ready', JSON.stringify(second));
  assert.deepEqual(second.input.query, { period: { startMs: 1790812800000, endMs: 1790899200000 },
    ...Object.fromEntries(Object.entries(scope).map(([key, values]) => [key, values[0]])), metric: 'cost', breakdown: ['model'] });
  assert.deepEqual(second.input.query.period, first.input.query.period);
  for (const path of ['query.metric', 'query.breakdown']) {
    const followedPresentation = await resolver.resolve({ ...request, instance: { ...request.instance,
      bindings: { ...example.bindings, [path]: { kind: 'context', slot: 'costBasis' } } } });
    assert.equal(followedPresentation.status, 'invalid');
    assert.ok(followedPresentation.fields.some(field => field.path === path
      && field.reasonCode === 'widget_context_binding_forbidden'));
  }
  const forgedAuthority = await resolver.resolve({ ...request, instance: { ...request.instance,
    bindings: { ...example.bindings, query: { kind: 'value', value: { accountId: 'other-account' } } } } });
  assert.equal(forgedAuthority.status, 'invalid');
  assert.ok(forgedAuthority.fields.some(field => field.path === 'query'));
  const digest = 'sha256:' + 'a'.repeat(64);
  const revisedDigest = 'sha256:' + 'b'.repeat(64);
  const expectedReference = { hostRead: 'usage.query', input: { queries: [second.input.query] } };
  const revisions = [];
  let watchSignal;
  const fixture = await createPluginUiTestkit({
    identity: { instanceId: 'usage-author', mountNonce: 'usage-author-mount' },
    authorPlugin: { id: example.manifest.id, version: example.manifest.version },
    surface: { kind: 'author-surface' }, surfaceContext: createSurfaceContextFixture(),
    adapter: { async mount() { return { async snapshot() { return { revision: 1, nodes: [] }; },
      async update() {}, async invoke() {}, async dispose() {} }; } },
    handlers: { watchResource: ({ resource, signal }) => {
      assert.deepEqual(resource, expectedReference);
      watchSignal = signal;
      return { digest };
    } },
  });
  try {
    const subscription = await example.watchUsage(fixture.context.hostApi, second.input.query,
      event => revisions.push(event));
    assert.equal(subscription.admittedDigest, digest);
    fixture.invalidateResource(expectedReference, revisedDigest);
    assert.deepEqual(revisions.map(event => event.digest), [revisedDigest]);
    await fixture.retire('account-access-lost');
    assert.equal(watchSignal.aborted, true);
    assert.throws(() => fixture.invalidateResource(expectedReference, digest), { code: 'stale_surface' });
    assert.deepEqual(revisions.map(event => event.digest), [revisedDigest]);
    await assert.rejects(example.watchUsage(fixture.context.hostApi, second.input.query, () => {}),
      { code: 'ui_host_unavailable' });
    subscription.dispose();
  } finally { await fixture.dispose(); }
});

test('invokes the public Coach Resource and Action and refuses denied or retired invocations', async () => {
  const { usageCoachAuthoring: example } = await import('../dist/daemon.js');
  assert.ok(example, 'the public author build must expose the Coach consumer');
  const { createPluginTestkit } = await import('@happier-dev/plugin-sdk/testing');
  const testkit = await createPluginTestkit({ manifest: example.manifest, module: example });
  const deniedCaller = await createPluginTestkit({
    manifest: { ...example.manifest, id: 'acme.coach-reader', contributes: { actions: [{
      ...example.manifest.contributes.actions[0], id: 'inspect',
    }] } }, actionTargets: [testkit],
    module: { activate(api) { api.actions.register('inspect', async (_input, context) =>
      context.services.actions.execute(example.inspectAction, {})); } },
  });
  try {
    const resource = testkit.registration('resources', 'findings');
    assert.ok(resource);
    const controller = new AbortController();
    assert.deepEqual(JSON.parse(await resource.read({ signal: controller.signal })), example.finding);
    assert.deepEqual(await testkit.invokeAction(example.inspectAction.localId, {}), example.finding);
    await assert.rejects(deniedCaller.invokeAction('inspect', {}), { code: 'plugin_action_unavailable' });
    controller.abort();
    assert.throws(() => resource.read({ signal: controller.signal }), { name: 'AbortError' });
    await testkit.dispose();
    await assert.rejects(testkit.invokeAction(example.inspectAction.localId, {}), { code: 'plugin_testkit_disposed' });
  } finally { await deniedCaller.dispose(); await testkit.dispose(); }
});

test('retains the portable production reference package contract', async () => {
  const { artifactHtmlBundleFromBodyV1 } = await import('@happier-dev/plugin-sdk/ui');
  const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  // This is a code-defined package. The canonical author build evaluates its
  // `definePlugin(...)` entry and materializes the generated cold manifest;
  // authors still never maintain that manifest as a second source owner.
  let builtManifest = null;
  try {
    builtManifest = JSON.parse(await readFile(
      new URL('../.happier-plugin/plugin.json', import.meta.url),
      'utf8',
    ));
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  const module = await import('../dist/daemon.js');
  const manifest = module.manifest;
  if (builtManifest !== null) {
    assert.equal(builtManifest.id, manifest.id);
    assert.equal(builtManifest.entrypoints.daemon, './dist/daemon.js');
  }
  const uiArtifactsManifest = JSON.parse(await readFile(
    new URL('../dist/happier-plugin-ui/ui-artifacts.json', import.meta.url),
    'utf8',
  ));
  const hostedSurface = await readFile(new URL('../ui/reviewPanel.web.tsx', import.meta.url), 'utf8');

  assert.ok(packageJson.dependencies['@happier-dev/plugin-ui']);
  assert.ok(packageJson.files.includes('resources'));
  assert.equal(typeof module.activate, 'function');
  assert.equal(manifest.id, 'examples.public-sdk-review-assistant');
  assert.deepEqual(manifest.contributes.resources, [
    {
      id: 'review-guide',
      source: 'packaged',
      kind: 'template',
      path: 'resources/review-guide.md',
      contentType: 'text/markdown',
    },
    {
      id: 'agent-context-companion-guide',
      source: 'packaged',
      kind: 'template',
      path: 'resources/agent-context-companion-guide.md',
      contentType: 'text/markdown',
    },
    {
      id: 'review-session-status',
      source: 'dynamic',
      kind: 'config',
      contentType: 'text/plain',
      scope: 'session',
      hostAccess: ['review-resource-account'],
      maxBytes: 8192,
    },
    {
      id: 'project-companion-dashboard-document',
      source: 'dynamic',
      kind: 'config',
      contentType: 'application/vnd.happier.declarative-document+json;version=1',
      scope: 'session',
      hostAccess: ['review-resource-account'],
      maxBytes: 8192,
    },
  ]);
  const projectCompanionDashboard = manifest.contributes.ui.views.find(
    (view) => view.id === 'project-companion-dashboard',
  );
  assert.deepEqual(
    manifest.contributes.ui.views.filter((view) => view.id.endsWith('-hosted-html')),
    [
      {
        id: 'review-services-hosted-html',
        container: 'servicesPanel',
        target: { kind: 'services' },
        renderer: 'review-services-hosted-html-renderer',
        title: 'Review service status',
      },
      {
        id: 'review-project-hosted-html',
        container: 'rightSidebarTab',
        target: { kind: 'project' },
        renderer: 'review-project-hosted-html-renderer',
        title: 'Review project status',
      },
    ],
  );
  assert.deepEqual(
    manifest.contributes.ui.renderers.filter((renderer) => renderer.id.endsWith('-hosted-html-renderer')),
    [
      {
        id: 'review-services-hosted-html-renderer',
        kind: 'hostedHtml',
        source: artifactHtmlBundleFromBodyV1('<main><h1>Review service</h1><p>Ready for review.</p></main>'),
      },
      {
        id: 'review-project-hosted-html-renderer',
        kind: 'hostedHtml',
        source: artifactHtmlBundleFromBodyV1('<main><h1>Project review</h1><p>Ready for review.</p></main>'),
      },
    ],
  );
  assert.deepEqual(
    uiArtifactsManifest.entries
      .map((entry) => entry.contributionId)
      .filter((contributionId) => contributionId?.endsWith('-hosted-html-renderer')),
    [],
  );
  assert.deepEqual(
    manifest.contributes.ui.views
      .filter((view) => view.id.startsWith('public-slot-coverage-'))
      .map(({ container, target }) => ({ container, target })),
    [
      { container: 'rightSidebarTab', target: { kind: 'project' } },
      { container: 'rightPane', target: { kind: 'project' } },
      { container: 'detailsTab', target: { kind: 'project' } },
      { container: 'detailsPane', target: { kind: 'session' } },
      { container: 'detailsPane', target: { kind: 'project' } },
    ],
  );
  assert.deepEqual(
    manifest.contributes.ui.views
      .filter((view) => view.container === 'sessionSubagentLaunch' || view.container === 'sessionSubagentDetails')
      .map(({ id, container, target }) => ({ id, container, target })),
    [
      {
        id: 'review-subagent-launch',
        container: 'sessionSubagentLaunch',
        target: { kind: 'session' },
      },
      {
        id: 'review-subagent-details',
        container: 'sessionSubagentDetails',
        target: { kind: 'session' },
      },
    ],
  );
  // The embedded Session widget emits an ordinary `ui.views` inline
  // contribution: a stable qualified surface identity plus the declared
  // renderer chain, with no destination, instance policy or placement.
  assert.deepEqual(
    manifest.contributes.ui.views.filter((view) => view.container === 'widget'),
    [
      {
        id: 'review-status-widget',
        container: 'widget',
        target: { kind: 'session' },
        renderer: 'review-native',
        fallbackRenderers: ['review-web'],
        title: 'Review status',
      },
    ],
  );
  // The widget's renderer chain keeps the trusted installed Host API. Both
  // members require `openSurface` and `publishCurrentUiContext`, which the
  // closed caller-authored HTML ceiling (`context | watchContext |
  // readResource | watchResource | executeAction | notify`) forbids. An
  // installed external plugin therefore keeps exactly the same public
  // ABI/capabilities as a built-in; caller HTML restrictions must not apply.
  for (const rendererId of ['review-native', 'review-web']) {
    const renderer = manifest.contributes.ui.renderers.find((entry) => entry.id === rendererId);
    assert.ok(renderer, `installed widget renderer ${rendererId} must be declared`);
    assert.ok(
      renderer.requiredHostMethods.includes('openSurface')
        && renderer.requiredHostMethods.includes('publishCurrentUiContext'),
      `installed widget renderer ${rendererId} must keep methods outside the caller ceiling`,
    );
    assert.ok(
      renderer.requiredHostMethods.includes('executeAction')
        && renderer.requiredHostMethods.includes('readResource')
        && renderer.requiredHostMethods.includes('watchResource'),
      `installed widget renderer ${rendererId} must keep the safe Action/Resource methods`,
    );
  }
  // The widget's safe public Action/tool capability: one safe daemon Action
  // plus the agent/mcp tool that invokes it. The widget calls it through
  // `Action.Execute` with the Session-scoped summary as input.
  const reviewSummary = manifest.contributes.actions.find((action) => action.id === 'review-summary');
  assert.deepEqual(
    {
      id: reviewSummary.id,
      danger: reviewSummary.danger ?? reviewSummary.dangerLevel,
      surfaces: reviewSummary.surfaces,
      target: reviewSummary.execution.target,
      scopes: reviewSummary.scopes,
    },
    {
      id: 'review-summary',
      danger: 'safe',
      surfaces: ['cli', 'agent', 'ui'],
      target: 'daemon',
      scopes: ['global'],
    },
  );
  const reviewSummaryTool = manifest.contributes.tools.find((tool) => tool.id === 'review-summary-tool');
  assert.deepEqual(
    { surfaces: reviewSummaryTool.surfaces, action: reviewSummaryTool.action },
    { surfaces: ['agent', 'mcp'], action: 'review-summary' },
  );
  const nativeSurface = await readFile(new URL('../ui/reviewPanel.native.tsx', import.meta.url), 'utf8');
  assert.match(nativeSurface, /readSessionWidgetMount/u);
  assert.match(nativeSurface, /readReviewWidgetView\(context\.launchInput\)/u);
  assert.match(nativeSurface, /useLivePluginResource\('review-session-status'\)/u);
  assert.match(nativeSurface, /Action\.Execute[\s\S]*?action="review-summary"/u);
  assert.match(hostedSurface, /mount\.kind === 'embedded' && mount\.role === 'widget'/u);
  const reviewAgent = manifest.contributes.agents.find((agent) => agent.id === 'review-agent');
  assert.deepEqual(
    reviewAgent.ui.components.slots.map(({ slot, surfaceId }) => ({ slot, surfaceId })),
    [
      { slot: 'sessionSubagents.launchCards', surfaceId: 'review-subagent-launch' },
      { slot: 'sessionSubagents.teammateDetailsTab', surfaceId: 'review-subagent-details' },
    ],
  );
  assert.deepEqual(manifest.contributes.ui.translations[0].messages, {
    'review.subagents.launch.title': 'Launch review teammate',
    'review.subagents.launch.subtitle': 'Start a focused teammate in this review Session.',
  });
  assert.deepEqual(manifest.contributes.sessionInfoSections, [{
    id: 'project-companion-status',
    resourceId: 'project-companion-dashboard-document',
    order: 40,
    actions: ['open-review-status'],
  }]);
  assert.deepEqual(projectCompanionDashboard, {
    id: 'project-companion-dashboard',
    container: 'rightPane',
    target: { kind: 'session' },
    renderer: 'project-companion-dashboard-renderer',
    title: 'Project Companion',
    instancePolicy: 'singleton',
  });
  const projectCompanionDashboardRenderer = manifest.contributes.ui.renderers.find(
    (renderer) => renderer.id === 'project-companion-dashboard-renderer',
  );
  assert.deepEqual(projectCompanionDashboardRenderer, {
    id: 'project-companion-dashboard-renderer',
    kind: 'declarative',
    root: {
      kind: 'group',
      title: 'Project Companion',
      description: 'Live review status for the current Session.',
      children: [{
        kind: 'status',
        label: 'Review status',
        value: 'Waiting for the current review status.',
      }],
    },
    documentSource: {
      kind: 'resource',
      resourceId: 'project-companion-dashboard-document',
    },
  });
  const openProjectCompanionDashboard = manifest.contributes.sessionHeaderActions?.find(
    (action) => action.id === 'open-project-companion-dashboard',
  );
  assert.deepEqual(openProjectCompanionDashboard, {
    id: 'open-project-companion-dashboard',
    title: 'Open Project Companion',
    command: {
      kind: 'openSurface',
      destination: 'project-companion-dashboard',
    },
  });
  const projectCompanionActivity = manifest.contributes.ui.views.find(
    (view) => view.id === 'project-companion-activity-log',
  );
  assert.deepEqual(projectCompanionActivity, {
    id: 'project-companion-activity-log',
    container: 'bottomPane',
    target: { kind: 'session' },
    renderer: 'review-native',
    fallbackRenderers: ['review-web'],
    title: 'Project Companion activity',
    instancePolicy: 'singleton',
  });
  const projectCompanionProjectActivity = manifest.contributes.ui.views.find(
    (view) => view.id === 'project-companion-project-activity-log',
  );
  assert.deepEqual(projectCompanionProjectActivity, {
    id: 'project-companion-project-activity-log',
    container: 'bottomPane',
    target: { kind: 'project' },
    renderer: 'review-native',
    fallbackRenderers: ['review-web'],
    title: 'Project Companion activity',
    instancePolicy: 'singleton',
  });
  const openProjectCompanionActivity = manifest.contributes.sessionHeaderActions?.find(
    (action) => action.id === 'open-project-companion-activity',
  );
  assert.deepEqual(openProjectCompanionActivity, {
    id: 'open-project-companion-activity',
    title: 'Open Project Companion activity',
    command: {
      kind: 'openSurface',
      destination: 'project-companion-activity-log',
    },
  });
  // The packed author toolchain must accept the real Workflow authoring scope
  // on both scoped Composer families, and emit it unchanged into the manifest.
  assert.deepEqual(
    manifest.contributes.composerControls.map(({ id, scopes }) => ({ id, scopes })),
    [{ id: 'add-review-evidence', scopes: ['workflowAuthoring'] }],
  );
  assert.deepEqual(
    manifest.contributes.composerRegions.map(({ id, scopes }) => ({ id, scopes })),
    [{ id: 'review-context', scopes: ['workflowAuthoring'] }],
  );
  assert.match(hostedSurface, /readResource\(\s*'review-guide'/u);
  assert.doesNotMatch(hostedSurface, /(?:window\.parent|location\.(?:search|hash)|URLSearchParams)/u);
  assert.match(
    hostedSurface,
    /watchContext\(\(surface\) => applyContext\(root, surface\), \{ signal: context\.signal \}\)/u,
  );
  assert.match(
    hostedSurface,
    /host\.executeAction\([\s\S]*?signal === undefined \? undefined : \{ signal \}/u,
  );
  assert.match(
    hostedSurface,
    /summarizeReview\(\s*context\.hostApi,\s*'The review is ready\. Follow-up is needed\.',\s*context\.signal,?\s*\)/u,
  );
});
