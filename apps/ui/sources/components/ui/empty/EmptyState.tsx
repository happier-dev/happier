import { HappierInfoState } from '@happier-dev/plugin-ui/presentation';
import * as React from 'react';

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
 * action. i18n is the caller's responsibility — pass already-translated strings.
 *
 * The centered wrapper and the action slot's offset are the shared presentation
 * owner (UI-T27), which the plugin loading/empty/error states render too. This
 * adapter supplies {@link CenteredInfoTile}, which is where core's Unistyles
 * typography lives.
 */
export const EmptyState = React.memo((props: EmptyStateProps) => {
    return (
        <HappierInfoState
            testID={props.testID}
            actionTestID={props.actionTestID}
            action={props.action}
        >
            <CenteredInfoTile
                icon={props.icon}
                title={props.title}
                description={props.subtitle ?? null}
                titleTestID={props.titleTestID}
                descriptionTestID={props.subtitleTestID}
                paddingHorizontal={props.paddingHorizontal}
            />
        </HappierInfoState>
    );
});

EmptyState.displayName = 'EmptyState';
