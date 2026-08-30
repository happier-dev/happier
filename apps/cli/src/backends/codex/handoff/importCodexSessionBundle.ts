import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';

import {
  buildCodexAgentRuntimeDescriptor,
  resolvePersistedCodexRuntimeIdentity,
} from '@happier-dev/agents';
import {
  DirectSessionsSourceSchema,
  readCanonicalAgentRuntimeDescriptorV1ForProvider,
} from '@happier-dev/protocol';

import type { CodexSessionBundle, ImportedSessionHandoffBundle } from '../../../session/handoff/types';
import { copySessionHandoffFileSlice } from '../../../session/handoff/sessionHandoffProviderBundleFile';
import { resolveConfiguredCodexHome } from '../utils/resolveConfiguredCodexHome';
import { resolveConfiguredCodexSqliteHome } from '../connectedServices/codexStateFileNames';

function resolveCodexRuntimeSourceAffinity(source: unknown): Readonly<{
  home?: 'user' | 'connectedService';
  connectedServiceId?: string;
  connectedServiceProfileId?: string;
  connectedServiceGroupId?: string;
}> {
  const parsedSource = DirectSessionsSourceSchema.safeParse(source);
  if (!parsedSource.success || parsedSource.data.kind !== 'codexHome') {
    return {};
  }

  return parsedSource.data.home === 'connectedService'
    ? {
      home: 'connectedService',
      connectedServiceId: parsedSource.data.connectedServiceId,
      connectedServiceProfileId: parsedSource.data.connectedServiceProfileId,
      connectedServiceGroupId: parsedSource.data.connectedServiceGroupId,
    }
    : { home: 'user' };
}

function resolveContainedCodexPath(codexHome: string, relativePath: string): string {
  const root = resolve(codexHome);
  const candidate = resolve(root, relativePath);
  const relativeCandidate = relative(root, candidate);
  if (relativeCandidate.startsWith('..') || isAbsolute(relativeCandidate)) {
    throw new Error(`Codex bundle path escapes CODEX_HOME: ${relativePath}`);
  }
  return candidate;
}

export async function importCodexSessionBundle(params: Readonly<{
  bundle: CodexSessionBundle;
  targetPath: string;
  env: NodeJS.ProcessEnv;
  sessionStorageMode?: 'direct' | 'persisted';
}>): Promise<ImportedSessionHandoffBundle> {
  const codexHome = resolveConfiguredCodexHome(params.env);
  const sqliteHome = resolveConfiguredCodexSqliteHome(params.env);
  const runtimeIdentity = resolvePersistedCodexRuntimeIdentity(params.bundle) ?? { backendMode: 'appServer' as const };
  const importedRuntimeDescriptor = readCanonicalAgentRuntimeDescriptorV1ForProvider(params.bundle.affinity?.runtimeDescriptor, 'codex');
  const sourceAffinity = resolveCodexRuntimeSourceAffinity(params.bundle.affinity?.source);
  const runtimeDescriptor = importedRuntimeDescriptor
    ? buildCodexAgentRuntimeDescriptor({
      backendMode: importedRuntimeDescriptor.backendMode ?? runtimeIdentity.backendMode,
      vendorSessionId: importedRuntimeDescriptor.vendorSessionId,
      home: importedRuntimeDescriptor.home,
      connectedServiceId: importedRuntimeDescriptor.connectedServiceId,
      connectedServiceProfileId: importedRuntimeDescriptor.connectedServiceProfileId,
      connectedServiceGroupId: importedRuntimeDescriptor.connectedServiceGroupId,
      // Handoff bundles must be portable across machines; never import a source-machine homePath.
      // Rollout files are written into the *target* CODEX_HOME below, so the runtime must use that.
      homePath: codexHome,
      sqliteHomePath: sqliteHome,
    })
    : buildCodexAgentRuntimeDescriptor({
      backendMode: runtimeIdentity.backendMode,
      vendorSessionId: params.bundle.remoteSessionId,
      ...sourceAffinity,
      homePath: codexHome,
      sqliteHomePath: sqliteHome,
    });
  const directSource = runtimeDescriptor.provider.home === 'connectedService'
    ? {
      kind: 'codexHome' as const,
      home: 'connectedService' as const,
      ...(runtimeDescriptor.provider.connectedServiceId ? { connectedServiceId: runtimeDescriptor.provider.connectedServiceId } : {}),
      ...(runtimeDescriptor.provider.connectedServiceProfileId ? { connectedServiceProfileId: runtimeDescriptor.provider.connectedServiceProfileId } : {}),
      ...(runtimeDescriptor.provider.connectedServiceGroupId ? { connectedServiceGroupId: runtimeDescriptor.provider.connectedServiceGroupId } : {}),
      // Intentionally omit any homePath: connected-service homes are resolved/verified per-machine.
    }
    : {
      kind: 'codexHome' as const,
      home: 'user' as const,
      homePath: codexHome,
    };
  for (const file of params.bundle.files) {
    const destPath = resolveContainedCodexPath(codexHome, file.relativePath);
    await mkdir(dirname(destPath), { recursive: true });
    if (file.contentFile) {
      await copySessionHandoffFileSlice({ source: file.contentFile, targetFilePath: destPath });
    } else {
      await writeFile(destPath, Buffer.from(file.contentBase64, 'base64'));
    }
  }

  return {
    remoteSessionId: params.bundle.remoteSessionId,
    directSource,
    agentRuntimeDescriptorV1: runtimeDescriptor,
    resume: {
      directory: params.targetPath,
      agent: 'codex',
      resume: params.bundle.remoteSessionId,
      environmentVariables: { CODEX_HOME: codexHome, CODEX_SQLITE_HOME: sqliteHome },
      transcriptStorage: params.sessionStorageMode === 'persisted' ? 'persisted' : 'direct',
      approvedNewDirectoryCreation: true,
      ...(runtimeIdentity ? { codexBackendMode: runtimeIdentity.backendMode } : {}),
    },
  };
}
