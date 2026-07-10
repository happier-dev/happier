import type { SessionStateProviderFieldHandler } from '@happier-dev/plugin-sdk/sessions';

export function createCodexRolloutDisplayTitleHandler(params: Readonly<{
    readTitle: () => Promise<string | null> | string | null;
}>): SessionStateProviderFieldHandler<'display.title'> {
    return {
        readField: async () => await params.readTitle(),
    };
}
