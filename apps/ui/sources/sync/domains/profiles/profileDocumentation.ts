export interface ProfileDocumentation {
    setupGuideUrl?: string;
    description: string;
    environmentVariables: Array<{
        name: string;
        expectedValue: string;
        description: string;
        isSecret: boolean;
    }>;
    shellConfigExample: string;
}

/** Setup guidance for the intentionally retained V1 legacy profiles only. */
export function getBuiltInProfileDocumentation(id: string): ProfileDocumentation | null {
    switch (id) {
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
        case 'gemini-api-key':
            return {
                setupGuideUrl: 'https://github.com/google-gemini/gemini-cli',
                description: 'Gemini CLI using an API key via environment variables.',
                environmentVariables: [{
                    name: 'GEMINI_API_KEY',
                    expectedValue: '...',
                    description: 'Your Gemini API key',
                    isSecret: true,
                }],
                shellConfigExample: `# Add to ~/.zshrc or ~/.bashrc:
export GEMINI_API_KEY="YOUR_GEMINI_API_KEY"`,
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

# Make sure ADC is configured on the target machine:
# gcloud auth application-default login`,
            };
        default:
            return null;
    }
}
