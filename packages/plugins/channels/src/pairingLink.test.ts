import { describe, expect, it } from 'vitest';

import { renderConversationPairingDeepLink } from './pairingLink.js';

describe('Channels pairing deep-link projection', () => {
  it('renders the one normalized challenge token from a provider template', () => {
    expect(renderConversationPairingDeepLink({
      template: 'https://t.me/ExampleBot?start={{token}}',
      normalizedToken: 'ABCD2345',
    })).toBe('https://t.me/ExampleBot?start=ABCD2345');
  });

  it('fails closed for malformed templates, non-https links, and a token that cannot be the rendered challenge', () => {
    expect(renderConversationPairingDeepLink({
      template: 'http://t.me/ExampleBot?start={{token}}',
      normalizedToken: 'ABCD2345',
    })).toBeNull();
    expect(renderConversationPairingDeepLink({
      template: 'https://t.me/ExampleBot',
      normalizedToken: 'ABCD2345',
    })).toBeNull();
    expect(renderConversationPairingDeepLink({
      template: 'https://t.me/ExampleBot?start={{token}}&copy={{token}}',
      normalizedToken: 'ABCD2345',
    })).toBeNull();
    expect(renderConversationPairingDeepLink({
      template: 'https://t.me/ExampleBot?start={{token}}',
      normalizedToken: 'abcd2345',
    })).toBeNull();
    expect(renderConversationPairingDeepLink({
      template: 'https://{{token}}.example.test/pair',
      normalizedToken: 'ABCD2345',
    })).toBeNull();
  });
});
