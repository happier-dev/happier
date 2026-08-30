import { execFile as execFileCallback } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { resolveWindowsCommandInvocation } from '@happier-dev/cli-common/process';

import { buildOpenCodeAgentRuntimeDescriptor } from '@happier-dev/agents';
import { buildOpenCodeSessionEnvironmentVariables } from '../utils/opencodeSessionAffinity';
import { resolveOpenCodeCliLaunchSpec } from '../utils/resolveOpenCodeCliCommand';
import type { ImportedSessionHandoffBundle, OpenCodeSessionBundle } from '../../../session/handoff/types';
import { copySessionHandoffFileSlice } from '../../../session/handoff/sessionHandoffProviderBundleFile';
import { OPEN_CODE_IMPORT_EXPORT_JSON_MAX_BYTES } from './opencodeHandoffLimits';

type ExecFileAsync = (
  command: string,
  args: readonly string[],
  options?: Readonly<{ windowsVerbatimArguments?: boolean }>,
) => Promise<Readonly<{ stdout: string; stderr: string }>>;

const execFileAsync = promisify(execFileCallback) as unknown as ExecFileAsync;
const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

function resolveOpenCodeImportFileName(remoteSessionId: string): string {
  if (!remoteSessionId || remoteSessionId.includes('/') || remoteSessionId.includes('\\')) {
    throw new Error(`Invalid remoteSessionId for OpenCode handoff: ${remoteSessionId}`);
  }
  return `${remoteSessionId}.json`;
}

function estimateBase64DecodedBytes(value: string): number {
  const paddingBytes = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
  return Math.floor((value.length * 3) / 4) - paddingBytes;
}

function decodeOpenCodeImportExportJson(exportJsonBase64: string): string {
  if (!BASE64_PATTERN.test(exportJsonBase64)) {
    throw new Error('Invalid OpenCode handoff export payload encoding');
  }

  const decoded = Buffer.from(exportJsonBase64, 'base64').toString('utf8');

  try {
    JSON.parse(decoded);
  } catch {
    throw new Error('Invalid OpenCode handoff export payload JSON');
  }

  return decoded;
}

export async function importOpenCodeSessionBundle(params: Readonly<{
  bundle: OpenCodeSessionBundle;
  targetPath: string;
  execFile?: ExecFileAsync;
  sessionStorageMode?: 'direct' | 'persisted';
  processEnv?: NodeJS.ProcessEnv;
}>): Promise<ImportedSessionHandoffBundle> {
  const execFile = params.execFile ?? execFileAsync;
  const exportFile = params.bundle.exportJsonFile;
  const exportSizeBytes = exportFile
    ? exportFile.sizeBytes
    : estimateBase64DecodedBytes(params.bundle.exportJsonBase64 ?? '');
  if (exportSizeBytes > OPEN_CODE_IMPORT_EXPORT_JSON_MAX_BYTES) {
    throw new Error(`OpenCode handoff import export payload exceeds size limit (${OPEN_CODE_IMPORT_EXPORT_JSON_MAX_BYTES} bytes)`);
  }
  const importFileName = resolveOpenCodeImportFileName(params.bundle.remoteSessionId);
  const tempDir = await mkdtemp(join(tmpdir(), 'handoff-opencode-'));
  const importPath = join(tempDir, importFileName);
  try {
    if (exportFile) {
      await copySessionHandoffFileSlice({ source: exportFile, targetFilePath: importPath });
      try {
        JSON.parse(await readFile(importPath, 'utf8'));
      } catch {
        throw new Error('Invalid OpenCode handoff export payload JSON');
      }
    } else {
      await writeFile(importPath, decodeOpenCodeImportExportJson(params.bundle.exportJsonBase64 ?? ''), 'utf8');
    }
    const launch = resolveOpenCodeCliLaunchSpec(params.processEnv);
    const invocation = resolveWindowsCommandInvocation({
      command: launch.command,
      args: [...launch.args, 'import', importPath],
      env: params.processEnv ?? process.env,
      resolveCommandOnPath: false,
    });
    await execFile(
      invocation.command,
      invocation.args,
      invocation.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : undefined,
    );

    // Direct sessions currently only support OpenCode's server transport (`DirectSessionsSource.kind=opencodeServer`).
    // If an exported bundle claims ACP affinity, treat it as a requested/preferred mode and normalize the imported
    // runtime envelope to server so downstream direct-session linking cannot end up in an impossible ACP state.
    const backendMode = params.bundle.affinity.backendMode === 'server'
      ? 'server'
      : params.bundle.affinity.backendMode === 'acp'
        ? 'server'
        : null;

    return {
      remoteSessionId: params.bundle.remoteSessionId,
      directSource: {
        kind: 'opencodeServer',
        // Only pin baseUrl when the exported affinity explicitly requested it. Otherwise, allow the
        // target machine to resolve its default opencode server URL independently.
        baseUrl: params.bundle.affinity.serverBaseUrlExplicit ? params.bundle.affinity.serverBaseUrl : null,
        directory: params.targetPath,
      },
      ...(backendMode ? {
        agentRuntimeDescriptorV1: buildOpenCodeAgentRuntimeDescriptor({
          backendMode,
          vendorSessionId: params.bundle.remoteSessionId,
          ...(params.bundle.affinity.serverBaseUrlExplicit ? { serverBaseUrl: params.bundle.affinity.serverBaseUrl } : {}),
          ...(params.bundle.affinity.serverBaseUrlExplicit ? { serverBaseUrlExplicit: true } : {}),
        }),
      } : {}),
      resume: {
        directory: params.targetPath,
        agent: 'opencode',
        resume: params.bundle.remoteSessionId,
        environmentVariables: buildOpenCodeSessionEnvironmentVariables({
          backendMode,
          serverBaseUrl: params.bundle.affinity.serverBaseUrlExplicit ? params.bundle.affinity.serverBaseUrl : null,
          serverBaseUrlExplicit: params.bundle.affinity.serverBaseUrlExplicit,
        }),
        transcriptStorage: params.sessionStorageMode === 'persisted' ? 'persisted' : 'direct',
        approvedNewDirectoryCreation: true,
      },
    };
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}
