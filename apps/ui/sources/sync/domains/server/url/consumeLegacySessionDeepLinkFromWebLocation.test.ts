import { afterEach, expect, it, vi } from 'vitest';

import { readLegacySessionDeepLinkFromWebLocation } from './consumeLegacySessionDeepLinkFromWebLocation';

afterEach(() => vi.unstubAllGlobals());

function read(href: string) {
    vi.stubGlobal('window', { location: { href } });
    return readLegacySessionDeepLinkFromWebLocation();
}

it('keeps Home, message and child identity when consuming a genuine Root link', () => {
    const home = 'srv_niq7wbpMyJviL4EtO5YlTEd0Us0Ou0nN';
    expect(read(`https://app.example.test/?id=session-123&serverId=${home}&messageId=message%2F1&jumpChildId=child%2F2`))
        .toBe(`/session/session-123/message/message%2F1?serverId=${home}&jumpChildId=child%2F2`);
});

it('keeps Home and child identity on a Session link without a message', () => {
    const home = 'srv_niq7wbpMyJviL4EtO5YlTEd0Us0Ou0nN';
    expect(read(`https://app.example.test/?id=session-123&serverId=${home}&jumpChildId=child-2`))
        .toBe(`/session/session-123?serverId=${home}&jumpChildId=child-2`);
});

it('keeps an unqualified historical link unqualified', () => {
    expect(read('https://app.example.test/?id=session-123')).toBe('/session/session-123');
});

it('does not interpret an entity route query as a legacy Session', () => {
    expect(read('https://app.example.test/machine/machine-123?id=session-123&serverId=srv_example')).toBeNull();
});
