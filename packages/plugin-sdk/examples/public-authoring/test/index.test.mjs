import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

test('retains the portable production reference package contract', async () => {
  const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  // This is a code-defined package. The canonical author build evaluates its
  // `definePlugin(...)` entry and emits the staged cold manifest only for the
  // package artifact; a handwritten source manifest would be a second owner.
  await assert.rejects(
    () => readFile(new URL('../.happier-plugin/plugin.json', import.meta.url), 'utf8'),
    { code: 'ENOENT' },
  );
  const module = await import('../dist/daemon.js');
  const manifest = module.manifest;
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
