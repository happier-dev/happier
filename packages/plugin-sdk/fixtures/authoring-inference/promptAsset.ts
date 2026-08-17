export const promptAssetDescriptor = Object.freeze({
  id: 'example.inference.skill',
  providerId: 'reviewer',
  title: 'Inference fixture skills',
  description: 'External-author Prompt Asset fixture.',
  libraryKind: 'bundle' as const,
  supportsScope: { user: true, project: true },
  supportsFiles: true,
  formatId: 'skill_md_v1',
  defaultRoots: [],
  capabilities: {},
});

const fixtureFailure = Object.freeze({
  ok: false as const,
  errorCode: 'unsupported' as const,
  error: 'external authoring fixture',
});

export const promptAssetAdapter = Object.freeze({
  descriptor: promptAssetDescriptor,
  async discover(_request: unknown, options?: Readonly<{ signal?: AbortSignal }>) {
    options?.signal?.throwIfAborted();
    return Object.freeze([]);
  },
  async read(_request: unknown, options?: Readonly<{ signal?: AbortSignal }>) {
    options?.signal?.throwIfAborted();
    return fixtureFailure;
  },
  async writeDoc(_request: unknown, options?: Readonly<{ signal?: AbortSignal }>) {
    options?.signal?.throwIfAborted();
    return fixtureFailure;
  },
  async writeBundle(_request: unknown, options?: Readonly<{ signal?: AbortSignal }>) {
    options?.signal?.throwIfAborted();
    return fixtureFailure;
  },
  async delete(_request: unknown, options?: Readonly<{ signal?: AbortSignal }>) {
    options?.signal?.throwIfAborted();
    return fixtureFailure;
  },
});
