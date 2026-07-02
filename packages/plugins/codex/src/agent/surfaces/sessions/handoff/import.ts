import { mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';

import {
  ExternalSessionsSourceSchema,
  type ExternalSessionsSource,
} from '@happier-dev/protocol';

import {
  readCanonicalCodexRuntimeDescriptorV1,
  resolvePersistedCodexRuntimeIdentity,
  toCanonicalCodexRuntimeBackendMode,
} from '../../../identity/runtimeDescriptor.js';
import { buildCodexAgentRuntimeDescriptor } from '../../../../protocol/runtimeDescriptorV1.js';
import type {
  CodexSessionHandoffBundle,
  ImportedCodexSessionHandoffBundle,
} from './bundle.js';

function parseExternalSessionsSource(source: unknown): ExternalSessionsSource | null {
  const parsedSource = ExternalSessionsSourceSchema.safeParse(source);
  return parsedSource.success ? parsedSource.data : null;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function resolveCodexRuntimeSourceAffinity(source: unknown): Readonly<{
  home?: 'user' | 'connectedService';
  connectedServiceId?: string;
  connectedServiceProfileId?: string;
}> {
  const parsedSource = parseExternalSessionsSource(source);
  if (!parsedSource || parsedSource.kind !== 'codexHome') {
    return {};
  }

  return parsedSource.home === 'connectedService'
    ? {
      home: 'connectedService',
      connectedServiceId: optionalString(parsedSource.connectedServiceId),
      connectedServiceProfileId: optionalString(parsedSource.connectedServiceProfileId),
    }
    : { home: 'user' };
}

function resolveCodexHome(env: NodeJS.ProcessEnv): string {
  const raw = typeof env.CODEX_HOME === 'string' ? env.CODEX_HOME.trim() : '';
  return raw || join(homedir(), '.codex');
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
  bundle: CodexSessionHandoffBundle;
  targetPath: string;
  env: NodeJS.ProcessEnv;
  sessionStorageMode?: 'direct' | 'persisted';
}>): Promise<ImportedCodexSessionHandoffBundle> {
  const codexHome = resolveCodexHome(params.env);
  const runtimeIdentity = resolvePersistedCodexRuntimeIdentity(params.bundle) ?? { backendMode: 'appServer' as const };
  const runtimeBackendMode = toCanonicalCodexRuntimeBackendMode(runtimeIdentity.backendMode) ?? 'appServer';
  const importedRuntimeDescriptor = readCanonicalCodexRuntimeDescriptorV1(params.bundle.affinity?.runtimeDescriptor);
  const sourceAffinity = resolveCodexRuntimeSourceAffinity(params.bundle.affinity?.source);
  const runtimeDescriptor = importedRuntimeDescriptor
    ? buildCodexAgentRuntimeDescriptor({
      backendMode: importedRuntimeDescriptor.backendMode ?? runtimeBackendMode,
      providerSessionId: importedRuntimeDescriptor.providerSessionId,
      home: importedRuntimeDescriptor.home,
      connectedServiceId: importedRuntimeDescriptor.connectedServiceId,
      connectedServiceProfileId: importedRuntimeDescriptor.connectedServiceProfileId,
      connectedServiceGroupId: importedRuntimeDescriptor.connectedServiceGroupId,
      // Handoff bundles must be portable across machines; never import a source-machine homePath.
      // Rollout files are written into the *target* CODEX_HOME below, so the runtime must use that.
      homePath: codexHome,
    })
    : buildCodexAgentRuntimeDescriptor({
      backendMode: runtimeBackendMode,
      providerSessionId: params.bundle.remoteSessionId,
      ...sourceAffinity,
      homePath: codexHome,
    });
  const externalSource = runtimeDescriptor.provider.home === 'connectedService'
    ? {
      kind: 'codexHome' as const,
      home: 'connectedService' as const,
      ...(runtimeDescriptor.provider.connectedServiceId ? { connectedServiceId: runtimeDescriptor.provider.connectedServiceId } : {}),
      ...(runtimeDescriptor.provider.connectedServiceProfileId ? { connectedServiceProfileId: runtimeDescriptor.provider.connectedServiceProfileId } : {}),
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
    await writeFile(destPath, Buffer.from(file.contentBase64, 'base64'));
  }

  return {
    remoteSessionId: params.bundle.remoteSessionId,
    externalSource,
    runtimeDescriptorV1: runtimeDescriptor,
    resume: {
      directory: params.targetPath,
      agent: 'codex',
      resume: params.bundle.remoteSessionId,
      environmentVariables: { CODEX_HOME: codexHome },
      transcriptStorage: params.sessionStorageMode === 'persisted' ? 'persisted' : 'direct',
      approvedNewDirectoryCreation: true,
      codexBackendMode: runtimeBackendMode,
    },
  };
}
