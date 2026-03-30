export function isCodexAppServerFastModelEligible(modelId: string | null | undefined): boolean {
    return modelId === 'gpt-5.4';
}

export function isCodexAppServerSpeedEligible(params: Readonly<{
    authMethod?: string | null;
    currentModelId: string | null;
}>): boolean {
    if (!isCodexAppServerFastModelEligible(params.currentModelId)) return false;
    return params.authMethod === 'oauth_cli' || params.authMethod === 'credentials_file';
}
