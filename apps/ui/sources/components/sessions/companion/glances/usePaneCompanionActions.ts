import * as React from 'react';

import type { ItemAction } from '@/components/ui/lists/itemActions';
import { normalizeSessionAddress } from '@/sync/domains/session/sessionAddress';
import { t } from '@/text';

import { useSessionCompanionRevealPort } from '../presentation/SessionCompanionRevealPort';
import { showSessionCompanionItem } from '../presentation/sessionCompanionHumanAction';
import { buildSessionPresentationNoticeKeyPrefix } from '../presentation/sessionCompanionPresentationAdapter';
import { publishPresentationNotice } from '@/components/sessions/presentation/presentationNotices';
import { useSessionCompanionController } from '../state/useSessionCompanionController';

const NOOP_OPEN_COMPANION = (): void => {};

/**
 * "Add to Companion" for a pane (lab WC3: the second way in, beside the Companion's own popover). It
 * keeps one link row to the pane through the Companion's one add path — `show`, which also reveals a
 * hidden Companion — and is absent once the pane is already there.
 */
export function usePaneCompanionActions(input: Readonly<{
    sessionId: string;
    serverId: string | null;
    paneId: string | null;
}>): readonly ItemAction[] {
    const address = React.useMemo(
        () => normalizeSessionAddress(input.serverId, input.sessionId),
        [input.serverId, input.sessionId],
    );
    const reveal = useSessionCompanionRevealPort(address);
    const companion = useSessionCompanionController({
        sessionId: input.sessionId,
        serverId: input.serverId,
        openFullSurface: reveal?.openFullSurface ?? NOOP_OPEN_COMPANION,
    });
    const paneId = input.paneId;
    const kept = paneId !== null && companion.preference.items.some((item) => item.kind === 'pane' && item.paneId === paneId);
    return React.useMemo<readonly ItemAction[]>(() => {
        if (paneId === null || kept || !reveal || companion.availability !== 'ready') return [];
        return [{
            id: 'add-to-companion',
            title: t('sessionBoard.companion.actions.addToCompanion'),
            icon: 'stack',
            onPress: () => {
                void showSessionCompanionItem({
                    address, companion, publishNotice: publishPresentationNotice,
                    noticeKeyPrefix: buildSessionPresentationNoticeKeyPrefix(address, input.sessionId),
                    item: { kind: 'pane', paneId },
                    revealAfterMutation: reveal.revealAfterMutation,
                });
            },
        }];
    }, [address, companion, input.sessionId, kept, paneId, reveal]);
}
