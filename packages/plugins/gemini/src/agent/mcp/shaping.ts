import { createSecureTempDirectorySync, linkDirectoryChildren } from '@happier-dev/plugin-sdk/fs';
import { isRecord, PluginError } from '@happier-dev/plugin-sdk';
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { resolveGeminiConfigPaths, resolveGeminiNativePolicyPaths } from '../utils/configPaths.js';
import type { AgentSessionConfigurationSnapshot, AgentSessionSkillDelivery } from '@happier-dev/plugin-sdk/agents/runtime';

type EnvLike = Readonly<Record<string, string | undefined>>;
type JsonObject = Record<string, unknown>;

const GEMINI_ALLOWED_SOURCE_FILE_SELECTORS = [
  (paths: ReturnType<typeof resolveGeminiConfigPaths>) => paths.userConfigPath,
  (paths: ReturnType<typeof resolveGeminiConfigPaths>) => paths.xdgConfigPath,
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

function readJsonObjectWithComments(path: string): { ok: boolean; value: JsonObject } {
  try {
    const raw = readFileSync(path, 'utf8');
    const parsed = JSON.parse(stripJsonComments(raw)) as unknown;
    return {
      ok: isRecord(parsed),
      value: isRecord(parsed) ? parsed : {},
    };
  } catch (error) {
    return { ok: error instanceof Error && 'code' in error && error.code === 'ENOENT', value: {} };
  }
}

function copyKnownGeminiConfigFiles(params: {
  sourceEnv: EnvLike;
  targetEnv: EnvLike;
  copyUserSettings?: boolean;
}): void {
  const sourcePaths = resolveGeminiConfigPaths(params.sourceEnv);
  const targetPaths = resolveGeminiConfigPaths(params.targetEnv);

  for (const selectPath of GEMINI_ALLOWED_SOURCE_FILE_SELECTORS) {
    const sourcePath = selectPath(sourcePaths);
    if (params.copyUserSettings === false && sourcePath === sourcePaths.userSettingsPath) continue;
    if (!existsSync(sourcePath)) continue;
    const targetPath = selectPath(targetPaths);
    ensureParentDir(targetPath);
    copyFileSync(sourcePath, targetPath);
  }
}

function scrubCopiedGeminiSettingsMcpServers(targetEnv: EnvLike): void {
  const targetPaths = resolveGeminiConfigPaths(targetEnv);
  if (!existsSync(targetPaths.userSettingsPath)) return;

  const readResult = readJsonObjectWithComments(targetPaths.userSettingsPath);
  if (!readResult.ok) {
    writeFileSync(targetPaths.userSettingsPath, JSON.stringify({}, null, 2), 'utf8');
    return;
  }

  const existingSettings = readResult.value;
  if (!Object.prototype.hasOwnProperty.call(existingSettings, 'mcpServers')) return;

  const nextSettings = { ...existingSettings };
  delete nextSettings.mcpServers;
  writeFileSync(targetPaths.userSettingsPath, JSON.stringify(nextSettings, null, 2), 'utf8');
}

function readNativeProviderPolicy(result: ReturnType<typeof readJsonObjectWithComments>) {
  const unavailable = () => new PluginError({ code: 'gemini_provider_auth_policy_unavailable', retryable: false,
    message: 'Gemini Provider binding cannot read the native authentication policy safely.' });
  if (!result.ok) throw unavailable();
  const experimental = result.value.experimental;
  const modelConfigs = result.value.modelConfigs;
  if (experimental !== undefined && !isRecord(experimental)) throw unavailable();
  // Do not mirror Gemini's experimental routing or native alias/override engine.
  const dynamicModels = experimental?.dynamicModelConfiguration;
  if ((dynamicModels !== undefined && dynamicModels !== false)
    || (modelConfigs !== undefined && modelConfigs !== null
      && (!isRecord(modelConfigs) || Object.keys(modelConfigs).length > 0))) {
    throw new PluginError({ code: 'gemini_provider_model_policy_unsupported', retryable: false,
      message: 'Gemini Provider binding cannot preserve a literal model with native model-routing configuration.' });
  }
  const security = result.value.security;
  if (security === undefined) return {};
  if (!isRecord(security)) throw unavailable();
  const auth = security.auth;
  if (auth === undefined) return {};
  if (!isRecord(auth)) throw unavailable();
  const selectedType = auth.selectedType;
  const enforcedType = auth.enforcedType;
  if ((selectedType !== undefined && typeof selectedType !== 'string')
    || (enforcedType !== undefined && typeof enforcedType !== 'string')) throw unavailable();
  return { ...(selectedType !== undefined ? { selectedType } : {}),
    ...(enforcedType !== undefined ? { enforcedType } : {}) };
}

function prepareCopiedProviderAuthentication(params: {
  sourceEnv: EnvLike;
  targetEnv: EnvLike;
  cwd: string;
  type: 'gemini-api-key';
  noTools: boolean;
}) {
  const paths = resolveGeminiNativePolicyPaths(params.sourceEnv);
  const userPath = resolveGeminiConfigPaths(params.targetEnv).userSettingsPath;
  const userSettings = readJsonObjectWithComments(resolveGeminiConfigPaths(params.sourceEnv).userSettingsPath);
  const systemSettings = readJsonObjectWithComments(paths.systemSettingsPath);
  const defaults = readNativeProviderPolicy(readJsonObjectWithComments(paths.systemDefaultsPath));
  const user = { ...readNativeProviderPolicy(userSettings), selectedType: params.type };
  const workspace = readNativeProviderPolicy(readJsonObjectWithComments(join(params.cwd, '.gemini', 'settings.json')));
  const system = readNativeProviderPolicy(systemSettings);
  // Native Gemini alone decides folder trust. Both possible native outcomes
  // must preserve the binding; do not reproduce its trusted-folders policy.
  for (const policy of [{ ...defaults, ...user, ...system }, { ...defaults, ...user, ...workspace, ...system }]) {
    if (policy.selectedType !== params.type || (policy.enforcedType && policy.enforcedType !== params.type)) {
      throw new PluginError({ code: 'gemini_provider_auth_policy_conflict', retryable: false,
        message: 'Gemini Provider binding conflicts with a potentially active native authentication policy.' });
    }
  }
  if (params.noTools) {
    if (!systemSettings.ok || Object.keys(systemSettings.value).length > 0) {
      throw new PluginError({ code: 'gemini_provider_native_policy_unsupported', retryable: false,
        message: 'Gemini Provider binding cannot replace native System policy for a no-tools launch.' });
    }
  }
  const security = isRecord(userSettings.value.security) ? userSettings.value.security : {};
  const auth = isRecord(security.auth) ? security.auth : {};
  ensureParentDir(userPath);
  writeFileSync(userPath, JSON.stringify({ ...userSettings.value, security: { ...security,
    auth: { ...auth, selectedType: params.type },
  } }), 'utf8');
  return paths;
}

/** Native sessions own this temporary home for exactly their composer lifetime. */
export async function prepareGeminiNativeMcpShaping(
  sourceEnv: EnvLike = process.env,
  configuration?: Pick<AgentSessionConfigurationSnapshot, 'allowedTools' | 'unlistedTools'>,
  skills?: AgentSessionSkillDelivery,
  providerAuth?: Readonly<{ type: 'gemini-api-key'; cwd: string }>,
) {
  const tempDirectory = createSecureTempDirectorySync({ prefix: 'happier-gemini-mcp-home' });
  const cliHomeDir = tempDirectory.path;
  const baseEnv = {
    GEMINI_CLI_HOME: cliHomeDir,
    HOME: cliHomeDir,
    XDG_CONFIG_HOME: join(cliHomeDir, '.config'),
  };
  const noTools = configuration?.unlistedTools === 'deny' && configuration.allowedTools?.length === 0;
  const toolSettingsPath = join(cliHomeDir, 'no-tools-settings.json');
  let providerDefaultsPath: string | undefined;

  try {
    copyKnownGeminiConfigFiles({ sourceEnv, targetEnv: baseEnv, copyUserSettings: !providerAuth });
    if (providerAuth) {
      const nativePaths = prepareCopiedProviderAuthentication({ sourceEnv, targetEnv: baseEnv,
        ...providerAuth, noTools });
      if (noTools) providerDefaultsPath = nativePaths.systemDefaultsPath;
    }
    scrubCopiedGeminiSettingsMcpServers(baseEnv);
    if (noTools) {
      // Gemini's system settings override workspace/user settings. An empty
      // core allowlist removes built-ins; admin controls also stop ambient MCP
      // and extension discovery rather than denying a later model tool call.
      writeFileSync(toolSettingsPath, JSON.stringify({
        tools: { core: [] },
        admin: { mcp: { enabled: false }, extensions: { enabled: false } },
      }), 'utf8');
    }
    const sourceHome = resolveGeminiConfigPaths(sourceEnv).cliHomeDir;
    await Promise.all([
      ['.gemini', 'skills'],
      ['.agents', 'skills'],
      ['.gemini', 'extensions'],
    ].map((segments) => linkDirectoryChildren({
      source: join(sourceHome, ...segments),
      destination: join(cliHomeDir, ...segments),
    })));
    if (skills) {
      const destination = join(cliHomeDir, '.agents', 'skills');
      for (const item of skills.items) {
        if (!statSync(join(item.directory, 'SKILL.md')).isFile()) {
          throw new Error('Gemini session skill is unavailable');
        }
        if (process.platform === 'win32' && !existsSync(join(destination, basename(item.directory)))) {
          cpSync(item.directory, join(destination, basename(item.directory)), { recursive: true });
        }
      }
      if (process.platform !== 'win32') {
        await linkDirectoryChildren({ source: skills.skillsRoot, destination });
      }
      if (skills.nativeDisables.length > 0) {
        const settingsPath = resolveGeminiConfigPaths(baseEnv).userSettingsPath;
        const settings = readJsonObjectWithComments(settingsPath).value;
        const existing = settings.skills;
        const skillSettings = existing && typeof existing === 'object' && !Array.isArray(existing)
          ? existing as JsonObject : {};
        const disabled = Array.isArray(skillSettings.disabled)
          ? skillSettings.disabled.filter((name): name is string => typeof name === 'string') : [];
        ensureParentDir(settingsPath);
        writeFileSync(settingsPath, JSON.stringify({ ...settings, skills: { ...skillSettings,
          disabled: [...new Set([...disabled, ...skills.nativeDisables.map(item => item.name)].map(name => name.toLowerCase()))],
        } }), 'utf8');
      }
    }
  } catch (error) {
    tempDirectory.cleanup();
    throw error;
  }

  let cleaned = false;
  return {
    env: { ...baseEnv, ...(noTools ? { GEMINI_CLI_SYSTEM_SETTINGS_PATH: toolSettingsPath } : {}),
      ...(providerDefaultsPath ? { GEMINI_CLI_SYSTEM_DEFAULTS_PATH: providerDefaultsPath } : {}) },
    async cleanup() {
      if (cleaned) return;
      cleaned = true;
      tempDirectory.cleanup();
    },
  };
}
