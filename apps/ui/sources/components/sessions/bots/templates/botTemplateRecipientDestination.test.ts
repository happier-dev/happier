import { describe, expect, it } from 'vitest';
import { buildBotTemplateRecipientRoute, readBotTemplateRecipientRoute } from './botTemplateRecipientDestination';

describe('recipient template destination', () => {
    it('round-trips an addressed release and refuses malformed route input', () => {
        const source = { kind: 'artifact' as const, serverId: 'home-a', artifactId: 'template-a' };
        const route = buildBotTemplateRecipientRoute(source, 'home-a');
        expect(readBotTemplateRecipientRoute(route.params)).toEqual({ source, serverId: 'home-a' });
        expect(readBotTemplateRecipientRoute({ ...route.params, source: '{broken' })).toBeNull();
        expect(readBotTemplateRecipientRoute({ ...route.params, serverId: [] })).toBeNull();
    });
    it('keeps update review bound to the recipient Session and refuses a malformed update target', () => {
        const source = { kind: 'artifact' as const, serverId: 'source-home', artifactId: 'template-a' };
        const sessionRef = { serverId: 'copy-home', sessionId: 'copy-a' };
        const route = buildBotTemplateRecipientRoute(source, 'copy-home', sessionRef);
        expect(readBotTemplateRecipientRoute(route.params)).toEqual({ source, serverId: 'copy-home', sessionRef });
        expect(readBotTemplateRecipientRoute({ ...route.params, sessionRef: '{broken' })).toBeNull();
        expect(readBotTemplateRecipientRoute({ ...route.params, sessionRef: JSON.stringify({ serverId: 'copy-home' }) })).toBeNull();
    });
});
