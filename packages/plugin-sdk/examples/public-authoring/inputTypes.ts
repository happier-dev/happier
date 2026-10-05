import type { DefinePluginInput } from '@happier-dev/plugin-sdk';

export const repositoryInputTypeRef = { pluginId: 'examples.public-sdk-review-assistant', localId: 'repository' } as const;
export const repositoryInputTypes = {
  repository: { title: 'Repository', semantic: 'repository',
    valueSchema: { type: 'object', properties: { repositoryId: { type: 'string', minLength: 1 } },
      required: ['repositoryId'], additionalProperties: false },
    options: { resource: 'review-repositories' }, picker: 'review-native' },
} satisfies NonNullable<DefinePluginInput['inputTypes']>;
export const repositoryResources = {
  'review-repositories': { source: 'dynamic', kind: 'config', scope: 'global', contentType: 'application/json',
    runtime: { read: () => JSON.stringify([{ value: { repositoryId: 'example/review-assistant' }, label: 'Review assistant' }]),
      observe: () => ({ dispose() {} }) } },
} satisfies NonNullable<DefinePluginInput['resources']>;
