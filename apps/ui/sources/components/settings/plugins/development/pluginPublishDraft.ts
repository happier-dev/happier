import { createStore } from 'zustand/vanilla';
import type { PluginPublicationMetadata } from '@happier-dev/protocol/actions/actionSpecs';

export const EMPTY_PLUGIN_PUBLISH_FIELDS = {
    packageName: '', title: '', description: '', icon: '', iconDataBase64: '', keywords: '',
    readme: '', version: '', changelog: '',
    github: false, repository: '', repositoryDeployment: 'https://github.com', branch: '', remote: '', push: true, release: true,
    createRepository: false, repositoryName: '', githubOwner: '',
    commit: false, commitMessage: '', commitPaths: '',
};
export type PluginPublishFields = typeof EMPTY_PLUGIN_PUBLISH_FIELDS;

/** The current-context payload enters the mounted form through its field types. */
export function parsePluginPublishDraftPatch(value: unknown): Partial<PluginPublishFields> | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const entries = Object.entries(value);
    if (entries.some(([key, item]) => !Object.hasOwn(EMPTY_PLUGIN_PUBLISH_FIELDS, key)
        || typeof item !== typeof EMPTY_PLUGIN_PUBLISH_FIELDS[key as keyof PluginPublishFields])) return null;
    return Object.fromEntries(entries) as Partial<PluginPublishFields>;
}

export function publicationDraftsEqual(current: PluginPublishFields, reviewed: PluginPublishFields): boolean {
    return publicationFieldKeys.every(key => current[key] === reviewed[key]);
}

/** A mounted form's local values. Remote work belongs to explicit controller commands. */
export function createPluginPublishDraft(initial?: Partial<PluginPublishFields>) {
    return createStore<{
        fields: PluginPublishFields;
        patch: (patch: Partial<PluginPublishFields>) => void;
    }>((set) => ({ fields: { ...EMPTY_PLUGIN_PUBLISH_FIELDS, ...initial }, patch: (patch) => set((state) => {
        const changed = Object.entries(patch).some(([key, value]) => state.fields[key as keyof PluginPublishFields] !== value);
        return changed ? { fields: { ...state.fields, ...patch } } : state;
    }) }));
}

/** Listing values are captured once by prepare, rather than read again during publish. */
export function publicationFromDraft(fields: PluginPublishFields, icon?: PluginPublicationMetadata['icon']): PluginPublicationMetadata {
    return {
        packageName: fields.packageName.trim(), title: fields.title.trim(), description: fields.description,
        version: fields.version.trim(), keywords: fields.keywords.split(',').map(value => value.trim()).filter(Boolean),
        readme: fields.readme, changelog: fields.changelog, ...(icon ? { icon } : {}),
        ...(fields.iconDataBase64 ? { iconSource: { dataBase64: fields.iconDataBase64, contentType: 'image/png' as const } } : {}),
    };
}

export function fieldsFromPublication(publication: PluginPublicationMetadata): Partial<PluginPublishFields> {
    return {
        packageName: publication.packageName ?? '', title: publication.title ?? '', description: publication.description ?? '',
        version: publication.version ?? '', keywords: publication.keywords?.join(', ') ?? '',
        readme: publication.readme ?? '', changelog: publication.changelog ?? '', icon: publication.icon?.iconResourceId ?? '',
        iconDataBase64: publication.iconSource?.dataBase64 ?? '',
    };
}

const publicationFieldKeys = Object.keys(fieldsFromPublication({})) as Array<keyof PluginPublishFields>;
