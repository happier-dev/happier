import * as React from 'react';
import type { BotTemplateReleaseSourceV1 } from '@happier-dev/protocol/bots/templates/botTemplateV1';
import { BotTemplatePreviewResultV1Schema, type BotTemplatePreviewResultV1 } from '@happier-dev/protocol/bots/templates/botTemplateActionsV1';
import { useMountedActionExecution } from '@/components/approvals/useMountedActionExecution';

export function useBotTemplateRecipient(source: BotTemplateReleaseSourceV1, serverId: string, enabled = true) {
    const execution = useMountedActionExecution(serverId);
    const key = JSON.stringify([source, execution.binding?.scope, execution.binding?.revision]);
    const currentKey = React.useRef(key);
    currentKey.current = key;
    const stableSource = React.useMemo(() => source, [key]);
    const [state, setState] = React.useState<{ key: string; preview: BotTemplatePreviewResultV1 | null; failed: boolean }>(
        { key, preview: null, failed: false });
    const reload = React.useCallback(async () => {
        if (!enabled || !execution.ready) return null;
        try {
            const result = BotTemplatePreviewResultV1Schema.parse(await execution.executeValue('template.preview', { source: stableSource }));
            if (currentKey.current !== key || !execution.isCurrent()) return null;
            setState({ key, preview: result, failed: false });
            return result;
        } catch {
            if (currentKey.current === key && execution.isCurrent()) setState(previous => ({ key,
                preview: previous.key === key ? previous.preview : null, failed: true }));
            return null;
        }
    }, [key, stableSource, enabled, execution.ready, execution.executeValue, execution.isCurrent]);
    React.useEffect(() => { void reload(); }, [reload]);
    return { preview: enabled && state.key === key ? state.preview : null,
        failed: state.key === key && state.failed, reload, execution };
}
