import * as React from 'react';
import { useUnistyles } from 'react-native-unistyles';

import { EmptyState } from '@/components/ui/empty/EmptyState';
import { Icon } from '@/components/ui/icons/Icon';
import { t } from '@/text';

/**
 * What a roster with nothing in it says.
 *
 * **One message, because a roster with no rows has exactly one meaning.** This briefly carried a
 * second `idle` variant ("no agents running right now") plus a launch button, on the theory that a
 * session whose agents had merely finished should not get the introduction again. Neither was
 * reachable: the only surface that draws this is the Agents pane, which is not live-only — a
 * session whose agents have finished *lists* them, so an empty roster there means the session has
 * never run one. The compact work-state surface returns `null` before the list mounts at all.
 *
 * The launch affordance went the same way: the pane already composes `SessionSubagentLaunchSection`
 * directly beneath this, so the button was a second way in, four points below the first.
 *
 * "We cannot reach the machine" is a different thing and is deliberately not handled here.
 */

export type AgentActivityEmptyStateProps = Readonly<{
    testID?: string;
}>;

export function AgentActivityEmptyState(props: AgentActivityEmptyStateProps): React.ReactElement {
    const { theme } = useUnistyles();

    return (
        <EmptyState
            testID={props.testID}
            titleTestID={props.testID ? `${props.testID}:title` : undefined}
            icon={<Icon name="robot" size={29} color={theme.colors.text.secondary} />}
            title={t('session.agentActivity.empty.firstUseTitle')}
            subtitle={t('session.agentActivity.empty.firstUseSubtitle')}
        />
    );
}
