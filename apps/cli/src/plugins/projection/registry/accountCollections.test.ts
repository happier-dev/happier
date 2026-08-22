import { describe, expect, it } from 'vitest';

import {
  PluginProjectionV2Schema,
} from '@happier-dev/protocol';

import { normalizePluginManifestV2 } from '@/plugins/manifest/normalize';
import type { LoadedPlugin } from '@/plugins/discovery/load/installed';

import { createResolvedContributionRegistry } from './createResolvedContributionRegistry';
import { buildPluginProjectionV2 } from './projection/v2';
import { projectLoadedPluginContributes } from './resolvePluginContributions';

const PLUGIN_ID = 'com.acme.tasks';

function loadedAccountCollectionsPlugin(): LoadedPlugin {
  return {
    pluginId: PLUGIN_ID,
    pluginRootPath: `/plugins/${PLUGIN_ID}`,
    manifestPath: `/plugins/${PLUGIN_ID}/.happier-plugin/plugin.json`,
    daemonEntryPath: `/plugins/${PLUGIN_ID}/dist/plugin.js`,
    devDaemonEntryPath: null,
    sourceSpec: {
      kind: 'path',
      locator: `/plugins/${PLUGIN_ID}`,
      trustPolicy: 'local_trusted',
      installPolicy: 'link',
    },
    manifest: normalizePluginManifestV2({
      schemaVersion: 2,
      id: PLUGIN_ID,
      version: '1.0.0',
      displayName: 'Acme Tasks',
      engines: { happier: '^1.0.0' },
      runtime: { apiVersion: 1 },
      entrypoints: { daemon: './dist/plugin.js' },
      contributes: {
        accountCollections: [
          {
            id: 'tasks',
            schemaVersion: 1,
            schema: {
              type: 'object',
              properties: {
                id: { type: 'string', maxLength: 256 },
                status: { type: 'string', enum: ['closed', 'open'] },
                title: { type: 'string', maxLength: 256 },
              },
              required: ['id', 'status', 'title'],
              additionalProperties: false,
            },
            serverReadable: ['title', 'status'],
            indexes: [{
              id: 'by-status',
              fields: [
                { field: 'status', direction: 'asc' },
                { field: 'id', direction: 'asc' },
              ],
            }],
            uiQueries: [{
              id: 'open',
              indexId: 'by-status',
              parameters: {
                status: { kind: 'string', maxUtf8Bytes: 16, enum: ['open', 'closed'] },
              },
              prefix: [{ kind: 'parameter', parameterId: 'status' }],
              order: 'asc',
              pageSize: 50,
              projectedFields: ['title', 'status'],
            }],
          },
        ],
      },
    }),
  };
}

describe('account collection contribution projection', () => {
  it('normalizes static collection UI-query descriptors before projecting them to the UI', () => {
    const registry = createResolvedContributionRegistry(projectLoadedPluginContributes({
      loadResult: {
        loadedPlugins: [loadedAccountCollectionsPlugin()],
        diagnosticsByPluginId: {},
      },
      provenance: 'external',
    }));

    const projection = PluginProjectionV2Schema.parse(buildPluginProjectionV2({
      registry,
      generation: 3,
    }));
    const entry = projection.familiesById.accountCollections?.entriesById[`${PLUGIN_ID}/tasks`];

    expect(entry).toEqual({
      pluginId: PLUGIN_ID,
      collectionId: 'tasks',
      schemaVersion: 1,
      contractDigest: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
      uiQueries: [{
        collection: { pluginId: PLUGIN_ID, collectionId: 'tasks' },
        id: 'open',
        indexId: 'by-status',
        parameters: {
          status: { kind: 'string', maxUtf8Bytes: 16, enum: ['closed', 'open'] },
        },
        prefix: [{ kind: 'parameter', parameterId: 'status' }],
        order: 'asc',
        pageSize: 50,
        projectedFields: [
          { field: 'status', kind: 'string' },
          { field: 'title', kind: 'string' },
        ],
      }],
    });
    expect(entry).not.toHaveProperty('schema');
    expect(entry?.uiQueries[0]).not.toHaveProperty('action');
  });
});
