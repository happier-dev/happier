import * as React from 'react';
import { BotTemplatePreviewResultV1Schema } from '@happier-dev/protocol/bots/templates/botTemplateActionsV1';
import { projectBotTemplateReleaseV1, BotTemplateVersionV1Schema, type BotTemplateReleaseV1 } from '@happier-dev/protocol/bots/templates/botTemplateV1';
import type { PluginPublicationBotTemplate } from '@happier-dev/protocol/actions/actionSpecs';
import { useMountedActionExecution } from '@/components/approvals/useMountedActionExecution';
import type { BotTemplateEditorBuffer } from '@/components/sessions/bots/templates/botTemplateEditorBuffer';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';

type PublicationSeed = Readonly<{ botTemplate: PluginPublicationBotTemplate; previousRelease: BotTemplateReleaseV1 | null }>;

/** Opening reads the existing release; only final publication may create or reuse it. */
export function useBotTemplatePublicationSeed(options: Readonly<{
    artifactId: string; buffer: BotTemplateEditorBuffer; scope: ServerAccountScope;
}>) {
    const execution = useMountedActionExecution(options.scope);
    const [opening] = React.useState(() => {
        const saved = options.buffer.getSnapshot();
        const version = BotTemplateVersionV1Schema.safeParse(saved.releaseOptions.version);
        return { releaseArtifactId: saved.draft.releaseArtifactId, botTemplate: {
            draftArtifactId: options.artifactId, expectedRevision: saved.revision,
            release: projectBotTemplateReleaseV1(saved.draft, { version: version.success ? version.data : '1.0.0',
                changelog: saved.releaseOptions.changelog, releasedAtMs: Date.now() }),
        } satisfies PluginPublicationBotTemplate };
    });
    const [attempt, retry] = React.useReducer(value => value + 1, 0);
    const [state, setState] = React.useState<{ seed: PublicationSeed | null; failed: boolean }>({ seed: null, failed: false });
    React.useEffect(() => {
        if (!execution.ready) return;
        let mounted = true;
        setState({ seed: null, failed: false });
        void (async () => {
            const result = await execution.execute('template.preview', { source: {
                kind: 'artifact', serverId: options.scope.serverId, artifactId: opening.releaseArtifactId,
            } });
            if (!result.ok && result.errorCode !== 'artifact_not_found') throw new Error('source_unavailable');
            const previousRelease = result.ok ? BotTemplatePreviewResultV1Schema.parse(result.result).release : null;
            if (mounted && execution.isCurrent()) setState({ seed: { botTemplate: opening.botTemplate, previousRelease }, failed: false });
        })().catch(() => {
            if (mounted && execution.isCurrent()) setState({ seed: null, failed: true });
        });
        return () => { mounted = false; };
    }, [execution.ready, execution.execute, execution.isCurrent, opening, options.scope.serverId, attempt]);
    return { seed: execution.ready ? state.seed : null, failed: state.failed, retry };
}
