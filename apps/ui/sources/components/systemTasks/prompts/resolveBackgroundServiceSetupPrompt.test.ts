import { describe, expect, it } from 'vitest';
import type { SystemTaskJsonObject } from '@happier-dev/protocol/system/tasks/spec';

import type { SystemTaskPromptEnvelope } from './readLatestSystemTaskPrompt';

function createPromptEnvelope<const TKind extends string, const TData extends SystemTaskJsonObject>(
    params: Readonly<{
        kind: TKind;
        data: TData;
    }>,
): Readonly<{
    kind: TKind;
    message: string;
    data: TData;
}> {
    return {
        kind: params.kind,
        message: 'Prompt message',
        data: params.data,
    };
}

describe('resolveBackgroundServiceSetupPrompt', () => {
    it('parses remote background-service replacement prompts', async () => {
        const { resolveBackgroundServiceReplacementPrompt } = await import('./resolveBackgroundServiceSetupPrompt');

        expect(resolveBackgroundServiceReplacementPrompt(createPromptEnvelope({
            kind: 'daemon.replaceRemoteBackgroundServices',
            data: {
                targetServerUrl: 'https://relay.example.test',
                targetReleaseChannel: 'preview',
                services: [{
                    label: 'com.happier.remote.preview.default',
                    releaseChannel: 'preview',
                    targetMode: 'default-following',
                    running: false,
                }],
            },
        }))).toEqual({
            kind: 'daemon.replaceRemoteBackgroundServices',
            message: 'Prompt message',
            targetServerUrl: 'https://relay.example.test',
            targetReleaseChannel: 'preview',
            services: [{
                label: 'com.happier.remote.preview.default',
                releaseChannel: 'preview',
                targetMode: 'default-following',
                running: false,
            }],
        });
    });
});
