import { MAX_CONVERSATION_PAIRING_DEEP_LINK_TEMPLATE_UTF8_BYTES } from '@happier-dev/channels-protocol/v1';

import { normalizeConversationPairingToken } from './commands.js';

const PAIRING_TOKEN_MARKER = '{{token}}';

function isPairingTemplate(value: string): boolean {
  if (new TextEncoder().encode(value).byteLength > MAX_CONVERSATION_PAIRING_DEEP_LINK_TEMPLATE_UTF8_BYTES) {
    return false;
  }
  return value.split(PAIRING_TOKEN_MARKER).length - 1 === 1;
}

export function renderConversationPairingDeepLink(input: Readonly<{
  template: string;
  normalizedToken: string;
}>): string | null {
  if (normalizeConversationPairingToken(input.normalizedToken) !== input.normalizedToken || !isPairingTemplate(input.template)) {
    return null;
  }

  const rendered = input.template.replace(PAIRING_TOKEN_MARKER, input.normalizedToken);
  try {
    const url = new URL(rendered);
    const encodedToken = `${url.pathname}${url.search}${url.hash}`;
    return url.protocol === 'https:' && encodedToken.includes(input.normalizedToken)
      ? rendered
      : null;
  } catch {
    return null;
  }
}
