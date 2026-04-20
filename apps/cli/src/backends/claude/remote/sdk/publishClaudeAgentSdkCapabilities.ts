export function publishClaudeAgentSdkCapabilities(params: {
    response: any;
    onCapabilities?: ((caps: {
        slashCommands?: string[];
        slashCommandDetails?: Array<{ command: string; description?: string }>;
        models?: unknown[];
    }) => void) | undefined;
}) {
    const onCapabilities = params.onCapabilities;
    if (!onCapabilities) return;

    void (async () => {
        try {
            const [commandsResult, modelsResult] = await Promise.allSettled([
                params.response?.supportedCommands?.(),
                params.response?.supportedModels?.(),
            ]);

            const commandsRaw = commandsResult.status === 'fulfilled' ? commandsResult.value : null;
            const modelsRaw = modelsResult.status === 'fulfilled' ? modelsResult.value : null;

            const commandDetails = Array.isArray(commandsRaw)
                ? commandsRaw
                      .map((cmd: any) => ({
                          command: typeof cmd?.command === 'string' ? cmd.command : null,
                          description: typeof cmd?.description === 'string' ? cmd.description : undefined,
                      }))
                      .filter((cmd: any) => typeof cmd.command === 'string' && cmd.command.length > 0)
                : [];

            onCapabilities({
                ...(commandDetails.length > 0
                    ? {
                          slashCommands: commandDetails.map((command: any) => command.command),
                          slashCommandDetails: commandDetails,
                      }
                    : {}),
                ...(Array.isArray(modelsRaw) ? { models: modelsRaw } : {}),
            });
        } catch {
            // ignore
        }
    })();
}
