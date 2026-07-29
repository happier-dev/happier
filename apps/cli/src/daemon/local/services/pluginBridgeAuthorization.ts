import { randomUUID } from 'node:crypto';
import { isAbsolute, join, relative, resolve } from 'node:path';

import { resolveReleaseRingScopedBasename } from '@/cli/runtime/publicReleaseChannel';
import {
  hashPrivateBearer,
  removePrivateBearerFileSync,
  verifyPrivateBearer,
  writePrivateBearerFile,
} from '@/daemon/privateBearerFile';

import { HAPPIER_PLUGIN_LOCAL_SERVICES_BRIDGE_TOKEN_FILE_ENV_KEY } from './pluginBridgeProtocol';

type PublicReleaseRingParam = Parameters<typeof resolveReleaseRingScopedBasename>[1];

export type PluginLocalServicesBridgeAuthorization = Readonly<{
  tokenHash: string;
  pluginId: string;
  contributionId: string;
  tokenFilePath?: string;
}>;

export type DurablePluginLocalServicesBridgeAuthorization = Readonly<{
  v: 1;
  tokenHash: string;
  pluginId: string;
  contributionId: string;
  tokenFilePath?: string;
}>;

export type CreatedPluginLocalServicesBridgeAuthorization = Readonly<{
  authorization: PluginLocalServicesBridgeAuthorization & { tokenFilePath: string };
  childEnv: Readonly<Record<typeof HAPPIER_PLUGIN_LOCAL_SERVICES_BRIDGE_TOKEN_FILE_ENV_KEY, string>>;
  cleanupTokenFile: () => void;
}>;

export function hashPluginLocalServicesBridgeToken(token: string): string {
  return hashPrivateBearer(token);
}

export function isPluginLocalServicesBridgeTokenHash(value: unknown): value is string {
  return typeof value === 'string' && /^sha256:[a-f0-9]{64}$/u.test(value);
}

export function verifyPluginLocalServicesBridgeToken(params: Readonly<{
  providedToken: string;
  expectedTokenHash: string;
}>): boolean {
  if (!isPluginLocalServicesBridgeTokenHash(params.expectedTokenHash)) {
    return false;
  }
  return verifyPrivateBearer({
    provided: params.providedToken,
    expectedHash: params.expectedTokenHash,
  });
}

function bridgeTokenDir(params: Readonly<{
  happyHomeDir: string;
  publicReleaseRing: PublicReleaseRingParam;
}>): string {
  return join(
    params.happyHomeDir,
    'tmp',
    resolveReleaseRingScopedBasename(
      'plugin-local-services-bridge-tokens',
      params.publicReleaseRing,
    ),
  );
}

function isPathInsideDir(filePath: string, dirPath: string): boolean {
  const relativePath = relative(resolve(dirPath), resolve(filePath));
  return !!relativePath && !relativePath.startsWith('..') && !isAbsolute(relativePath);
}

export function cleanupPluginLocalServicesBridgeTokenFile(params: Readonly<{
  happyHomeDir: string;
  publicReleaseRing: PublicReleaseRingParam;
  tokenFilePath: string | undefined;
}>): void {
  const tokenFilePath = typeof params.tokenFilePath === 'string' ? params.tokenFilePath.trim() : '';
  if (!tokenFilePath) {
    return;
  }
  const dir = bridgeTokenDir(params);
  if (!isPathInsideDir(tokenFilePath, dir)) {
    return;
  }
  try {
    removePrivateBearerFileSync(tokenFilePath);
  } catch {
    // Token files are best-effort cleanup artifacts; never let cleanup failure mask session cleanup.
  }
}

export async function createPluginLocalServicesBridgeAuthorization(params: Readonly<{
  happyHomeDir: string;
  publicReleaseRing: PublicReleaseRingParam;
  token: string;
  pluginId: string;
  contributionId: string;
}>): Promise<CreatedPluginLocalServicesBridgeAuthorization> {
  const token = params.token.trim();
  const pluginId = params.pluginId.trim();
  const contributionId = params.contributionId.trim();
  if (!token || !pluginId || !contributionId) {
    throw new Error('Cannot create plugin local-services bridge authorization without token, pluginId, and contributionId');
  }

  const dir = bridgeTokenDir(params);
  const tokenFilePath = join(dir, `${process.pid}-${randomUUID()}.token`);
  await writePrivateBearerFile({ path: tokenFilePath, contents: `${token}\n` });

  return Object.freeze({
    authorization: Object.freeze({
      tokenHash: hashPluginLocalServicesBridgeToken(token),
      pluginId,
      contributionId,
      tokenFilePath,
    }),
    childEnv: Object.freeze({
      [HAPPIER_PLUGIN_LOCAL_SERVICES_BRIDGE_TOKEN_FILE_ENV_KEY]: tokenFilePath,
    }),
    cleanupTokenFile: () => cleanupPluginLocalServicesBridgeTokenFile({
      happyHomeDir: params.happyHomeDir,
      publicReleaseRing: params.publicReleaseRing,
      tokenFilePath,
    }),
  });
}

export function toDurablePluginLocalServicesBridgeAuthorization(
  authorization: PluginLocalServicesBridgeAuthorization | undefined,
): DurablePluginLocalServicesBridgeAuthorization | undefined {
  if (
    !authorization ||
    !isPluginLocalServicesBridgeTokenHash(authorization.tokenHash) ||
    !authorization.pluginId.trim() ||
    !authorization.contributionId.trim()
  ) {
    return undefined;
  }
  return {
    v: 1,
    tokenHash: authorization.tokenHash,
    pluginId: authorization.pluginId.trim(),
    contributionId: authorization.contributionId.trim(),
    ...(authorization.tokenFilePath?.trim() ? { tokenFilePath: authorization.tokenFilePath.trim() } : {}),
  };
}

export function toTrackedPluginLocalServicesBridgeAuthorizationFields(
  authorization: DurablePluginLocalServicesBridgeAuthorization | PluginLocalServicesBridgeAuthorization | undefined,
): Readonly<{
  localServicesBridgeTokenHash?: string;
  localServicesBridgePluginId?: string;
  localServicesBridgeContributionId?: string;
  localServicesBridgeTokenFilePath?: string;
}> {
  const durable = toDurablePluginLocalServicesBridgeAuthorization(authorization);
  if (!durable) {
    return {};
  }
  return {
    localServicesBridgeTokenHash: durable.tokenHash,
    localServicesBridgePluginId: durable.pluginId,
    localServicesBridgeContributionId: durable.contributionId,
    ...(durable.tokenFilePath ? { localServicesBridgeTokenFilePath: durable.tokenFilePath } : {}),
  };
}
