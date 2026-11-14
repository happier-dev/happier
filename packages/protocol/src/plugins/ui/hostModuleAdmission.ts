import { PLUGIN_UI_HOST_PROVIDED_PROTOCOL_SPECIFIERS } from './hostProvidedProtocolSubpaths.generated.js';
import { PLUGIN_UI_HOST_RUNTIME_EXTERNAL_SPECIFIERS } from './hostRuntimeExternals.js';

const hostProvidedProtocolSpecifiers = new Set(PLUGIN_UI_HOST_PROVIDED_PROTOCOL_SPECIFIERS);
const hostRuntimeExternalSpecifiers = new Set<string>(PLUGIN_UI_HOST_RUNTIME_EXTERNAL_SPECIFIERS);

/**
 * Whether every Plugin UI host provides `specifier`: the fixed runtime list
 * above, or a public Protocol subpath the export generator proved React Native
 * can load. The compiler externalizes exactly these; hosts provide exactly these.
 */
export function isPluginUiHostRuntimeExternalSpecifierV1(specifier: string): boolean {
    return hostRuntimeExternalSpecifiers.has(specifier) || hostProvidedProtocolSpecifiers.has(specifier);
}

/** Recorded artifact host modules this host does not provide (empty when it provides all of them). */
export function readMissingPluginUiHostModulesV1(hostModules: readonly string[] | undefined): readonly string[] {
    return (hostModules ?? []).filter(specifier => !isPluginUiHostRuntimeExternalSpecifierV1(specifier));
}
