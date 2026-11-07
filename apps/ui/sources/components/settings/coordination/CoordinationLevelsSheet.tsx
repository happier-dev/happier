import * as React from 'react';

import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { Modal, type CustomModalInjectedProps } from '@/modal';
import { useModalCardChrome } from '@/modal/components/card/useModalCardChrome';
import { t } from '@/text';

const LEVELS = ['everything', 'important', 'quiet', 'custom'] as const;

/**
 * "What each level means": the follow editor's own level names and session descriptions (C1 §4.3 owns the
 * meaning), listed once so a default can be chosen without opening a follow.
 */
export function CoordinationLevelsSheet(props: CustomModalInjectedProps) {
    useModalCardChrome(props.setChrome, React.useMemo(() => ({
        kind: 'card' as const,
        title: t('settingsCoordination.levelMeaning'),
        phonePresentation: 'sheet' as const,
        testID: 'settings-coordination-levels-sheet',
    }), []));
    return (
        <ItemList presentation="grouped" style={{ paddingTop: 0 }}>
            <ItemGroup>
                {LEVELS.map((level) => (
                    <Item
                        key={level}
                        testID={`settings-coordination-level-meaning-${level}`}
                        title={t(`session.follow.policy.${level}`)}
                        subtitle={t(`session.follow.policyEditor.session.presetDescription.${level}`)}
                        subtitleLines={0}
                        showChevron={false}
                    />
                ))}
            </ItemGroup>
        </ItemList>
    );
}

export function showCoordinationLevelsSheet(): void {
    Modal.show({ component: CoordinationLevelsSheet, closeOnBackdrop: true });
}
