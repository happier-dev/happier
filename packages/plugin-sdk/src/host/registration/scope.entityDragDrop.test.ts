import { describe, expect, it } from 'vitest';
import { createPluginRegistrationScope } from './scope.js';
import { definePlugin } from '../../definePlugin.js';

const client = { artifactId: 'entity-runtime', exportName: 'activate' };
describe('entity client activation rights', () => {
  it('projects portable declarations and captures callbacks only for declared client rights until retirement', async () => {
    const plugin = definePlugin({ id: 'com.acme.entities', version: '1.0.0', dragSources: { issue: {
      title: 'Issue', referenceSchema: { type: 'string' }, client, platforms: ['web'],
    } } });
    expect(plugin.manifest.contributes).toMatchObject({ dragSources: [{ id: 'issue', title: 'Issue' }] });
    const scope = createPluginRegistrationScope({ pluginId: 'com.acme.entities', target: { realm: 'client', ...client, platform: 'web' },
      rights: [{ family: 'dragSources', localId: 'issue', target: { realm: 'client', ...client, platforms: ['web'] } }] });
    const denied = createPluginRegistrationScope({ pluginId: 'com.acme.entities', target: { realm: 'client', ...client, platform: 'web' }, rights: [] });
    expect(() => denied.api.dragSources.register('undeclared', { describe: () => ({ title: 'Wrong' }) })).toThrow();
    scope.api.dragSources.register('issue', { describe: reference => ({ title: String(reference) }) });
    const registrations = scope.commit();
    const source = registrations.find(entry => entry.family === 'dragSources');
    if (source?.family !== 'dragSources') throw new Error('Missing admitted source');
    expect(source.value.describe('Issue 1')).toEqual({ title: 'Issue 1' });
    await scope.dispose();
    expect(scope.registrations()).toEqual([]);
    expect(() => scope.api.dragSources.register('issue', { describe: () => null })).toThrow();
  });
});
