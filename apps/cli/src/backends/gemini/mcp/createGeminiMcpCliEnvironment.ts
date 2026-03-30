import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import type { McpServerConfig } from '@/agent/core';
import { resolveGeminiConfigPaths } from '@/backends/gemini/utils/resolveGeminiConfigPaths';
import { logger } from '@/ui/logger';

type EnvLike = Readonly<Record<string, string | undefined>>;

type JsonObject = Record<string, unknown>;

const GEMINI_SOURCE_FILE_SELECTORS = [
  (paths: ReturnType<typeof resolveGeminiConfigPaths>) => paths.userOauthCredsPath,
  (paths: ReturnType<typeof resolveGeminiConfigPaths>) => paths.userConfigPath,
  (paths: ReturnType<typeof resolveGeminiConfigPaths>) => paths.xdgConfigPath,
  (paths: ReturnType<typeof resolveGeminiConfigPaths>) => paths.userAuthPath,
  (paths: ReturnType<typeof resolveGeminiConfigPaths>) => paths.xdgAuthPath,
  (paths: ReturnType<typeof resolveGeminiConfigPaths>) => paths.userSettingsPath,
] as const;

function ensureParentDir(path: string): void {
  mkdirSync(dirname(path), { recursive: true });
}

function stripJsonComments(input: string): string {
  let result = '';
  let inString = false;
  let escaping = false;
  let inLineComment = false;
  let inBlockComment = false;

  for (let index = 0; index < input.length; index += 1) {
    const current = input[index] ?? '';
    const next = input[index + 1] ?? '';

    if (inLineComment) {
      if (current === '\n') {
        inLineComment = false;
        result += current;
      }
      continue;
    }

    if (inBlockComment) {
      if (current === '*' && next === '/') {
        inBlockComment = false;
        index += 1;
      }
      continue;
    }

    if (!inString && current === '/' && next === '/') {
      inLineComment = true;
      index += 1;
      continue;
    }

    if (!inString && current === '/' && next === '*') {
      inBlockComment = true;
      index += 1;
      continue;
    }

    result += current;

    if (!inString && current === '"') {
      inString = true;
      escaping = false;
      continue;
    }

    if (inString) {
      if (escaping) {
        escaping = false;
      } else if (current === '\\') {
        escaping = true;
      } else if (current === '"') {
        inString = false;
      }
    }
  }

  return result;
}

function readJsonObjectWithComments(path: string): JsonObject {
  if (!existsSync(path)) return {};

  try {
    const raw = readFileSync(path, 'utf8');
    const parsed = JSON.parse(stripJsonComments(raw)) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as JsonObject : {};
  } catch (error) {
    logger.debug(`[Gemini] Failed to parse copied settings at ${path}; continuing with MCP-only settings`, error);
    return {};
  }
}

function sanitizeEnvTokenSegment(value: string): string {
  const sanitized = value
    .trim()
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toUpperCase();
  return sanitized.length > 0 ? sanitized : 'VALUE';
}

function createGeminiMcpEnvVarName(params: {
  serverName: string;
  envName: string;
  usedNames: Set<string>;
}): string {
  const serverSegment = sanitizeEnvTokenSegment(params.serverName);
  const envSegment = sanitizeEnvTokenSegment(params.envName);
  const baseName = `HAPPIER_GEMINI_MCP_ENV_${serverSegment}_${envSegment}`;

  if (!params.usedNames.has(baseName)) {
    params.usedNames.add(baseName);
    return baseName;
  }

  let suffix = 2;
  while (params.usedNames.has(`${baseName}_${suffix}`)) {
    suffix += 1;
  }

  const uniqueName = `${baseName}_${suffix}`;
  params.usedNames.add(uniqueName);
  return uniqueName;
}

function buildGeminiSettingsMcpServers(
  mcpServers: Readonly<Record<string, McpServerConfig>>,
  cwd: string,
): {
  entries: Record<string, { command: string; args: string[]; env: Record<string, string>; cwd: string }>;
  launchEnv: Record<string, string>;
} {
  const entries: Record<string, { command: string; args: string[]; env: Record<string, string>; cwd: string }> = {};
  const launchEnv: Record<string, string> = {};
  const usedNames = new Set<string>();

  for (const [name, server] of Object.entries(mcpServers)) {
    const serverEnv: Record<string, string> = {};
    for (const [envName, envValue] of Object.entries(server.env ?? {})) {
      const launchEnvName = createGeminiMcpEnvVarName({
        serverName: name,
        envName,
        usedNames,
      });
      launchEnv[launchEnvName] = envValue;
      serverEnv[envName] = `$${launchEnvName}`;
    }

    entries[name] = {
      command: server.command,
      args: Array.isArray(server.args) ? [...server.args] : [],
      env: serverEnv,
      cwd,
    };
  }

  return {
    entries,
    launchEnv,
  };
}

function copyKnownGeminiConfigFiles(params: {
  sourceEnv: EnvLike;
  targetEnv: EnvLike;
}): void {
  const sourcePaths = resolveGeminiConfigPaths(params.sourceEnv);
  const targetPaths = resolveGeminiConfigPaths(params.targetEnv);

  for (const selectPath of GEMINI_SOURCE_FILE_SELECTORS) {
    const sourcePath = selectPath(sourcePaths);
    if (!existsSync(sourcePath)) continue;
    const targetPath = selectPath(targetPaths);
    ensureParentDir(targetPath);
    copyFileSync(sourcePath, targetPath);
  }
}

export function createGeminiMcpCliEnvironment(params: {
  cwd: string;
  processEnv?: EnvLike;
  mcpServers: Readonly<Record<string, McpServerConfig>>;
}): Readonly<{
  cliHomeDir: string;
  env: Readonly<Record<string, string>>;
  cleanup: () => void;
}> {
  const cliHomeDir = mkdtempSync(join(tmpdir(), 'happier-gemini-mcp-home-'));
  const baseEnv = {
    GEMINI_CLI_HOME: cliHomeDir,
    HOME: cliHomeDir,
    XDG_CONFIG_HOME: join(cliHomeDir, '.config'),
  } as const;

  copyKnownGeminiConfigFiles({
    sourceEnv: params.processEnv ?? process.env,
    targetEnv: baseEnv,
  });

  const targetPaths = resolveGeminiConfigPaths(baseEnv);
  const mcpSettings = buildGeminiSettingsMcpServers(params.mcpServers, params.cwd);
  const existingSettings = readJsonObjectWithComments(targetPaths.userSettingsPath);
  const nextSettings = {
    ...existingSettings,
    mcpServers: {
      ...(existingSettings.mcpServers && typeof existingSettings.mcpServers === 'object' && !Array.isArray(existingSettings.mcpServers)
        ? existingSettings.mcpServers as JsonObject
        : {}),
      ...mcpSettings.entries,
    },
  };

  ensureParentDir(targetPaths.userSettingsPath);
  writeFileSync(targetPaths.userSettingsPath, JSON.stringify(nextSettings, null, 2), 'utf8');

  const env = {
    ...baseEnv,
    ...mcpSettings.launchEnv,
  };

  return {
    cliHomeDir,
    env,
    cleanup: () => {
      rmSync(cliHomeDir, { recursive: true, force: true });
    },
  };
}
