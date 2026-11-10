import * as React from 'react';

import { SessionHeaderIconWithCount } from '@/components/sessions/actions/SessionHeaderIconWithCount';
import { SessionHeaderActionButton, SessionHeaderGlyph } from '@/components/sessions/actions/SessionHeaderActionButton';

import {
    resolveSessionCompanionHeaderAccessibilityLabel,
    type SessionCompanionHeaderIntent,
} from './sessionCompanionHeaderIntent';

/**
 * Visual projection of the canonical Companion header action. The Session
 * header menu owns placement and execution so direct and overflow never become
 * separate commands or compete for independent width budgets.
 */
export const SessionCompanionHeaderButton = React.memo((props: Readonly<{
    intent: SessionCompanionHeaderIntent;
    onPress: () => void;
}>) => {
    const { intent } = props;

    return (
        <SessionHeaderActionButton
            testID="session-header-companion"
            onPress={props.onPress}
            expanded={intent.expanded}
            accessibilityLabel={resolveSessionCompanionHeaderAccessibilityLabel(intent)}
        >
            <SessionHeaderIconWithCount count={intent.itemCount}>
                <SessionHeaderGlyph name="stack-simple" />
            </SessionHeaderIconWithCount>
        </SessionHeaderActionButton>
    );
});
