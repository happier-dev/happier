import { z } from 'zod/mini';
import { lazyZodSchema } from '../../lazyZodSchema.js';
import { ProjectSourceRepositorySelectorV1Schema } from '../sources/projectSourceV1.js';
import { ScmCommitOidSchema } from '../../scm/commitPublication.js';

const text = z.string().check(z.trim(), z.minLength(1));

// SCM owns credential-free locator admission; bundled starters additionally require HTTPS.
const WholeRepositorySelectorV1Schema = lazyZodSchema(() => z.readonly(
  ProjectSourceRepositorySelectorV1Schema.check(z.refine(selector => {
    const repository = selector.repository;
    const https = (url: string) => /^https:\/\//i.test(url);
    return selector.protocol === 'https'
      && https(selector.provider.baseUrl)
      && typeof repository.cloneUrl === 'string' && https(repository.cloneUrl)
      && (repository.webUrl === undefined || https(repository.webUrl))
      && repository.sshUrl === undefined;
  }, 'Bundled starters require credential-free HTTPS repository selectors')),
));

/** Bundled development data, not deployment authority or a repository materializer. */
export const ProjectStarterV1Schema = lazyZodSchema(() => z.readonly(z.strictObject({
  schemaVersion: z.literal(1),
  id: text,
  titleKey: text,
  summaryKey: text,
  technologyLabels: z.readonly(z.array(text).check(z.minLength(1))),
  previewAssetKey: text,
  repository: z.readonly(z.strictObject({
    selector: WholeRepositorySelectorV1Schema,
    ref: ScmCommitOidSchema,
  })),
  buildGoal: text,
  appShape: z.enum(['static', 'webApp', 'service']),
  // ownServerReady is a reviewed source-data fact: the pin must contain Dockerfile,
  // compose.yaml and a healthcheck. platformOnly entries need Prepare on an own server.
  deploymentSupport: z.enum(['ownServerReady', 'platformOnly']),
})));
export type ProjectStarterV1 = z.infer<typeof ProjectStarterV1Schema>;

export const ProjectStarterCatalogV1Schema = lazyZodSchema(() => z.readonly(
  z.array(ProjectStarterV1Schema).check(z.superRefine((starters, context) => {
    const ids = new Set<string>();
    starters.forEach((starter, index) => {
      if (ids.has(starter.id)) context.addIssue({ code: 'custom', path: [index, 'id'], message: 'Duplicate starter id' });
      ids.add(starter.id);
    });
  })),
));
