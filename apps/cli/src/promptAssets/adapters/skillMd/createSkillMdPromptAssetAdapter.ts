import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { dirname, isAbsolute, join, sep } from 'node:path';

import {
  PromptAssetDeleteRequest,
  PromptAssetDiscoverRequest,
  type PromptAssetDiscoveryItemV1,
  type PromptAssetMutationErrorCodeV1,
  PromptAssetMutationResponseV1,
  PromptAssetReadRequest,
  PromptAssetReadResponseV1,
  PromptAssetTypeDescriptorV1,
  PromptAssetWriteDocRequest,
  PromptAssetWriteBundleRequest,
  type PromptAssetCapabilitiesV1,
  validatePromptBundleBodyV1AgainstSchemaId,
} from '@happier-dev/protocol';

import type { PromptAssetAdapter } from '@/promptAssets/types';
import {
  buildPromptBundleBodyFromDirectory,
  computePromptBundleDigest,
} from '@/promptAssets/shared/promptBundleDirectory';
import {
  deleteManagedBundleSymlinkInstall,
  replaceDirectoryWithManagedSymlink,
  resolveAllowedManagedBundleSymlinkTarget,
  resolvePromptAssetManagedBundleInstallDir,
} from '@/promptAssets/shared/promptAssetManagedSymlinkInstall';

const DEFAULT_SKILL_NAME_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

type SkillMdPromptAssetAdapterConfig = Readonly<{
  assetTypeId: string;
  providerId: string;
  title: string;
  description: string;
  projectRootPath: readonly string[];
  projectRootDisplayPath: string;
  userRootPath: readonly string[];
  userRootDisplayPath: string;
  capabilities?: PromptAssetCapabilitiesV1;
  skillNamePattern?: RegExp;
}>;

function resolveHomedir(depsHomedir?: (() => string) | undefined): string {
  return typeof depsHomedir === 'function' ? depsHomedir() : os.homedir();
}

function resolveReadableSkillContentRoot(params: Readonly<{
  skillDir: string;
  happierHomeDir?: () => string;
}>): { ok: true; contentRoot: string } | { ok: false; error: string } {
  if (!existsSync(params.skillDir)) {
    return { ok: false, error: 'skill not found' };
  }
  if (!lstatSync(params.skillDir).isSymbolicLink()) {
    return { ok: true, contentRoot: params.skillDir };
  }
  const managedTarget = resolveAllowedManagedBundleSymlinkTarget({
    linkPath: params.skillDir,
    happierHomeDir: params.happierHomeDir,
  });
  if (!managedTarget) {
    return { ok: false, error: 'skill directory resolves through an unsupported symlink' };
  }
  return { ok: true, contentRoot: managedTarget };
}

function resolveSkillRootPath(params: Readonly<{
  scope: 'user' | 'project';
  directory?: string | null | undefined;
  homedir?: () => string;
  config: SkillMdPromptAssetAdapterConfig;
}>): { ok: true; rootPath: string; displayRoot: string } | { ok: false; error: string } {
  if (params.scope === 'project') {
    const directory = typeof params.directory === 'string' ? params.directory.trim() : '';
    if (!directory) return { ok: false, error: 'directory is required for project-scoped prompt assets' };
    if (!isAbsolute(directory)) {
      return { ok: false, error: 'directory must be an absolute path for project-scoped prompt assets' };
    }
    return {
      ok: true,
      rootPath: join(directory, ...params.config.projectRootPath),
      displayRoot: params.config.projectRootDisplayPath,
    };
  }

  const homeDirectory = resolveHomedir(params.homedir);
  return {
    ok: true,
    rootPath: join(homeDirectory, ...params.config.userRootPath),
    displayRoot: params.config.userRootDisplayPath,
  };
}

function readSkillNameFromExternalRef(externalRef: Record<string, unknown>): string | null {
  const skillName = typeof externalRef.skillName === 'string' ? externalRef.skillName.trim() : '';
  return skillName || null;
}

function validateSkillName(skillName: string, skillNamePattern: RegExp): { ok: true } | { ok: false; error: string } {
  if (!skillNamePattern.test(skillName)) {
    return { ok: false, error: `skill name must match ${skillNamePattern}` };
  }
  return { ok: true };
}

function buildBundleBodyFromSkillDir(skillDir: string) {
  return buildPromptBundleBodyFromDirectory({
    rootDirectory: skillDir,
    preferredFirstPath: 'SKILL.md',
  });
}

function safeBuildBundleBodyFromSkillDir(params: Readonly<{
  skillDir: string;
  happierHomeDir?: () => string;
}>): { ok: true; bundleBody: ReturnType<typeof buildBundleBodyFromSkillDir> } | { ok: false; error: string } {
  try {
    const resolved = resolveReadableSkillContentRoot(params);
    if (!resolved.ok) return resolved;
    return { ok: true, bundleBody: buildBundleBodyFromSkillDir(resolved.contentRoot) };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error && error.message.trim().length > 0
        ? error.message
        : 'skill directory contains unsupported symlinks',
    };
  }
}

function resolveSkillDir(params: Readonly<{
  rootPath: string;
  skillName: string;
}>): string {
  return join(params.rootPath, params.skillName);
}

type PromptAssetMutationErrorResponseV1 = Extract<PromptAssetMutationResponseV1, { ok: false }>;
type PromptAssetReadErrorResponseV1 = Extract<PromptAssetReadResponseV1, { ok: false }>;

function toReadError(
  errorCode: PromptAssetMutationErrorCodeV1,
  error: string,
): PromptAssetReadErrorResponseV1 {
  return { ok: false, errorCode, error };
}

function toMutationError(
  errorCode: PromptAssetMutationErrorCodeV1,
  error: string,
  currentDigest?: string | null,
): PromptAssetMutationErrorResponseV1 {
  return {
    ok: false,
    errorCode,
    error,
    ...(currentDigest !== undefined ? { currentDigest } : {}),
  };
}

export function createSkillMdPromptAssetAdapter(
  config: SkillMdPromptAssetAdapterConfig,
  params?: Readonly<{ homedir?: () => string; happierHomeDir?: () => string }>,
): PromptAssetAdapter {
  const skillNamePattern = config.skillNamePattern ?? DEFAULT_SKILL_NAME_PATTERN;

  const descriptor: PromptAssetTypeDescriptorV1 = {
    id: config.assetTypeId,
    providerId: config.providerId,
    title: config.title,
    description: config.description,
    libraryKind: 'bundle',
    supportsScope: { user: true, project: true },
    supportsFiles: true,
    formatId: 'skill_md_v1',
    defaultRoots: [
      { label: 'Project skills', scope: 'project', pathTemplate: config.projectRootDisplayPath },
      { label: 'User skills', scope: 'user', pathTemplate: config.userRootDisplayPath },
    ],
    capabilities: config.capabilities ?? {},
  };

  function buildDiscoveryItem(paramsInner: Readonly<{
    scope: 'user' | 'project';
    skillName: string;
    displayRoot: string;
    bundleBody: ReturnType<typeof buildBundleBodyFromSkillDir>;
  }>): PromptAssetDiscoveryItemV1 {
    return {
      assetTypeId: config.assetTypeId,
      scope: paramsInner.scope,
      externalRef: { skillName: paramsInner.skillName },
      title: paramsInner.skillName,
      libraryKind: 'bundle',
      bundleSchemaId: 'skills.skill_md_v1',
      digest: computePromptBundleDigest(paramsInner.bundleBody),
      displayPath: `${paramsInner.displayRoot}/${paramsInner.skillName}`,
    };
  }

  function buildReadItem(paramsInner: Readonly<{
    scope: 'user' | 'project';
    skillName: string;
    displayRoot: string;
    bundleBody: ReturnType<typeof buildBundleBodyFromSkillDir>;
  }>): Extract<PromptAssetReadResponseV1, { ok: true }>['item'] {
    return {
      assetTypeId: config.assetTypeId,
      scope: paramsInner.scope,
      externalRef: { skillName: paramsInner.skillName },
      title: paramsInner.skillName,
      libraryKind: 'bundle',
      bundleSchemaId: 'skills.skill_md_v1',
      digest: computePromptBundleDigest(paramsInner.bundleBody),
      displayPath: `${paramsInner.displayRoot}/${paramsInner.skillName}`,
      bundleBody: paramsInner.bundleBody,
    };
  }

  return {
    descriptor,

    async discover(request: PromptAssetDiscoverRequest) {
      const root = resolveSkillRootPath({
        scope: request.scope,
        directory: request.directory,
        homedir: params?.homedir,
        config,
      });
      if (!root.ok || !existsSync(root.rootPath)) return [];

      return readdirSync(root.rootPath, { withFileTypes: true })
        .map((dirent) => dirent.name.trim())
        .filter((skillName) => validateSkillName(skillName, skillNamePattern).ok)
        .flatMap((skillName) => {
          const skillDir = resolveSkillDir({ rootPath: root.rootPath, skillName });
          const readableRoot = resolveReadableSkillContentRoot({
            skillDir,
            happierHomeDir: params?.happierHomeDir,
          });
          if (!readableRoot.ok || !existsSync(join(readableRoot.contentRoot, 'SKILL.md'))) return [];
          const bundleBody = safeBuildBundleBodyFromSkillDir({
            skillDir,
            happierHomeDir: params?.happierHomeDir,
          });
          if (!bundleBody.ok) return [];
          return [buildDiscoveryItem({
            scope: request.scope,
            skillName,
            displayRoot: root.displayRoot,
            bundleBody: bundleBody.bundleBody,
          })];
        });
    },

    async read(request: PromptAssetReadRequest): Promise<PromptAssetReadResponseV1> {
      const root = resolveSkillRootPath({
        scope: request.scope,
        directory: request.directory,
        homedir: params?.homedir,
        config,
      });
      if (!root.ok) return toReadError('invalid_request', root.error);

      const skillName = readSkillNameFromExternalRef(request.externalRef);
      if (!skillName) return toReadError('invalid_request', 'externalRef.skillName is required');
      const skillNameValidation = validateSkillName(skillName, skillNamePattern);
      if (!skillNameValidation.ok) return toReadError('invalid_request', skillNameValidation.error);

      const skillDir = resolveSkillDir({ rootPath: root.rootPath, skillName });
      const readableRoot = resolveReadableSkillContentRoot({
        skillDir,
        happierHomeDir: params?.happierHomeDir,
      });
      if (!readableRoot.ok || !existsSync(join(readableRoot.contentRoot, 'SKILL.md'))) {
        return toReadError('not_found', 'skill not found');
      }
      const bundleBody = safeBuildBundleBodyFromSkillDir({
        skillDir,
        happierHomeDir: params?.happierHomeDir,
      });
      if (!bundleBody.ok) return toReadError('access_denied', bundleBody.error);

      return {
        ok: true,
        item: buildReadItem({
          scope: request.scope,
          skillName,
          displayRoot: root.displayRoot,
          bundleBody: bundleBody.bundleBody,
        }),
      };
    },

    async writeBundle(request: PromptAssetWriteBundleRequest): Promise<PromptAssetMutationResponseV1> {
      const root = resolveSkillRootPath({
        scope: request.scope,
        directory: request.directory,
        homedir: params?.homedir,
        config,
      });
      if (!root.ok) return toMutationError('invalid_request', root.error);

      const skillNameValidation = validateSkillName(request.targetName, skillNamePattern);
      if (!skillNameValidation.ok) return toMutationError('invalid_request', skillNameValidation.error);

      const bundleValidation = validatePromptBundleBodyV1AgainstSchemaId({
        bundleSchemaId: request.bundleSchemaId,
        body: request.bundleBody,
      });
      if (!bundleValidation.ok) return toMutationError('invalid_request', bundleValidation.message);

      const skillDir = resolveSkillDir({ rootPath: root.rootPath, skillName: request.targetName });
      const installMode = request.installMode ?? 'copy';
      const preview = {
        operation: 'write' as const,
        targetPath: `${root.displayRoot}/${request.targetName}`,
        fileCount: request.bundleBody.entries.length,
      };

      if (installMode === 'symlink' && descriptor.capabilities.supportsSymlinkInstall !== true) {
        return toMutationError('unsupported', 'symlink installs are not supported for this prompt asset type');
      }

      const currentBundleBody = existsSync(skillDir) ? safeBuildBundleBodyFromSkillDir({
        skillDir,
        happierHomeDir: params?.happierHomeDir,
      }) : null;
      if (currentBundleBody && !currentBundleBody.ok) return toMutationError('access_denied', currentBundleBody.error);
      const currentDigest = currentBundleBody?.ok ? computePromptBundleDigest(currentBundleBody.bundleBody) : null;
      if (request.expectedDigest && request.expectedDigest !== currentDigest) {
        return toMutationError('conflict', 'prompt asset has changed on disk', currentDigest);
      }

      if (request.previewOnly === true) {
        return {
          ok: true,
          externalRef: { skillName: request.targetName },
          digest: computePromptBundleDigest(request.bundleBody),
          preview,
        };
      }

      const installDirectory = installMode === 'symlink'
        ? resolvePromptAssetManagedBundleInstallDir({
            assetTypeId: config.assetTypeId,
            scope: request.scope,
            directory: request.directory,
            targetName: request.targetName,
            happierHomeDir: params?.happierHomeDir,
          })
        : skillDir;

      deleteManagedBundleSymlinkInstall({
        linkPath: skillDir,
        happierHomeDir: params?.happierHomeDir,
      });
      rmSync(installDirectory, { recursive: true, force: true });
      mkdirSync(installDirectory, { recursive: true });
      for (const entry of request.bundleBody.entries) {
        const absolutePath = join(installDirectory, entry.path.split('/').join(sep));
        mkdirSync(dirname(absolutePath), { recursive: true });
        writeFileSync(absolutePath, Buffer.from(entry.contentBase64, 'base64'));
        if (typeof entry.unixMode === 'number') {
          chmodSync(absolutePath, entry.unixMode);
        }
      }
      if (installMode === 'symlink') {
        replaceDirectoryWithManagedSymlink({
          linkPath: skillDir,
          managedDirectory: installDirectory,
        });
      }
      const committedBundleBody = safeBuildBundleBodyFromSkillDir({
        skillDir,
        happierHomeDir: params?.happierHomeDir,
      });
      if (!committedBundleBody.ok) return toMutationError('access_denied', committedBundleBody.error);
      const committedDigest = computePromptBundleDigest(committedBundleBody.bundleBody);

      return {
        ok: true,
        externalRef: { skillName: request.targetName },
        digest: committedDigest,
        preview,
      };
    },

    async writeDoc(_request: PromptAssetWriteDocRequest): Promise<PromptAssetMutationResponseV1> {
      return toMutationError('unsupported', 'doc writes are not supported for this prompt asset type');
    },

    async delete(request: PromptAssetDeleteRequest): Promise<PromptAssetMutationResponseV1> {
      const root = resolveSkillRootPath({
        scope: request.scope,
        directory: request.directory,
        homedir: params?.homedir,
        config,
      });
      if (!root.ok) return toMutationError('invalid_request', root.error);

      const skillName = readSkillNameFromExternalRef(request.externalRef);
      if (!skillName) return toMutationError('invalid_request', 'externalRef.skillName is required');
      const skillNameValidation = validateSkillName(skillName, skillNamePattern);
      if (!skillNameValidation.ok) return toMutationError('invalid_request', skillNameValidation.error);

      const skillDir = resolveSkillDir({ rootPath: root.rootPath, skillName });
      const currentBundleBody = existsSync(skillDir) ? safeBuildBundleBodyFromSkillDir({
        skillDir,
        happierHomeDir: params?.happierHomeDir,
      }) : null;
      if (currentBundleBody && !currentBundleBody.ok) return toMutationError('access_denied', currentBundleBody.error);
      const currentDigest = currentBundleBody?.ok ? computePromptBundleDigest(currentBundleBody.bundleBody) : null;
      if (!currentDigest) return toMutationError('not_found', 'skill not found');
      if (request.expectedDigest && request.expectedDigest !== currentDigest) {
        return toMutationError('conflict', 'prompt asset has changed on disk', currentDigest);
      }

      const preview = {
        operation: 'delete' as const,
        targetPath: `${root.displayRoot}/${skillName}`,
        fileCount: currentBundleBody?.ok ? currentBundleBody.bundleBody.entries.length : 0,
      };

      if (request.previewOnly === true) {
        return {
          ok: true,
          externalRef: { skillName },
          digest: currentDigest,
          preview,
        };
      }

      deleteManagedBundleSymlinkInstall({
        linkPath: skillDir,
        happierHomeDir: params?.happierHomeDir,
      });
      return {
        ok: true,
        externalRef: { skillName },
        digest: currentDigest,
        preview,
      };
    },
  };
}
