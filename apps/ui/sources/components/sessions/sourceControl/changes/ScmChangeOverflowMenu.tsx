import * as React from 'react';

import * as Clipboard from 'expo-clipboard';

import { ItemRowActions } from '@/components/ui/lists/ItemRowActions';
import type { ItemAction } from '@/components/ui/lists/itemActions';
import { Modal } from '@/modal';
import { t } from '@/text';

export type ScmChangeOverflowMenuProps = Readonly<{
    title: string;
    filePath: string;
    onRevealInTree?: () => void;
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
                        await Clipboard.setStringAsync(props.filePath);
                        Modal.alert(t('common.copied'), t('items.copiedToClipboard', { label: t('common.path') }));
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

        return out;
    }, [props.filePath, props.onRevealInTree]);

    return (
        <ItemRowActions
            title={props.title}
            actions={actions}
            compactThreshold={Number.POSITIVE_INFINITY}
            compactActionIds={[]}
        />
    );
});
