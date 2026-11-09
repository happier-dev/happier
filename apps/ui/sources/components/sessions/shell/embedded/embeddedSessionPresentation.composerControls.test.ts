import { describe, expect, it } from 'vitest';

import { resolveEmbeddedComposerControls, narrowEmbeddedComposerInputLock } from './embeddedSessionPresentation';

describe('embedded composer controls', () => {
    it('locks submission while reconnecting without locking draft edits or weakening an existing lock', () => {
        const reconnecting = { kind: 'embedded', composer: 'auto', composerInputLocked: true } as const;
        expect(narrowEmbeddedComposerInputLock(null, reconnecting, 'Reconnecting')).toEqual({ mode: 'submit', reasons: ['Reconnecting'] });
        const existing = { mode: 'editAndSubmit', reasons: ['Owned operation'] } as const;
        expect(narrowEmbeddedComposerInputLock(existing, reconnecting, 'Reconnecting')).toBe(existing);
        expect(narrowEmbeddedComposerInputLock(null, { kind: 'embedded', composer: 'auto' }, 'Reconnecting')).toBeNull();
    });
    it('derives the composer affordances from the embedded presentation, for the chat and its preview alike', () => {
        expect(resolveEmbeddedComposerControls(null)).toBeNull();
        expect(resolveEmbeddedComposerControls({ kind: 'embedded', composer: 'auto' })).toEqual({
            voiceAffordance: 'none',
            engineControls: 'none',
            attachments: true,
            allowPlacementCustomization: false,
        });
        expect(resolveEmbeddedComposerControls({ kind: 'embedded', composer: 'auto', attachments: false, modelPicker: true })).toEqual({
            voiceAffordance: 'none',
            engineControls: 'auto',
            attachments: false,
            allowPlacementCustomization: false,
        });
    });
});
