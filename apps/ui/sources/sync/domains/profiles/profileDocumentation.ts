export interface ProfileDocumentation {
    setupGuideUrl?: string; // Link to official setup documentation
    description: string; // Clear description of what this profile does
    environmentVariables: {
        name: string; // Environment variable name (e.g., "Z_AI_BASE_URL")
        expectedValue: string; // What value it should have (e.g., "https://api.z.ai/api/anthropic")
        description: string; // What this variable does
        isSecret: boolean; // Whether this is a secret (never retrieve or display actual value)
    }[];
    shellConfigExample: string; // Example .zshrc/.bashrc configuration
}

/**
 * Get documentation for a built-in profile.
 * Returns setup instructions, expected values, and configuration examples.
 */
export const getBuiltInProfileDocumentation = (id: string): ProfileDocumentation | null => {
    switch (id) {
        case 'anthropic':
            return {
                description: 'Official Anthropic backend (Claude Code). Requires being logged in on the selected machine.',
                environmentVariables: [],
                shellConfigExample: `# No additional environment variables needed.
# Make sure you are logged in to Claude Code on the target machine:
# 1) Run: claude
# 2) Then run: /login
#
# If you want to use an API key instead of CLI login, set:
# export ANTHROPIC_AUTH_TOKEN="sk-..."`,
            };
        case 'codex':
            return {
                setupGuideUrl: 'https://developers.openai.com/codex/get-started',
                description: 'Codex CLI using machine-local login (recommended). No API key env vars required.',
                environmentVariables: [],
                shellConfigExample: `# No additional environment variables needed.
# Make sure you are logged in to Codex on the target machine:
# 1) Run: codex login`,
            };
        case 'deepseek':
            return {
                setupGuideUrl: 'https://api-docs.deepseek.com/',
                description: 'DeepSeek Reasoner API proxied through Anthropic-compatible interface',
                environmentVariables: [
                    {
                        name: 'DEEPSEEK_BASE_URL',
                        expectedValue: 'https://api.deepseek.com/anthropic',
                        description: 'DeepSeek API endpoint (Anthropic-compatible)',
                        isSecret: false,
                    },
                    {
                        name: 'DEEPSEEK_AUTH_TOKEN',
                        expectedValue: 'sk-...',
                        description: 'Your DeepSeek API key',
                        isSecret: true,
                    },
                    {
                        name: 'DEEPSEEK_API_TIMEOUT_MS',
                        expectedValue: '600000',
                        description: 'API timeout (10 minutes for reasoning models)',
                        isSecret: false,
                    },
                    {
                        name: 'DEEPSEEK_MODEL',
                        expectedValue: 'deepseek-reasoner',
                        description: 'Default model (reasoning model for complex debugging/algorithms, use deepseek-chat for faster general tasks)',
                        isSecret: false,
                    },
                    {
                        name: 'DEEPSEEK_SMALL_FAST_MODEL',
                        expectedValue: 'deepseek-chat',
                        description: 'Fast model for quick responses',
                        isSecret: false,
                    },
                    {
                        name: 'DEEPSEEK_CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC',
                        expectedValue: '1',
                        description: 'Disable non-essential network traffic',
                        isSecret: false,
                    },
                ],
                shellConfigExample: `# Add to ~/.zshrc or ~/.bashrc:
export DEEPSEEK_BASE_URL="https://api.deepseek.com/anthropic"
export DEEPSEEK_AUTH_TOKEN="sk-YOUR_DEEPSEEK_API_KEY"
export DEEPSEEK_API_TIMEOUT_MS="600000"
export DEEPSEEK_MODEL="deepseek-reasoner"
export DEEPSEEK_SMALL_FAST_MODEL="deepseek-chat"
export DEEPSEEK_CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC="1"

# Model selection guide:
# - deepseek-reasoner: Best for complex debugging, algorithms, precision (slower but more accurate)
# - deepseek-chat: Best for everyday coding, boilerplate, speed (handles 80% of general tasks)`,
            };
        case 'zai':
            return {
                setupGuideUrl: 'https://docs.z.ai/devpack/tool/claude',
                description: 'Z.AI GLM-4.6 API proxied through Anthropic-compatible interface',
                environmentVariables: [
                    {
                        name: 'Z_AI_BASE_URL',
                        expectedValue: 'https://api.z.ai/api/anthropic',
                        description: 'Z.AI API endpoint (Anthropic-compatible)',
                        isSecret: false,
                    },
                    {
                        name: 'Z_AI_AUTH_TOKEN',
                        expectedValue: 'sk-...',
                        description: 'Your Z.AI API key',
                        isSecret: true,
                    },
                    {
                        name: 'Z_AI_API_TIMEOUT_MS',
                        expectedValue: '3000000',
                        description: 'API timeout (50 minutes)',
                        isSecret: false,
                    },
                    {
                        name: 'Z_AI_MODEL',
                        expectedValue: 'GLM-4.6',
                        description: 'Default model',
                        isSecret: false,
                    },
                    {
                        name: 'Z_AI_OPUS_MODEL',
                        expectedValue: 'GLM-4.6',
                        description: 'Model for "Opus" tasks (maps to GLM-4.6)',
                        isSecret: false,
                    },
                    {
                        name: 'Z_AI_SONNET_MODEL',
                        expectedValue: 'GLM-4.6',
                        description: 'Model for "Sonnet" tasks (maps to GLM-4.6)',
                        isSecret: false,
                    },
                    {
                        name: 'Z_AI_HAIKU_MODEL',
                        expectedValue: 'GLM-4.5-Air',
                        description: 'Model for "Haiku" tasks (maps to GLM-4.5-Air)',
                        isSecret: false,
                    },
                ],
                shellConfigExample: `# Add to ~/.zshrc or ~/.bashrc:
export Z_AI_BASE_URL="https://api.z.ai/api/anthropic"
export Z_AI_AUTH_TOKEN="sk-YOUR_ZAI_API_KEY"
export Z_AI_API_TIMEOUT_MS="3000000"
export Z_AI_MODEL="GLM-4.6"
export Z_AI_OPUS_MODEL="GLM-4.6"
export Z_AI_SONNET_MODEL="GLM-4.6"
export Z_AI_HAIKU_MODEL="GLM-4.5-Air"`,
            };
        case 'openai':
            return {
                setupGuideUrl: 'https://platform.openai.com/docs/api-reference',
                description: 'OpenAI GPT-5 Codex API for code generation and completion',
                environmentVariables: [
                    {
                        name: 'OPENAI_BASE_URL',
                        expectedValue: 'https://api.openai.com/v1',
                        description: 'OpenAI API endpoint',
                        isSecret: false,
                    },
                    {
                        name: 'OPENAI_API_KEY',
                        expectedValue: '',
                        description: 'Your OpenAI API key',
                        isSecret: true,
                    },
                    {
                        name: 'OPENAI_MODEL',
                        expectedValue: 'gpt-5-codex-high',
                        description: 'Default model for code tasks',
                        isSecret: false,
                    },
                    {
                        name: 'OPENAI_SMALL_FAST_MODEL',
                        expectedValue: 'gpt-5-codex-low',
                        description: 'Fast model for quick responses',
                        isSecret: false,
                    },
                ],
                shellConfigExample: `# Add to ~/.zshrc or ~/.bashrc:
export OPENAI_BASE_URL="https://api.openai.com/v1"
export OPENAI_API_KEY="sk-YOUR_OPENAI_API_KEY"
export OPENAI_MODEL="gpt-5-codex-high"
export OPENAI_SMALL_FAST_MODEL="gpt-5-codex-low"`,
            };
        case 'azure-openai':
            return {
                setupGuideUrl: 'https://learn.microsoft.com/en-us/azure/ai-services/openai/',
                description: 'Azure OpenAI for Codex (configure your provider/base URL in ~/.codex/config.toml or ~/.codex/config.json).',
                environmentVariables: [
                    {
                        name: 'AZURE_OPENAI_API_KEY',
                        expectedValue: 'your-azure-key',
                        description: 'Your Azure OpenAI API key',
                        isSecret: true,
                    },
                    {
                        name: 'AZURE_OPENAI_API_VERSION',
                        expectedValue: '2024-02-15-preview',
                        description: 'Azure OpenAI API version (optional)',
                        isSecret: false,
                    },
                ],
                shellConfigExample: `# Add to ~/.zshrc or ~/.bashrc:
export AZURE_OPENAI_API_KEY="YOUR_AZURE_API_KEY"
export AZURE_OPENAI_API_VERSION="2024-02-15-preview"

# Then configure Codex provider/base URL in ~/.codex/config.toml or ~/.codex/config.json.`,
            };
        case 'gemini':
            return {
                setupGuideUrl: 'https://github.com/google-gemini/gemini-cli',
                description: 'Gemini CLI using machine-local login (recommended). No API key env vars required.',
                environmentVariables: [],
                shellConfigExample: `# No additional environment variables needed.
# Make sure you are logged in to Gemini CLI on the target machine:
# 1) Run: gemini auth`,
            };
        case 'gemini-api-key':
            return {
                setupGuideUrl: 'https://github.com/google-gemini/gemini-cli',
                description: 'Gemini CLI using an API key via environment variables.',
                environmentVariables: [
                    {
                        name: 'GEMINI_API_KEY',
                        expectedValue: '...',
                        description: 'Your Gemini API key',
                        isSecret: true,
                    },
                    {
                        name: 'GEMINI_MODEL',
                        expectedValue: 'gemini-2.5-pro',
                        description: 'Default model (optional)',
                        isSecret: false,
                    },
                ],
                shellConfigExample: `# Add to ~/.zshrc or ~/.bashrc:
export GEMINI_API_KEY="YOUR_GEMINI_API_KEY"
export GEMINI_MODEL="gemini-2.5-pro"`,
            };
        case 'gemini-vertex':
            return {
                setupGuideUrl: 'https://github.com/google-gemini/gemini-cli',
                description: 'Gemini CLI using Vertex AI (Application Default Credentials).',
                environmentVariables: [
                    {
                        name: 'GOOGLE_GENAI_USE_VERTEXAI',
                        expectedValue: '1',
                        description: 'Enable Vertex AI backend',
                        isSecret: false,
                    },
                    {
                        name: 'GOOGLE_CLOUD_PROJECT',
                        expectedValue: 'your-gcp-project-id',
                        description: 'Google Cloud project ID',
                        isSecret: false,
                    },
                    {
                        name: 'GOOGLE_CLOUD_LOCATION',
                        expectedValue: 'us-central1',
                        description: 'Google Cloud location/region',
                        isSecret: false,
                    },
                ],
                shellConfigExample: `# Add to ~/.zshrc or ~/.bashrc:
export GOOGLE_GENAI_USE_VERTEXAI="1"
export GOOGLE_CLOUD_PROJECT="YOUR_GCP_PROJECT_ID"
export GOOGLE_CLOUD_LOCATION="us-central1"

# Make sure ADC is configured on the target machine (one option):
# gcloud auth application-default login`,
            };
        default:
            return null;
    }
};
