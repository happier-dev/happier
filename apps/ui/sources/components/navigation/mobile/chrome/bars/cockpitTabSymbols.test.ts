import { describe, expect, it } from 'vitest';

import { sfSymbolForCockpitTabIcon } from './cockpitTabSymbols';

describe('native cockpit icon semantics', () => {
    it('preserves the original chat, files, branch, navigation, open files and terminal glyph meanings', () => {
        const icons = ['chats-circle', 'folder', 'git-branch', 'list', 'files', 'terminal'] as const;
        expect(icons.map(sfSymbolForCockpitTabIcon))
            .toEqual(['bubble.left', 'folder', 'arrow.triangle.branch', 'list.bullet', 'square.on.square', 'terminal']);
    });
});
