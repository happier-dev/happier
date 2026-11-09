import type { DefinePluginInput } from '@happier-dev/plugin-sdk';
import type { ActionInputFieldHint } from '@happier-dev/plugin-sdk/actions';
import type { PluginResourceDefinition } from '@happier-dev/plugin-sdk/resources';

// 0.3 development: the host owns the picker; the Action receives no secret bytes.
export const savedSecretReferenceField = {
  path: 'secret', title: 'Saved Secret', widget: 'select', required: true,
  inputType: { hostType: 'savedSecretReference' },
} satisfies ActionInputFieldHint;

export const repositoryInputTypeRef = { pluginId: 'examples.public-sdk-review-assistant', localId: 'repository' } as const;
export const repositoryInputTypes = {
  repository: { title: 'Repository', semantic: 'repository',
    valueSchema: { type: 'object', properties: { repositoryId: { type: 'string', minLength: 1 } },
      required: ['repositoryId'], additionalProperties: false },
    options: { resource: 'review-repositories' }, picker: 'review-native' },
} satisfies NonNullable<DefinePluginInput['inputTypes']>;
export const repositoryResources: Readonly<Record<string, PluginResourceDefinition>> = {
  'review-repositories': { source: 'dynamic', kind: 'config', scope: 'global', contentType: 'application/json',
    runtime: { read: options => {
      // The same request serves UI and headless forms. A real provider forwards
      // its selected draft refs to a declared read-only Action via readAction.
      const repositories = [{ value: { repositoryId: 'example/review-assistant' }, label: 'Review assistant' }];
      const search = options.query?.query?.toLowerCase() ?? '';
      return JSON.stringify({ options: repositories.filter(repository => repository.label.toLowerCase().includes(search)) });
    },
      observe: () => ({ dispose() {} }) } },
};
