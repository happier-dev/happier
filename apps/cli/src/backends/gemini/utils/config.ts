/**
 * Gemini Configuration Utilities
 * 
 * Utilities for reading and writing Gemini CLI configuration files,
 * including API keys, tokens, and model settings.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { logger } from '@/ui/logger';
import { DEFAULT_GEMINI_MODEL } from '../constants';
import { resolveGeminiConfigPaths } from './resolveGeminiConfigPaths';

/**
 * Result of reading Gemini local configuration
 */
export interface GeminiLocalConfig {
  token: string | null;
  model: string | null;
  googleCloudProject: string | null;
  /** Email associated with the stored Google Cloud Project (for per-account projects) */
  googleCloudProjectEmail: string | null;
}

function readStringField(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

function readSettingsModelName(record: Record<string, unknown>): string | null {
  const model = record.model;
  if (typeof model === 'string' && model.trim().length > 0) return model;
  if (!model || typeof model !== 'object' || Array.isArray(model)) return null;
  const name = (model as Record<string, unknown>).name;
  return typeof name === 'string' && name.trim().length > 0 ? name : null;
}

/**
 * Try to read Gemini config (auth token and model) from local Gemini CLI config
 * Gemini CLI stores tokens in ~/.gemini/ or uses gcloud Application Default Credentials
 */
export function readGeminiLocalConfig(env: Readonly<Record<string, string | undefined>> = process.env): GeminiLocalConfig {
  return readGeminiLocalConfigFromEnv(env);
}

export function readGeminiLocalConfigFromEnv(env: Readonly<Record<string, string | undefined>>): GeminiLocalConfig {
  let token: string | null = null;
  let model: string | null = null;
  let googleCloudProject: string | null = null;
  let googleCloudProjectEmail: string | null = null;

  const paths = resolveGeminiConfigPaths(env);
  const possiblePaths = [
    paths.userOauthCredsPath,
    paths.userSettingsPath,
    paths.userConfigPath,
    paths.xdgConfigPath,
    paths.userAuthPath,
    paths.xdgAuthPath,
  ];

  for (const configPath of possiblePaths) {
    if (existsSync(configPath)) {
      try {
        const config = JSON.parse(readFileSync(configPath, 'utf-8'));
        if (!token) {
          const foundToken = config.token || config.apiKey || config.GEMINI_API_KEY;
          if (foundToken && typeof foundToken === 'string') {
            token = foundToken;
            logger.debug(`[Gemini] Found token in ${configPath}`);
          }
        }

        if (!model) {
          const foundModel = readSettingsModelName(config) ?? readStringField(config, 'GEMINI_MODEL');
          if (foundModel) {
            model = foundModel;
            logger.debug(`[Gemini] Found model in ${configPath}: ${model}`);
          }
        }

        if (!googleCloudProject) {
          const foundProject = config.googleCloudProject || config.google_cloud_project || config.projectId;
          if (foundProject && typeof foundProject === 'string') {
            googleCloudProject = foundProject;
            if (config.googleCloudProjectEmail && typeof config.googleCloudProjectEmail === 'string') {
              googleCloudProjectEmail = config.googleCloudProjectEmail;
            }
            logger.debug(
              `[Gemini] Found Google Cloud Project in ${configPath}: ${googleCloudProject}${googleCloudProjectEmail ? ` (for ${googleCloudProjectEmail})` : ''}`,
            );
          }
        }
      } catch (error) {
        logger.debug(`[Gemini] Failed to read config from ${configPath}:`, error);
      }
    }
  }

  if (!googleCloudProject) {
    const envProject = env.GOOGLE_CLOUD_PROJECT || env.GOOGLE_CLOUD_PROJECT_ID;
    if (envProject) {
      googleCloudProject = envProject;
      googleCloudProjectEmail = null;
      logger.debug(`[Gemini] Found Google Cloud Project from env: ${googleCloudProject}`);
    }
  }

  return { token, model, googleCloudProject, googleCloudProjectEmail };
}

/**
 * Determine the model to use based on priority:
 * 1. Explicit model parameter (if provided)
 * 2. Local config file
 * 3. Default model
 * 
 * @param explicitModel - Model explicitly provided (undefined = check sources, null = skip config)
 * @param localConfig - Local config result from readGeminiLocalConfig()
 * @returns The model string to use
 */
export function determineGeminiModel(
  explicitModel: string | null | undefined,
  localConfig: GeminiLocalConfig,
  _env: Readonly<Record<string, string | undefined>> = process.env,
): string {
  if (explicitModel !== undefined) {
    if (explicitModel === null) {
      // Explicitly null - skip local config and inherited model env.
      return DEFAULT_GEMINI_MODEL;
    } else {
      // Model explicitly provided - use it
      return explicitModel;
    }
  } else {
    // No explicit model - defer to Gemini CLI settings/auto routing instead of inherited env.
    logger.debug(`[Gemini] Model selection: localConfig.model=${localConfig.model}, DEFAULT=${DEFAULT_GEMINI_MODEL}`);
    const model = localConfig.model || DEFAULT_GEMINI_MODEL;
    logger.debug(`[Gemini] Selected model: ${model}`);
    return model;
  }
}

/**
 * Save model to Gemini config file
 * 
 * @param model - The model name to save
 */
export function saveGeminiModelToConfig(model: string): void {
  try {
    const { geminiDir: configDir, userConfigPath: configPath } = resolveGeminiConfigPaths();
    
    // Create directory if it doesn't exist
    if (!existsSync(configDir)) {
      mkdirSync(configDir, { recursive: true });
    }
    
    // Read existing config or create new one
    let config: any = {};
    if (existsSync(configPath)) {
      try {
        config = JSON.parse(readFileSync(configPath, 'utf-8'));
      } catch (error) {
        logger.debug(`[Gemini] Failed to read existing config, creating new one`);
        config = {};
      }
    }
    
    // Update model in config
    config.model = model;
    
    // Write config back
    writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');
    logger.debug(`[Gemini] Saved model "${model}" to ${configPath}`);
  } catch (error) {
    logger.debug(`[Gemini] Failed to save model to config:`, error);
    // Don't throw - this is not critical
  }
}

/**
 * Save Google Cloud Project ID to Gemini config file
 * 
 * @param projectId - The Google Cloud Project ID to save
 * @param email - Optional email to associate with this project (for per-account projects)
 */
export function saveGoogleCloudProjectToConfig(projectId: string, email?: string): void {
  try {
    const { geminiDir: configDir, userConfigPath: configPath } = resolveGeminiConfigPaths();
    
    // Create directory if it doesn't exist
    if (!existsSync(configDir)) {
      mkdirSync(configDir, { recursive: true });
    }
    
    // Read existing config or create new one
    let config: Record<string, unknown> = {};
    if (existsSync(configPath)) {
      try {
        config = JSON.parse(readFileSync(configPath, 'utf-8'));
      } catch {
        config = {};
      }
    }
    
    // Update project in config
    config.googleCloudProject = projectId;
    
    // Store the associated email if provided
    if (email) {
      config.googleCloudProjectEmail = email;
    }
    
    // Write config back
    writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');
    logger.debug(`[Gemini] Saved Google Cloud Project "${projectId}"${email ? ` for ${email}` : ''} to ${configPath}`);
  } catch (error) {
    logger.debug(`[Gemini] Failed to save Google Cloud Project to config:`, error);
    throw error; // This is important - let user know if save failed
  }
}

/**
 * Get the initial model value for UI display
 * Priority: local config > default
 * 
 * @returns The initial model string
 */
export function getInitialGeminiModel(): string {
  return getInitialGeminiModelFromEnv(process.env);
}

export function getInitialGeminiModelFromEnv(
  env: Readonly<Record<string, string | undefined>>,
): string {
  const localConfig = readGeminiLocalConfig(env);
  return localConfig.model || DEFAULT_GEMINI_MODEL;
}

/**
 * Determine the source of the model for logging purposes
 * 
 * @param explicitModel - Model explicitly provided (undefined = check sources, null = skip config)
 * @param localConfig - Local config result from readGeminiLocalConfig()
 * @returns Source identifier: 'explicit' | 'local-config' | 'default'
 */
export function getGeminiModelSource(
  explicitModel: string | null | undefined,
  localConfig: GeminiLocalConfig,
  _env: Readonly<Record<string, string | undefined>> = process.env,
): 'explicit' | 'local-config' | 'default' {
  if (explicitModel !== undefined && explicitModel !== null) {
    return 'explicit';
  } else if (localConfig.model) {
    return 'local-config';
  } else {
    return 'default';
  }
}
