import * as React from 'react';

import { useSessionChatReveal } from '@/components/sessions/panes/useSessionChatReveal';
import { useKeyboardCommand } from '@/keyboard/KeyboardShortcutProvider';
import { deferOnWeb } from '@/utils/platform/deferOnWeb';

export function useReviewComposerHandoff(scopeId: string): () => void {
    const revealChat = useSessionChatReveal(scopeId);
    const executeKeyboardCommand = useKeyboardCommand();
    return React.useCallback(() => {
        deferOnWeb(() => {
            // Review state is retained; the composer's shared focus request reveals its main column.
            revealChat();
            requestAnimationFrame(() => { executeKeyboardCommand('composer.focus'); });
        });
    }, [executeKeyboardCommand, revealChat]);
}
