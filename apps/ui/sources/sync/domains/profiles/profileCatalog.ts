import { type AIBackendProfile } from '../settings/settings';
import { getAgentCore } from '@/agents/catalog/catalog';

/**
 * Get a built-in AI backend profile by ID.
 * Built-in profiles provide sensible defaults for popular AI providers.
 *
 * ENVIRONMENT VARIABLE FLOW:
 * 1. User launches daemon with env vars: Z_AI_AUTH_TOKEN=sk-... Z_AI_BASE_URL=https://api.z.ai
 * 2. Profile defines mappings: ANTHROPIC_AUTH_TOKEN=${Z_AI_AUTH_TOKEN}
 * 3. When spawning session, daemon expands ${VAR} from its process.env
 * 4. Session receives: ANTHROPIC_AUTH_TOKEN=sk-... (actual value)
 * 5. Claude CLI reads ANTHROPIC_* env vars, connects to Z.AI
 *
 * This pattern lets users:
 * - Set credentials ONCE when launching daemon
 * - Switch backends by selecting different profiles
 * - Each profile maps daemon env vars to what CLI expects
 *
 * @param id - The profile ID (anthropic, deepseek, zai, openai, azure-openai, together)
 * @returns The complete profile configuration, or null if not found
 */
export const getBuiltInProfile = (id: string): AIBackendProfile | null => {
    switch (id) {
        case 'anthropic':
            return {
                id: 'anthropic',
                name: 'Anthropic (Default)',
                authMode: 'machineLogin',
                requiresMachineLogin: getAgentCore('claude').cli.machineLoginKey,
                environmentVariables: [],
                defaultPermissionModeByAgent: { claude: 'default' },
                compatibility: { claude: true, codex: false, gemini: false },
                envVarRequirements: [],
                isBuiltIn: true,
                createdAt: Date.now(),
                updatedAt: Date.now(),
                version: '1.0.0',
            };
        case 'deepseek':
            // DeepSeek profile: Maps DEEPSEEK_* daemon environment to ANTHROPIC_* for Claude CLI
            // Launch daemon with: DEEPSEEK_AUTH_TOKEN=sk-... DEEPSEEK_BASE_URL=https://api.deepseek.com/anthropic
            // Uses ${VAR:-default} format for fallback values (bash parameter expansion)
            // Secrets use ${VAR} without fallback for security
            // NOTE: Profiles are env-var based; environmentVariables are the single source of truth.
            return {
                id: 'deepseek',
                name: 'DeepSeek (Reasoner)',
                envVarRequirements: [{ name: 'DEEPSEEK_AUTH_TOKEN', kind: 'secret', required: true }],
                environmentVariables: [
                    { name: 'ANTHROPIC_BASE_URL', value: '${DEEPSEEK_BASE_URL:-https://api.deepseek.com/anthropic}' },
                    { name: 'ANTHROPIC_AUTH_TOKEN', value: '${DEEPSEEK_AUTH_TOKEN}' }, // Secret - no fallback
                    { name: 'API_TIMEOUT_MS', value: '${DEEPSEEK_API_TIMEOUT_MS:-600000}' },
                    { name: 'ANTHROPIC_MODEL', value: '${DEEPSEEK_MODEL:-deepseek-reasoner}' },
                    { name: 'ANTHROPIC_SMALL_FAST_MODEL', value: '${DEEPSEEK_SMALL_FAST_MODEL:-deepseek-chat}' },
                    { name: 'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC', value: '${DEEPSEEK_CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:-1}' },
                ],
                defaultPermissionModeByAgent: { claude: 'default' },
                compatibility: { claude: true, codex: false, gemini: false },
                isBuiltIn: true,
                createdAt: Date.now(),
                updatedAt: Date.now(),
                version: '1.0.0',
            };
        case 'zai':
            // Z.AI profile: Maps Z_AI_* daemon environment to ANTHROPIC_* for Claude CLI
            // Launch daemon with: Z_AI_AUTH_TOKEN=sk-... Z_AI_BASE_URL=https://api.z.ai/api/anthropic
            // Model mappings: Z_AI_OPUS_MODEL=GLM-4.6, Z_AI_SONNET_MODEL=GLM-4.6, Z_AI_HAIKU_MODEL=GLM-4.5-Air
            // Uses ${VAR:-default} format for fallback values (bash parameter expansion)
            // Secrets use ${VAR} without fallback for security
            // NOTE: Profiles are env-var based; environmentVariables are the single source of truth.
            return {
                id: 'zai',
                name: 'Z.AI (GLM-4.6)',
                envVarRequirements: [{ name: 'Z_AI_AUTH_TOKEN', kind: 'secret', required: true }],
                environmentVariables: [
                    { name: 'ANTHROPIC_BASE_URL', value: '${Z_AI_BASE_URL:-https://api.z.ai/api/anthropic}' },
                    { name: 'ANTHROPIC_AUTH_TOKEN', value: '${Z_AI_AUTH_TOKEN}' }, // Secret - no fallback
                    { name: 'API_TIMEOUT_MS', value: '${Z_AI_API_TIMEOUT_MS:-3000000}' },
                    { name: 'ANTHROPIC_MODEL', value: '${Z_AI_MODEL:-GLM-4.6}' },
                    { name: 'ANTHROPIC_DEFAULT_OPUS_MODEL', value: '${Z_AI_OPUS_MODEL:-GLM-4.6}' },
                    { name: 'ANTHROPIC_DEFAULT_SONNET_MODEL', value: '${Z_AI_SONNET_MODEL:-GLM-4.6}' },
                    { name: 'ANTHROPIC_DEFAULT_HAIKU_MODEL', value: '${Z_AI_HAIKU_MODEL:-GLM-4.5-Air}' },
                ],
                defaultPermissionModeByAgent: { claude: 'default' },
                compatibility: { claude: true, codex: false, gemini: false },
                isBuiltIn: true,
                createdAt: Date.now(),
                updatedAt: Date.now(),
                version: '1.0.0',
            };
        case 'codex':
            return {
                id: 'codex',
                name: 'Codex (Default)',
                authMode: 'machineLogin',
                requiresMachineLogin: getAgentCore('codex').cli.machineLoginKey,
                environmentVariables: [],
                defaultPermissionModeByAgent: { codex: 'default' },
                compatibility: { claude: false, codex: true, gemini: false },
                envVarRequirements: [],
                isBuiltIn: true,
                createdAt: Date.now(),
                updatedAt: Date.now(),
                version: '1.0.0',
            };
        case 'openai':
            return {
                id: 'openai',
                name: 'OpenAI (GPT-5)',
                envVarRequirements: [{ name: 'OPENAI_API_KEY', kind: 'secret', required: true }],
                environmentVariables: [
                    { name: 'OPENAI_BASE_URL', value: 'https://api.openai.com/v1' },
                    { name: 'OPENAI_MODEL', value: 'gpt-5-codex-high' },
                    { name: 'OPENAI_API_TIMEOUT_MS', value: '600000' },
                    { name: 'OPENAI_SMALL_FAST_MODEL', value: 'gpt-5-codex-low' },
                    { name: 'API_TIMEOUT_MS', value: '600000' },
                    { name: 'CODEX_SMALL_FAST_MODEL', value: 'gpt-5-codex-low' },
                ],
                defaultPermissionModeByAgent: { codex: 'default' },
                compatibility: { claude: false, codex: true, gemini: false },
                isBuiltIn: true,
                createdAt: Date.now(),
                updatedAt: Date.now(),
                version: '1.0.0',
            };
        case 'azure-openai':
            return {
                id: 'azure-openai',
                name: 'Azure OpenAI',
                envVarRequirements: [{ name: 'AZURE_OPENAI_API_KEY', kind: 'secret', required: true }],
                environmentVariables: [
                    { name: 'AZURE_OPENAI_API_VERSION', value: '2024-02-15-preview' },
                    { name: 'OPENAI_API_TIMEOUT_MS', value: '600000' },
                    { name: 'API_TIMEOUT_MS', value: '600000' },
                ],
                defaultPermissionModeByAgent: { codex: 'default' },
                compatibility: { claude: false, codex: true, gemini: false },
                isBuiltIn: true,
                createdAt: Date.now(),
                updatedAt: Date.now(),
                version: '1.0.0',
            };
        case 'gemini':
            return {
                id: 'gemini',
                name: 'Gemini (Default)',
                authMode: 'machineLogin',
                requiresMachineLogin: getAgentCore('gemini').cli.machineLoginKey,
                environmentVariables: [],
                defaultPermissionModeByAgent: { gemini: 'default' },
                compatibility: { claude: false, codex: false, gemini: true },
                envVarRequirements: [],
                isBuiltIn: true,
                createdAt: Date.now(),
                updatedAt: Date.now(),
                version: '1.0.0',
            };
        case 'gemini-api-key':
            return {
                id: 'gemini-api-key',
                name: 'Gemini (API key)',
                envVarRequirements: [{ name: 'GEMINI_API_KEY', kind: 'secret', required: true }],
                environmentVariables: [{ name: 'GEMINI_MODEL', value: 'gemini-2.5-pro' }],
                defaultPermissionModeByAgent: { gemini: 'default' },
                compatibility: { claude: false, codex: false, gemini: true },
                isBuiltIn: true,
                createdAt: Date.now(),
                updatedAt: Date.now(),
                version: '1.0.0',
            };
        case 'gemini-vertex':
            return {
                id: 'gemini-vertex',
                name: 'Gemini (Vertex AI)',
                envVarRequirements: [
                    { name: 'GOOGLE_CLOUD_PROJECT', kind: 'config', required: true },
                    { name: 'GOOGLE_CLOUD_LOCATION', kind: 'config', required: true },
                ],
                environmentVariables: [
                    { name: 'GOOGLE_GENAI_USE_VERTEXAI', value: '1' },
                    { name: 'GEMINI_MODEL', value: 'gemini-2.5-pro' },
                ],
                defaultPermissionModeByAgent: { gemini: 'default' },
                compatibility: { claude: false, codex: false, gemini: true },
                isBuiltIn: true,
                createdAt: Date.now(),
                updatedAt: Date.now(),
                version: '1.0.0',
            };
        default:
            return null;
    }
};

/**
 * Default built-in profiles available to all users.
 * These provide quick-start configurations for popular AI providers.
 */
export const DEFAULT_PROFILES = [
    {
        id: 'anthropic',
        name: 'Anthropic (Default)',
        isBuiltIn: true,
    },
    {
        id: 'deepseek',
        name: 'DeepSeek (Reasoner)',
        isBuiltIn: true,
    },
    {
        id: 'zai',
        name: 'Z.AI (GLM-4.6)',
        isBuiltIn: true,
    },
    {
        id: 'codex',
        name: 'Codex (Default)',
        isBuiltIn: true,
    },
    {
        id: 'openai',
        name: 'OpenAI (GPT-5)',
        isBuiltIn: true,
    },
    {
        id: 'azure-openai',
        name: 'Azure OpenAI',
        isBuiltIn: true,
    },
    {
        id: 'gemini',
        name: 'Gemini (Default)',
        isBuiltIn: true,
    },
    {
        id: 'gemini-api-key',
        name: 'Gemini (API key)',
        isBuiltIn: true,
    },
    {
        id: 'gemini-vertex',
        name: 'Gemini (Vertex AI)',
        isBuiltIn: true,
    },
];
