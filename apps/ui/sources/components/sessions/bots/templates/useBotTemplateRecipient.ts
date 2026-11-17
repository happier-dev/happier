import * as React from 'react';
import type { BotTemplateReleaseSourceV1 } from '@happier-dev/protocol/bots/templates/botTemplateV1';
import { BotTemplatePreviewResultV1Schema, type BotTemplatePreviewResultV1 } from '@happier-dev/protocol/bots/templates/botTemplateActionsV1';
import { useMountedActionExecution } from '@/components/approvals/useMountedActionExecution';
import { readBotTemplateOpenRefusal, type BotTemplateOpenRefusal } from './botTemplateOpenRefusal';

export function useBotTemplateRecipient(source: BotTemplateReleaseSourceV1, serverId: string, enabled = true) {
    const execution = useMountedActionExecution(serverId);
    const key = JSON.stringify([source, execution.binding?.scope, execution.binding?.revision]);
    const currentKey = React.useRef(key);
    currentKey.current = key;
    const stableSource = React.useMemo(() => source, [key]);
    const [state, setState] = React.useState<{ key: string; preview: BotTemplatePreviewResultV1 | null; failed: boolean;
        refusal: BotTemplateOpenRefusal | null }>({ key, preview: null, failed: false, refusal: null });
    const reload = React.useCallback(async () => {
        if (!enabled || !execution.ready) return null;
        const fail = (refusal: BotTemplateOpenRefusal | null) => {
            if (currentKey.current === key && execution.isCurrent()) setState(previous => ({ key,
                preview: previous.key === key ? previous.preview : null, failed: true, refusal }));
            return null;
        };
        try {
            const outcome = await execution.execute('template.preview', { source: stableSource });
            // A refused open says why once; retrying the same address can't change it.
            if (!outcome.ok) return fail(readBotTemplateOpenRefusal(outcome));
            const result = BotTemplatePreviewResultV1Schema.parse(outcome.result);
            if (currentKey.current !== key || !execution.isCurrent()) return null;
            setState({ key, preview: result, failed: false, refusal: null });
            return result;
        } catch { return fail(null); }
    }, [key, stableSource, enabled, execution.ready, execution.execute, execution.isCurrent]);
    React.useEffect(() => { void reload(); }, [reload]);
    return { preview: enabled && state.key === key ? state.preview : null,
        failed: state.key === key && state.failed, refusal: state.key === key ? state.refusal : null, reload, execution };
}
