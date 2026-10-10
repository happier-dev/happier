import { artifactHtmlBundleFromBodyV1 } from '@happier-dev/protocol/artifacts/artifactHtmlV1';
import { decodeBase64 } from '@happier-dev/protocol/crypto/base64';
import { PluginHostedHtmlSourceV1Schema } from '@happier-dev/protocol/plugins/contributions/ui/hostedHtmlSourceV1';
import { SessionSurfaceItemV1Schema, type SessionSurfaceItemV1 } from '@happier-dev/protocol/sessions/board/item';

import type { SessionBoardItemBuildResult } from '../useSessionBoardItemEditor';

export type SessionBoardHostedHtmlEditorInvalidReason = 'session_board_invalid';

/** The editable entrypoint of the submitted item, also used to reconcile recovery. */
export function readSessionBoardHostedHtmlItemText(item: SessionSurfaceItemV1): string | null {
    const source = item.source;
    if (source.kind !== 'hostedHtml') return null;
    const entrypoint = source.source.files[source.source.entrypoint];
    if (!entrypoint) return null;
    try {
        return new TextDecoder('utf-8', { fatal: true }).decode(decodeBase64(entrypoint.contentBase64));
    } catch {
        return null;
    }
}

export function buildSessionBoardHostedHtmlItem(input: Readonly<{
    title: string;
    html: string;
    baseItem?: SessionSurfaceItemV1;
}>): SessionSurfaceItemV1 | null {
    const result = buildSessionBoardHostedHtmlItemResult(input);
    return result.ok ? result.item : null;
}

export function buildSessionBoardHostedHtmlItemResult(input: Readonly<{
    title: string;
    html: string;
    baseItem?: SessionSurfaceItemV1;
}>): SessionBoardItemBuildResult<SessionBoardHostedHtmlEditorInvalidReason> {
    if (input.baseItem && input.baseItem.source.kind !== 'hostedHtml') {
        return { ok: false, error: 'session_board_invalid' };
    }
    const entrypointBody = artifactHtmlBundleFromBodyV1(input.html);
    const baseBundle = input.baseItem?.source.kind === 'hostedHtml' ? input.baseItem.source.source : null;
    const source = PluginHostedHtmlSourceV1Schema.safeParse(baseBundle ? {
        ...baseBundle,
        files: {
            ...baseBundle.files,
            [baseBundle.entrypoint]: {
                ...baseBundle.files[baseBundle.entrypoint],
                contentBase64: entrypointBody.files[entrypointBody.entrypoint].contentBase64,
            },
        },
    } : entrypointBody);
    if (!source.success) return { ok: false, error: 'session_board_invalid' };
    const item = SessionSurfaceItemV1Schema.safeParse(input.baseItem ? {
        ...input.baseItem,
        title: input.title.trim(),
        source: { ...input.baseItem.source, source: source.data },
    } : {
        v: 1,
        title: input.title.trim(),
        frame: 'card',
        height: { mode: 'auto', fallback: 'regular' },
        source: { kind: 'hostedHtml', source: source.data },
    });
    return item.success
        ? { ok: true, item: item.data }
        : { ok: false, error: 'session_board_invalid' };
}
