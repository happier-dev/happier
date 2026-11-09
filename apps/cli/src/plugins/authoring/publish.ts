import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHappierTempDir, removeHappierTempDirAsync } from '@happier-dev/cli-common/tempDirs';
import type { ActionExecutorContext } from '@happier-dev/protocol';
import { BotTemplateReleaseResultV1Schema } from '@happier-dev/protocol/bots/templates/botTemplateActionsV1';
import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import { PLUGIN_PUBLICATION_BOT_TEMPLATE_CHILD_ROLE, pluginPublicationReviewedChildren } from '@happier-dev/protocol/actions/actionSpecs';
import { resolvePluginLocalizedStringV2Text } from '@happier-dev/protocol/plugins/contributions/public-types';
import type {
  PluginPublicationEffectResult, PluginPublicationMetadata, PluginPublicationPrepared,
  PluginPublishInspectActionInput, PluginPublishInspectResult, PluginPublishPrepareActionInput,
  PluginPublishPrepareResult, PluginPublishActionInput, PluginPublishResult,
  PluginPublishStatusActionInput, PluginPublishStatusResult,
} from '@happier-dev/protocol/actions/actionSpecs';
import semver from 'semver';
import * as tar from 'tar';

import { packLocalPlugin } from '../packaging/pack';
import { createNpmRegistryHttpsClient } from '../distribution/npm/httpsClient';
import { createNpmRegistryProfileService } from '../distribution/npm/profiles/service';
import { checkNpmPublication, npmPackageUrl, publishNpmPackage, readNpmPackageVersionHistory } from '../distribution/npm/publish';
import { evaluatePluginAuthorSource, resolvePluginAuthoringSource } from './sourceModule';
import { createPluginGithubActionDependencies, inspectPluginPublicationGithub, publishPluginGithub } from './publishGithub';
import { withPublicationProject } from './publicationProject';

export type PluginPublicationOptions = Readonly<{
  happyHomeDir?: string;
  signal?: AbortSignal;
  hostReviewedChild?: ActionExecutorContext['hostReviewedChild'];
  npmHttp?: Pick<Parameters<typeof createNpmRegistryHttpsClient>[0], 'lookup' | 'request'>;
}>;

function failure(code: string, message: string) {
  return { status: 'failed' as const, diagnostics: [{ code, message }] };
}

async function optionalText(path: string): Promise<string | undefined> {
  try { return await readFile(path, 'utf8'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

type RegistryAccess = Parameters<Parameters<ReturnType<typeof createNpmRegistryProfileService>['withAuthorization']>[1]>[0];
function registryClient(access: RegistryAccess, options: PluginPublicationOptions) {
  return createNpmRegistryHttpsClient({ ...options.npmHttp, registryOrigin: access.profile.origin,
    allowPrivateNetwork: access.profile.allowPrivateNetwork, authorizationHeader: access.authorizationHeader, signal: options.signal });
}

function privateFailure(error: unknown, signal?: AbortSignal): PluginPublicationEffectResult {
  if (signal?.aborted) return { status: 'cancelled' };
  if (error instanceof Error && error.message === 'npm_registry_authentication_required') return { status: 'authentication_required' };
  return { status: 'failed', code: 'publication_unavailable' };
}

export async function inspectPluginPublication(input: PluginPublishInspectActionInput, options: PluginPublicationOptions = {}): Promise<PluginPublishInspectResult> {
  try {
    options.signal?.throwIfAborted();
    if (input.botTemplate) {
      const result = await withPublicationProject(input, projectRoot => inspectPluginPublication({ ...input, projectRoot, botTemplate: undefined, includeGithub: undefined }, options));
      if (result.status !== 'ready') return result;
      const { projectRoot: _generatedRoot, ...inspection } = result;
      const github = input.includeGithub && input.projectRoot
        ? await inspectPluginPublicationGithub({ directory: input.projectRoot, signal: options.signal }) : undefined;
      return { ...inspection, ...(input.projectRoot ? { projectRoot: input.projectRoot } : {}), ...(github ? { github } : {}) };
    }
    if (!input.projectRoot) return failure('publication_source_required', 'Choose a plugin source.');
    const source = await resolvePluginAuthoringSource(input.projectRoot);
    if (!source.ok) return { status: 'failed', diagnostics: [...source.diagnostics] };
    const projectRoot = source.kind === 'manifest' ? source.source.pluginRootPath : source.entry.packageRoot;
    const packageText = await optionalText(join(projectRoot, 'package.json'));
    if (packageText === undefined) return {
      ...failure('publication_scaffold_required', 'Create a plugin package with the existing scaffold flow before publishing this source.'),
      scaffold: { sourceRootPath: source.kind === 'code' ? source.entry.locator : source.source.pluginRootPath,
        sessionDirectory: projectRoot },
    };
    const manifest = source.kind === 'manifest' ? source.source.manifest : (await evaluatePluginAuthorSource({ locator: input.projectRoot })).manifest;
    // This is a preview of the author input; the pack owner validates and produces the effective publication candidate.
    const packageJson = JSON.parse(packageText) as Record<string, unknown>;
    const [readme, changelog, snapshot] = await Promise.all([
      optionalText(join(projectRoot, 'README.md')), optionalText(join(projectRoot, 'CHANGELOG.md')),
      createNpmRegistryProfileService({ happyHomeDir: options.happyHomeDir }).snapshot(),
    ]);
    const publication: PluginPublicationMetadata = {
      packageName: typeof packageJson.name === 'string' ? packageJson.name : undefined,
      version: manifest.version, title: resolvePluginLocalizedStringV2Text(manifest.displayName),
      description: manifest.description === undefined ? undefined : resolvePluginLocalizedStringV2Text(manifest.description),
      keywords: Array.isArray(packageJson.keywords) ? packageJson.keywords.filter((value): value is string => typeof value === 'string') : [],
      readme, changelog, icon: manifest.brand,
    };
    let history: Extract<PluginPublishInspectResult, { status: 'ready' }>['history'];
    let releasedVersion = manifest.version;
    const packageName = input.packageName ?? publication.packageName;
    if (input.profileId && packageName) {
      const result = await createNpmRegistryProfileService({ happyHomeDir: options.happyHomeDir }).withAuthorization(input.profileId,
        async access => readNpmPackageVersionHistory({ registryOrigin: access.profile.origin, packageName,
          client: registryClient(access, options), signal: options.signal }));
      if (result.status === 'available') {
        history = { packageUrl: npmPackageUrl(result.registryOrigin, result.packageName),
          versions: result.versions.map(version => ({ version, versionUrl: npmPackageUrl(result.registryOrigin, result.packageName, version) })) };
        releasedVersion = result.latestVersion ?? result.versions[0] ?? manifest.version;
      }
      else if (result.status === 'missing') history = { packageUrl: npmPackageUrl(result.registryOrigin, result.packageName), versions: [] };
      else return failure(result.status, 'Selected package history is unavailable. Check the selected registry connection.');
    }
    const patch = semver.inc(releasedVersion, 'patch');
    const minor = semver.inc(releasedVersion, 'minor');
    const major = semver.inc(releasedVersion, 'major');
    const resources = (manifest.contributes?.resources ?? []).flatMap(resource => resource.source === 'dynamic' ? []
      : [{ id: resource.id, path: resource.path, contentType: resource.contentType, kind: resource.kind }]);
    const github = input.includeGithub ? await inspectPluginPublicationGithub({ directory: projectRoot, signal: options.signal }) : undefined;
    return { status: 'ready', projectRoot, publication, profiles: [...snapshot.profiles],
      resources, ...(github ? { github } : {}),
      ...(patch && minor && major ? { nextVersions: { patch, minor, major } } : {}), ...(history ? { history } : {}) };
  } catch {
    return failure('publication_inspect_failed', 'Could not inspect this plugin package. Check its source and selected registry connection.');
  }
}

type PublicationCandidate = Readonly<{
  preparation: PluginPublicationPrepared;
  manifest: Readonly<Record<string, unknown>> & Readonly<{ name: string; version: string }>;
  archive: Buffer;
}>;

async function withCandidate<T>(input: PluginPublishPrepareActionInput, options: PluginPublicationOptions,
  use: (candidate: PublicationCandidate) => Promise<T>): Promise<T | Extract<PluginPublishPrepareResult, { status: 'failed' }>> {
  const directory = await createHappierTempDir({ purpose: 'plugin-publication' });
  try {
    options.signal?.throwIfAborted();
    const packed = await withPublicationProject(input, projectRoot => packLocalPlugin({ locator: projectRoot,
      outPath: join(directory, 'candidate.tgz'), publication: input.publication ?? {}, signal: options.signal }));
    options.signal?.throwIfAborted();
    if (!packed.ok) return { status: 'failed', diagnostics: [...packed.diagnostics] };
    const files: PluginPublicationPrepared['files'] = [];
    const contents = new Map<string, Buffer[]>();
    // Project the actual package sent to npm, including the pack owner's generated metadata.
    await tar.t({ file: packed.archivePath, onentry(entry) {
      if (entry.type !== 'File') return;
      const path = entry.path.replace(/^package\//, '');
      files.push({ path, sizeBytes: entry.size });
      if (path === 'package.json' || path === 'README.md' || path === 'CHANGELOG.md') {
        const chunks: Buffer[] = [];
        contents.set(path, chunks);
        entry.on('data', (chunk: Buffer) => chunks.push(chunk));
      }
    } });
    const text = (path: string) => contents.has(path) ? Buffer.concat(contents.get(path)!).toString('utf8') : undefined;
    // Internal pack output already satisfies the package contract; this read supplies the npm document, not a second validator.
    const manifest = JSON.parse(text('package.json')!) as PublicationCandidate['manifest'];
    const publication: PluginPublicationMetadata = { packageName: manifest.name, version: packed.manifest.version,
      title: resolvePluginLocalizedStringV2Text(packed.manifest.displayName),
      description: packed.manifest.description === undefined ? undefined : resolvePluginLocalizedStringV2Text(packed.manifest.description),
      keywords: manifest.keywords as string[] | undefined, readme: text('README.md'), changelog: text('CHANGELOG.md'), icon: packed.manifest.brand,
      ...(input.publication?.iconSource ? { iconSource: input.publication.iconSource } : {}) };
    const archive = await readFile(packed.archivePath);
    const projectRoot = input.botTemplate ? input.projectRoot : packed.packageRootPath;
    const preparation: PluginPublicationPrepared = { status: 'prepared', ...(projectRoot ? { projectRoot } : {}),
      packageName: manifest.name, version: manifest.version, publication, archiveIntegrity: packed.archiveIntegrity,
      npmIntegrity: `sha512-${createHash('sha512').update(archive).digest('base64')}`,
      archiveSizeBytes: packed.archiveSizeBytes, files: files.sort((a, b) => a.path.localeCompare(b.path)), diagnostics: [],
      tests: packed.publicationChecks?.tests ?? { status: 'not_configured' },
      ...(packed.publicationChecks ? { stages: { validation: packed.publicationChecks.validation.status, build: packed.publicationChecks.build.status } } : {}),
      ...(packed.publicationChecks?.sdkVersion ? { sdkVersion: packed.publicationChecks.sdkVersion } : {}) };
    return await use({ preparation, manifest, archive });
  } finally {
    await removeHappierTempDirAsync(directory);
  }
}

export async function preparePluginPublication(input: PluginPublishPrepareActionInput, options: PluginPublicationOptions = {}): Promise<PluginPublishPrepareResult> {
  try { return await withCandidate(input, options, async candidate => candidate.preparation); }
  catch { return failure(options.signal?.aborted ? 'publication_cancelled' : 'publication_prepare_failed', 'Could not prepare the publication candidate.'); }
}

export async function publishPluginPublication(input: PluginPublishActionInput, options: PluginPublicationOptions = {}): Promise<PluginPublishResult> {
  try {
    return await withCandidate(input, options, async candidate => {
      if (input.expectedArchiveIntegrity !== candidate.preparation.archiveIntegrity) {
        return { status: 'review_required' as const, preparation: candidate.preparation };
      }
      if (!input.profileId) return { status: 'authentication_required' as const };
      options.signal?.throwIfAborted();
      if (input.botTemplate && !input.githubOnly) {
        if (!options.hostReviewedChild) return { status: 'failed' as const, code: 'template_admission_unavailable' };
        const releaseChild = pluginPublicationReviewedChildren(input).find(child => child.role === PLUGIN_PUBLICATION_BOT_TEMPLATE_CHILD_ROLE)!;
        const released = await options.hostReviewedChild.invoke({ action: 'template.release', role: releaseChild.role, input: releaseChild.input! });
        if (!released.ok) return { status: 'failed' as const, code: released.errorCode };
        const result = BotTemplateReleaseResultV1Schema.parse(released.result);
        const reviewedRelease = { ...input.botTemplate.release, version: candidate.preparation.version,
          changelog: input.publication?.changelog ?? input.botTemplate.release.changelog };
        if (!sameStrictJsonValue(result.release, reviewedRelease)) return { status: 'failed' as const, code: 'version_mismatch' };
        options.signal?.throwIfAborted();
      }
      const result = await createNpmRegistryProfileService({ happyHomeDir: options.happyHomeDir }).withAuthorization(input.profileId, async access => {
        const coordinate = { registryOrigin: access.profile.origin, packageName: candidate.manifest.name, version: candidate.manifest.version,
          integrity: candidate.preparation.npmIntegrity };
        const client = registryClient(access, options);
        if (input.githubOnly) return await checkNpmPublication({ ...coordinate, client, signal: options.signal });
        if (!access.authorizationHeader) return { status: 'authentication_required' as const, ...coordinate };
        return await publishNpmPackage({ registryOrigin: access.profile.origin, manifest: candidate.manifest,
          tarball: candidate.archive, mode: input.mode, client, signal: options.signal });
      });
      if (result.status !== 'published' || !input.github) return result;
      if (!options.hostReviewedChild) return { ...result, github: { status: 'failed' as const, phase: 'repository' as const,
        pushed: false, errorCode: 'github_admission_unavailable' } };
      try {
        const github = await publishPluginGithub({ directory: candidate.preparation.projectRoot, selection: input.github,
          signal: options.signal, ...createPluginGithubActionDependencies(options.hostReviewedChild) });
        return { ...result, github };
      } catch {
        return { ...result, github: { status: options.signal?.aborted ? 'cancelled' as const : 'failed' as const,
          phase: 'repository' as const, pushed: false, errorCode: 'github_publication_failed' } };
      }
    });
  } catch (error) { return privateFailure(error, options.signal); }
}

export async function checkPluginPublicationStatus(input: PluginPublishStatusActionInput, options: PluginPublicationOptions = {}): Promise<PluginPublishStatusResult> {
  try {
    options.signal?.throwIfAborted();
    return await createNpmRegistryProfileService({ happyHomeDir: options.happyHomeDir }).withAuthorization(input.profileId,
      async access => checkNpmPublication({ registryOrigin: access.profile.origin, packageName: input.packageName,
        version: input.version, integrity: input.integrity, client: registryClient(access, options), signal: options.signal }));
  } catch (error) { return privateFailure(error, options.signal); }
}
