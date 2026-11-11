import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

describe('Voice runtime Inbox owner', () => {
    it('mounts the canonical Inbox owner for the active Voice lifetime', async () => {
        const source = await readFile(new URL('./VoiceSessionRuntimeHost.tsx', import.meta.url), 'utf8');

        expect(source).toContain("import { InboxModelProvider } from '@/hooks/inbox/useInboxModel';");
        expect(source).toContain('<InboxModelProvider>');
    });
});
