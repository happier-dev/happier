import { z } from 'zod/mini';
import { lazyZodSchema } from '../../lazyZodSchema.js';
import { PluginBrandV2Schema } from '../../plugins/manifest/v2.js';
import { PluginPackagedResourceContributionV2Schema } from '../../plugins/contributions/v2.js';
import { NpmRegistryProfileIdV1Schema, NpmRegistryProfileViewV1Schema } from '../../rpc/npmRegistryProfiles.js';
import { ScmHostingRepositoryIdentityV1Schema } from '../../scm/hostingRepositoryIdentity.js';
import { ScmHostingRepositoryPublishRequestSchema, ScmHostingRepositoryDescribePublishTargetsResponseSchema } from '../../scm/repositoryProvisioning.js';
import { projectNativeJsonValueForTransport } from '../../json/strictJsonValue.js';
import type { HostReviewedChildrenPlanV1 } from '../executor/types.js';
import { ArtifactCreateIdV1Schema } from '../../artifacts/artifactIdV1.js';
import { ArtifactRevisionV1Schema } from '../../artifacts/artifactRevisionV1.js';
import { BotTemplateReleaseV1AuthoringSchema } from '../../bots/templates/botTemplateV1.js';

const text = () => z.string().check(z.trim(), z.minLength(1));
export const PluginPublicationMetadataSchema = lazyZodSchema(() => z.strictObject({
  packageName: z.optional(text()), title: z.optional(text()), description: z.optional(z.string()),
  version: z.optional(text()), keywords: z.optional(z.array(text())), readme: z.optional(z.string()),
  changelog: z.optional(z.string()), icon: z.optional(PluginBrandV2Schema),
  iconSource: z.optional(z.strictObject({ dataBase64: text(), contentType: z.literal('image/png') })),
}));
export type PluginPublicationMetadata = z.infer<typeof PluginPublicationMetadataSchema>;
export const PluginPublicationResourceSchema = lazyZodSchema(() => z.pick(PluginPackagedResourceContributionV2Schema,
  { id: true, path: true, contentType: true, kind: true }));

export const PluginPublicationGithubInputSchema = lazyZodSchema(() => z.strictObject({
  repository: ScmHostingRepositoryIdentityV1Schema.check(z.refine(value => value.kind === 'github')),
  createRepository: z.optional(ScmHostingRepositoryPublishRequestSchema.check(z.refine(value =>
    value.providerKind === 'github' && value.pushCurrentBranch !== true))),
  source: z.optional(z.strictObject({ remote: text(), branch: text(),
    commit: z.optional(z.strictObject({ message: text(), paths: z.array(text()).check(z.minLength(1)) })),
  })),
  release: z.optional(z.strictObject({
    tagName: text(), targetCommitish: text(), name: z.string(), body: z.string(), prerelease: z.boolean(),
    makeLatest: z.enum(['true', 'false', 'legacy']), releaseId: z.optional(text()),
  })),
}));
export type PluginPublicationGithubInput = z.infer<typeof PluginPublicationGithubInputSchema>;
export const PluginPublicationGithubResultSchema = lazyZodSchema(() => z.strictObject({
  status: z.enum(['published', 'failed', 'partial', 'outcome_unknown', 'conflict', 'cancelled']),
  phase: z.enum(['repository', 'commit', 'push', 'release']), pushed: z.boolean(),
  repositoryUrl: z.optional(text()), releaseUrl: z.optional(text()), releaseId: z.optional(text()),
  commitSha: z.optional(text()), errorCode: z.optional(text()),
}));
export type PluginPublicationGithubResult = z.infer<typeof PluginPublicationGithubResultSchema>;
export const PluginPublicationGithubInspectionSchema = lazyZodSchema(() => z.strictObject({
  status: z.enum(['ready', 'unavailable']), reason: z.optional(text()),
  repository: z.optional(ScmHostingRepositoryIdentityV1Schema), remote: z.optional(text()), branch: z.optional(text()),
  publishTargets: z.optional(ScmHostingRepositoryDescribePublishTargetsResponseSchema),
}));
export type PluginPublicationGithubInspection = z.infer<typeof PluginPublicationGithubInspectionSchema>;

export const PluginPublicationBotTemplateSchema = lazyZodSchema(() => z.strictObject({
  draftArtifactId: ArtifactCreateIdV1Schema, expectedRevision: ArtifactRevisionV1Schema, release: BotTemplateReleaseV1AuthoringSchema,
}));
export type PluginPublicationBotTemplate = z.infer<typeof PluginPublicationBotTemplateSchema>;
const project = () => ({ projectRoot: z.optional(text()), botTemplate: z.optional(PluginPublicationBotTemplateSchema),
  machineId: z.optional(text()), profileId: z.optional(NpmRegistryProfileIdV1Schema) });
const hasSource = (value: { projectRoot?: string; botTemplate?: PluginPublicationBotTemplate }) => Boolean(value.projectRoot || value.botTemplate);
export const PluginPublishInspectActionInputSchema = lazyZodSchema(() => z.strictObject({ ...project(), packageName: z.optional(text()),
  cursor: z.optional(text()), includeGithub: z.optional(z.literal(true)) }).check(z.refine(hasSource)));
export const PluginPublishPrepareActionInputSchema = lazyZodSchema(() => z.strictObject({ ...project(), publication: z.optional(PluginPublicationMetadataSchema) }).check(z.refine(hasSource)));
export const PluginPublishActionInputSchema = lazyZodSchema(() => z.strictObject({
  ...PluginPublishPrepareActionInputSchema.shape, access: z.literal('public'), mode: z.enum(['direct', 'staged']),
  expectedArchiveIntegrity: z.optional(text()), github: z.optional(PluginPublicationGithubInputSchema),
  githubOnly: z.optional(z.literal(true)),
}).check(z.refine(hasSource), z.refine(value => !value.githubOnly || Boolean(value.github)),
  z.refine(value => !value.github?.source && !value.github?.createRepository || Boolean(value.projectRoot))));
export const PluginPublishStatusActionInputSchema = lazyZodSchema(() => z.strictObject({
  machineId: z.optional(text()), profileId: NpmRegistryProfileIdV1Schema, packageName: text(), version: text(), integrity: text(),
}));
export type PluginPublishInspectActionInput = z.infer<typeof PluginPublishInspectActionInputSchema>;
export type PluginPublishPrepareActionInput = z.infer<typeof PluginPublishPrepareActionInputSchema>;
export type PluginPublishActionInput = z.infer<typeof PluginPublishActionInputSchema>;
export type PluginPublishStatusActionInput = z.infer<typeof PluginPublishStatusActionInputSchema>;

export const PLUGIN_PUBLICATION_GITHUB_PLUGIN_ID = 'happier.scm.forge.github';
export const PLUGIN_PUBLICATION_BOT_TEMPLATE_CHILD_ROLE = 'bot-template-release';
export const PLUGIN_PUBLICATION_GITHUB_CHILD_ROLES = {
  'scm.hostingRepository.describePublishTargets': 'github-repository-describe',
  'scm.hostingRepository.publish': 'github-repository-publish',
  'scm.commit.create': 'github-source-commit',
  'scm.remote.push': 'github-source-push',
  'github/releases/draft-create': 'github-release-create',
  'github/releases/release-read': 'github-release-read',
  'github/releases/draft-publish': 'github-release-publish',
} as const;

/** Demand selected child effects at the parent's single Action admission boundary. */
export function pluginPublicationReviewedChildren(input: unknown): HostReviewedChildrenPlanV1['children'] {
  const { projectRoot, github, botTemplate, publication, githubOnly } = input as PluginPublishActionInput;
  const children: Array<HostReviewedChildrenPlanV1['children'][number]> = [];
  if (botTemplate && !githubOnly) children.push({ action: 'template.release', role: PLUGIN_PUBLICATION_BOT_TEMPLATE_CHILD_ROLE,
    input: { draftArtifactId: botTemplate.draftArtifactId, expectedRevision: botTemplate.expectedRevision,
      version: publication?.version ?? botTemplate.release.version, changelog: publication?.changelog ?? botTemplate.release.changelog,
      releasedAtMs: botTemplate.release.releasedAtMs } });
  if (!github) return children;
  if (github.createRepository && projectRoot) {
    children.push({ action: 'scm.hostingRepository.describePublishTargets', role: PLUGIN_PUBLICATION_GITHUB_CHILD_ROLES['scm.hostingRepository.describePublishTargets'],
      input: projectNativeJsonValueForTransport({ cwd: projectRoot, providerKind: 'github',
        ...(github.createRepository.providerId ? { providerId: github.createRepository.providerId } : {}) }) });
    children.push({ action: 'scm.hostingRepository.publish', role: PLUGIN_PUBLICATION_GITHUB_CHILD_ROLES['scm.hostingRepository.publish'],
      input: projectNativeJsonValueForTransport({ ...github.createRepository, cwd: projectRoot, pushCurrentBranch: false }) });
  }
  if (github.source?.commit && projectRoot) children.push({ action: 'scm.commit.create', role: PLUGIN_PUBLICATION_GITHUB_CHILD_ROLES['scm.commit.create'],
    input: { cwd: projectRoot, message: github.source.commit.message, scope: { kind: 'paths', include: github.source.commit.paths } } });
  if (github.source && projectRoot) children.push({ action: 'scm.remote.push', role: PLUGIN_PUBLICATION_GITHUB_CHILD_ROLES['scm.remote.push'],
    input: { cwd: projectRoot, remote: github.source.remote, branch: github.source.branch, pushMode: 'ordinary' } });
  if (github.release) {
    const { releaseId, makeLatest, ...fields } = github.release;
    if (releaseId) children.push({ action: { pluginId: PLUGIN_PUBLICATION_GITHUB_PLUGIN_ID, localId: 'github/releases/release-read' },
      role: PLUGIN_PUBLICATION_GITHUB_CHILD_ROLES['github/releases/release-read'], input: { repository: github.repository, releaseId } });
    else children.push({ action: { pluginId: PLUGIN_PUBLICATION_GITHUB_PLUGIN_ID, localId: 'github/releases/draft-create' },
      role: PLUGIN_PUBLICATION_GITHUB_CHILD_ROLES['github/releases/draft-create'], input: { repository: github.repository, ...fields } });
    // The provider supplies the draft's native identity after creation/read; the
    // host alone supplies the concrete reviewed draft through this admitted port.
    children.push({ action: { pluginId: PLUGIN_PUBLICATION_GITHUB_PLUGIN_ID, localId: 'github/releases/draft-publish' },
      role: PLUGIN_PUBLICATION_GITHUB_CHILD_ROLES['github/releases/draft-publish'], scopeInput: { repository: github.repository, makeLatest } });
  }
  return children;
}

export const PluginPublicationDiagnosticSchema = lazyZodSchema(() => z.strictObject({ code: text(), message: z.string() }));
export const PluginPublicationFailureSchema = lazyZodSchema(() => z.strictObject({ status: z.literal('failed'), diagnostics: z.array(PluginPublicationDiagnosticSchema) }));
export const PluginPublicationPreparedSchema = lazyZodSchema(() => z.strictObject({
  status: z.literal('prepared'), projectRoot: z.optional(text()), packageName: text(), version: text(),
  publication: PluginPublicationMetadataSchema, archiveIntegrity: text(), npmIntegrity: text(), archiveSizeBytes: z.number().check(z.nonnegative()),
  files: z.array(z.strictObject({ path: text(), sizeBytes: z.number().check(z.nonnegative()) })),
  diagnostics: z.array(PluginPublicationDiagnosticSchema), sdkVersion: z.optional(text()),
  tests: z.optional(z.strictObject({ status: z.enum(['passed', 'failed', 'not_configured']) })),
  stages: z.optional(z.strictObject({ validation: z.enum(['passed', 'failed']), build: z.enum(['passed', 'failed', 'not_configured']) })),
}));
export type PluginPublicationPrepared = z.infer<typeof PluginPublicationPreparedSchema>;
export const PluginPublishPrepareResultSchema = lazyZodSchema(() => z.union([PluginPublicationPreparedSchema, PluginPublicationFailureSchema]));
export type PluginPublishPrepareResult = z.infer<typeof PluginPublishPrepareResultSchema>;
export const PluginPublishInspectResultSchema = lazyZodSchema(() => z.union([
  z.strictObject({ status: z.literal('ready'), projectRoot: z.optional(text()), publication: PluginPublicationMetadataSchema,
    profiles: z.array(NpmRegistryProfileViewV1Schema),
    resources: z.optional(z.array(PluginPublicationResourceSchema)),
    github: z.optional(PluginPublicationGithubInspectionSchema),
    nextVersions: z.optional(z.strictObject({ patch: text(), minor: text(), major: text() })),
    history: z.optional(z.strictObject({ packageUrl: z.optional(text()),
      versions: z.array(z.strictObject({ version: text(), versionUrl: z.optional(text()), integrity: z.optional(text()), publishedAt: z.optional(text()) })), cursor: z.optional(text()) })),
  }), z.extend(PluginPublicationFailureSchema, { scaffold: z.optional(z.strictObject({
    sourceRootPath: text(), sessionDirectory: text(),
  })) }),
]));
export type PluginPublishInspectResult = z.infer<typeof PluginPublishInspectResultSchema>;
export const PluginPublicationEffectResultSchema = lazyZodSchema(() => z.strictObject({
  status: z.enum(['published', 'awaiting_maintainer', 'authentication_required', 'authentication_failed', 'challenge',
    'version_conflict', 'outcome_unknown', 'cancelled', 'failed', 'missing']),
  packageName: z.optional(text()), version: z.optional(text()), integrity: z.optional(text()), registryOrigin: z.optional(text()),
  packageUrl: z.optional(text()), stageId: z.optional(text()), reviewUrl: z.optional(text()), code: z.optional(text()),
  github: z.optional(PluginPublicationGithubResultSchema),
}));
export type PluginPublicationEffectResult = z.infer<typeof PluginPublicationEffectResultSchema>;
export const PluginPublishResultSchema = lazyZodSchema(() => z.union([
  PluginPublicationEffectResultSchema, PluginPublicationFailureSchema,
  z.strictObject({ status: z.literal('review_required'), preparation: PluginPublicationPreparedSchema }),
]));
export type PluginPublishResult = z.infer<typeof PluginPublishResultSchema>;
export const PluginPublishStatusResultSchema = lazyZodSchema(() => z.union([PluginPublicationEffectResultSchema, PluginPublicationFailureSchema]));
export type PluginPublishStatusResult = z.infer<typeof PluginPublishStatusResultSchema>;

export const PluginPublicationActionOutputSchemas = {
  'plugins.dev.publication.inspect': lazyZodSchema(() => z.strictObject({ ok: z.boolean(), kind: z.literal('plugins_dev_publication_inspect'), result: PluginPublishInspectResultSchema })),
  'plugins.dev.publication.prepare': lazyZodSchema(() => z.strictObject({ ok: z.boolean(), kind: z.literal('plugins_dev_publication_prepare'), result: PluginPublishPrepareResultSchema })),
  'plugins.dev.publish': lazyZodSchema(() => z.strictObject({ ok: z.boolean(), kind: z.literal('plugins_dev_publish'), result: PluginPublishResultSchema })),
  'plugins.dev.publication.status': lazyZodSchema(() => z.strictObject({ ok: z.boolean(), kind: z.literal('plugins_dev_publication_status'), result: PluginPublishStatusResultSchema })),
} as const;
