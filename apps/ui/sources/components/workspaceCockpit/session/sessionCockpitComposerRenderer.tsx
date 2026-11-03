import * as React from 'react';

import { PhoneAskSheet } from '@/components/sessions/composer/phoneAsk/PhoneAskSheet';
import type { SessionComposerRenderer } from '@/components/sessions/composer/sessionComposerModel';

import type { SessionMobileSurface } from './sessionCockpitState';

const renderChatComposer: SessionComposerRenderer = (composer) => <PhoneAskSheet composer={composer} />;

/** Keep Chat's composer parent stable across widths; the sheet controller owns whether Ask is available. */
export function resolveSessionCockpitComposerRenderer(surface: SessionMobileSurface): SessionComposerRenderer | undefined {
    return surface === 'chat' ? renderChatComposer : undefined;
}
