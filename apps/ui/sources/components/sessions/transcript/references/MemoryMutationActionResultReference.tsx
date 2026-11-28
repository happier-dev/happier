import * as React from 'react';
import type { ToolCall } from '@happier-dev/session-core/messages';
import { ArtifactActionOutputSchemasV1 } from '@happier-dev/protocol/artifacts/artifactActionsV1';
import { HappierWorkUpdateCard } from '@happier-dev/plugin-ui/presentation';

import { useMountedActionExecution } from '@/components/approvals/useMountedActionExecution';
import { memoryDocumentHref } from '@/components/memory/memoryDocumentRoutes';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Icon } from '@/components/ui/icons/Icon';
import { Text } from '@/components/ui/text/Text';
import { renderWorkUpdateCardSurface, useWorkTheme, WORK_HOST } from '@/components/work/map/WorkMapView';
import { t } from '@/text';

import { useOptionalSessionTranscriptSource } from '../source/SessionTranscriptSourceContext';
import { readTranscriptMemoryMutationReference } from './transcriptToolResultCardModel';

type Receipt = NonNullable<ReturnType<typeof readTranscriptMemoryMutationReference>>;
type UndoState = 'ready' | 'pending' | 'stale' | 'failed' | { readonly bodyVersion: number };

export const MemoryMutationActionResultReference = React.memo(function MemoryMutationActionResultReference(props: Readonly<{
    tool: ToolCall;
    serverId?: string;
}>) {
    const receipt = React.useMemo(() => readTranscriptMemoryMutationReference(props.tool), [props.tool]);
    return receipt ? <SavedMemoryReceipt receipt={receipt} serverId={props.serverId} /> : null;
});

function SavedMemoryReceipt({ receipt, serverId }: Readonly<{ receipt: Receipt; serverId?: string }>) {
    const theme = useWorkTheme();
    const source = useOptionalSessionTranscriptSource();
    const home = receipt.ref?.serverId ?? serverId ?? source?.serverId ?? null;
    const canInteract = source?.kind === 'app' && home !== null;
    const undo = receipt.receipt.undo;
    const { execute } = useMountedActionExecution(canInteract && undo ? home : null);
    const [state, setState] = React.useState<UndoState>('ready');

    const undoReceipt = async () => {
        if (!undo) return;
        setState('pending');
        try {
            const result = await execute('artifact.revisions.restore', undo);
            if (!result.ok) {
                setState(result.errorCode === 'version_mismatch' ? 'stale' : 'failed');
                return;
            }
            const restored = ArtifactActionOutputSchemasV1['artifact.revisions.restore'].safeParse(result.result);
            setState(restored.success ? restored.data.revision : 'failed');
        } catch {
            setState('failed');
        }
    };

    const message = state === 'stale' ? t('artifacts.browser.proposal.undoConflict')
        : state === 'failed' ? t('memoryContext.memory.refused')
        : typeof state === 'object' ? t('artifacts.browser.proposal.undone', { n: state.bodyVersion })
        : undefined;
    const navigate = canInteract ? source.navigate : null;
    return <HappierWorkUpdateCard
        testID="transcript-memory-receipt"
        theme={theme}
        host={WORK_HOST}
        renderSurface={renderWorkUpdateCardSurface}
        mark={<Icon name="brain" size={16} />}
        title={t('memoryContext.memory.title')}
        tone="neutral"
        meta={t('artifacts.browser.facts.version', { n: receipt.revision.bodyVersion })}
        state={t('memoryContext.memory.factCount', { count: receipt.receipt.changes.length })}
        leadingAction={navigate && <RoundButton size="small" display="inverted" title={t('common.open')}
            onPress={() => navigate(memoryDocumentHref({ artifactId: receipt.artifactId }, { serverId: home }))} />}
        actions={canInteract && undo && (state === 'ready' || state === 'pending' || state === 'failed') && <RoundButton
            testID="transcript-memory-receipt-undo"
            size="small"
            display="secondary"
            title={t('common.undo')}
            loading={state === 'pending'}
            disabled={state === 'pending'}
            action={undoReceipt}
        />}
    >{message ? <Text variant="meta" accessibilityLiveRegion="polite">{message}</Text> : null}</HappierWorkUpdateCard>;
}
