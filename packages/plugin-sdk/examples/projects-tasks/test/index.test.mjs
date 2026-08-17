import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

async function read(relativePath) {
  return await readFile(new URL(relativePath, import.meta.url), 'utf8');
}

test('declares one public-only Projects and Tasks direct-Data surface', async () => {
  const packageJson = JSON.parse(await read('../package.json'));
  const manifest = JSON.parse(await read('../.happier-plugin/plugin.json'));
  const collections = await read('../src/collections.ts');
  const surface = await read('../ui/panel.native.tsx');

  assert.equal(packageJson.name, '@example/happier-projects-tasks');
  assert.deepEqual(Object.keys(packageJson.dependencies).sort(), [
    '@happier-dev/plugin-sdk',
    '@happier-dev/plugin-ui',
    'react',
    'react-dom',
    'react-native',
    'react-native-web',
  ]);
  assert.equal(manifest.id, 'examples.projects-tasks');

  const view = manifest.contributes.ui.views.find((candidate) => candidate.id === 'projects-and-tasks');
  assert.deepEqual({
    renderer: view.renderer,
    fallbackRenderers: view.fallbackRenderers,
  }, {
    renderer: 'projects-tasks-native',
    fallbackRenderers: ['projects-tasks-declarative'],
  });
  const declarativeRenderer = manifest.contributes.ui.renderers
    .find((candidate) => candidate.id === 'projects-tasks-declarative');
  assert.deepEqual(declarativeRenderer, {
    id: 'projects-tasks-declarative',
    kind: 'declarative',
    root: {
      kind: 'collectionList',
      source: {
        collectionId: 'tasks',
        uiQueryId: 'openByProject',
        parameters: { projectId: 'project-a' },
      },
      projection: {
        titleField: { field: 'title', kind: 'string' },
        detailField: { field: 'dueAt', kind: 'instant' },
        statusField: { field: 'status', kind: 'string' },
      },
    },
  });
  assert.equal(manifest.contributes.ui.renderers
    .some((candidate) => candidate.id === 'projects-tasks-unavailable'), false);

  const tasks = manifest.contributes.accountCollections.find((collection) => collection.id === 'tasks');
  assert.deepEqual({
    schemaProperties: Object.keys(tasks.schema.properties).sort(),
    required: tasks.schema.required,
    serverReadable: tasks.serverReadable,
    indexes: tasks.indexes,
    uiQueries: tasks.uiQueries,
    relations: tasks.relations,
  }, {
    schemaProperties: ['dueAt', 'id', 'projectId', 'status', 'title'],
    required: ['id', 'title', 'status', 'dueAt', 'projectId'],
    serverReadable: ['title', 'status', 'dueAt', 'projectId'],
    indexes: [{
      id: 'byProjectAndStatus',
      fields: [
        { field: 'projectId', direction: 'asc' },
        { field: 'status', direction: 'asc' },
        { field: 'dueAt', direction: 'asc' },
      ],
    }],
    uiQueries: [{
      id: 'openByProject',
      indexId: 'byProjectAndStatus',
      parameters: { projectId: { kind: 'string', maxUtf8Bytes: 256 } },
      prefix: [
        { kind: 'parameter', parameterId: 'projectId' },
        { kind: 'literal', value: 'open' },
      ],
      order: 'asc',
      pageSize: 50,
      projectedFields: ['title', 'status', 'dueAt'],
    }],
    relations: [{
      id: 'project',
      kind: 'collection',
      field: 'projectId',
      collectionId: 'projects',
      required: true,
      onDelete: 'restrict',
    }],
  });
  assert.match(collections, /import \{ defineAccountCollection \} from '@happier-dev\/plugin-sdk\/collections';/u);
  assert.match(collections, /defineAccountCollection\(/u);
  assert.doesNotMatch(`${collections}\n${surface}`, /(?:project-id|due-at|open-by-project|by-project-and-status)/u);
  assert.doesNotMatch(surface, /variant="subtitle"/u);
  assert.match(surface, /\bList\b/u);
  assert.match(surface, /<List\s+[\s\S]*items=\{query\.rows\}/u);
  assert.match(surface, /keyForItem=\{\(row\) => row\.context\.rowId\}/u);
  assert.match(surface, /renderItem=\{\(row\) =>/u);
  assert.match(surface, /const queryFeedback = [\s\S]*query\.status === 'error'/u);
  assert.match(surface, /query\.rows\.length === 0[\s\S]*query\.status === 'error'/u);
  assert.match(surface, /usePluginCollectionQuery\('tasks', 'openByProject'/u);
  assert.match(surface, /dataClient\.collection\(Tasks\)/u);
  assert.match(surface, /tasks\.get\(rowId, \{ signal \}\)/u);
  assert.match(surface, /expectedRevision: current\.revision/u);
  assert.doesNotMatch(surface, /<ScrollArea\b/u);
  assert.doesNotMatch(surface, /query\.rows\.map\(/u);
  assert.doesNotMatch(surface, /(?:apps\/ui|createPluginUiDataClient|openCollectionQuery|\.\.\/\.\.\/\.\.\/apps)/u);
});
