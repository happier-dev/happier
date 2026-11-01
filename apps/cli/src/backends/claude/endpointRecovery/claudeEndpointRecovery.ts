import { constants as fsConstants } from 'node:fs';
import { access, readFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join } from 'node:path';

import { logger } from '@/ui/logger';
import { refreshRetainedClaudeHookPlugin } from '@/backends/claude/utils/generateHookSettings';
import { readTerminalAttachmentInfo } from '@/terminal/attachment/terminalAttachmentInfo';
import { createDefaultTerminalHostRegistry } from '@/integrations/terminalHost/defaultRegistry';
import { evaluateTerminalHostLivenessForRecovery } from '@/integrations/terminalHost/livenessPolicy';
import {
  HAPPIER_CLAUDE_ENDPOINT_STATE_ENV_KEY,
  type AttachmentBoundClaudeEndpointState,
  parseAttachmentBoundClaudeEndpointState,
  readClaudeEndpointDescriptor,
  writeClaudeEndpointDescriptor,
} from './claudeEndpointArtifacts';

export type ClaudeAdoptEndpointRecovery = Readonly<{
  state: AttachmentBoundClaudeEndpointState;
  permissionHookSecret: string;
  statuslineSecret: string;
}>;

function readPositiveInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : null;
}

function parseClaudeEndpointStateFromEnv(env: NodeJS.ProcessEnv = process.env): AttachmentBoundClaudeEndpointState | null {
  const raw = env[HAPPIER_CLAUDE_ENDPOINT_STATE_ENV_KEY];
  if (typeof raw !== 'string' || raw.trim().length === 0) return null;
  try {
    return parseAttachmentBoundClaudeEndpointState(JSON.parse(raw));
  } catch {
    return null;
  }
}

export function hasClaudeEndpointRecoveryRequest(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env[HAPPIER_CLAUDE_ENDPOINT_STATE_ENV_KEY];
  return typeof raw === 'string' && raw.trim().length > 0;
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path, fsConstants.R_OK);
    return true;
  } catch {
    return false;
  }
}

async function canBindRequestedLocalPort(port: number): Promise<boolean> {
  return await new Promise<boolean>((resolvePortAvailability) => {
    const server = createServer();
    let settled = false;
    const settle = (available: boolean) => {
      if (settled) return;
      settled = true;
      server.removeAllListeners('error');
      if (!available) {
        resolvePortAvailability(false);
        return;
      }
      server.close(() => resolvePortAvailability(true));
    };
    server.once('error', () => settle(false));
    server.listen(port, '127.0.0.1', () => settle(true));
  });
}

function collectHookForwarderPorts(value: unknown, ports: number[] = []): number[] {
  if (typeof value === 'string') {
    const match = /session_hook_forwarder\.cjs["']?\s+(\d+)/.exec(value);
    const port = match ? readPositiveInteger(Number(match[1])) : null;
    if (port) ports.push(port);
    return ports;
  }
  if (Array.isArray(value)) {
    for (const entry of value) collectHookForwarderPorts(entry, ports);
    return ports;
  }
  if (value && typeof value === 'object') {
    for (const entry of Object.values(value)) collectHookForwarderPorts(entry, ports);
  }
  return ports;
}

async function readRetainedHooksJsonHookServerPort(hooksJsonPath: string): Promise<number | null> {
  try {
    const parsed = JSON.parse(await readFile(hooksJsonPath, 'utf8')) as unknown;
    const ports = Array.from(new Set(collectHookForwarderPorts(parsed)));
    return ports.length === 1 ? ports[0] ?? null : null;
  } catch {
    return null;
  }
}

export async function resolveClaudeAdoptEndpointRecoveryForState(
  state: AttachmentBoundClaudeEndpointState,
  options: Readonly<{
    permissionHookTimeoutSeconds?: number;
    observeNativeToolPrompts?: boolean;
  }> = {},
): Promise<ClaudeAdoptEndpointRecovery | null> {
  if (!state.hookPluginDir) return null;

  const permissionSecretPath = join(state.hookPluginDir, 'permission-hook-secret');
  const hooksJsonPath = join(state.hookPluginDir, 'hooks', 'hooks.json');
  const statuslineSecretFilePath = state.statuslineSecretFilePath
    ?? state.hookSettingsPath.replace(/\.json$/, '.statusline-secret');
  const requiredPaths = [
    state.hookPluginDir,
    hooksJsonPath,
    permissionSecretPath,
    state.hookSettingsPath,
    ...(state.hookSettingsOverlayPath ? [state.hookSettingsOverlayPath] : []),
    statuslineSecretFilePath,
  ];
  const missing = [];
  for (const path of requiredPaths) if (!(await fileExists(path))) missing.push(path);
  if (missing.length > 0) {
    logger.debug('[claude] Claude adopt-first recovery skipped because retained endpoint artifacts are missing', { missing });
    return null;
  }

  const retainedHookServerPort = await readRetainedHooksJsonHookServerPort(hooksJsonPath);
  if (retainedHookServerPort !== state.hookServerPort) {
    logger.debug('[claude] Claude adopt-first recovery skipped because retained hooks.json does not match endpoint state', {
      descriptorHookServerPort: state.hookServerPort,
      retainedHookServerPort,
    });
    return null;
  }

  const permissionHookSecret = (await readFile(permissionSecretPath, 'utf8')).trim();
  const statuslineSecret = (await readFile(statuslineSecretFilePath, 'utf8')).trim();
  if (!permissionHookSecret || !statuslineSecret) return null;
  const [hookPortAvailable, mcpPortAvailable] = await Promise.all([
    canBindRequestedLocalPort(state.hookServerPort),
    canBindRequestedLocalPort(state.mcpPort),
  ]);
  if (!hookPortAvailable || !mcpPortAvailable) {
    logger.debug('[claude] Claude adopt-first recovery skipped because retained endpoint port is occupied', {
      hookServerPort: state.hookServerPort,
      hookPortAvailable,
      mcpPort: state.mcpPort,
      mcpPortAvailable,
    });
    return null;
  }
  try {
    refreshRetainedClaudeHookPlugin({
      pluginDir: state.hookPluginDir,
      port: state.hookServerPort,
      observeNativeToolPrompts: options.observeNativeToolPrompts,
      ...(options.permissionHookTimeoutSeconds === undefined
        ? {}
        : { permissionHookTimeoutSeconds: options.permissionHookTimeoutSeconds }),
    });
  } catch (error) {
    logger.debug('[claude] Claude adopt-first recovery skipped because retained hook refresh failed', { error });
    return null;
  }
  return { state, permissionHookSecret, statuslineSecret };
}

export async function resolveClaudeAdoptEndpointRecovery(options: Readonly<{
  permissionHookTimeoutSeconds?: number;
  observeNativeToolPrompts?: boolean;
  /** Explicit continuation, consumed only after this runner's Session lock admission. */
  existingSession?: Readonly<{ happyHomeDir: string; sessionId: string }>;
}> = {}): Promise<ClaudeAdoptEndpointRecovery | null> {
  let state = parseClaudeEndpointStateFromEnv();
  if (!hasClaudeEndpointRecoveryRequest() && options.existingSession) {
    const attachment = await readTerminalAttachmentInfo(options.existingSession);
    // A foreground shell is not transferable owned-host custody. A dead or
    // unproven host still belongs to the existing terminal disposition owner.
    if (attachment?.version !== 2) return null;
    const adapter = (await createDefaultTerminalHostRegistry())[attachment.handle.kind];
    if (!adapter || (await evaluateTerminalHostLivenessForRecovery(adapter, attachment.handle)).status !== 'alive') return null;
    state = await readClaudeEndpointDescriptor({ ...options.existingSession, attachmentId: attachment.attachmentId });
  }
  return state ? await resolveClaudeAdoptEndpointRecoveryForState(state, options) : null;
}

export function buildClaudeEndpointState(params: Readonly<{
  attachmentId: string;
  hookServerPort: number;
  hookPluginDir: string | null;
  hookSettingsPath: string;
  mcpUrl: string;
  mcpPort: number;
}>): AttachmentBoundClaudeEndpointState {
  return {
    v: 2,
    attachmentId: params.attachmentId,
    hookServerPort: params.hookServerPort,
    hookPluginDir: params.hookPluginDir,
    hookSettingsPath: params.hookSettingsPath,
    hookSettingsOverlayPath: params.hookSettingsPath.replace(/\.json$/, '.overlay.json'),
    statuslineSecretFilePath: params.hookSettingsPath.replace(/\.json$/, '.statusline-secret'),
    mcpUrl: params.mcpUrl,
    mcpPort: params.mcpPort,
  };
}

export function parsePortFromUrl(url: string): number | null {
  try {
    const port = Number(new URL(url).port);
    return Number.isInteger(port) && port > 0 ? port : null;
  } catch {
    return null;
  }
}

export async function persistClaudeEndpointStateBestEffort(params: Readonly<{
  happyHomeDir: string;
  sessionId: string;
  state: AttachmentBoundClaudeEndpointState;
}>): Promise<boolean> {
  try {
    await writeClaudeEndpointDescriptor({
      happyHomeDir: params.happyHomeDir,
      sessionId: params.sessionId,
      endpointState: params.state,
    });
    return true;
  } catch (error) {
    logger.debug('[claude] Failed to persist Claude endpoint recovery state', error);
    return false;
  }
}
