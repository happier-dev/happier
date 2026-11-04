import { readBundledProviderWireProtocolFactV1, type BundledProviderWireProtocol, type ProviderWireProtocol } from '@happier-dev/protocol/providers/capabilities/v1';

import { t } from '@/text';

/**
 * Translated endpoint labels exist only for the protocols this build has a
 * copy string for: the bundled ones, plus the text-completion protocol that the
 * Provider contract derives from an `openai-text-completions` operation (DeepSeek's
 * fill-in-the-middle endpoint). A protocol contributed by an installed plugin has
 * none, so the endpoint is labelled with the protocol id the plugin declared
 * rather than with another protocol's label or an unresolved translation key.
 */
const BUNDLED_PROTOCOL_LABEL_KEYS = {
    anthropic: 'settingsProviders.authoring.protocol.anthropic.title',
    'openai-chat': 'settingsProviders.authoring.protocol.openai-chat.title',
    'openai-responses': 'settingsProviders.authoring.protocol.openai-responses.title',
    'ollama-native': 'settingsProviders.authoring.protocol.ollama-native.title',
} as const satisfies Record<BundledProviderWireProtocol, string>;

const TEXT_COMPLETIONS_PROTOCOL = 'openai-completions';

/** The translated name of a protocol this build knows, or `null` for a plugin's own protocol. */
export function knownEndpointProtocolLabel(protocol: ProviderWireProtocol): string | null {
    if (protocol === TEXT_COMPLETIONS_PROTOCOL) return t('settingsProviders.authoring.protocol.openai-completions.title');
    const key = readBundledProviderWireProtocolFactV1(BUNDLED_PROTOCOL_LABEL_KEYS, protocol);
    return key === null ? null : t(key);
}

/** How a person reads an endpoint's protocol ("OpenAI Chat compatible"), not its wire id. */
export function endpointProtocolLabel(protocol: ProviderWireProtocol): string {
    return knownEndpointProtocolLabel(protocol) ?? protocol;
}
