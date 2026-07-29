import * as React from 'react';

import { ItemRowActions } from '@/components/ui/lists/ItemRowActions';
import type { ItemAction } from '@/components/ui/lists/itemActions';
import { Modal } from '@/modal';
import { t } from '@/text';
import { setClipboardStringSafe } from '@/utils/ui/clipboard';

export type ScmChangeOverflowMenuProps = Readonly<{
    title: string;
    filePath: string;
    onRevealInTree?: () => void;
    onCopyPathSuccess?: () => void;
    /**
     * When provided, a destructive "Discard changes" action is appended to the menu.
     * The revert affordance lives here (instead of an inline row button) so the row
     * stays legible at narrow widths. Discard itself confirms before running.
     */
    onDiscard?: () => void;
    discardDisabled?: boolean;
}>;

export const ScmChangeOverflowMenu = React.memo((props: ScmChangeOverflowMenuProps) => {
    const actions = React.useMemo((): ItemAction[] => {
        const out: ItemAction[] = [
            {
                id: 'copy_path',
                title: t('common.path'),
                icon: 'copy-outline',
                onPress: () => {
                    void (async () => {
                        const ok = await setClipboardStringSafe(props.filePath);
                        if (!ok) {
                            Modal.alert(t('common.error'), t('items.failedToCopyToClipboard'));
                            return;
                        }
                        props.onCopyPathSuccess?.();
                    })();
                },
            },
        ];

        if (props.onRevealInTree) {
            out.push({
                id: 'reveal_in_tree',
                title: t('common.files'),
                icon: 'folder-open-outline',
                onPress: props.onRevealInTree,
            });
        }

        if (props.onDiscard) {
            out.push({
                id: 'discard',
                title: t('common.discardChanges'),
                icon: 'arrow-undo-outline',
                destructive: true,
                disabled: props.discardDisabled,
                onPress: props.onDiscard,
            });
        }

        return out;
    }, [props.filePath, props.onRevealInTree, props.onCopyPathSuccess, props.onDiscard, props.discardDisabled]);

    return (
        <ItemRowActions
            title={props.title}
            actions={actions}
            compactThreshold={Number.POSITIVE_INFINITY}
            compactActionIds={[]}
        />
    );
});
