import * as React from 'react';
import { View } from 'react-native';

import { CenteredInfoTile } from '@/components/ui/lists/CenteredInfoTile';

type EmptyStateProps = Readonly<{
    /** Leading glyph (e.g. an `Ionicons`/`SvgXml` element). Already themed by the caller. */
    icon: React.ReactNode;
    /** Already-translated title string. */
    title: string;
    /** Already-translated supporting copy. */
    subtitle?: React.ReactNode;
    /** Optional call-to-action rendered below the copy (e.g. a button/card). */
    action?: React.ReactNode;
    testID?: string;
    titleTestID?: string;
    subtitleTestID?: string;
    actionTestID?: string;
    paddingHorizontal?: number;
}>;

/**
 * Generic, app-wide empty state: themed icon + title + subtitle + optional
 * action. Reuses {@link CenteredInfoTile} for the icon/title/subtitle layout
 * (the canonical centered info tile) and adds the action slot it lacks. i18n is
 * the caller's responsibility — pass already-translated strings.
 */
export const EmptyState = React.memo((props: EmptyStateProps) => {
    return (
        <View testID={props.testID} style={{ width: '100%', alignItems: 'center' }}>
            <CenteredInfoTile
                icon={props.icon}
                title={props.title}
                description={props.subtitle ?? null}
                titleTestID={props.titleTestID}
                descriptionTestID={props.subtitleTestID}
                paddingHorizontal={props.paddingHorizontal}
            />
            {props.action != null ? (
                <View
                    testID={props.actionTestID}
                    style={{ width: '100%', maxWidth: 520, alignItems: 'center', marginTop: 16 }}
                >
                    {props.action}
                </View>
            ) : null}
        </View>
    );
});

EmptyState.displayName = 'EmptyState';
